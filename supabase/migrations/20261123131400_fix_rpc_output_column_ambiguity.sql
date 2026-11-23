-- Apply this hotfix to databases where the original Phase 2 migration is already installed.
-- CREATE OR REPLACE preserves the existing function grants.

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

    with candidates as (
      select distinct on (questions.category)
        questions.id, questions.category, questions.actual_price, questions.currency,
        questions.is_demo, questions.verification_status,
        md5(today_in_croatia::text || ':' || questions.id) as stable_order
      from public.questions as questions
      where questions.active
        and (
          (not challenge_row.is_demo and not questions.is_demo and questions.verification_status = 'verified')
          or (challenge_row.is_demo and questions.is_demo and questions.verification_status = 'unverified')
        )
      order by questions.category, md5(today_in_croatia::text || ':' || questions.id)
    ), selected as (
      select
        candidates.id, candidates.actual_price, candidates.currency,
        candidates.is_demo, candidates.verification_status,
        row_number() over (order by candidates.stable_order, candidates.id)::smallint as position
      from candidates
      order by candidates.stable_order, candidates.id
      limit 5
    )
    insert into public.challenge_questions (
      challenge_id, question_id, position, actual_price_snapshot,
      currency_snapshot, is_demo_snapshot, verification_status_snapshot
    )
    select
      challenge_row.id, selected.id, selected.position, selected.actual_price,
      selected.currency, selected.is_demo, selected.verification_status
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

create or replace function public.start_daily_attempt(p_challenge_date date)
returns table (attempt_token text, challenge_id uuid, challenge_date date)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict error
declare
  authenticated_user_id uuid := auth.uid();
  today_in_croatia date := (now() at time zone 'Europe/Zagreb')::date;
  challenge_row public.daily_challenges%rowtype;
  attempt_row public.challenge_attempts%rowtype;
  new_token text;
begin
  if authenticated_user_id is null then raise exception 'authentication_required'; end if;
  if p_challenge_date is distinct from today_in_croatia then
    raise exception 'challenge_date_must_be_today_in_europe_zagreb';
  end if;

  perform * from public.get_today_challenge();
  select daily_challenges.* into challenge_row
  from public.daily_challenges as daily_challenges
  where daily_challenges.challenge_date = today_in_croatia
    and daily_challenges.published;
  if not found then raise exception 'challenge_not_available'; end if;

  insert into public.challenge_attempts (user_id, challenge_id, challenge_date)
  values (authenticated_user_id, challenge_row.id, today_in_croatia)
  on conflict on constraint challenge_attempts_user_id_challenge_id_key do nothing;

  select challenge_attempts.* into attempt_row
  from public.challenge_attempts as challenge_attempts
  where challenge_attempts.user_id = authenticated_user_id
    and challenge_attempts.challenge_id = challenge_row.id
  for update;
  if attempt_row.submitted_at is not null then
    raise exception 'challenge_attempt_already_submitted';
  end if;
  if now() >= attempt_row.expires_at then
    raise exception 'challenge_attempt_expired';
  end if;

  new_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.challenge_attempt_tokens (attempt_id, token_hash, expires_at)
  values (
    attempt_row.id,
    encode(extensions.digest(new_token, 'sha256'), 'hex'),
    least(attempt_row.expires_at, now() + interval '24 hours')
  );

  return query select new_token as attempt_token,
    challenge_row.id as challenge_id,
    challenge_row.challenge_date as challenge_date;
end;
$$;

