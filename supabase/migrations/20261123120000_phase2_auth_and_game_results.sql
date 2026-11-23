-- CIFRA Phase 2 schema. This migration is intentionally not applied automatically.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_length check (char_length(username) between 3 and 32)
);

create table if not exists public.questions (
  id text primary key,
  question text not null,
  item_name text not null,
  category text not null,
  actual_price numeric(12,2) not null check (actual_price > 0),
  currency text not null default 'EUR' check (currency = 'EUR'),
  unit text not null,
  location text not null,
  image_url text,
  explanation text,
  source_name text,
  source_url text,
  verification_date date,
  verification_status text not null default 'unverified'
    check (verification_status in ('verified', 'needs-review', 'expired', 'unverified')),
  is_demo boolean not null default true,
  price_type text not null default 'illustrative'
    check (price_type in ('regular', 'promotional', 'loyalty', 'online-only', 'discounted', 'delivery-app', 'illustrative')),
  is_promotional boolean not null default false,
  difficulty text not null default 'medium' check (difficulty in ('easy', 'medium', 'hard')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists questions_active_category_idx on public.questions (active, category);

create table if not exists public.daily_challenges (
  id uuid primary key default gen_random_uuid(),
  challenge_date date not null unique,
  published boolean not null default false,
  is_demo boolean not null default true,
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (id, challenge_date)
);

create table if not exists public.challenge_questions (
  challenge_id uuid not null references public.daily_challenges(id) on delete cascade,
  question_id text not null references public.questions(id),
  position smallint not null check (position between 1 and 5),
  actual_price_snapshot numeric(12,2) not null check (actual_price_snapshot > 0),
  currency_snapshot text not null check (currency_snapshot = 'EUR'),
  is_demo_snapshot boolean not null,
  verification_status_snapshot text not null
    check (verification_status_snapshot in ('verified', 'needs-review', 'expired', 'unverified')),
  primary key (challenge_id, position),
  unique (challenge_id, question_id)
);

create table if not exists public.game_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  challenge_id uuid not null,
  challenge_date date not null,
  total_score integer not null check (total_score between 0 and 5000),
  guesses numeric(12,2)[] not null
    check (
      array_ndims(guesses) = 1 and array_lower(guesses, 1) = 1 and array_upper(guesses, 1) = 5
      and array_position(guesses, null) is null
      and 0 < all(guesses) and 1000000000 >= all(guesses)
    ),
  question_scores integer[] not null
    check (
      array_ndims(question_scores) = 1 and array_lower(question_scores, 1) = 1 and array_upper(question_scores, 1) = 5
      and array_position(question_scores, null) is null
      and 0 <= all(question_scores) and 1000 >= all(question_scores)
      and total_score = question_scores[1] + question_scores[2] + question_scores[3] + question_scores[4] + question_scores[5]
    ),
  exact_guesses smallint not null check (exact_guesses between 0 and 5),
  average_error_percent numeric(16,2) not null check (average_error_percent >= 0),
  completed_at timestamptz not null default now(),
  foreign key (challenge_id, challenge_date) references public.daily_challenges(id, challenge_date),
  unique (user_id, challenge_id),
  unique (user_id, challenge_date)
);

create table if not exists public.challenge_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  challenge_id uuid not null,
  challenge_date date not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  submitted_at timestamptz,
  check (expires_at > started_at),
  check (submitted_at is null or submitted_at >= started_at),
  foreign key (challenge_id, challenge_date) references public.daily_challenges(id, challenge_date) on delete cascade,
  unique (user_id, challenge_id),
  unique (user_id, challenge_date)
);

create table if not exists public.challenge_attempt_tokens (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.challenge_attempts(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > created_at)
);

create index if not exists challenge_attempt_tokens_attempt_idx
  on public.challenge_attempt_tokens (attempt_id, expires_at);

create index if not exists game_results_user_date_idx on public.game_results (user_id, challenge_date desc);

