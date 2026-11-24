-- Replace both UUIDs below with two disposable, existing Auth user IDs.
-- Run in cifra-test only. All game data changes are rolled back.
-- If a statement fails, issue ROLLBACK in SQL Editor before continuing.
begin;

create temporary table cifra_security_test_users (
  user_a uuid not null,
  user_b uuid not null
) on commit drop;

insert into pg_temp.cifra_security_test_users (user_a, user_b)
values (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002'
);

do $test$
declare
  v_rpc_signatures text[] := array[
    'public.get_today_challenge()',
    'public.start_daily_attempt(date)',
    'public.get_daily_attempt_progress(date)',
    'public.submit_daily_answer(date, smallint, numeric, text)',
    'public.submit_daily_result(date, numeric[], text)'
  ];
  v_protected_tables text[] := array[
    'public.questions',
    'public.daily_challenges',
    'public.challenge_questions',
    'public.challenge_attempts',
    'public.challenge_attempt_tokens',
    'public.challenge_attempt_answers',
    'public.game_results',
    'public.user_statistics'
  ];
  v_private_progress_tables text[] := array[
    'public.profiles',
    'public.questions',
    'public.daily_challenges',
    'public.challenge_questions',
    'public.challenge_attempts',
    'public.challenge_attempt_tokens',
    'public.challenge_attempt_answers',
    'public.game_results',
    'public.user_statistics'
  ];
  v_signature text;
  v_table text;
  v_privilege text;
  v_rls_enabled boolean;
  v_trigger_definition text;
  v_user_a uuid;
  v_user_b uuid;
  v_today date := (now() at time zone 'Europe/Zagreb')::date;
  v_challenge_id uuid;
  v_token_a text := repeat('a', 64);
  v_token_b text := repeat('b', 64);
  v_guesses numeric[] := array[12.34, 20.25, 30.50, 40.75, 50.99]::numeric[];
  v_answered_count integer;
  v_saved_guess numeric;
  v_duplicate boolean;
  v_result_id uuid;
  v_duplicate_result_id uuid;
  v_games_before integer;
  v_points_before bigint;
  v_streak_before integer;
  v_games_after integer;
  v_points_after bigint;
  v_streak_after integer;
