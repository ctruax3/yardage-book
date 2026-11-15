-- The Yardage Book: friends, rounds feed, leaderboard. Run once in the Supabase SQL editor. Safe to re-run.

create table if not exists public.public_profiles (user_id uuid primary key default auth.uid() references auth.users on delete cascade, display_name text, idx numeric(4,1), low_idx numeric(4,1), rounds int default 0, share boolean not null default true, discoverable boolean not null default true, updated_at timestamptz not null default now());

create table if not exists public.follows (id uuid primary key default gen_random_uuid(), follower uuid not null default auth.uid() references auth.users on delete cascade, followee uuid not null references auth.users on delete cascade, created_at timestamptz not null default now(), unique (follower, followee), check (follower <> followee));

create table if not exists public.feed_items (id uuid primary key, user_id uuid not null default auth.uid() references auth.users on delete cascade, played_on timestamptz not null, course text, tee text, holes smallint, gross smallint, par smallint, differential numeric(4,1), stats jsonb, card jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create index if not exists feed_items_user on public.feed_items (user_id, played_on desc);

alter table public.public_profiles enable row level security;
alter table public.follows enable row level security;
alter table public.feed_items enable row level security;

drop policy if exists "see profiles" on public.public_profiles;
create policy "see profiles" on public.public_profiles for select to authenticated using (discoverable or user_id = auth.uid() or exists (select 1 from public.follows f where f.follower = auth.uid() and f.followee = public_profiles.user_id));
drop policy if exists "own profile" on public.public_profiles;
create policy "own profile" on public.public_profiles for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "see my follows" on public.follows;
create policy "see my follows" on public.follows for select to authenticated using (follower = auth.uid() or followee = auth.uid());
drop policy if exists "follow" on public.follows;
create policy "follow" on public.follows for insert to authenticated with check (follower = auth.uid());
drop policy if exists "unfollow" on public.follows;
create policy "unfollow" on public.follows for delete to authenticated using (follower = auth.uid());

drop policy if exists "see feed" on public.feed_items;
create policy "see feed" on public.feed_items for select to authenticated using (user_id = auth.uid() or (exists (select 1 from public.follows f where f.follower = auth.uid() and f.followee = feed_items.user_id) and exists (select 1 from public.public_profiles p where p.user_id = feed_items.user_id and p.share)));
drop policy if exists "own feed" on public.feed_items;
create policy "own feed" on public.feed_items for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

notify pgrst, 'reload schema';
