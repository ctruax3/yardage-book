-- SUPERSEDED: run 003_courses.sql instead (it includes everything here).
-- Yardage Book: handicap tracking. Run once in the Supabase SQL editor after schema.sql. Safe to re-run.

alter table public.profiles add column if not exists official_index numeric(4,1);
alter table public.profiles add column if not exists gender text default 'M';
alter table public.profiles add column if not exists tee_ratings jsonb;

-- Scores from other courses, or differentials copied from GHIN.
-- Rounds at The Crown are scored from rounds + hole_scores and don't need a row here.
create table if not exists public.posted_scores (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  played_on     timestamptz not null,
  course        text,
  tee           text,
  holes         smallint default 18,
  gross         smallint,
  ags           smallint,              -- adjusted gross score (net double bogey applied)
  course_rating numeric(4,1),
  slope         smallint,
  par           smallint,
  differential  numeric(4,1),          -- when entered directly from GHIN
  updated_at    timestamptz not null default now()
);
create index if not exists posted_scores_user on public.posted_scores (user_id, played_on desc);

alter table public.posted_scores enable row level security;
drop policy if exists "own rows" on public.posted_scores;
create policy "own rows" on public.posted_scores for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