create or replace function public.submit_daily_result(p_challenge_date date, p_guesses numeric[], p_attempt_token text)
returns table (
  result_id uuid,
  total_score integer,
  question_scores integer[],
  exact_guesses smallint,
  average_error_percent numeric,
  current_streak integer,
  best_streak integer,
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
  challenge_row public.daily_challenges%rowtype;
  existing_result public.game_results%rowtype;
  attempt_row public.challenge_attempts%rowtype;
  attempt_token_row public.challenge_attempt_tokens%rowtype;
  stats public.user_statistics%rowtype;
  actual_prices numeric(12,2)[] := array[]::numeric(12,2)[];
  calculated_scores integer[] := array[]::integer[];
  error_sum double precision := 0;
  score_sum integer := 0;
  exact_count smallint := 0;
  relative_error double precision;
  next_streak integer;
  i integer;
begin
  if authenticated_user_id is null then raise exception 'authentication_required'; end if;
  if p_challenge_date is distinct from today_in_croatia then
    raise exception 'challenge_date_must_be_today_in_europe_zagreb';
  end if;
  if p_attempt_token is null or p_attempt_token !~ '^[0-9a-f]{64}$' then
    raise exception 'valid_challenge_attempt_token_required';
  end if;
  if p_guesses is null or array_ndims(p_guesses) <> 1
    or array_lower(p_guesses, 1) <> 1 or array_upper(p_guesses, 1) <> 5 then
    raise exception 'exactly_five_guesses_required';
  end if;

  for i in 1..5 loop
    if p_guesses[i] is null or p_guesses[i] <= 0 or p_guesses[i] > 1000000000 then
      raise exception 'guesses_must_be_positive_euro_amounts';
    end if;
    if scale(p_guesses[i]) > 2 then
      raise exception 'guesses_must_have_at_most_two_decimal_places';
    end if;
  end loop;

  perform * from public.get_today_challenge();
  select daily_challenges.* into challenge_row
  from public.daily_challenges as daily_challenges
  where daily_challenges.challenge_date = today_in_croatia
    and daily_challenges.published;
  if not found then raise exception 'challenge_not_available'; end if;

  select challenge_attempts.* into attempt_row
  from public.challenge_attempts as challenge_attempts
  where challenge_attempts.user_id = authenticated_user_id
    and challenge_attempts.challenge_id = challenge_row.id
  for update;
  if not found or attempt_row.challenge_date <> p_challenge_date then
    raise exception 'challenge_attempt_not_found_or_invalid';
  end if;
  select attempt_tokens.* into attempt_token_row
  from public.challenge_attempt_tokens as attempt_tokens
  where attempt_tokens.attempt_id = attempt_row.id
    and attempt_tokens.token_hash = encode(extensions.digest(p_attempt_token, 'sha256'), 'hex')
  for update;
  if not found or now() >= attempt_token_row.expires_at then
    raise exception 'challenge_attempt_token_expired_or_invalid';
  end if;

  insert into public.user_statistics (user_id)
  values (authenticated_user_id) on conflict on constraint user_statistics_pkey do nothing;
  select user_statistics.* into stats
  from public.user_statistics as user_statistics
  where user_statistics.user_id = authenticated_user_id
  for update;
  select game_results.* into existing_result
  from public.game_results as game_results
  where game_results.user_id = authenticated_user_id
    and game_results.challenge_id = challenge_row.id;
  if attempt_row.submitted_at is not null then
    if not found then raise exception 'challenge_attempt_already_submitted'; end if;
    return query select existing_result.id as result_id,
      existing_result.total_score as total_score,
      existing_result.question_scores as question_scores,
      existing_result.exact_guesses as exact_guesses,
      existing_result.average_error_percent as average_error_percent,
      stats.current_streak as current_streak,
      stats.best_streak as best_streak,
      true as duplicate;
    return;
  end if;
  if found then
    update public.challenge_attempts as challenge_attempts
    set submitted_at = now()
    where challenge_attempts.id = attempt_row.id;
    return query select existing_result.id as result_id,
      existing_result.total_score as total_score,
      existing_result.question_scores as question_scores,
      existing_result.exact_guesses as exact_guesses,
      existing_result.average_error_percent as average_error_percent,
      stats.current_streak as current_streak,
      stats.best_streak as best_streak,
      true as duplicate;
    return;
  end if;
  if now() < attempt_row.started_at + interval '10 seconds' then
    raise exception 'challenge_attempt_submitted_too_soon';
  end if;
  if now() >= attempt_row.expires_at then raise exception 'challenge_attempt_expired'; end if;

  select array_agg(challenge_questions.actual_price_snapshot order by challenge_questions.position)
    into actual_prices
  from public.challenge_questions as challenge_questions
  where challenge_questions.challenge_id = challenge_row.id
    and challenge_questions.currency_snapshot = 'EUR'
    and challenge_questions.is_demo_snapshot = challenge_row.is_demo
    and (
      (challenge_row.is_demo and challenge_questions.verification_status_snapshot = 'unverified')
      or (not challenge_row.is_demo and challenge_questions.verification_status_snapshot = 'verified')
    );
  if actual_prices is null or cardinality(actual_prices) <> 5 then
    raise exception 'challenge_question_data_is_invalid';
  end if;

  for i in 1..5 loop
    relative_error := abs(p_guesses[i]::double precision - actual_prices[i]::double precision)
      / actual_prices[i]::double precision;
    calculated_scores := array_append(calculated_scores,
      greatest(0, least(1000, round(1000 * exp(-4 * relative_error))::integer)));
    score_sum := score_sum + calculated_scores[i];
    error_sum := error_sum + relative_error;
    if p_guesses[i] = actual_prices[i] then exact_count := exact_count + 1; end if;
  end loop;

  if stats.last_completed_date is null then next_streak := 1;
  elsif stats.last_completed_date = today_in_croatia - 1 then next_streak := stats.current_streak + 1;
  else next_streak := 1;
  end if;

  insert into public.game_results as inserted_result (
    user_id, challenge_id, challenge_date, total_score, guesses, question_scores,
    exact_guesses, average_error_percent
  ) values (
    authenticated_user_id, challenge_row.id, today_in_croatia, score_sum, p_guesses, calculated_scores,
    exact_count, round(((error_sum / 5) * 100)::numeric, 2)
  ) returning inserted_result.id into result_id;

  update public.user_statistics as user_statistics set
    current_streak = next_streak,
    best_streak = greatest(stats.best_streak, next_streak),
    last_completed_date = today_in_croatia,
    total_games = stats.total_games + 1,
    total_points = stats.total_points + score_sum,
    best_score = greatest(stats.best_score, score_sum),
    exact_guesses = stats.exact_guesses + exact_count,
    updated_at = now()
  where user_statistics.user_id = authenticated_user_id
  returning user_statistics.* into stats;

  update public.challenge_attempts as challenge_attempts
  set submitted_at = now()
  where challenge_attempts.id = attempt_row.id;

  return query select result_id as result_id,
    score_sum as total_score,
    calculated_scores as question_scores,
    exact_count as exact_guesses,
    round(((error_sum / 5) * 100)::numeric, 2) as average_error_percent,
    stats.current_streak as current_streak,
    stats.best_streak as best_streak,
    false as duplicate;
end;
$$;
