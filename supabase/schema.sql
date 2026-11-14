-- Yardage Book: accounts, rounds, scorecard and shot tracking.
-- Run once in the Supabase SQL editor. Safe to re-run.
-- Every table is locked so a signed-in person can only see and change their own rows.

create table if not exists public.profiles (
  user_id      uuid primary key default auth.uid() references auth.users on delete cascade,
  display_name text,
  default_tee  text,
  bag          jsonb,                      -- clubs in the bag, in order
  updated_at   timestamptz not null default now()
);

create table if not exists public.rounds (
  id          uuid primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  course      text not null,               -- e.g. 'crown'
  tee         text,
  started_at  timestamptz not null,
  ended_at    timestamptz,
  status      text not null default 'active',   -- active | done
  weather     jsonb,                       -- wind/temp snapshot at the start
  updated_at  timestamptz not null default now()
);

create table if not exists public.hole_scores (
  round_id   uuid not null references public.rounds on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  hole       smallint not null check (hole between 1 and 18),
  score      smallint,
  putts      smallint,
  fairway    text,                         -- hit | left | right | null (par 3s)
  penalties  smallint default 0,
  updated_at timestamptz not null default now(),
  primary key (round_id, hole)
);

create table if not exists public.shots (
  id         uuid primary key,
  round_id   uuid not null references public.rounds on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  hole       smallint not null check (hole between 1 and 18),
  seq        smallint not null,            -- order within the hole
  kind       text not null default 'shot', -- shot | penalty | ongreen
  club       text,
  lat        double precision,             -- where the ball was when this shot was hit
  lon        double precision,
  accuracy   real,                         -- GPS accuracy in metres (null when placed on the map)
  source     text,                         -- gps | map
  taken_at   timestamptz not null,
  weather    jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists shots_user_course_hole on public.shots (user_id, hole);
create index if not exists rounds_user on public.rounds (user_id, started_at desc);

alter table public.profiles    enable row level security;
alter table public.rounds      enable row level security;
alter table public.hole_scores enable row level security;
alter table public.shots       enable row level security;

do $$
declare t text;
begin
  foreach t in array array['profiles','rounds','hole_scores','shots'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;
