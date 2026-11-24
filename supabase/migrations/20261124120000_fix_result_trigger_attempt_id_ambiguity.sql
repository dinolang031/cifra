begin;

create or replace function public.require_accepted_answers_for_game_result()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
#variable_conflict error
declare
  v_attempt_id uuid;
  v_accepted_guesses numeric[];
  v_accepted_scores integer[];
  v_answer_count integer;
begin
  select challenge_attempts.id
  into v_attempt_id
  from public.challenge_attempts as challenge_attempts
  where challenge_attempts.user_id = new.user_id
    and challenge_attempts.challenge_id = new.challenge_id
  for update;
  if not found then raise exception 'challenge_attempt_not_found_or_invalid'; end if;

  select count(*)::integer,
    array_agg(answer_rows.guess order by answer_rows.question_position),
    array_agg(answer_rows.score order by answer_rows.question_position)
  into v_answer_count, v_accepted_guesses, v_accepted_scores
  from public.challenge_attempt_answers as answer_rows
  where answer_rows.attempt_id = v_attempt_id;

  if v_answer_count <> 5
    or v_accepted_guesses is distinct from new.guesses
    or v_accepted_scores is distinct from new.question_scores then
    raise exception 'game_result_requires_five_server_accepted_answers';
  end if;

  return new;
end;
$$;

revoke all on function public.require_accepted_answers_for_game_result() from public, anon, authenticated;

commit;
