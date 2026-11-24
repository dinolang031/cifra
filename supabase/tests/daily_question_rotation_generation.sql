-- Run only in a fresh disposable project with all CIFRA migrations applied.
-- Run once with cifra.rotation_test_mode = 'demo', then again with 'verified'.
-- If a statement fails, issue ROLLBACK in SQL Editor before continuing.
begin;

select set_config('cifra.rotation_test_mode', 'demo', true);
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);

drop table if exists pg_temp.cifra_rotation_challenges_before;
drop table if exists pg_temp.cifra_rotation_questions_before;

create temporary table cifra_rotation_challenges_before (
  id uuid,
  challenge_date date,
  is_demo boolean,
  published_at timestamptz
) on commit drop;

create temporary table cifra_rotation_questions_before (
  challenge_id uuid,
  question_id text,
  position smallint,
  actual_price_snapshot numeric,
  currency_snapshot text,
  is_demo_snapshot boolean,
  verification_status_snapshot text
) on commit drop;

do $test$
declare
  v_mode text := current_setting('cifra.rotation_test_mode', true);
  v_is_demo boolean;
  v_verification_status text;
  v_price_type text;
  v_today date := (now() at time zone 'Europe/Zagreb')::date;
  v_challenge_id uuid;
  v_generated_challenge_id uuid;
  v_generated_date date;
  v_generated_is_demo boolean;
  v_generated_question_ids text[];
  v_fixture record;
  v_day_offset integer;
  v_question_position integer;
  v_fixture_question_ids text[];
  v_actual_price numeric(12,2);
  v_currency text;
  v_question_is_demo boolean;
  v_question_verification_status text;
  v_category_count integer;
  v_snapshot_count integer;
  v_invalid_snapshot_count integer;
