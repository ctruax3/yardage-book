-- Yardage Book: account storage for scores + a shared course database.
-- Run once in the Supabase SQL editor (after schema.sql). Includes everything from 002_handicap.sql,
-- so you can skip 002. Safe to re-run.

-- ---------------------------------------------------------------- profile settings
alter table public.profiles add column if not exists official_index numeric(4,1);
alter table public.profiles add column if not exists gender text default 'M';
alter table public.profiles add column if not exists tee_ratings jsonb;

-- ---------------------------------------------------------------- shared course database
-- One row per course. tees: [{ "name": "Blue", "gender": "M", "rating": 70.0, "slope": 128, "par": 72, "yards": 6532, "holes": 18 }, ...]
create table if not exists public.courses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  city        text,
  state       text,
  country     text,
  tees        jsonb not null default '[]'::jsonb,
  source      text not null default 'user',      -- 'user' (entered by a golfer) or 'golfcourseapi'
  source_id   text unique,                       -- id at the data provider
  created_by  uuid default auth.uid() references auth.users on delete set null,
  updated_at  timestamptz not null default now()
);
create index if not exists courses_name on public.courses (lower(name));

alter table public.courses enable row level security;
drop policy if exists "anyone can read courses" on public.courses;
create policy "anyone can read courses" on public.courses for select to anon, authenticated using (true);
drop policy if exists "golfers add courses" on public.courses;
create policy "golfers add courses" on public.courses for insert to authenticated with check (created_by = auth.uid() and source = 'user');
drop policy if exists "golfers edit their courses" on public.courses;
create policy "golfers edit their courses" on public.courses for update to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid() and source = 'user');

-- The Crown (verify against GHIN; edit here or in the app)
insert into public.courses (name, city, state, country, tees, source, source_id, created_by)
values ('The Crown Golf Club', 'Traverse City', 'MI', 'USA',
  '[{"name":"Black","gender":"M","rating":72.1,"slope":137,"par":72,"holes":18},
    {"name":"Blue","gender":"M","rating":70.0,"slope":128,"par":72,"holes":18},
    {"name":"Blue/White","gender":"M","rating":68.3,"slope":126,"par":72,"holes":18},
    {"name":"White","gender":"M","rating":66.1,"slope":116,"par":72,"holes":18},
    {"name":"Blue","gender":"F","rating":76.2,"slope":134,"par":72,"holes":18},
    {"name":"White","gender":"F","rating":71.4,"slope":126,"par":72,"holes":18}]'::jsonb,
  'seed', 'seed:the-crown', null)
on conflict (source_id) do nothing;

-- ---------------------------------------------------------------- scores from other courses / imports
create table if not exists public.posted_scores (
  id            uuid primary key,
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  played_on     timestamptz not null,
  course        text,
  tee           text,
  holes         smallint default 18,
  gross         smallint,
  ags           smallint,              -- adjusted gross score
  course_rating numeric(4,1),
  slope         smallint,
  par           smallint,
  differential  numeric(4,1),          -- when entered directly from GHIN
  updated_at    timestamptz not null default now()
);
alter table public.posted_scores add column if not exists course_id uuid references public.courses on delete set null;
create index if not exists posted_scores_user on public.posted_scores (user_id, played_on desc);

alter table public.posted_scores enable row level security;
drop policy if exists "own rows" on public.posted_scores;
create policy "own rows" on public.posted_scores for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- tell the API about the new tables/columns right away
notify pgrst, 'reload schema';
