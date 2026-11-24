begin;

create table if not exists public.gameplay_settings (
  singleton boolean primary key default true check (singleton),
  timed_gameplay_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.gameplay_settings (singleton, timed_gameplay_enabled)
values (true, false)
on conflict (singleton) do nothing;

alter table public.gameplay_settings enable row level security;
revoke all on public.gameplay_settings from public, anon, authenticated;

alter table public.challenge_attempts
  add column ruleset text not null default 'untimed-v1';
alter table public.challenge_attempts
  add constraint challenge_attempts_ruleset_check
  check (ruleset in ('untimed-v1', 'timed-v1'));

create table public.challenge_attempt_questions (
  attempt_id uuid not null references public.challenge_attempts(id) on delete cascade,
  question_position smallint not null check (question_position between 1 and 5),
  status text not null check (status in ('active', 'answered', 'timed_out')),
  started_at timestamptz not null,
  deadline_at timestamptz not null,
  resolved_at timestamptz,
  guess numeric(12,2),
  score integer,
  primary key (attempt_id, question_position),
  check (deadline_at = started_at + interval '20 seconds'),
  check (
    (status = 'active' and resolved_at is null and guess is null and score is null)
    or (status = 'answered' and resolved_at is not null and guess > 0 and guess <= 1000000000 and score between 0 and 1000)
    or (status = 'timed_out' and resolved_at is not null and guess is null and score = 0)
  ),
  check (resolved_at is null or resolved_at >= started_at)
);

create unique index challenge_attempt_questions_one_active_idx
  on public.challenge_attempt_questions (attempt_id)
  where status = 'active';

alter table public.challenge_attempt_questions enable row level security;
revoke all on public.challenge_attempt_questions from public, anon, authenticated;

alter table public.game_results
  drop constraint if exists game_results_guesses_check;
alter table public.game_results
  add constraint game_results_guesses_shape_check
  check (
    array_ndims(guesses) = 1
    and array_lower(guesses, 1) = 1
    and array_upper(guesses, 1) = 5
    and 0 < all(guesses)
    and 1000000000 >= all(guesses)
  );
alter table public.game_results
  alter column average_error_percent drop not null;
alter table public.game_results
  drop constraint if exists game_results_average_error_percent_check;
alter table public.game_results
  add constraint game_results_average_error_percent_check
  check (average_error_percent is null or average_error_percent >= 0);

do $type$
begin
  create type public.cifra_timed_question_result as (
    question_position smallint,
    question_id text,
    question_text text,
    item_name text,
    category text,
    unit text,
    location text,
    outcome text,
    started_at timestamptz,
    deadline_at timestamptz,
    server_now timestamptz,
    guess numeric,
    actual_price numeric,
    question_score integer,
    explanation text,
    duplicate boolean
  );
exception
  when duplicate_object then null;
end;
$type$;

create or replace function public.prevent_attempt_ruleset_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict error
begin
  if new.ruleset is distinct from old.ruleset then
    raise exception 'challenge_attempt_ruleset_is_immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_attempt_ruleset_change on public.challenge_attempts;
create trigger prevent_attempt_ruleset_change
  before update on public.challenge_attempts
  for each row execute procedure public.prevent_attempt_ruleset_change();

create or replace function public.require_timed_ruleset_when_enabled()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict error
declare
  v_timed_enabled boolean;
begin
  select settings.timed_gameplay_enabled
  into v_timed_enabled
  from public.gameplay_settings as settings
  where settings.singleton;

  if coalesce(v_timed_enabled, false) and new.ruleset <> 'timed-v1' then
    raise exception 'timed_gameplay_required';
  end if;
  return new;
end;
$$;

drop trigger if exists require_timed_ruleset_when_enabled on public.challenge_attempts;
create trigger require_timed_ruleset_when_enabled
  before insert on public.challenge_attempts
  for each row execute procedure public.require_timed_ruleset_when_enabled();

create or replace function public.prevent_timed_answer_without_resolution()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict error
declare
  v_ruleset text;
  v_question public.challenge_attempt_questions%rowtype;
begin
  select attempts.ruleset
  into v_ruleset
  from public.challenge_attempts as attempts
  where attempts.id = new.attempt_id;

  if v_ruleset = 'timed-v1' then
    select timed_questions.*
    into v_question
    from public.challenge_attempt_questions as timed_questions
    where timed_questions.attempt_id = new.attempt_id
      and timed_questions.question_position = new.question_position;

    if not found
      or v_question.status <> 'answered'
      or v_question.guess is distinct from new.guess
      or v_question.score is distinct from new.score then
      raise exception 'timed_answer_requires_server_accepted_question';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_timed_answer_without_resolution on public.challenge_attempt_answers;
create trigger prevent_timed_answer_without_resolution
  before insert on public.challenge_attempt_answers
  for each row execute procedure public.prevent_timed_answer_without_resolution();

create or replace function public._get_timed_question_state(
  p_attempt_id uuid,
  p_question_position smallint,
  p_duplicate boolean default false
)
returns setof public.cifra_timed_question_result
language sql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select
    timed_questions.question_position,
    challenge_questions.question_id,
    questions.question,
    questions.item_name,
    questions.category,
    questions.unit,
    questions.location,
    timed_questions.status,
    timed_questions.started_at,
    timed_questions.deadline_at,
    clock_timestamp(),
    case when timed_questions.status = 'answered' then timed_questions.guess else null end,
    case when timed_questions.status <> 'active' then challenge_questions.actual_price_snapshot else null end,
    timed_questions.score,
    case when timed_questions.status <> 'active' then questions.explanation else null end,
    p_duplicate
  from public.challenge_attempt_questions as timed_questions
  join public.challenge_attempts as attempts
    on attempts.id = timed_questions.attempt_id
  join public.challenge_questions as challenge_questions
    on challenge_questions.challenge_id = attempts.challenge_id
    and challenge_questions.position = timed_questions.question_position
  join public.questions as questions
    on questions.id = challenge_questions.question_id
  where timed_questions.attempt_id = p_attempt_id
    and timed_questions.question_position = p_question_position;
$$;

create or replace function public.get_public_timed_gameplay_enabled()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce((
    select settings.timed_gameplay_enabled
    from public.gameplay_settings as settings
    where settings.singleton
  ), false);
$$;

create or replace function public.get_today_game_mode(p_challenge_date date)
returns table (
  timed_enabled boolean,
  challenge_id uuid,
  challenge_date date,
  is_demo boolean,
  attempt_ruleset text,
  has_result boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict error
declare
  v_user_id uuid := auth.uid();
  v_today date := (clock_timestamp() at time zone 'Europe/Zagreb')::date;
  v_challenge_id uuid;
  v_is_demo boolean;
  v_timed_enabled boolean;
  v_ruleset text;
  v_has_result boolean;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  if p_challenge_date is distinct from v_today then
    raise exception 'challenge_date_must_be_today_in_europe_zagreb';
  end if;

  perform * from public.get_today_challenge();

  select daily_challenges.id, daily_challenges.is_demo
  into v_challenge_id, v_is_demo
  from public.daily_challenges as daily_challenges
  where daily_challenges.challenge_date = p_challenge_date
    and daily_challenges.published;
  if not found then raise exception 'challenge_not_available'; end if;

  select settings.timed_gameplay_enabled
  into v_timed_enabled
  from public.gameplay_settings as settings
  where settings.singleton;
  select attempts.ruleset
  into v_ruleset
  from public.challenge_attempts as attempts
  where attempts.user_id = v_user_id
    and attempts.challenge_id = v_challenge_id;
  select exists (
    select 1
    from public.game_results as results
    where results.user_id = v_user_id
      and results.challenge_id = v_challenge_id
  ) into v_has_result;

  return query select coalesce(v_timed_enabled, false), v_challenge_id,
    p_challenge_date, v_is_demo, v_ruleset, v_has_result;
end;
$$;

create or replace function public.get_timed_attempt_progress(p_challenge_date date)
returns setof public.cifra_timed_question_result
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict error
declare
  v_user_id uuid := auth.uid();
  v_today date := (clock_timestamp() at time zone 'Europe/Zagreb')::date;
  v_attempt_id uuid;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  if p_challenge_date is distinct from v_today then
    raise exception 'challenge_date_must_be_today_in_europe_zagreb';
  end if;

  select attempts.id
  into v_attempt_id
  from public.challenge_attempts as attempts
  where attempts.user_id = v_user_id
    and attempts.challenge_date = p_challenge_date
    and attempts.ruleset = 'timed-v1';

  if v_attempt_id is null then return; end if;

  return query
    select response.*
    from public.challenge_attempt_questions as timed_questions
    cross join lateral public._get_timed_question_state(
      v_attempt_id, timed_questions.question_position, false
    ) as response
    where timed_questions.attempt_id = v_attempt_id
    order by timed_questions.question_position;
end;
$$;

create or replace function public.start_timed_daily_attempt(p_challenge_date date)
returns table (
  attempt_token text,
  question_position smallint,
  question_id text,
  question_text text,
  item_name text,
  category text,
  unit text,
  location text,
  outcome text,
  started_at timestamptz,
  deadline_at timestamptz,
  server_now timestamptz,
  guess numeric,
  actual_price numeric,
  question_score integer,
  explanation text,
  duplicate boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict error
declare
  v_user_id uuid := auth.uid();
  v_today date := (clock_timestamp() at time zone 'Europe/Zagreb')::date;
  v_challenge public.daily_challenges%rowtype;
  v_attempt public.challenge_attempts%rowtype;
  v_timed_enabled boolean;
  v_token text;
  v_now timestamptz;
  v_position smallint;
  v_response public.cifra_timed_question_result;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  if p_challenge_date is distinct from v_today then
    raise exception 'challenge_date_must_be_today_in_europe_zagreb';
  end if;

  perform * from public.get_today_challenge();
  select daily_challenges.*
  into v_challenge
  from public.daily_challenges as daily_challenges
  where daily_challenges.challenge_date = p_challenge_date
    and daily_challenges.published;
  if not found then raise exception 'challenge_not_available'; end if;

  select attempts.*
  into v_attempt
  from public.challenge_attempts as attempts
  where attempts.user_id = v_user_id
    and attempts.challenge_id = v_challenge.id
  for update;

  if not found then
    select settings.timed_gameplay_enabled
    into v_timed_enabled
    from public.gameplay_settings as settings
    where settings.singleton;
    if not coalesce(v_timed_enabled, false) then
      raise exception 'timed_gameplay_disabled';
    end if;
    v_now := clock_timestamp();
    insert into public.challenge_attempts (
      user_id, challenge_id, challenge_date, started_at, expires_at, ruleset
    ) values (
      v_user_id, v_challenge.id, p_challenge_date, v_now, v_now + interval '24 hours', 'timed-v1'
    )
    on conflict (user_id, challenge_date) do nothing;
    select attempts.*
    into v_attempt
    from public.challenge_attempts as attempts
    where attempts.user_id = v_user_id
      and attempts.challenge_id = v_challenge.id
    for update;
  end if;

  if v_attempt.ruleset <> 'timed-v1' then
    raise exception 'legacy_attempt_requires_legacy_flow';
  end if;
  if v_attempt.submitted_at is not null then raise exception 'challenge_attempt_already_submitted'; end if;
  v_now := clock_timestamp();
  if v_now >= v_attempt.expires_at then raise exception 'challenge_attempt_expired'; end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.challenge_attempt_tokens (attempt_id, token_hash, expires_at)
  values (
    v_attempt.id,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    least(v_attempt.expires_at, v_now + interval '24 hours')
  );

  select max(timed_questions.question_position)
  into v_position
  from public.challenge_attempt_questions as timed_questions
  where timed_questions.attempt_id = v_attempt.id;
  if v_position is null then
    v_now := clock_timestamp();
    insert into public.challenge_attempt_questions (
      attempt_id, question_position, status, started_at, deadline_at
    ) values (
      v_attempt.id, 1, 'active', v_now, v_now + interval '20 seconds'
    );
    v_position := 1;
  end if;

  select response.*
  into v_response
  from public._get_timed_question_state(v_attempt.id, v_position, false) as response;
  if not found then raise exception 'timed_question_state_is_invalid'; end if;

  return query select v_token, v_response.question_position, v_response.question_id,
    v_response.question_text, v_response.item_name, v_response.category, v_response.unit,
    v_response.location, v_response.outcome, v_response.started_at, v_response.deadline_at,
    v_response.server_now, v_response.guess, v_response.actual_price, v_response.question_score,
    v_response.explanation, v_response.duplicate;
end;
$$;

create or replace function public.start_timed_question(
  p_challenge_date date,
  p_question_position smallint,
  p_attempt_token text
)
returns setof public.cifra_timed_question_result
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict error
declare
  v_user_id uuid := auth.uid();
  v_today date := (clock_timestamp() at time zone 'Europe/Zagreb')::date;
  v_attempt public.challenge_attempts%rowtype;
  v_question public.challenge_attempt_questions%rowtype;
  v_token_exists boolean;
  v_existing_count integer;
  v_now timestamptz;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  if p_challenge_date is distinct from v_today then
    raise exception 'challenge_date_must_be_today_in_europe_zagreb';
  end if;
  if p_question_position is null or p_question_position not between 1 and 5 then
    raise exception 'question_position_must_be_between_one_and_five';
  end if;
  if p_attempt_token is null or p_attempt_token !~ '^[0-9a-f]{64}$' then
    raise exception 'valid_challenge_attempt_token_required';
  end if;

  select attempts.*
  into v_attempt
  from public.challenge_attempts as attempts
  where attempts.user_id = v_user_id
    and attempts.challenge_date = p_challenge_date
  for update;
  if not found or v_attempt.ruleset <> 'timed-v1' or v_attempt.submitted_at is not null then
    raise exception 'timed_challenge_attempt_not_found_or_invalid';
  end if;
  v_now := clock_timestamp();
  if v_now >= v_attempt.expires_at then raise exception 'challenge_attempt_expired'; end if;

  select exists (
    select 1 from public.challenge_attempt_tokens as tokens
    where tokens.attempt_id = v_attempt.id
      and tokens.token_hash = encode(extensions.digest(p_attempt_token, 'sha256'), 'hex')
      and tokens.expires_at > v_now
  ) into v_token_exists;
  if not v_token_exists then raise exception 'challenge_attempt_token_expired_or_invalid'; end if;

  select timed_questions.*
  into v_question
  from public.challenge_attempt_questions as timed_questions
  where timed_questions.attempt_id = v_attempt.id
    and timed_questions.question_position = p_question_position
  for update;
  if found then
    return query select response.*
    from public._get_timed_question_state(v_attempt.id, p_question_position, true) as response;
    return;
  end if;

  select count(*)::integer
  into v_existing_count
  from public.challenge_attempt_questions as timed_questions
  where timed_questions.attempt_id = v_attempt.id;
  if p_question_position <> v_existing_count + 1 then
    raise exception 'timed_questions_must_be_started_in_order';
  end if;
  if v_existing_count > 0 then
    select timed_questions.*
    into v_question
    from public.challenge_attempt_questions as timed_questions
    where timed_questions.attempt_id = v_attempt.id
      and timed_questions.question_position = v_existing_count
    for update;
    if not found or v_question.status = 'active' then
      raise exception 'previous_timed_question_must_be_resolved';
    end if;
  end if;

  v_now := clock_timestamp();
  insert into public.challenge_attempt_questions (
    attempt_id, question_position, status, started_at, deadline_at
  ) values (
    v_attempt.id, p_question_position, 'active', v_now, v_now + interval '20 seconds'
  );

  return query select response.*
  from public._get_timed_question_state(v_attempt.id, p_question_position, false) as response;
end;
$$;

create or replace function public.submit_timed_answer(
  p_challenge_date date,
  p_question_position smallint,
  p_guess numeric,
  p_attempt_token text
)
returns setof public.cifra_timed_question_result
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict error
declare
  v_user_id uuid := auth.uid();
  v_today date := (clock_timestamp() at time zone 'Europe/Zagreb')::date;
  v_attempt public.challenge_attempts%rowtype;
  v_question public.challenge_attempt_questions%rowtype;
  v_challenge public.daily_challenges%rowtype;
  v_actual_price numeric(12,2);
  v_score integer;
  v_now timestamptz;
  v_token_exists boolean;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  if p_challenge_date is distinct from v_today then
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

  select attempts.*
  into v_attempt
  from public.challenge_attempts as attempts
  where attempts.user_id = v_user_id
    and attempts.challenge_date = p_challenge_date
  for update;
  if not found or v_attempt.ruleset <> 'timed-v1' or v_attempt.submitted_at is not null then
    raise exception 'timed_challenge_attempt_not_found_or_invalid';
  end if;
  v_now := clock_timestamp();
  if v_now >= v_attempt.expires_at then raise exception 'challenge_attempt_expired'; end if;

  select exists (
    select 1 from public.challenge_attempt_tokens as tokens
    where tokens.attempt_id = v_attempt.id
      and tokens.token_hash = encode(extensions.digest(p_attempt_token, 'sha256'), 'hex')
      and tokens.expires_at > v_now
  ) into v_token_exists;
  if not v_token_exists then raise exception 'challenge_attempt_token_expired_or_invalid'; end if;

  select timed_questions.*
  into v_question
  from public.challenge_attempt_questions as timed_questions
  where timed_questions.attempt_id = v_attempt.id
    and timed_questions.question_position = p_question_position
  for update;
  if not found then raise exception 'timed_question_not_started'; end if;
  if v_question.status = 'answered' then
    if v_question.guess is distinct from p_guess then
      raise exception 'timed_answer_already_recorded';
    end if;
    return query select response.*
    from public._get_timed_question_state(v_attempt.id, p_question_position, true) as response;
    return;
  end if;
  if v_question.status = 'timed_out' then raise exception 'timed_question_already_timed_out'; end if;
  if v_now >= v_question.deadline_at then raise exception 'timed_question_deadline_passed'; end if;

  select challenges.*
  into v_challenge
  from public.daily_challenges as challenges
  where challenges.id = v_attempt.challenge_id
    and challenges.challenge_date = p_challenge_date
    and challenges.published;
  if not found then raise exception 'challenge_not_available'; end if;

  select challenge_questions.actual_price_snapshot
  into v_actual_price
  from public.challenge_questions as challenge_questions
  where challenge_questions.challenge_id = v_attempt.challenge_id
    and challenge_questions.position = p_question_position
    and challenge_questions.currency_snapshot = 'EUR'
    and challenge_questions.is_demo_snapshot = v_challenge.is_demo
    and (
      (v_challenge.is_demo and challenge_questions.verification_status_snapshot = 'unverified')
      or (not v_challenge.is_demo and challenge_questions.verification_status_snapshot = 'verified')
    );
  if not found or v_actual_price is null or v_actual_price <= 0 then
    raise exception 'challenge_question_data_is_invalid';
  end if;

  v_score := greatest(0, least(1000,
    round(1000 * exp(-4 * abs(p_guess::double precision - v_actual_price::double precision)
      / v_actual_price::double precision))::integer));
  v_now := clock_timestamp();
  update public.challenge_attempt_questions as timed_questions
  set status = 'answered', resolved_at = v_now, guess = p_guess, score = v_score
  where timed_questions.attempt_id = v_attempt.id
    and timed_questions.question_position = p_question_position;

  insert into public.challenge_attempt_answers (attempt_id, question_position, guess, score)
  values (v_attempt.id, p_question_position, p_guess, v_score);

  return query select response.*
  from public._get_timed_question_state(v_attempt.id, p_question_position, false) as response;
end;
$$;

create or replace function public.expire_timed_question(
  p_challenge_date date,
  p_question_position smallint,
  p_attempt_token text
)
returns setof public.cifra_timed_question_result
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict error
declare
  v_user_id uuid := auth.uid();
  v_today date := (clock_timestamp() at time zone 'Europe/Zagreb')::date;
  v_attempt public.challenge_attempts%rowtype;
  v_question public.challenge_attempt_questions%rowtype;
  v_now timestamptz;
  v_token_exists boolean;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  if p_challenge_date is distinct from v_today then
    raise exception 'challenge_date_must_be_today_in_europe_zagreb';
  end if;
  if p_question_position is null or p_question_position not between 1 and 5 then
    raise exception 'question_position_must_be_between_one_and_five';
  end if;
  if p_attempt_token is null or p_attempt_token !~ '^[0-9a-f]{64}$' then
    raise exception 'valid_challenge_attempt_token_required';
  end if;

  select attempts.*
  into v_attempt
  from public.challenge_attempts as attempts
  where attempts.user_id = v_user_id
    and attempts.challenge_date = p_challenge_date
  for update;
  if not found or v_attempt.ruleset <> 'timed-v1' or v_attempt.submitted_at is not null then
    raise exception 'timed_challenge_attempt_not_found_or_invalid';
  end if;
  v_now := clock_timestamp();
  if v_now >= v_attempt.expires_at then raise exception 'challenge_attempt_expired'; end if;

  select exists (
    select 1 from public.challenge_attempt_tokens as tokens
    where tokens.attempt_id = v_attempt.id
      and tokens.token_hash = encode(extensions.digest(p_attempt_token, 'sha256'), 'hex')
      and tokens.expires_at > v_now
  ) into v_token_exists;
  if not v_token_exists then raise exception 'challenge_attempt_token_expired_or_invalid'; end if;

  select timed_questions.*
  into v_question
  from public.challenge_attempt_questions as timed_questions
  where timed_questions.attempt_id = v_attempt.id
    and timed_questions.question_position = p_question_position
  for update;
  if not found then raise exception 'timed_question_not_started'; end if;
  if v_question.status <> 'active' then
    return query select response.*
    from public._get_timed_question_state(v_attempt.id, p_question_position, true) as response;
    return;
  end if;
  if v_now < v_question.deadline_at then raise exception 'timed_question_deadline_not_reached'; end if;

  update public.challenge_attempt_questions as timed_questions
  set status = 'timed_out', resolved_at = v_now, guess = null, score = 0
  where timed_questions.attempt_id = v_attempt.id
    and timed_questions.question_position = p_question_position;

  return query select response.*
  from public._get_timed_question_state(v_attempt.id, p_question_position, false) as response;
end;
$$;

create or replace function public.require_timed_result_matches_lifecycle()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict error
declare
  v_attempt_id uuid;
  v_ruleset text;
  v_question_count integer;
  v_resolved_count integer;
  v_accepted_guesses numeric[];
  v_accepted_scores integer[];
  v_answer_count integer;
  v_answer_mismatch_count integer;
begin
  select attempts.id, attempts.ruleset
  into v_attempt_id, v_ruleset
  from public.challenge_attempts as attempts
  where attempts.user_id = new.user_id
    and attempts.challenge_id = new.challenge_id
  for update;
  if not found then raise exception 'challenge_attempt_not_found_or_invalid'; end if;
  if v_ruleset <> 'timed-v1' then return new; end if;

  select count(*)::integer,
    count(*) filter (where timed_questions.status in ('answered', 'timed_out'))::integer,
    array_agg(
      case when timed_questions.status = 'answered' then timed_questions.guess else null end
      order by timed_questions.question_position
    ),
    array_agg(timed_questions.score order by timed_questions.question_position)
  into v_question_count, v_resolved_count, v_accepted_guesses, v_accepted_scores
  from public.challenge_attempt_questions as timed_questions
  where timed_questions.attempt_id = v_attempt_id;

  select count(*)::integer,
    count(*) filter (
      where timed_questions.status is distinct from 'answered'
        or timed_questions.guess is distinct from answers.guess
        or timed_questions.score is distinct from answers.score
    )::integer
  into v_answer_count, v_answer_mismatch_count
  from public.challenge_attempt_answers as answers
  join public.challenge_attempt_questions as timed_questions
    on timed_questions.attempt_id = answers.attempt_id
    and timed_questions.question_position = answers.question_position
  where answers.attempt_id = v_attempt_id;

  if v_question_count <> 5 or v_resolved_count <> 5
    or v_answer_count <> (select count(*) from public.challenge_attempt_questions as timed_questions
      where timed_questions.attempt_id = v_attempt_id and timed_questions.status = 'answered')
    or v_answer_mismatch_count <> 0
    or v_accepted_guesses is distinct from new.guesses
    or v_accepted_scores is distinct from new.question_scores then
    raise exception 'timed_game_result_requires_five_server_resolved_questions';
  end if;
  return new;
end;
$$;

drop trigger if exists require_timed_result_matches_lifecycle on public.game_results;
create trigger require_timed_result_matches_lifecycle
  before insert on public.game_results
  for each row execute procedure public.require_timed_result_matches_lifecycle();

create or replace function public.require_accepted_answers_for_game_result()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict error
declare
  v_attempt_id uuid;
  v_ruleset text;
  v_accepted_guesses numeric[];
  v_accepted_scores integer[];
  v_answer_count integer;
  v_resolved_count integer;
begin
  select attempts.id, attempts.ruleset
  into v_attempt_id, v_ruleset
  from public.challenge_attempts as attempts
  where attempts.user_id = new.user_id
    and attempts.challenge_id = new.challenge_id
  for update;
  if not found then raise exception 'challenge_attempt_not_found_or_invalid'; end if;

  if v_ruleset = 'timed-v1' then
    select count(*)::integer,
      count(*) filter (where timed_questions.status in ('answered', 'timed_out'))::integer,
      array_agg(
        case when timed_questions.status = 'answered' then timed_questions.guess else null end
        order by timed_questions.question_position
      ),
      array_agg(timed_questions.score order by timed_questions.question_position)
    into v_answer_count, v_resolved_count, v_accepted_guesses, v_accepted_scores
    from public.challenge_attempt_questions as timed_questions
    where timed_questions.attempt_id = v_attempt_id;

    if v_answer_count <> 5 or v_resolved_count <> 5
      or v_accepted_guesses is distinct from new.guesses
      or v_accepted_scores is distinct from new.question_scores then
      raise exception 'game_result_requires_five_server_resolved_answers';
    end if;
  else
    select count(*)::integer,
      array_agg(answers.guess order by answers.question_position),
      array_agg(answers.score order by answers.question_position)
    into v_answer_count, v_accepted_guesses, v_accepted_scores
    from public.challenge_attempt_answers as answers
    where answers.attempt_id = v_attempt_id;

    if v_answer_count <> 5
      or v_accepted_guesses is distinct from new.guesses
      or v_accepted_scores is distinct from new.question_scores then
      raise exception 'game_result_requires_five_server_accepted_answers';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.submit_timed_daily_result(
  p_challenge_date date,
  p_attempt_token text
)
returns table (
  result_id uuid,
  total_score integer,
  question_scores integer[],
  guesses numeric[],
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
  v_user_id uuid := auth.uid();
  v_today date := (clock_timestamp() at time zone 'Europe/Zagreb')::date;
  v_attempt public.challenge_attempts%rowtype;
  v_challenge public.daily_challenges%rowtype;
  v_token_exists boolean;
  v_now timestamptz;
  v_question_count integer;
  v_resolved_count integer;
  v_guesses numeric[];
  v_scores integer[];
  v_score_sum integer;
  v_exact_count smallint;
  v_average_error numeric;
  v_stats public.user_statistics%rowtype;
  v_existing public.game_results%rowtype;
  v_next_streak integer;
begin
  if v_user_id is null then raise exception 'authentication_required'; end if;
  if p_challenge_date is distinct from v_today then
    raise exception 'challenge_date_must_be_today_in_europe_zagreb';
  end if;
  if p_attempt_token is null or p_attempt_token !~ '^[0-9a-f]{64}$' then
    raise exception 'valid_challenge_attempt_token_required';
  end if;

  select attempts.*
  into v_attempt
  from public.challenge_attempts as attempts
  where attempts.user_id = v_user_id
    and attempts.challenge_date = p_challenge_date
  for update;
  if not found or v_attempt.ruleset <> 'timed-v1' then
    raise exception 'timed_challenge_attempt_not_found_or_invalid';
  end if;
  v_now := clock_timestamp();
  if v_now >= v_attempt.expires_at then raise exception 'challenge_attempt_expired'; end if;
  select exists (
    select 1 from public.challenge_attempt_tokens as tokens
    where tokens.attempt_id = v_attempt.id
      and tokens.token_hash = encode(extensions.digest(p_attempt_token, 'sha256'), 'hex')
      and tokens.expires_at > v_now
  ) into v_token_exists;
  if not v_token_exists then raise exception 'challenge_attempt_token_expired_or_invalid'; end if;

  select challenges.*
  into v_challenge
  from public.daily_challenges as challenges
  where challenges.id = v_attempt.challenge_id
    and challenges.challenge_date = p_challenge_date
    and challenges.published;
  if not found then raise exception 'challenge_not_available'; end if;

  insert into public.user_statistics (user_id)
  values (v_user_id)
  on conflict on constraint user_statistics_pkey do nothing;
  select statistics.*
  into v_stats
  from public.user_statistics as statistics
  where statistics.user_id = v_user_id
  for update;

  select results.*
  into v_existing
  from public.game_results as results
  where results.user_id = v_user_id
    and results.challenge_id = v_challenge.id;
  if found then
    if v_attempt.submitted_at is null then
      update public.challenge_attempts as attempts
      set submitted_at = v_now
      where attempts.id = v_attempt.id;
    end if;
    return query select v_existing.id, v_existing.total_score, v_existing.question_scores,
      v_existing.guesses, v_existing.exact_guesses, v_existing.average_error_percent,
      v_stats.current_streak, v_stats.best_streak, true;
    return;
  end if;
  if v_attempt.submitted_at is not null then raise exception 'challenge_attempt_already_submitted'; end if;
  if v_now < v_attempt.started_at + interval '10 seconds' then
    raise exception 'challenge_attempt_submitted_too_soon';
  end if;

  select count(*)::integer,
    count(*) filter (where timed_questions.status in ('answered', 'timed_out'))::integer,
    array_agg(
      case when timed_questions.status = 'answered' then timed_questions.guess else null end
      order by timed_questions.question_position
    ),
    array_agg(timed_questions.score order by timed_questions.question_position),
    sum(timed_questions.score)::integer,
    count(*) filter (
      where timed_questions.status = 'answered'
        and timed_questions.guess = challenge_questions.actual_price_snapshot
    )::smallint,
    round((
      avg(
        abs(timed_questions.guess::double precision - challenge_questions.actual_price_snapshot::double precision)
        / challenge_questions.actual_price_snapshot::double precision
      ) filter (where timed_questions.status = 'answered') * 100
    )::numeric, 2)
  into v_question_count, v_resolved_count, v_guesses, v_scores, v_score_sum, v_exact_count, v_average_error
  from public.challenge_attempt_questions as timed_questions
  join public.challenge_questions as challenge_questions
    on challenge_questions.challenge_id = v_attempt.challenge_id
    and challenge_questions.position = timed_questions.question_position
    and challenge_questions.currency_snapshot = 'EUR'
    and challenge_questions.is_demo_snapshot = v_challenge.is_demo
    and (
      (v_challenge.is_demo and challenge_questions.verification_status_snapshot = 'unverified')
      or (not v_challenge.is_demo and challenge_questions.verification_status_snapshot = 'verified')
    )
  where timed_questions.attempt_id = v_attempt.id;

  if v_question_count <> 5 or v_resolved_count <> 5
    or cardinality(v_guesses) <> 5 or cardinality(v_scores) <> 5 then
    raise exception 'timed_game_result_requires_five_resolved_questions';
  end if;

  if v_stats.last_completed_date is null then v_next_streak := 1;
  elsif v_stats.last_completed_date = v_today - 1 then v_next_streak := v_stats.current_streak + 1;
  else v_next_streak := 1;
  end if;

  insert into public.game_results as inserted_result (
    user_id, challenge_id, challenge_date, total_score, guesses, question_scores,
    exact_guesses, average_error_percent
  ) values (
    v_user_id, v_challenge.id, v_today, v_score_sum, v_guesses, v_scores,
    v_exact_count, v_average_error
  ) returning inserted_result.id into result_id;

  update public.user_statistics as statistics set
    current_streak = v_next_streak,
    best_streak = greatest(v_stats.best_streak, v_next_streak),
    last_completed_date = v_today,
    total_games = v_stats.total_games + 1,
    total_points = v_stats.total_points + v_score_sum,
    best_score = greatest(v_stats.best_score, v_score_sum),
    exact_guesses = v_stats.exact_guesses + v_exact_count,
    updated_at = v_now
  where statistics.user_id = v_user_id
  returning statistics.* into v_stats;

  update public.challenge_attempts as attempts
  set submitted_at = v_now
  where attempts.id = v_attempt.id;

  return query select result_id, v_score_sum, v_scores, v_guesses, v_exact_count,
    v_average_error, v_stats.current_streak, v_stats.best_streak, false;
end;
$$;

revoke all on function public.prevent_attempt_ruleset_change() from public, anon, authenticated;
revoke all on function public.require_timed_ruleset_when_enabled() from public, anon, authenticated;
revoke all on function public.prevent_timed_answer_without_resolution() from public, anon, authenticated;
revoke all on function public._get_timed_question_state(uuid, smallint, boolean) from public, anon, authenticated;
revoke all on function public.get_public_timed_gameplay_enabled() from public, anon, authenticated;
revoke all on function public.get_today_game_mode(date) from public, anon, authenticated;
revoke all on function public.get_timed_attempt_progress(date) from public, anon, authenticated;
revoke all on function public.start_timed_daily_attempt(date) from public, anon, authenticated;
revoke all on function public.start_timed_question(date, smallint, text) from public, anon, authenticated;
revoke all on function public.submit_timed_answer(date, smallint, numeric, text) from public, anon, authenticated;
revoke all on function public.expire_timed_question(date, smallint, text) from public, anon, authenticated;
revoke all on function public.require_timed_result_matches_lifecycle() from public, anon, authenticated;
revoke all on function public.require_accepted_answers_for_game_result() from public, anon, authenticated;
revoke all on function public.submit_timed_daily_result(date, text) from public, anon, authenticated;

grant execute on function public.get_public_timed_gameplay_enabled() to anon, authenticated;
grant execute on function public.get_today_game_mode(date) to authenticated;
grant execute on function public.get_timed_attempt_progress(date) to authenticated;
grant execute on function public.start_timed_daily_attempt(date) to authenticated;
grant execute on function public.start_timed_question(date, smallint, text) to authenticated;
grant execute on function public.submit_timed_answer(date, smallint, numeric, text) to authenticated;
grant execute on function public.expire_timed_question(date, smallint, text) to authenticated;
grant execute on function public.submit_timed_daily_result(date, text) to authenticated;

commit;