begin
  if v_mode not in ('demo', 'verified') then
    raise exception 'Set cifra.rotation_test_mode to demo or verified before running';
  end if;
  v_is_demo := v_mode = 'demo';
  v_verification_status := case when v_is_demo then 'unverified' else 'verified' end;
  v_price_type := case when v_is_demo then 'illustrative' else 'regular' end;

  if to_regprocedure('public.get_today_challenge()') is null
    or to_regclass('public.questions') is null
    or to_regclass('public.daily_challenges') is null
    or to_regclass('public.challenge_questions') is null then
    raise exception 'Required CIFRA schema or get_today_challenge() is missing';
  end if;
  if exists (
    select 1
    from public.questions as questions
    where questions.id like 'rotation-test-%'
  ) then
    raise exception 'Disposable rotation fixture IDs already exist; use a clean test project';
  end if;

  for v_day_offset in 0..4 loop
    if exists (
      select 1
      from public.daily_challenges as daily_challenges
      where daily_challenges.challenge_date = v_today - v_day_offset
    ) then
      raise exception 'Use a fresh disposable project: a challenge already exists for %',
        v_today - v_day_offset;
    end if;
  end loop;

  update public.questions as questions
  set active = false
  where questions.active;

  for v_fixture in
    select fixture.question_id, fixture.category, fixture.actual_price, fixture.active
    from (values
      ('rotation-test-yesterday', 'Rotation test yesterday', 2.00::numeric, true),
      ('rotation-test-older', 'Rotation test yesterday', 3.00::numeric, true),
      ('rotation-test-never', 'Rotation test never-used', 4.00::numeric, true),
      ('rotation-test-used', 'Rotation test never-used', 5.00::numeric, true),
      ('rotation-test-lru-old', 'Rotation test least-recently-used', 6.00::numeric, true),
      ('rotation-test-lru-recent', 'Rotation test least-recently-used', 7.00::numeric, true),
      ('rotation-test-category-4', 'Rotation test category 4', 8.00::numeric, true),
      ('rotation-test-category-5', 'Rotation test category 5', 9.00::numeric, true),
      ('rotation-test-filler-1', 'Rotation test history filler', 10.00::numeric, false),
      ('rotation-test-filler-2', 'Rotation test history filler', 11.00::numeric, false),
      ('rotation-test-filler-3', 'Rotation test history filler', 12.00::numeric, false),
      ('rotation-test-filler-4', 'Rotation test history filler', 13.00::numeric, false),
      ('rotation-test-filler-5', 'Rotation test history filler', 14.00::numeric, false),
      ('rotation-test-filler-6', 'Rotation test history filler', 15.00::numeric, false)
    ) as fixture(question_id, category, actual_price, active)
  loop
    insert into public.questions (
      id, question, item_name, category, actual_price, currency, unit, location,
      source_name, source_url, verification_date, verification_status, is_demo,
      price_type, active
    ) values (
      v_fixture.question_id,
      'Disposable rotation fixture: ' || v_fixture.question_id,
      v_fixture.question_id,
      v_fixture.category,
      v_fixture.actual_price,
      'EUR',
      'test item',
      'Disposable SQL test',
      case when v_is_demo then 'Unverified test fixture' else 'Disposable test fixture' end,
      case when v_is_demo then null else 'https://example.invalid/cifra-test-fixture' end,
      case when v_is_demo then null else v_today end,
      v_verification_status,
      v_is_demo,
      v_price_type,
      v_fixture.active
    );
  end loop;

  for v_day_offset in 1..4 loop
    insert into public.daily_challenges (challenge_date, published, is_demo)
    values (v_today - v_day_offset, false, v_is_demo)
    returning id into v_challenge_id;

    case v_day_offset
      when 1 then
        v_fixture_question_ids := array[
          'rotation-test-yesterday',
          'rotation-test-filler-1',
          'rotation-test-filler-2',
          'rotation-test-filler-3',
          'rotation-test-filler-4'
        ];
      when 2 then
        v_fixture_question_ids := array[
          'rotation-test-older',
          'rotation-test-used',
          'rotation-test-lru-recent',
          'rotation-test-filler-1',
          'rotation-test-filler-2'
        ];
      when 3 then
        v_fixture_question_ids := array[
          'rotation-test-older',
          'rotation-test-filler-3',
          'rotation-test-filler-4',
          'rotation-test-filler-5',
          'rotation-test-filler-6'
        ];
      else
        v_fixture_question_ids := array[
          'rotation-test-lru-old',
          'rotation-test-filler-1',
          'rotation-test-filler-3',
          'rotation-test-filler-5',
          'rotation-test-filler-6'
        ];
    end case;

    for v_question_position in 1..5 loop
      select questions.actual_price, questions.currency, questions.is_demo,
        questions.verification_status
      into v_actual_price, v_currency, v_question_is_demo, v_question_verification_status
      from public.questions as questions
      where questions.id = v_fixture_question_ids[v_question_position];

      insert into public.challenge_questions (
        challenge_id, question_id, position, actual_price_snapshot,
        currency_snapshot, is_demo_snapshot, verification_status_snapshot
      ) values (
        v_challenge_id,
        v_fixture_question_ids[v_question_position],
        v_question_position::smallint,
        v_actual_price,
        v_currency,
        v_question_is_demo,
        v_question_verification_status
      );
    end loop;

    update public.daily_challenges as daily_challenges
    set published = true
    where daily_challenges.id = v_challenge_id;
  end loop;

  insert into pg_temp.cifra_rotation_challenges_before
  select daily_challenges.id, daily_challenges.challenge_date,
    daily_challenges.is_demo, daily_challenges.published_at
  from public.daily_challenges as daily_challenges
  where daily_challenges.published;

  insert into pg_temp.cifra_rotation_questions_before
  select challenge_questions.challenge_id, challenge_questions.question_id,
    challenge_questions.position, challenge_questions.actual_price_snapshot,
    challenge_questions.currency_snapshot, challenge_questions.is_demo_snapshot,
    challenge_questions.verification_status_snapshot
  from public.challenge_questions as challenge_questions
  join public.daily_challenges as daily_challenges
    on daily_challenges.id = challenge_questions.challenge_id
  where daily_challenges.published;

  select today_challenge.challenge_id, today_challenge.challenge_date,
    today_challenge.is_demo, today_challenge.question_ids
  into v_generated_challenge_id, v_generated_date,
    v_generated_is_demo, v_generated_question_ids
  from public.get_today_challenge() as today_challenge;

  if v_generated_challenge_id is null or v_generated_question_ids is null then
    raise exception 'get_today_challenge() did not generate a challenge row';
  end if;
  if v_generated_date <> v_today or v_generated_is_demo is distinct from v_is_demo then
    raise exception 'Generated challenge date or demo mode did not match the test fixture';
  end if;
  if cardinality(v_generated_question_ids) <> 5
    or (select count(distinct generated.question_id)
      from unnest(v_generated_question_ids) as generated(question_id)) <> 5 then
    raise exception 'Generated challenge must contain exactly five unique questions';
  end if;

  if not (v_generated_question_ids @> array['rotation-test-older'])
    or v_generated_question_ids && array['rotation-test-yesterday'] then
    raise exception 'Yesterday avoidance failed to outrank the lower appearance count';
  end if;
  if not (v_generated_question_ids @> array['rotation-test-never'])
    or v_generated_question_ids && array['rotation-test-used'] then
    raise exception 'Never-used question did not outrank a previously used question';
  end if;
  if not (v_generated_question_ids @> array['rotation-test-lru-old'])
    or v_generated_question_ids && array['rotation-test-lru-recent'] then
    raise exception 'Least-recently-used question was not selected';
  end if;

  select count(distinct questions.category)
  into v_category_count
  from public.challenge_questions as challenge_questions
  join public.questions as questions
    on questions.id = challenge_questions.question_id
  where challenge_questions.challenge_id = v_generated_challenge_id;
  if v_category_count <> 5 then
    raise exception 'Expected five distinct categories when five eligible categories exist';
  end if;

  select count(*), count(*) filter (where
    questions.is_demo is distinct from v_is_demo
    or questions.verification_status is distinct from v_verification_status
    or challenge_questions.is_demo_snapshot is distinct from v_is_demo
    or challenge_questions.verification_status_snapshot is distinct from v_verification_status
  )
  into v_snapshot_count, v_invalid_snapshot_count
  from public.challenge_questions as challenge_questions
  join public.questions as questions
    on questions.id = challenge_questions.question_id
  where challenge_questions.challenge_id = v_generated_challenge_id;
  if v_snapshot_count <> 5 or v_invalid_snapshot_count <> 0 then
    raise exception 'Demo and verified question/snapshot eligibility was mixed';
  end if;

  if not exists (
    select 1 from public.daily_challenges as daily_challenges
    where daily_challenges.id = v_generated_challenge_id
      and daily_challenges.published
  ) then
    raise exception 'Generated challenge was not published';
  end if;

  select count(*) into v_snapshot_count
  from public.challenge_questions as challenge_questions
  where challenge_questions.challenge_id = v_generated_challenge_id;
  if v_snapshot_count <> 5 then
    raise exception 'Generated challenge did not persist five assignments';
  end if;

  if exists (
    select * from pg_temp.cifra_rotation_challenges_before
    except
    select daily_challenges.id, daily_challenges.challenge_date,
      daily_challenges.is_demo, daily_challenges.published_at
    from public.daily_challenges as daily_challenges
    where daily_challenges.published
      and daily_challenges.id <> v_generated_challenge_id
  ) or exists (
    select * from public.daily_challenges as daily_challenges
    where daily_challenges.published
      and daily_challenges.id <> v_generated_challenge_id
    except
    select * from pg_temp.cifra_rotation_challenges_before
  ) or exists (
    select * from pg_temp.cifra_rotation_questions_before
    except
    select challenge_questions.challenge_id, challenge_questions.question_id,
      challenge_questions.position, challenge_questions.actual_price_snapshot,
      challenge_questions.currency_snapshot, challenge_questions.is_demo_snapshot,
      challenge_questions.verification_status_snapshot
    from public.challenge_questions as challenge_questions
    join public.daily_challenges as daily_challenges
      on daily_challenges.id = challenge_questions.challenge_id
    where daily_challenges.published
      and daily_challenges.id <> v_generated_challenge_id
  ) or exists (
    select challenge_questions.challenge_id, challenge_questions.question_id,
      challenge_questions.position, challenge_questions.actual_price_snapshot,
      challenge_questions.currency_snapshot, challenge_questions.is_demo_snapshot,
      challenge_questions.verification_status_snapshot
    from public.challenge_questions as challenge_questions
    join public.daily_challenges as daily_challenges
      on daily_challenges.id = challenge_questions.challenge_id
    where daily_challenges.published
      and daily_challenges.id <> v_generated_challenge_id
    except
    select * from pg_temp.cifra_rotation_questions_before
  ) then
    raise exception 'Previously published challenges or assignments changed';
  end if;

  raise notice 'PASS: actual get_today_challenge() generation, % mode, five unique questions, category diversity, rotation priority, eligibility, and historical immutability',
    v_mode;
end;
$test$;

rollback;
