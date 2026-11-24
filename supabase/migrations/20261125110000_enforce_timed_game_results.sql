begin;

do $stage_c$
begin
  if to_regprocedure('public.require_accepted_answers_for_game_result()') is null then
    raise exception 'phase3_timed_gameplay_migration_must_be_applied_first';
  end if;

  if not exists (
    select 1
    from pg_trigger as triggers
    where triggers.tgrelid = 'public.game_results'::regclass
      and triggers.tgname = 'require_accepted_answers_for_game_result'
      and not triggers.tgisinternal
  ) then
    execute $create_trigger$
      create trigger require_accepted_answers_for_game_result
      before insert on public.game_results
      for each row execute procedure public.require_accepted_answers_for_game_result()
    $create_trigger$;
  end if;

  execute 'alter table public.game_results enable trigger require_accepted_answers_for_game_result';
end;
$stage_c$;

commit;