create table if not exists public.user_statistics (
  user_id uuid primary key references auth.users(id) on delete cascade,
  current_streak integer not null default 0 check (current_streak >= 0),
  best_streak integer not null default 0 check (best_streak >= current_streak),
  last_completed_date date,
  total_games integer not null default 0 check (total_games >= 0),
  total_points bigint not null default 0 check (total_points >= 0),
  best_score integer not null default 0 check (best_score between 0 and 5000),
  exact_guesses bigint not null default 0 check (exact_guesses >= 0),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists set_profiles_updated_at on public.profiles;
create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();

revoke all on function public.set_updated_at() from public, anon, authenticated;

create or replace function public.prevent_published_challenge_question_changes()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  target_challenge_id uuid;
  is_published boolean;
begin
  if tg_op = 'UPDATE' then
    perform 1
    from public.daily_challenges
    where id in (old.challenge_id, new.challenge_id)
    order by id
    for update;

    select exists (
      select 1
      from public.daily_challenges
      where id in (old.challenge_id, new.challenge_id)
        and published
    ) into is_published;
  else
    if tg_op = 'DELETE' then
      target_challenge_id := old.challenge_id;
    else
      target_challenge_id := new.challenge_id;
    end if;

    perform 1
    from public.daily_challenges
    where id = target_challenge_id
    for update;

    select published into is_published
    from public.daily_challenges
    where id = target_challenge_id;
  end if;

  if coalesce(is_published, false) then
    raise exception 'published_challenge_questions_are_immutable';
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists protect_published_challenge_questions on public.challenge_questions;
create trigger protect_published_challenge_questions
  before insert or update or delete on public.challenge_questions
  for each row execute procedure public.prevent_published_challenge_question_changes();

revoke all on function public.prevent_published_challenge_question_changes() from public, anon, authenticated;

create or replace function public.validate_daily_challenge_publication()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
declare
  snapshot_count integer;
  valid_snapshot_count integer;
begin
  if old.published and (
    new.challenge_date is distinct from old.challenge_date
    or new.is_demo is distinct from old.is_demo
    or new.published_at is distinct from old.published_at
    or not new.published
  ) then
    raise exception 'published_challenge_is_immutable';
  end if;

  if new.published and not old.published then
    select count(*), count(*) filter (where
      cq.actual_price_snapshot > 0
      and cq.currency_snapshot = 'EUR'
      and cq.is_demo_snapshot = new.is_demo
      and (
        (new.is_demo and cq.verification_status_snapshot = 'unverified')
        or (not new.is_demo and cq.verification_status_snapshot = 'verified')
      )
    ) into snapshot_count, valid_snapshot_count
    from public.challenge_questions cq
    where cq.challenge_id = new.id;
    if snapshot_count <> 5 or valid_snapshot_count <> 5 then
      raise exception 'daily_challenge_requires_exactly_five_valid_snapshots';
    end if;
    new.published_at := coalesce(new.published_at, now());
  end if;

  return new;
end;
$$;

drop trigger if exists validate_daily_challenge_publication on public.daily_challenges;
create trigger validate_daily_challenge_publication
  before update on public.daily_challenges
  for each row execute procedure public.validate_daily_challenge_publication();

revoke all on function public.validate_daily_challenge_publication() from public, anon, authenticated;

create or replace function public.handle_new_cifra_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  base_name text;
begin
  base_name := lower(regexp_replace(
    coalesce(new.raw_user_meta_data ->> 'username', split_part(coalesce(new.email, 'igrac'), '@', 1)),
    '[^a-zA-Z0-9_-]+', '-', 'g'
  ));
  base_name := left(trim(both '-' from base_name), 20);
  if char_length(base_name) < 3 then base_name := 'igrac'; end if;

  insert into public.profiles (id, username, display_name)
  values (new.id, base_name || '-' || left(new.id::text, 8), nullif(new.raw_user_meta_data ->> 'display_name', ''))
  on conflict (id) do nothing;
  insert into public.user_statistics (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_cifra on auth.users;
create trigger on_auth_user_created_cifra
  after insert on auth.users
  for each row execute procedure public.handle_new_cifra_user();

revoke all on function public.handle_new_cifra_user() from public, anon, authenticated;

with existing_users as (
  select
    users.id,
    left(trim(both '-' from lower(regexp_replace(
      coalesce(users.raw_user_meta_data ->> 'username', split_part(coalesce(users.email, 'igrac'), '@', 1)),
      '[^a-zA-Z0-9_-]+', '-', 'g'
    ))), 20) as base_name,
    nullif(users.raw_user_meta_data ->> 'display_name', '') as display_name
  from auth.users users
)
insert into public.profiles (id, username, display_name)
select
  id,
  (case when char_length(base_name) < 3 then 'igrac' else base_name end) || '-' || left(id::text, 8),
  display_name
from existing_users
on conflict (id) do nothing;
insert into public.user_statistics (user_id)
select id from auth.users
on conflict (user_id) do nothing;

alter table public.profiles enable row level security;
alter table public.questions enable row level security;
alter table public.daily_challenges enable row level security;
alter table public.challenge_questions enable row level security;
alter table public.game_results enable row level security;
alter table public.user_statistics enable row level security;
alter table public.challenge_attempts enable row level security;
alter table public.challenge_attempt_tokens enable row level security;

drop policy if exists "Users can view their own profile" on public.profiles;
create policy "Users can view their own profile"
  on public.profiles for select to authenticated using (id = (select auth.uid()));
drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile"
  on public.profiles for update to authenticated using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists "Users can read their own results" on public.game_results;
create policy "Users can read their own results"
  on public.game_results for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "Users can read their own statistics" on public.user_statistics;
create policy "Users can read their own statistics"
  on public.user_statistics for select to authenticated using (user_id = (select auth.uid()));

revoke all on public.questions, public.daily_challenges, public.challenge_questions from public, anon, authenticated;
revoke all on public.profiles, public.game_results, public.user_statistics,
  public.challenge_attempts, public.challenge_attempt_tokens from public, anon, authenticated;
grant select on public.profiles, public.game_results, public.user_statistics to authenticated;
grant update (username, display_name, avatar_url) on public.profiles to authenticated;

-- Existing local examples are seeded as illustrative only and cannot be mistaken for verified prices.
insert into public.questions (id, question, item_name, category, actual_price, currency, unit, location, image_url, explanation, source_name, source_url, verification_date, verification_status, is_demo, price_type, is_promotional, difficulty, active) values
  ('coffee-zagreb-001', 'Koliko košta cappuccino u kafiću u Zagrebu?', 'Cappuccino', 'Piće', '2.4', 'EUR', 'jedna šalica', 'Zagreb', 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?auto=format&fit=crop&w=900&q=82', 'Ilustrativna prosječna cijena u Zagrebu.', 'Demo podatak — zamijeniti provjerenim izvorom', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('mandarine-001', 'Koliko košta kilogram mandarina na hrvatskoj tržnici?', 'Mandarine', 'Hrana', '1.8', 'EUR', '1 kg', 'Hrvatska', 'https://images.unsplash.com/photo-1547514701-42782101795e?auto=format&fit=crop&w=900&q=82', 'Ilustrativna sezonska cijena.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('fuel-diesel-001', 'Koliko košta jedan litra dizela na benzinskoj postaji?', 'Dizel', 'Gorivo', '1.55', 'EUR', '1 litra', 'Hrvatska', 'https://images.unsplash.com/photo-1545179605-5a9e0bcde12e?auto=format&fit=crop&w=900&q=82', 'Ilustrativna prosječna cijena goriva.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('apartment-split-001', 'Koliko košta prosječni kvadratni metar stana u Splitu?', 'Kvadratni metar stana', 'Stanovanje', '3800', 'EUR', '1 m²', 'Split', 'https://images.unsplash.com/photo-1545324418-cc1a3fa10c00?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena u širem centru grada.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'hard', true),
  ('museum-zagreb-001', 'Koliko košta ulaznica u Tehnički muzej u Zagrebu?', 'Ulaznica u muzej', 'Turizam', '9', 'EUR', 'odrasla osoba', 'Zagreb', 'https://images.unsplash.com/photo-1564399579883-451a5d44ec08?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena ulaznice.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('bread-001', 'Koliko košta obična baguette u hrvatskoj pekarnici?', 'Baguette', 'Hrana', '1.2', 'EUR', '1 komad', 'Hrvatska', 'https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena kruha.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('milk-001', 'Koliko košta litra trajnog mlijeka u supermarketu?', 'Trajno mlijeko', 'Supermarket', '1.15', 'EUR', '1 litra', 'Hrvatska', 'https://images.unsplash.com/photo-1550583724-b2692b85b150?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena pakiranja od litre.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('tram-zagreb-001', 'Koliko košta jedna vožnja tramvajem u Zagrebu?', 'Jedna vožnja ZET-om', 'Prijevoz', '0.53', 'EUR', 'jedna vožnja', 'Zagreb', 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena sms ulaznice.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('haircut-001', 'Koliko košta muško šišanje u Zagrebu?', 'Muško šišanje', 'Usluge', '16', 'EUR', 'jedna usluga', 'Zagreb', 'https://images.unsplash.com/photo-1503951914875-452162b0f3f1?auto=format&fit=crop&w=900&q=82', 'Ilustrativna prosječna cijena usluge.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('football-001', 'Koliko košta ulaznica za utakmicu HNL-a na zapadnoj tribini?', 'Ulaznica za nogomet', 'Sport', '12', 'EUR', 'jedna ulaznica', 'Hrvatska', 'https://images.unsplash.com/photo-1522778119026-d647f0596c20?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena ulaznice.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('water-001', 'Koliko košta boca mineralne vode od 1,5 litre u dućanu?', 'Mineralna voda', 'Supermarket', '0.85', 'EUR', '1,5 litre', 'Hrvatska', 'https://images.unsplash.com/photo-1548839140-29a749e1cf4d?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena vode u trgovini.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('pizza-001', 'Koliko košta pizza margherita u gradskoj pizzeriji?', 'Pizza Margherita', 'Hrana', '9.5', 'EUR', 'jedna pizza', 'Hrvatska', 'https://images.unsplash.com/photo-1574071318508-1cdbab80d002?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena standardne pizze.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('beer-001', 'Koliko košta točeno pale pivo od 0,5 litre u centru?', 'Točeno pivo', 'Piće', '3.2', 'EUR', '0,5 litre', 'Zagreb', 'https://images.unsplash.com/photo-1510812431401-41d2bd2722f3?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena u kafiću.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('taxi-001', 'Koliko košta kratka vožnja taksijem od 5 kilometara?', 'Taksi 5 km', 'Prijevoz', '12', 'EUR', 'oko 5 km', 'Zagreb', 'https://images.unsplash.com/photo-1551830820-330a71b99659?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena vožnje gradom.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('cinema-001', 'Koliko košta kino ulaznica u večernjem terminu?', 'Kino ulaznica', 'Zabava', '6.5', 'EUR', 'jedna ulaznica', 'Hrvatska', 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena standardne projekcije.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('ferry-001', 'Koliko košta trajektna karta Split—Supetar po vozilu?', 'Trajektna karta', 'Prijevoz', '14.2', 'EUR', 'osobni automobil', 'Split — Supetar', 'https://images.unsplash.com/photo-1578575437130-527eed3abbec?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena za vozilo i vozača.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'hard', true),
  ('rent-zagreb-001', 'Koliko košta prosječni najam jednosobnog stana u Zagrebu?', 'Jednosoban stan', 'Stanovanje', '650', 'EUR', 'mjesečno', 'Zagreb', 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena u širem centru.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'hard', true),
  ('laundry-001', 'Koliko košta pranje rublja u praonici samoposlužnog tipa?', 'Pranje rublja', 'Svakodnevni život', '6', 'EUR', 'jedan ciklus', 'Hrvatska', 'https://images.unsplash.com/photo-1582735689369-4fe89db7114c?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena jednog pranja.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('gym-001', 'Koliko košta mjesečna članarina u fitness centru?', 'Fitness članarina', 'Sport', '35', 'EUR', 'mjesečno', 'Hrvatska', 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?auto=format&fit=crop&w=900&q=82', 'Ilustrativna prosječna cijena članstva.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('museum-dubrovnik-001', 'Koliko košta ulaznica za Kraljeve dvore u Dubrovniku?', 'Ulaznica u palaču', 'Turizam', '15', 'EUR', 'odrasla osoba', 'Dubrovnik', 'https://images.unsplash.com/photo-1555990538-cde5b2c2b6a2?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena ulaznice.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'hard', true),
  ('croissant-001', 'Koliko košta masni kroasan u hrvatskoj pekarnici?', 'Kroasan', 'Hrana', '1.4', 'EUR', '1 komad', 'Hrvatska', 'https://images.unsplash.com/photo-1555507036-ab1f4038808a?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena peciva.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('eggs-001', 'Koliko košta pakiranje od 10 jaja u supermarketu?', '10 jaja', 'Supermarket', '3.3', 'EUR', '10 komada', 'Hrvatska', 'https://images.unsplash.com/photo-1506976785307-8732e854ad03?auto=format&fit=crop&w=900&q=82', 'Ilustrativna prosječna cijena.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('chicken-001', 'Koliko košta kilogram pilećih prsa u trgovini?', 'Pileća prsa', 'Hrana', '7.2', 'EUR', '1 kg', 'Hrvatska', 'https://images.unsplash.com/photo-1604503468506-a8da13d82791?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena svježeg mesa.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('gasoline-001', 'Koliko košta jedan litra euro dizela u osječkom kraju?', 'Euro dizel', 'Gorivo', '1.54', 'EUR', '1 litra', 'Osijek', 'https://images.unsplash.com/photo-1545225879-70b1c6dfcc48?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena goriva.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('icecream-001', 'Koliko košta kugla sladoleda na obali?', 'Kugla sladoleda', 'Zabava', '2', 'EUR', 'jedna kugla', 'Jadranska obala', 'https://images.unsplash.com/photo-1563805042-7684c019e1cb?auto=format&fit=crop&w=900&q=82', 'Ilustrativna sezonska cijena.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('parking-001', 'Koliko košta jedan sat parkinga u centru Zagreba?', 'Gradski parking', 'Prijevoz', '2.66', 'EUR', '1 sat', 'Zagreb', 'https://images.unsplash.com/photo-1506521781263-d8422e82f27a?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena parkinga u prvoj zoni.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'hard', true),
  ('coffee-machine-001', 'Koliko košta aparat za kavu srednje klase?', 'Aparat za kavu', 'Svakodnevni život', '89', 'EUR', 'jedan aparat', 'Hrvatska', 'https://images.unsplash.com/photo-1517668808822-9ebb02f2a0e6?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena kućnog aparata.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'hard', true),
  ('car-wash-001', 'Koliko košta vanjsko pranje osobnog automobila?', 'Vanjsko pranje automobila', 'Usluge', '8', 'EUR', 'jedna usluga', 'Hrvatska', 'https://images.unsplash.com/photo-1520340356584-f9917d1eea6f?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena osnovnog pranja.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('concert-001', 'Koliko košta prosječna ulaznica za veliki koncert u Areni Zagreb?', 'Ulaznica za koncert', 'Zabava', '40', 'EUR', 'jedna ulaznica', 'Zagreb', 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena ulaznice.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'hard', true),
  ('kayak-001', 'Koliko košta sat vremena iznajmljenog kajaka?', 'Najam kajaka', 'Turizam', '14', 'EUR', '1 sat', 'Jadranska obala', 'https://images.unsplash.com/photo-1559592413-7cec4d0cae2b?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena najma.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('tennis-001', 'Koliko košta sat najma vanjskog teniskog terena?', 'Najam teniskog terena', 'Sport', '18', 'EUR', '1 sat', 'Hrvatska', 'https://images.unsplash.com/photo-1554068865-24cecd4e34b8?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena najma terena.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('bus-zadar-001', 'Koliko košta autobusna karta Zagreb—Zadar u jednom smjeru?', 'Autobus Zagreb—Zadar', 'Prijevoz', '16', 'EUR', 'jedna karta', 'Zagreb—Zadar', 'https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena za redovitu liniju.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'hard', true),
  ('burger-001', 'Koliko košta meni burger s pomfritom u fast food restoranu?', 'Burger meni', 'Hrana', '8.5', 'EUR', 'meni', 'Hrvatska', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena standardnog menija.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('wine-001', 'Koliko košta boca običnog malvazije u dućanu?', 'Malvazija', 'Piće', '7.5', 'EUR', '0,75 litre', 'Istra', 'https://images.unsplash.com/photo-1506377247377-2a5b3b417ebb?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena vina u trgovini.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('olive-oil-001', 'Koliko košta boca ekstra djevičanskog maslinovog ulja od 0,75 litre?', 'Maslinovo ulje', 'Supermarket', '14', 'EUR', '0,75 litre', 'Istra', 'https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?auto=format&fit=crop&w=900&q=82', 'Ilustrativna prosječna cijena.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('hotel-001', 'Koliko košta dvokrevetna soba u hotelu uz more po noćenju?', 'Hotelska soba', 'Turizam', '110', 'EUR', 'po noćenju', 'Jadranska obala', 'https://images.unsplash.com/photo-1566073771259-6a8506099945?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena izvan najviše sezone.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'hard', true),
  ('bikeshare-001', 'Koliko košta dnevna karta za sustav javnih bicikala u Zagrebu?', 'Dnevna karta bicikla', 'Prijevoz', '3', 'EUR', '24 sata', 'Zagreb', 'https://images.unsplash.com/photo-1576435728678-68d0fbf94e91?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena sustava najma.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('laundromat-001', 'Koliko košta sušenje rublja u praonici samoposlužnog tipa?', 'Sušenje rublja', 'Svakodnevni život', '1.5', 'EUR', '15 minuta', 'Hrvatska', 'https://images.unsplash.com/photo-1517677208171-0bc6725a3e60?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena sušenja.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('apartment-rent-split-001', 'Koliko košta najam jednosobnog stana u Splitu?', 'Najam jednosobnog stana', 'Stanovanje', '700', 'EUR', 'mjesečno', 'Split', 'https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena u blizini centra.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'hard', true),
  ('swimming-001', 'Koliko košta ulaznica za gradski bazen?', 'Ulaznica za bazen', 'Sport', '4.5', 'EUR', 'jedno kupanje', 'Hrvatska', 'https://images.unsplash.com/photo-1530549387789-4c1017266635?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena dnevne ulaznice.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('plumber-001', 'Koliko košta dolazak vodoinstalatera kući?', 'Dolazak vodoinstalatera', 'Usluge', '40', 'EUR', 'jedna intervencija', 'Hrvatska', 'https://images.unsplash.com/photo-1585704032915-c3400ca199e7?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena početne intervencije.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'hard', true),
  ('toothpaste-001', 'Koliko košta pasta za zube od 75 ml u ljekarni?', 'Pasta za zube', 'Svakodnevni život', '3.8', 'EUR', '75 ml', 'Hrvatska', 'https://images.unsplash.com/photo-1559591937-f91d8e872c1c?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena srednjeg raspona.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('chocolate-001', 'Koliko košta čokolada od 100 grama u supermarketu?', 'Čokolada 100 g', 'Supermarket', '2.2', 'EUR', '100 g', 'Hrvatska', 'https://images.unsplash.com/photo-1549007994-cb92caebd54b?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena popularne čokolade.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('apple-001', 'Koliko košta kilogram domaćih jabuka?', 'Domaće jabuke', 'Hrana', '1.5', 'EUR', '1 kg', 'Hrvatska', 'https://images.unsplash.com/photo-1560806887-1e4cd0b6cbd6?auto=format&fit=crop&w=900&q=82', 'Ilustrativna sezonska cijena.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('icecream-tub-001', 'Koliko košta litre kutija sladoleda u trgovini?', 'Kutija sladoleda', 'Hrana', '5.5', 'EUR', '1 litra', 'Hrvatska', 'https://images.unsplash.com/photo-1497034825429-c343d7c6a68f?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena kutije sladoleda.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('train-001', 'Koliko košta povratna vlakna karta Zagreb—Rijeka u drugom razredu?', 'Vlak Zagreb—Rijeka', 'Prijevoz', '20', 'EUR', 'povratna karta', 'Zagreb—Rijeka', 'https://images.unsplash.com/photo-1474487548417-781cb71495f3?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena povratne karte.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'hard', true),
  ('amusement-001', 'Koliko košta ulaznica u zabavni park na jednodnevni posjet?', 'Ulaznica u zabavni park', 'Zabava', '25', 'EUR', 'odrasla osoba', 'Hrvatska', 'https://images.unsplash.com/photo-1513889961551-628c1e5e2ee9?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena ulaznice.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('wifi-001', 'Koliko košta mjesec standardnog kućnog interneta 300 Mb/s?', 'Kućni internet', 'Usluge', '22', 'EUR', 'mjesečno', 'Hrvatska', 'https://images.unsplash.com/photo-1544197150-b99a580bb7a8?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena tarife.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true),
  ('bread-loaf-001', 'Koliko košta kilogram običnog bijelog kruha?', 'Bijeli kruh', 'Hrana', '3.2', 'EUR', '1 kg', 'Hrvatska', 'https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena kruha po kilogramu.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('vegetables-001', 'Koliko košta kilogram rajčice na tržnici?', 'Rajčice', 'Hrana', '2.8', 'EUR', '1 kg', 'Hrvatska', 'https://images.unsplash.com/photo-1561136594-7f68413baa99?auto=format&fit=crop&w=900&q=82', 'Ilustrativna sezonska cijena.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'easy', true),
  ('bus-ticket-001', 'Koliko košta gradska autobusna karta u Rijeci?', 'Gradska karta', 'Prijevoz', '1.5', 'EUR', 'jedna vožnja', 'Rijeka', 'https://images.unsplash.com/photo-1494515843206-f3117d3f51b7?auto=format&fit=crop&w=900&q=82', 'Ilustrativna cijena jednosmjerne karte.', 'Demo podatak', null, null, 'unverified', true, 'illustrative', false, 'medium', true)
on conflict (id) do nothing;

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
  values (
    authenticated_user_id,
    challenge_row.id,
    today_in_croatia
  )
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

  select array_agg(challenge_questions.actual_price_snapshot order by challenge_questions.position) into actual_prices
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

revoke all on function public.get_today_challenge() from public, anon, authenticated;
revoke all on function public.start_daily_attempt(date) from public, anon, authenticated;
revoke all on function public.submit_daily_result(date, numeric[], text) from public, anon, authenticated;
grant execute on function public.get_today_challenge() to authenticated;
grant execute on function public.start_daily_attempt(date) to authenticated;
grant execute on function public.submit_daily_result(date, numeric[], text) to authenticated;
