-- Incremental Phase 1 reliability migration. It preserves published challenges/results.
create table if not exists public.challenge_attempt_answers (
  attempt_id uuid not null references public.challenge_attempts(id) on delete cascade,
  question_position smallint not null check (question_position between 1 and 5),
  guess numeric(12,2) not null check (guess > 0 and guess <= 1000000000),
  score integer not null check (score between 0 and 1000),
  answered_at timestamptz not null default now(),
  primary key (attempt_id, question_position)
);

alter table public.challenge_attempt_answers enable row level security;
revoke all on public.challenge_attempt_answers from public, anon, authenticated;

create or replace function public.get_today_challenge()
returns table (challenge_id uuid, challenge_date date, question_ids text[], is_demo boolean)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict error
declare
  today_in_croatia date := (now() at time zone 'Europe/Zagreb')::date;
  challenge_row public.daily_challenges%rowtype;
  use_verified boolean;
  selected_count integer;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;

  select daily_challenges.* into challenge_row
  from public.daily_challenges as daily_challenges
  where daily_challenges.challenge_date = today_in_croatia;

  if not found then
    perform pg_advisory_xact_lock(hashtextextended('cifra-daily-challenge:' || today_in_croatia::text, 0));
    select daily_challenges.* into challenge_row
    from public.daily_challenges as daily_challenges
    where daily_challenges.challenge_date = today_in_croatia;
  end if;

  if found and not challenge_row.published then raise exception 'challenge_not_published'; end if;

  if not found then
    select count(distinct questions.category) >= 5 into use_verified
    from public.questions as questions
    where questions.active
      and not questions.is_demo
      and questions.verification_status = 'verified';

    insert into public.daily_challenges (challenge_date, published, is_demo)
    values (today_in_croatia, false, not use_verified)
    returning * into challenge_row;

    with usage as (
      select challenge_questions.question_id,
        count(*) as appearances,
        max(daily_challenges.challenge_date) as last_appeared
      from public.challenge_questions as challenge_questions
      join public.daily_challenges as daily_challenges
        on daily_challenges.id = challenge_questions.challenge_id
      where daily_challenges.published
        and daily_challenges.challenge_date < today_in_croatia
      group by challenge_questions.question_id
    ), ranked as (
      select questions.id, questions.category, questions.actual_price, questions.currency,
        questions.is_demo, questions.verification_status,
        coalesce(usage.appearances, 0) as appearances,
        usage.last_appeared,
        md5(today_in_croatia::text || ':' || questions.id) as stable_order,
        row_number() over (
          partition by questions.category
          order by
            case when coalesce(usage.appearances, 0) = 0 then 0 else 1 end,
            case when usage.last_appeared = today_in_croatia - 1 then 1 else 0 end,
            usage.last_appeared nulls first,
            coalesce(usage.appearances, 0),
            md5(today_in_croatia::text || ':' || questions.id),
            questions.id
        ) as category_rank
      from public.questions as questions
      left join usage on usage.question_id = questions.id
      where questions.active
        and (
          (not challenge_row.is_demo and not questions.is_demo and questions.verification_status = 'verified')
          or (challenge_row.is_demo and questions.is_demo and questions.verification_status = 'unverified')
        )
    ), category_choices as (
      select ranked.*
      from ranked
      where ranked.category_rank = 1
      order by case when ranked.appearances = 0 then 0 else 1 end,
        case when ranked.last_appeared = today_in_croatia - 1 then 1 else 0 end,
        ranked.last_appeared nulls first,
        ranked.appearances,
        md5(today_in_croatia::text || ':category:' || ranked.category),
        ranked.category
      limit 5
    ), fill_choices as (
      select ranked.*
      from ranked
      where not exists (
        select 1 from category_choices
        where category_choices.id = ranked.id
      )
      order by case when ranked.appearances = 0 then 0 else 1 end,
        case when ranked.last_appeared = today_in_croatia - 1 then 1 else 0 end,
        ranked.last_appeared nulls first,
        ranked.appearances,
        ranked.stable_order,
        ranked.id
      limit greatest(0, 5 - (select count(*) from category_choices))
    ), selected as (
      select category_choices.id, category_choices.actual_price, category_choices.currency,
        category_choices.is_demo, category_choices.verification_status, category_choices.stable_order
      from category_choices
      union all
      select fill_choices.id, fill_choices.actual_price, fill_choices.currency,
        fill_choices.is_demo, fill_choices.verification_status, fill_choices.stable_order
      from fill_choices
    )
    insert into public.challenge_questions (
      challenge_id, question_id, position, actual_price_snapshot,
      currency_snapshot, is_demo_snapshot, verification_status_snapshot
    )
    select challenge_row.id, selected.id,
      row_number() over (order by selected.stable_order, selected.id)::smallint,
      selected.actual_price, selected.currency, selected.is_demo, selected.verification_status
    from selected;

    select count(*) into selected_count
    from public.challenge_questions as challenge_questions
    where challenge_questions.challenge_id = challenge_row.id
      and challenge_questions.actual_price_snapshot > 0
      and challenge_questions.currency_snapshot = 'EUR'
      and challenge_questions.is_demo_snapshot = challenge_row.is_demo
      and (
        (challenge_row.is_demo and challenge_questions.verification_status_snapshot = 'unverified')
        or (not challenge_row.is_demo and challenge_questions.verification_status_snapshot = 'verified')
      );
    if selected_count <> 5 then
      raise exception 'daily_challenge_requires_exactly_five_valid_snapshots';
    end if;

    update public.daily_challenges as daily_challenges
    set published = true, published_at = now()
    where daily_challenges.id = challenge_row.id
    returning * into challenge_row;
  end if;

  select count(*) into selected_count
  from public.challenge_questions as challenge_questions
  where challenge_questions.challenge_id = challenge_row.id
    and challenge_questions.actual_price_snapshot > 0
    and challenge_questions.currency_snapshot = 'EUR'
    and challenge_questions.is_demo_snapshot = challenge_row.is_demo
    and (
      (challenge_row.is_demo and challenge_questions.verification_status_snapshot = 'unverified')
      or (not challenge_row.is_demo and challenge_questions.verification_status_snapshot = 'verified')
    );
  if not challenge_row.published or selected_count <> 5 then
    raise exception 'daily_challenge_is_invalid';
  end if;

  return query
    select challenge_row.id as challenge_id,
      challenge_row.challenge_date as challenge_date,
      array_agg(challenge_questions.question_id order by challenge_questions.position) as question_ids,
      challenge_row.is_demo as is_demo
    from public.challenge_questions as challenge_questions
    where challenge_questions.challenge_id = challenge_row.id
    group by challenge_row.id, challenge_row.challenge_date, challenge_row.is_demo
    having count(*) = 5;
