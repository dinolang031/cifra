begin;

create or replace function public.require_accepted_answers_for_game_result()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  attempt_id uuid;
  accepted_guesses numeric[];
  accepted_scores integer[];
  answer_count integer;
begin
  select challenge_attempts.id into attempt_id
  from public.challenge_attempts as challenge_attempts
  where challenge_attempts.user_id = new.user_id
    and challenge_attempts.challenge_id = new.challenge_id
  for update;
  if not found then raise exception 'challenge_attempt_not_found_or_invalid'; end if;

  select count(*)::integer,
    array_agg(challenge_attempt_answers.guess order by challenge_attempt_answers.question_position),
    array_agg(challenge_attempt_answers.score order by challenge_attempt_answers.question_position)
  into answer_count, accepted_guesses, accepted_scores
  from public.challenge_attempt_answers as challenge_attempt_answers
  where challenge_attempt_answers.attempt_id = attempt_id;
  if answer_count <> 5
    or accepted_guesses is distinct from new.guesses
    or accepted_scores is distinct from new.question_scores then
    raise exception 'game_result_requires_five_server_accepted_answers';
  end if;
  return new;
end;
$$;

drop trigger if exists require_accepted_answers_for_game_result on public.game_results;
create trigger require_accepted_answers_for_game_result
  before insert on public.game_results
  for each row execute procedure public.require_accepted_answers_for_game_result();

revoke all on function public.require_accepted_answers_for_game_result() from public, anon, authenticated;

commit;