begin
  for v_signature in select unnest(v_rpc_signatures) loop
    if to_regprocedure(v_signature) is null then
      raise exception 'Missing expected RPC signature: %', v_signature;
    end if;
    if has_function_privilege('anon', v_signature, 'EXECUTE') then
      raise exception 'Anonymous execution is unexpectedly granted: %', v_signature;
    end if;
    if not has_function_privilege('authenticated', v_signature, 'EXECUTE') then
      raise exception 'Authenticated execution is missing: %', v_signature;
    end if;
  end loop;

  foreach v_table in array v_protected_tables loop
    if to_regclass(v_table) is null then
      raise exception 'Missing expected table: %', v_table;
    end if;
    foreach v_privilege in array array['INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege('authenticated', v_table, v_privilege) then
        raise exception 'Authenticated direct % is unexpectedly granted on %',
          v_privilege, v_table;
      end if;
    end loop;
  end loop;

  foreach v_table in array v_private_progress_tables loop
    select relations.relrowsecurity
    into v_rls_enabled
    from pg_class as relations
    where relations.oid = to_regclass(v_table);
    if v_rls_enabled is distinct from true then
      raise exception 'RLS is not enabled on %', v_table;
    end if;
  end loop;

  if not exists (
    select 1 from pg_policies as policies
    where policies.schemaname = 'public'
      and policies.tablename = 'profiles'
      and policies.cmd = 'SELECT'
      and policies.qual ilike '%auth.uid%'
      and policies.qual ilike '%id%'
  ) or not exists (
    select 1 from pg_policies as policies
    where policies.schemaname = 'public'
      and policies.tablename = 'game_results'
      and policies.cmd = 'SELECT'
      and policies.qual ilike '%auth.uid%'
      and policies.qual ilike '%user_id%'
  ) or not exists (
    select 1 from pg_policies as policies
    where policies.schemaname = 'public'
      and policies.tablename = 'user_statistics'
      and policies.cmd = 'SELECT'
      and policies.qual ilike '%auth.uid%'
      and policies.qual ilike '%user_id%'
  ) then
    raise exception 'Owner-scoped SELECT policies are missing for private account data';
  end if;

  if has_table_privilege('authenticated', 'public.challenge_attempt_answers', 'SELECT')
    or has_table_privilege('authenticated', 'public.challenge_attempts', 'SELECT') then
    raise exception 'Authenticated direct reads of private attempt progress are unexpectedly granted';
  end if;
  raise notice 'PASS: RPC ACLs, protected-table DML grants, private table reads, and RLS catalog settings';

  if not exists (
    select 1
    from pg_trigger as triggers
    where triggers.tgrelid = 'public.game_results'::regclass
      and triggers.tgname = 'require_accepted_answers_for_game_result'
      and not triggers.tgisinternal
      and triggers.tgenabled <> 'D'
  ) then
    raise exception 'Stage C result-enforcement trigger is missing or disabled';
  end if;
  select pg_get_triggerdef(triggers.oid)
  into v_trigger_definition
  from pg_trigger as triggers
  where triggers.tgrelid = 'public.game_results'::regclass
    and triggers.tgname = 'require_accepted_answers_for_game_result'
    and not triggers.tgisinternal;
  if v_trigger_definition not ilike '%BEFORE INSERT%' then
    raise exception 'Stage C result-enforcement trigger is not BEFORE INSERT';
  end if;
  if position(
    'v_attempt_id' in pg_get_functiondef(
      to_regprocedure('public.require_accepted_answers_for_game_result()')
    )
  ) = 0 then
    raise exception 'Result trigger ambiguity hotfix is not applied';
  end if;
  raise notice 'PASS: Stage C trigger is enabled before INSERT and the ambiguity hotfix is installed';

  select test_users.user_a, test_users.user_b
  into v_user_a, v_user_b
  from pg_temp.cifra_security_test_users as test_users;
  if v_user_a = v_user_b then raise exception 'Use two distinct test users'; end if;
  if not exists (select 1 from auth.users as users where users.id = v_user_a)
    or not exists (select 1 from auth.users as users where users.id = v_user_b) then
    raise exception 'Replace the placeholders with two existing disposable Auth user IDs';
  end if;

  select daily_challenges.id
  into v_challenge_id
  from public.daily_challenges as daily_challenges
  where daily_challenges.challenge_date = v_today
    and daily_challenges.published;
  if v_challenge_id is null then raise exception 'No published challenge exists for today'; end if;

  if exists (
    select 1 from public.challenge_attempts as attempts
    where attempts.user_id in (v_user_a, v_user_b)
      and attempts.challenge_date = v_today
  ) or exists (
    select 1 from public.game_results as results
    where results.user_id in (v_user_a, v_user_b)
      and results.challenge_date = v_today
  ) then
    raise exception 'Choose fresh test users with no attempt or result for today';
  end if;

  insert into public.challenge_attempts (
    user_id, challenge_id, challenge_date, started_at, expires_at
  ) values
    (v_user_a, v_challenge_id, v_today, now() - interval '1 minute', now() + interval '1 day'),
    (v_user_b, v_challenge_id, v_today, now() - interval '1 minute', now() + interval '1 day');

  insert into public.challenge_attempt_tokens (attempt_id, token_hash, expires_at)
  select attempts.id,
    encode(extensions.digest(case attempts.user_id
      when v_user_a then v_token_a else v_token_b end, 'sha256'), 'hex'),
    now() + interval '1 hour'
  from public.challenge_attempts as attempts
  where attempts.user_id in (v_user_a, v_user_b)
    and attempts.challenge_id = v_challenge_id;

  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  begin
    perform * from public.submit_daily_answer(v_today, 2::smallint, v_guesses[2], v_token_a);
    raise exception 'test_expected_out_of_order_rejection';
  exception
    when others then
      if sqlerrm <> 'challenge_answers_must_be_submitted_in_order' then raise; end if;
  end;
  raise notice 'PASS: out-of-order answer rejected';

  perform * from public.submit_daily_answer(v_today, 1::smallint, v_guesses[1], v_token_a);
  select answer.duplicate
  into v_duplicate
  from public.submit_daily_answer(v_today, 1::smallint, v_guesses[1], v_token_a) as answer;
  if v_duplicate is distinct from true then
    raise exception 'Same-answer retry was not idempotent';
  end if;

  begin
    perform * from public.submit_daily_answer(v_today, 1::smallint, v_guesses[1] + 1, v_token_a);
    raise exception 'test_expected_changed_answer_rejection';
  exception
    when others then
      if sqlerrm <> 'challenge_answer_already_recorded' then raise; end if;
  end;
  select answers.guess
  into v_saved_guess
  from public.challenge_attempt_answers as answers
  join public.challenge_attempts as attempts
    on attempts.id = answers.attempt_id
  where attempts.user_id = v_user_a
    and attempts.challenge_id = v_challenge_id
    and answers.question_position = 1;
  if v_saved_guess is distinct from v_guesses[1] then
    raise exception 'An accepted answer changed after a rejected retry';
  end if;
  raise notice 'PASS: accepted answers are immutable and same-answer retries are idempotent';

  perform set_config('request.jwt.claim.sub', v_user_b::text, true);
  select progress.answered_count
  into v_answered_count
  from public.get_daily_attempt_progress(v_today) as progress;
  if v_answered_count <> 0 then
    raise exception 'User B can see progress belonging to User A';
  end if;
  raise notice 'PASS: progress RPC returns only the authenticated user''s answers';

  select coalesce((select statistics.total_games from public.user_statistics as statistics
    where statistics.user_id = v_user_b), 0),
    coalesce((select statistics.total_points from public.user_statistics as statistics
    where statistics.user_id = v_user_b), 0),
    coalesce((select statistics.current_streak from public.user_statistics as statistics
    where statistics.user_id = v_user_b), 0)
  into v_games_before, v_points_before, v_streak_before;

  begin
    perform * from public.submit_daily_result(v_today, v_guesses, v_token_b);
    raise exception 'test_expected_missing_answers_rejection';
  exception
    when others then
      if sqlerrm <> 'game_result_requires_five_server_accepted_answers' then raise; end if;
  end;
  select coalesce((select statistics.total_games from public.user_statistics as statistics
    where statistics.user_id = v_user_b), 0),
    coalesce((select statistics.total_points from public.user_statistics as statistics
    where statistics.user_id = v_user_b), 0),
    coalesce((select statistics.current_streak from public.user_statistics as statistics
    where statistics.user_id = v_user_b), 0)
  into v_games_after, v_points_after, v_streak_after;
  if v_games_after <> v_games_before
    or v_points_after <> v_points_before
    or v_streak_after <> v_streak_before
    or exists (
      select 1 from public.game_results as results
      where results.user_id = v_user_b
        and results.challenge_id = v_challenge_id
    ) then
    raise exception 'Rejected incomplete result changed results or statistics';
  end if;
  raise notice 'PASS: a result without five accepted answers is rejected without changing statistics';

  perform set_config('request.jwt.claim.sub', v_user_a::text, true);
  for v_answered_count in 2..5 loop
    perform * from public.submit_daily_answer(
      v_today,
      v_answered_count::smallint,
      v_guesses[v_answered_count],
      v_token_a
    );
  end loop;

  select result.result_id, result.duplicate
  into v_result_id, v_duplicate
  from public.submit_daily_result(v_today, v_guesses, v_token_a) as result;
  if v_duplicate is distinct from false then
    raise exception 'First valid result submission was unexpectedly marked duplicate';
  end if;

  select statistics.total_games, statistics.total_points, statistics.current_streak
  into v_games_before, v_points_before, v_streak_before
  from public.user_statistics as statistics
  where statistics.user_id = v_user_a;

  select result.result_id, result.duplicate
  into v_duplicate_result_id, v_duplicate
  from public.submit_daily_result(v_today, v_guesses, v_token_a) as result;
  if v_duplicate is distinct from true or v_duplicate_result_id is distinct from v_result_id then
    raise exception 'Duplicate submission did not return the existing result';
  end if;

  select statistics.total_games, statistics.total_points, statistics.current_streak
  into v_games_after, v_points_after, v_streak_after
  from public.user_statistics as statistics
  where statistics.user_id = v_user_a;
  if v_games_after <> v_games_before
    or v_points_after <> v_points_before
    or v_streak_after <> v_streak_before then
    raise exception 'Duplicate submission incremented statistics more than once';
  end if;

  if (select count(*) from public.game_results as results
      where results.user_id = v_user_a and results.challenge_id = v_challenge_id) <> 1 then
    raise exception 'Expected exactly one result for the successful test submission';
  end if;
  raise notice 'PASS: duplicate result submission returns the existing result without double-counting statistics';
end;
$test$;

rollback;
