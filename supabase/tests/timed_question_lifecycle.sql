-- Run only in cifra-test after Phase 3A and Stage C have been applied.
-- Replace all three IDs with distinct disposable Auth users that have no attempt
-- or result for today's Europe/Zagreb challenge. The transaction is rolled back.
-- If any assertion fails, issue ROLLBACK in SQL Editor before continuing.
begin;

create temporary table cifra_timed_test_users (
  user_a uuid not null,
  user_b uuid not null,
  user_c uuid not null
) on commit drop;

insert into pg_temp.cifra_timed_test_users (user_a, user_b, user_c)
values (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003'
);

do $test$
declare
  v_signatures text[] := array[
    'public.get_today_game_mode(date)',
    'public.get_timed_attempt_progress(date)',
    'public.start_timed_daily_attempt(date)',
    'public.start_timed_question(date, smallint, text)',
    'public.submit_timed_answer(date, smallint, numeric, text)',
    'public.expire_timed_question(date, smallint, text)',
    'public.submit_timed_daily_result(date, text)'
  ];
  v_table text;
  v_privilege text;
  v_signature text;
  v_today date := (clock_timestamp() at time zone 'Europe/Zagreb')::date;
  v_users record;
  v_challenge_id uuid;
  v_is_demo boolean;
  v_token text;
  v_token_refresh text;
  v_started record;
  v_reopened record;
  v_answer record;
  v_result record;
  v_price numeric(12,2);
  v_guesses numeric[];
  v_answer_count integer;
  v_result_count integer;
  v_games_before integer;
  v_games_after integer;
  v_points_before bigint;
  v_points_after bigint;
  v_flag_before boolean;
  v_question_count integer;
  v_distinct_question_count integer;
  v_distinct_category_count integer;
  v_trigger_count integer;
  v_progress_count integer;
  v_sqlerrm text;
  v_deadline timestamptz;
  v_past timestamptz;
  v_position smallint;
  v_index integer;
