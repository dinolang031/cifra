-- Supplemental comparator scenario. daily_question_rotation_generation.sql
-- exercises the actual get_today_challenge() generation function.
do $$
declare
  selected_question text;
begin
  with candidates(question_id, appearances, last_appeared) as (
    values
      ('yesterday-question', 2, date '2026-03-10'),
      ('older-alternative', 7, date '2026-03-07')
  ),
  ranked as (
    select candidates.question_id,
      row_number() over (
        order by
          case when candidates.appearances = 0 then 0 else 1 end,
          case when candidates.last_appeared = date '2026-03-11' - 1 then 1 else 0 end,
          candidates.last_appeared nulls first,
          candidates.appearances,
          candidates.question_id
      ) as selection_order
    from candidates
  )
  select ranked.question_id into selected_question
  from ranked
  where ranked.selection_order = 1;

  if selected_question <> 'older-alternative' then
    raise exception 'Question rotation regression: expected the older alternative, got %', selected_question;
  end if;

  with candidates(question_id, appearances, last_appeared) as (
    values
      ('previously-used', 1, date '2026-03-07'),
      ('never-used', 0, null::date)
  ),
  ranked as (
    select candidates.question_id,
      row_number() over (
        order by
          case when candidates.appearances = 0 then 0 else 1 end,
          case when candidates.last_appeared = date '2026-03-11' - 1 then 1 else 0 end,
          candidates.last_appeared nulls first,
          candidates.appearances,
          candidates.question_id
      ) as selection_order
    from candidates
  )
  select ranked.question_id into selected_question
  from ranked
  where ranked.selection_order = 1;

  if selected_question <> 'never-used' then
    raise exception 'Question rotation regression: expected a never-used question, got %', selected_question;
  end if;
end;
$$;