end;
$$;

create or replace function public.get_daily_attempt_progress(p_challenge_date date)
returns table (guesses numeric[], question_scores integer[], actual_prices numeric[], answered_count integer)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict error
declare
  authenticated_user_id uuid := auth.uid();
  today_in_croatia date := (now() at time zone 'Europe/Zagreb')::date;
  v_attempt_id uuid;
  v_challenge_id uuid;
begin
  if authenticated_user_id is null then raise exception 'authentication_required'; end if;
  if p_challenge_date is distinct from today_in_croatia then
    raise exception 'challenge_date_must_be_today_in_europe_zagreb';
  end if;

  select challenge_attempts.id, challenge_attempts.challenge_id
  into v_attempt_id, v_challenge_id
  from public.challenge_attempts as challenge_attempts
  join public.daily_challenges as daily_challenges
    on daily_challenges.id = challenge_attempts.challenge_id
  where challenge_attempts.user_id = authenticated_user_id
    and daily_challenges.challenge_date = p_challenge_date;

  if v_attempt_id is null then
    return query select array[]::numeric[], array[]::integer[], array[]::numeric[], 0;
    return;
  end if;

  return query
    select coalesce(array_agg(attempt_answers.guess order by attempt_answers.question_position), array[]::numeric[]),
      coalesce(array_agg(attempt_answers.score order by attempt_answers.question_position), array[]::integer[]),
      coalesce(array_agg(challenge_questions.actual_price_snapshot order by attempt_answers.question_position), array[]::numeric[]),
      count(*)::integer
    from public.challenge_attempt_answers as attempt_answers
    join public.challenge_questions as challenge_questions
      on challenge_questions.challenge_id = v_challenge_id
      and challenge_questions.position = attempt_answers.question_position
    where attempt_answers.attempt_id = v_attempt_id;
end;
$$;