begin
  select test_users.user_a, test_users.user_b, test_users.user_c
  into v_users
  from pg_temp.cifra_timed_test_users as test_users;
  if v_users.user_a = v_users.user_b or v_users.user_a = v_users.user_c
    or v_users.user_b = v_users.user_c then
    raise exception 'Use three distinct disposable Auth users';
  end if;
  if not exists (select 1 from auth.users as users where users.id = v_users.user_a)
    or not exists (select 1 from auth.users as users where users.id = v_users.user_b)
    or not exists (select 1 from auth.users as users where users.id = v_users.user_c) then
    raise exception 'Replace the placeholders with three existing disposable Auth user IDs';
  end if;
  if exists (
    select 1 from public.challenge_attempts as attempts
    where attempts.user_id in (v_users.user_a, v_users.user_b, v_users.user_c)
      and attempts.challenge_date = v_today
  ) or exists (
    select 1 from public.game_results as results
    where results.user_id in (v_users.user_a, v_users.user_b, v_users.user_c)
      and results.challenge_date = v_today
  ) then
    raise exception 'Choose users with no attempt or result for today';
  end if;

  for v_signature in select unnest(v_signatures) loop
    if to_regprocedure(v_signature) is null then
      raise exception 'Missing timed gameplay RPC: %', v_signature;
    end if;
    if has_function_privilege('anon', v_signature, 'EXECUTE') then
      raise exception 'Anonymous execution is unexpectedly granted: %', v_signature;
    end if;
    if not has_function_privilege('authenticated', v_signature, 'EXECUTE') then
      raise exception 'Authenticated execution is missing: %', v_signature;
    end if;
  end loop;

  foreach v_table in array array['public.gameplay_settings', 'public.challenge_attempt_questions'] loop
    if to_regclass(v_table) is null then raise exception 'Missing timed gameplay table: %', v_table; end if;
    foreach v_privilege in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege('authenticated', v_table, v_privilege) then
        raise exception 'Authenticated direct % is unexpectedly granted on %', v_privilege, v_table;
      end if;
    end loop;
    if not exists (
      select 1 from pg_class as relations
      where relations.oid = to_regclass(v_table)
        and relations.relrowsecurity
    ) then
      raise exception 'RLS is not enabled on %', v_table;
    end if;
  end loop;

  select count(*), count(distinct challenge_questions.question_id),
    count(distinct questions.category), challenges.id, challenges.is_demo
  into v_question_count, v_distinct_question_count, v_distinct_category_count, v_challenge_id, v_is_demo
  from public.daily_challenges as challenges
  join public.challenge_questions as challenge_questions
    on challenge_questions.challenge_id = challenges.id
  join public.questions as questions
    on questions.id = challenge_questions.question_id
  where challenges.challenge_date = v_today
    and challenges.published
  group by challenges.id, challenges.is_demo;
  if v_challenge_id is null or v_question_count <> 5 or v_distinct_question_count <> 5 then
    raise exception 'The published challenge must contain exactly five unique questions';
  end if;
  if v_distinct_category_count < 5
    and (select count(distinct questions.category)
      from public.questions as questions
      where questions.active
        and ((v_is_demo and questions.is_demo and questions.verification_status = 'unverified')
          or (not v_is_demo and not questions.is_demo and questions.verification_status = 'verified'))) >= 5 then
    raise exception 'Category diversity was lost despite five eligible categories';
  end if;

  select settings.timed_gameplay_enabled
  into v_flag_before
  from public.gameplay_settings as settings
  where settings.singleton;
  update public.gameplay_settings as settings
  set timed_gameplay_enabled = true, updated_at = clock_timestamp()
  where settings.singleton;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_users.user_a::text, true);

  begin
    perform * from public.start_daily_attempt(v_today);
    raise exception 'test_expected_legacy_attempt_rejection';
  exception
    when others then
      get stacked diagnostics v_sqlerrm = message_text;
      if v_sqlerrm = 'test_expected_legacy_attempt_rejection' then raise; end if;
      if v_sqlerrm <> 'timed_gameplay_required' then raise; end if;
  end;
  raise notice 'PASS: new legacy attempts are blocked when timed mode is enabled';

  select * into v_started from public.start_timed_daily_attempt(v_today);
  if v_started.question_position <> 1
    or v_started.outcome <> 'active'
    or v_started.actual_price is not null
    or v_started.guess is not null
    or v_started.deadline_at - v_started.started_at <> interval '20 seconds' then
    raise exception 'First timed question did not start safely with a 20-second hidden-price deadline';
  end if;
  v_token := v_started.attempt_token;
  v_deadline := v_started.deadline_at;
  begin
    perform * from public.expire_timed_question(v_today, 1::smallint, v_token);
    raise exception 'test_expected_early_timeout_rejection';
  exception
    when others then
      get stacked diagnostics v_sqlerrm = message_text;
      if v_sqlerrm = 'test_expected_early_timeout_rejection' then raise; end if;
      if v_sqlerrm <> 'timed_question_deadline_not_reached' then raise; end if;
  end;
  select * into v_reopened from public.start_timed_daily_attempt(v_today);
  if v_reopened.question_id <> v_started.question_id
    or v_reopened.deadline_at <> v_deadline
    or v_reopened.attempt_token = v_token then
    raise exception 'Reopening reset the active timer, changed the question, or failed to renew its token';
  end if;
  v_token_refresh := v_reopened.attempt_token;

  select count(*) into v_progress_count
  from public.get_timed_attempt_progress(v_today);
  if v_progress_count <> 1 then
    raise exception 'Future question data was returned before starting that question';
  end if;

  begin
    perform * from public.start_timed_question(v_today, 2::smallint, v_token);
    raise exception 'test_expected_out_of_order_start_rejection';
  exception
    when others then
      get stacked diagnostics v_sqlerrm = message_text;
      if v_sqlerrm = 'test_expected_out_of_order_start_rejection' then raise; end if;
      if v_sqlerrm <> 'previous_timed_question_must_be_resolved' then raise; end if;
  end;

  select challenge_questions.actual_price_snapshot
  into v_price
  from public.challenge_questions as challenge_questions
  where challenge_questions.challenge_id = v_challenge_id
    and challenge_questions.position = 1;

  begin
    perform * from public.submit_daily_answer(v_today, 1::smallint, v_price, v_token);
    raise exception 'test_expected_legacy_answer_rejection';
  exception
    when others then
      get stacked diagnostics v_sqlerrm = message_text;
      if v_sqlerrm = 'test_expected_legacy_answer_rejection' then raise; end if;
      if v_sqlerrm <> 'timed_answer_requires_server_accepted_question' then raise; end if;
  end;

  update public.challenge_attempts as attempts
  set started_at = clock_timestamp() - interval '1 minute',
    expires_at = clock_timestamp() + interval '1 day'
  where attempts.user_id = v_users.user_a
    and attempts.challenge_date = v_today;

  begin
    perform * from public.submit_timed_daily_result(v_today, v_token);
    raise exception 'test_expected_incomplete_result_rejection';
  exception
    when others then
      get stacked diagnostics v_sqlerrm = message_text;
      if v_sqlerrm = 'test_expected_incomplete_result_rejection' then raise; end if;
      if v_sqlerrm <> 'timed_game_result_requires_five_resolved_questions' then raise; end if;
  end;

  select array_agg(challenge_questions.actual_price_snapshot order by challenge_questions.position)
  into v_guesses
  from public.challenge_questions as challenge_questions
  where challenge_questions.challenge_id = v_challenge_id;
  begin
    perform * from public.submit_daily_result(v_today, v_guesses, v_token);
    raise exception 'test_expected_legacy_timed_result_rejection';
  exception
    when others then
      get stacked diagnostics v_sqlerrm = message_text;
      if v_sqlerrm = 'test_expected_legacy_timed_result_rejection' then raise; end if;
  end;
  if exists (
    select 1 from public.game_results as results
    where results.user_id = v_users.user_a and results.challenge_date = v_today
  ) then
    raise exception 'Legacy result submission bypassed timed lifecycle validation';
  end if;
  raise notice 'PASS: early finalization, legacy answer/result RPCs, and out-of-order starts cannot bypass timed enforcement';

  select * into v_answer
  from public.submit_timed_answer(v_today, 1::smallint, v_price, v_token);
  if v_answer.outcome <> 'answered' or v_answer.guess <> v_price or v_answer.question_score <> 1000
    or v_answer.actual_price <> v_price then
    raise exception 'Exact timed answer did not receive the existing 1,000-point score';
  end if;
  select * into v_answer
  from public.submit_timed_answer(v_today, 1::smallint, v_price, v_token);
  if v_answer.duplicate is distinct from true then
    raise exception 'Lost-response retry of the same timed answer was not idempotent';
  end if;
  begin
    perform * from public.submit_timed_answer(v_today, 1::smallint, v_price + 1, v_token);
    raise exception 'test_expected_changed_timed_answer_rejection';
  exception
    when others then
      get stacked diagnostics v_sqlerrm = message_text;
      if v_sqlerrm = 'test_expected_changed_timed_answer_rejection' then raise; end if;
      if v_sqlerrm <> 'timed_answer_already_recorded' then raise; end if;
  end;

  select * into v_started
  from public.start_timed_question(v_today, 2::smallint, v_token);
  v_past := clock_timestamp() - interval '1 minute';
  update public.challenge_attempt_questions as timed_questions
  set started_at = v_past,
    deadline_at = v_past + interval '20 seconds'
  where timed_questions.attempt_id = (
    select attempts.id from public.challenge_attempts as attempts
    where attempts.user_id = v_users.user_a and attempts.challenge_date = v_today
  )
    and timed_questions.question_position = 2;
  select * into v_answer
  from public.expire_timed_question(v_today, 2::smallint, v_token);
  if v_answer.outcome <> 'timed_out' or v_answer.guess is not null
    or v_answer.question_score <> 0 or v_answer.actual_price is null then
    raise exception 'Timeout did not persist a zero-score no-guess outcome';
  end if;
  select * into v_answer
  from public.expire_timed_question(v_today, 2::smallint, v_token);
  if v_answer.duplicate is distinct from true then raise exception 'Timeout retry was not idempotent'; end if;
  begin
    perform * from public.submit_timed_answer(v_today, 2::smallint, 1, v_token);
    raise exception 'test_expected_late_answer_rejection';
  exception
    when others then
      get stacked diagnostics v_sqlerrm = message_text;
      if v_sqlerrm = 'test_expected_late_answer_rejection' then raise; end if;
      if v_sqlerrm <> 'timed_question_already_timed_out' then raise; end if;
  end;

  for v_position in 3..5 loop
    select * into v_started
    from public.start_timed_question(v_today, v_position::smallint, v_token);
    select challenge_questions.actual_price_snapshot
    into v_price
    from public.challenge_questions as challenge_questions
    where challenge_questions.challenge_id = v_challenge_id
      and challenge_questions.position = v_position;
    select * into v_answer
    from public.submit_timed_answer(v_today, v_position::smallint, v_price, v_token);
    if v_answer.question_score <> 1000 then
      raise exception 'Exact answer at position % did not score 1,000', v_position;
    end if;
  end loop;

  perform set_config('request.jwt.claim.sub', v_users.user_b::text, true);
  select count(*) into v_progress_count from public.get_timed_attempt_progress(v_today);
  if v_progress_count <> 0 then raise exception 'Another account can read private timed progress'; end if;

  perform set_config('request.jwt.claim.sub', v_users.user_a::text, true);
  select * into v_result from public.submit_timed_daily_result(v_today, v_token);
  if v_result.total_score <> 4000 or v_result.exact_guesses <> 4
    or v_result.guesses[2] is not null or v_result.question_scores[2] <> 0
    or v_result.average_error_percent <> 0 then
    raise exception 'Mixed answer/timeout finalization produced an invalid result';
  end if;
  select statistics.total_games, statistics.total_points
  into v_games_before, v_points_before
  from public.user_statistics as statistics
  where statistics.user_id = v_users.user_a;
  select * into v_result from public.submit_timed_daily_result(v_today, v_token);
  if v_result.duplicate is distinct from true then raise exception 'Result retry was not idempotent'; end if;
  select statistics.total_games, statistics.total_points
  into v_games_after, v_points_after
  from public.user_statistics as statistics
  where statistics.user_id = v_users.user_a;
  if v_games_after <> v_games_before or v_points_after <> v_points_before then
    raise exception 'Duplicate finalization changed user statistics';
  end if;
  raise notice 'PASS: mixed timed results preserve null timeout guesses, existing scoring, and exactly-once statistics';

  perform set_config('request.jwt.claim.sub', v_users.user_b::text, true);
  select * into v_started from public.start_timed_daily_attempt(v_today);
  v_token := v_started.attempt_token;
  update public.challenge_attempts as attempts
  set started_at = clock_timestamp() - interval '1 minute',
    expires_at = clock_timestamp() + interval '1 day'
  where attempts.user_id = v_users.user_b and attempts.challenge_date = v_today;
  for v_position in 1..5 loop
    if v_position > 1 then
      select * into v_started
      from public.start_timed_question(v_today, v_position::smallint, v_token);
    end if;
    v_past := clock_timestamp() - interval '1 minute';
    update public.challenge_attempt_questions as timed_questions
    set started_at = v_past, deadline_at = v_past + interval '20 seconds'
    where timed_questions.attempt_id = (
      select attempts.id from public.challenge_attempts as attempts
      where attempts.user_id = v_users.user_b and attempts.challenge_date = v_today
    )
      and timed_questions.question_position = v_position;
    select * into v_answer
    from public.expire_timed_question(v_today, v_position::smallint, v_token);
    if v_answer.outcome <> 'timed_out' or v_answer.question_score <> 0 or v_answer.guess is not null then
      raise exception 'Timed-out question % was not recorded correctly', v_position;
    end if;
  end loop;
  select * into v_result from public.submit_timed_daily_result(v_today, v_token);
  if v_result.total_score <> 0 or v_result.exact_guesses <> 0
    or v_result.average_error_percent is not null
    or array_position(v_result.guesses, null) is null then
    raise exception 'All-timeout result must score zero without fabricated guesses or error percentage';
  end if;
  raise notice 'PASS: all-timeout challenge completes with zero points, null guesses, and null average error';

  perform set_config('request.jwt.claim.sub', v_users.user_c::text, true);
  select * into v_started from public.start_timed_daily_attempt(v_today);
  v_token := v_started.attempt_token;
  update public.challenge_attempts as attempts
  set started_at = clock_timestamp() - interval '1 minute',
    expires_at = clock_timestamp() + interval '1 day'
  where attempts.user_id = v_users.user_c and attempts.challenge_date = v_today;
  for v_position in 1..5 loop
    if v_position > 1 then
      select * into v_started
      from public.start_timed_question(v_today, v_position::smallint, v_token);
    end if;
    select challenge_questions.actual_price_snapshot
    into v_price
    from public.challenge_questions as challenge_questions
    where challenge_questions.challenge_id = v_challenge_id
      and challenge_questions.position = v_position;
    select * into v_answer
    from public.submit_timed_answer(v_today, v_position::smallint, v_price, v_token);
    if v_answer.question_score <> 1000 then raise exception 'Exact timed answer scored incorrectly'; end if;
  end loop;
  select * into v_result from public.submit_timed_daily_result(v_today, v_token);
  if v_result.total_score <> 5000 or v_result.exact_guesses <> 5 then
    raise exception 'The existing 5,000-point maximum was not preserved';
  end if;
  raise notice 'PASS: five exact answers retain the 5,000-point maximum';

  select count(*) into v_trigger_count
  from pg_trigger as triggers
  where triggers.tgrelid = 'public.game_results'::regclass
    and triggers.tgname = 'require_accepted_answers_for_game_result'
    and not triggers.tgisinternal
    and triggers.tgenabled <> 'D';
  if v_trigger_count <> 1 then raise exception 'Stage C sequential-result trigger is not enabled'; end if;
  raise notice 'PASS: Stage C result enforcement is enabled';
end;
$test$;

rollback;
