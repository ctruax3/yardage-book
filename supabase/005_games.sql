-- The Yardage Book: play together. Friends on the same course join one group round; each
-- player keeps their own scorecard and sees everyone else's scores live.
-- Run once in the Supabase SQL editor (after 004_social.sql). Safe to re-run.

create table if not exists public.games (
  id         uuid primary key,
  host       uuid not null default auth.uid() references auth.users on delete cascade,
  course     text not null default 'crown',
  format     text not null default 'stroke',     -- stroke | match
  net        boolean not null default true,       -- use handicaps
  status     text not null default 'active',      -- active | done
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.game_players (
  game_id      uuid not null references public.games on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  round_id     uuid,                    -- this player's own round (rounds.id)
  display_name text,
  tee          text,
  course_hcp   smallint,
  joined_at    timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (game_id, user_id)
);
create index if not exists game_players_round on public.game_players (round_id);
create index if not exists game_players_user on public.game_players (user_id);

alter table public.rounds add column if not exists game_id uuid;

-- what friends see on Home: "Sam is on the course · hole 6 · Join"
alter table public.public_profiles add column if not exists live_game uuid;
alter table public.public_profiles add column if not exists live_hole smallint;
alter table public.public_profiles add column if not exists live_at timestamptz;

-- am I in this group? (security definer so policies can ask without looping)
create or replace function public.is_game_member(gid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.game_players where game_id = gid and user_id = auth.uid());
$$;

alter table public.games enable row level security;
alter table public.game_players enable row level security;

drop policy if exists "see my games" on public.games;
create policy "see my games" on public.games for select to authenticated using (host = auth.uid() or public.is_game_member(id));
drop policy if exists "host games" on public.games;
create policy "host games" on public.games for insert to authenticated with check (host = auth.uid());
drop policy if exists "host edits games" on public.games;
create policy "host edits games" on public.games for update to authenticated using (host = auth.uid()) with check (host = auth.uid());

drop policy if exists "see my group" on public.game_players;
create policy "see my group" on public.game_players for select to authenticated using (public.is_game_member(game_id));
drop policy if exists "edit my spot" on public.game_players;
create policy "edit my spot" on public.game_players for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "leave a group" on public.game_players;
create policy "leave a group" on public.game_players for delete to authenticated using (user_id = auth.uid());
-- joining goes through join_game() below

-- group members can read each other's hole scores (only for rounds tied to the group)
drop policy if exists "see group scores" on public.hole_scores;
create policy "see group scores" on public.hole_scores for select to authenticated using (
  exists (select 1 from public.game_players gp where gp.round_id = hole_scores.round_id and public.is_game_member(gp.game_id)));

-- join (or update my spot in) a group. Anyone with the group's link can join while it's active.
create or replace function public.join_game(gid uuid, rid uuid, name text, tee text, hcp smallint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if not exists (select 1 from public.games where id = gid and status = 'active' and created_at > now() - interval '24 hours') then
    raise exception 'This group round has finished';
  end if;
  insert into public.game_players (game_id, user_id, round_id, display_name, tee, course_hcp)
  values (gid, auth.uid(), rid, name, tee, hcp)
  on conflict (game_id, user_id) do update set round_id = excluded.round_id, display_name = excluded.display_name,
    tee = excluded.tee, course_hcp = excluded.course_hcp, updated_at = now();
end $$;

-- what an invite link shows before joining: who's playing and the format
create or replace function public.game_preview(gid uuid)
returns json language sql stable security definer set search_path = public as $$
  select json_build_object('id', g.id, 'format', g.format, 'net', g.net, 'status', g.status,
    'open', g.status = 'active' and g.created_at > now() - interval '24 hours',
    'players', coalesce((select json_agg(p.display_name order by p.joined_at) from public.game_players p where p.game_id = g.id), '[]'::json))
  from public.games g where g.id = gid;
$$;

grant execute on function public.join_game(uuid, uuid, text, text, smallint) to authenticated;
grant execute on function public.game_preview(uuid) to authenticated;
grant execute on function public.is_game_member(uuid) to authenticated;

-- live updates: scores and players stream to the other phones in the group
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['hole_scores', 'game_players', 'games'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

notify pgrst, 'reload schema';