create or replace function public.submit_daily_answer(
  p_challenge_date date,
  p_question_position smallint,
  p_guess numeric,
  p_attempt_token text
)
returns table (
  question_position smallint,
  accepted_guess numeric,
  actual_price numeric,
  question_score integer,
  duplicate boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict error
declare
  authenticated_user_id uuid := auth.uid();
  today_in_croatia date := (now() at time zone 'Europe/Zagreb')::date;
  attempt_row public.challenge_attempts%rowtype;
  attempt_token_row public.challenge_attempt_tokens%rowtype;
  saved_answer public.challenge_attempt_answers%rowtype;
  challenge_row public.daily_challenges%rowtype;
  actual_price_snapshot numeric(12,2);
  answered_count integer;
  calculated_score integer;
begin
  if authenticated_user_id is null then raise exception 'authentication_required'; end if;
  if p_challenge_date is distinct from today_in_croatia then
    raise exception 'challenge_date_must_be_today_in_europe_zagreb';
  end if;
  if p_question_position is null or p_question_position not between 1 and 5 then
    raise exception 'question_position_must_be_between_one_and_five';
  end if;
  if p_guess is null or p_guess <= 0 or p_guess > 1000000000 or scale(p_guess) > 2 then
    raise exception 'guess_must_be_a_positive_euro_amount_with_at_most_two_decimals';
  end if;
  if p_attempt_token is null or p_attempt_token !~ '^[0-9a-f]{64}$' then
    raise exception 'valid_challenge_attempt_token_required';
  end if;

  select challenge_attempts.* into attempt_row
  from public.challenge_attempts as challenge_attempts
  where challenge_attempts.user_id = authenticated_user_id
    and challenge_attempts.challenge_date = p_challenge_date
  for update;
  if not found or attempt_row.submitted_at is not null then
    raise exception 'challenge_attempt_not_found_or_invalid';
  end if;
  if now() >= attempt_row.expires_at then raise exception 'challenge_attempt_expired'; end if;

  select attempt_tokens.* into attempt_token_row
  from public.challenge_attempt_tokens as attempt_tokens
  where attempt_tokens.attempt_id = attempt_row.id
    and attempt_tokens.token_hash = encode(extensions.digest(p_attempt_token, 'sha256'), 'hex')
  for update;
  if not found or now() >= attempt_token_row.expires_at then
    raise exception 'challenge_attempt_token_expired_or_invalid';
  end if;

  select challenge_attempt_answers.* into saved_answer
  from public.challenge_attempt_answers as challenge_attempt_answers
  where challenge_attempt_answers.attempt_id = attempt_row.id
    and challenge_attempt_answers.question_position = p_question_position;
  if found then
    if saved_answer.guess <> p_guess then
      raise exception 'challenge_answer_already_recorded';
    end if;
    select challenge_questions.actual_price_snapshot into actual_price_snapshot
    from public.challenge_questions as challenge_questions
    where challenge_questions.challenge_id = attempt_row.challenge_id
      and challenge_questions.position = p_question_position;
    return query select p_question_position, saved_answer.guess::numeric,
      actual_price_snapshot::numeric, saved_answer.score, true;
    return;
  end if;

  select count(*) into answered_count
  from public.challenge_attempt_answers as challenge_attempt_answers
  where challenge_attempt_answers.attempt_id = attempt_row.id;
  if p_question_position <> answered_count + 1 then
    raise exception 'challenge_answers_must_be_submitted_in_order';
  end if;

  select daily_challenges.* into challenge_row
  from public.daily_challenges as daily_challenges
  where daily_challenges.id = attempt_row.challenge_id
    and daily_challenges.challenge_date = p_challenge_date
    and daily_challenges.published;
  if not found then raise exception 'challenge_not_available'; end if;

  select challenge_questions.actual_price_snapshot into actual_price_snapshot
  from public.challenge_questions as challenge_questions
  where challenge_questions.challenge_id = attempt_row.challenge_id
    and challenge_questions.position = p_question_position
    and challenge_questions.currency_snapshot = 'EUR'
    and challenge_questions.is_demo_snapshot = challenge_row.is_demo
    and (
      (challenge_row.is_demo and challenge_questions.verification_status_snapshot = 'unverified')
      or (not challenge_row.is_demo and challenge_questions.verification_status_snapshot = 'verified')
    );
  if not found or actual_price_snapshot is null or actual_price_snapshot <= 0 then
    raise exception 'challenge_question_data_is_invalid';
  end if;

  calculated_score := greatest(0, least(1000,
    round(1000 * exp(-4 * abs(p_guess::double precision - actual_price_snapshot::double precision)
      / actual_price_snapshot::double precision))::integer));
  insert into public.challenge_attempt_answers (attempt_id, question_position, guess, score)
  values (attempt_row.id, p_question_position, p_guess, calculated_score);

  return query select p_question_position, p_guess::numeric,
    actual_price_snapshot::numeric, calculated_score, false;
end;
$$;



revoke all on function public.get_daily_attempt_progress(date) from public, anon, authenticated;
revoke all on function public.submit_daily_answer(date, smallint, numeric, text) from public, anon, authenticated;
grant execute on function public.get_daily_attempt_progress(date) to authenticated;
grant execute on function public.submit_daily_answer(date, smallint, numeric, text) to authenticated;
