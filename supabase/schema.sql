-- Replay DB 구조 (Supabase 프로젝트 my-spotify에 이미 적용됨)

create table public.playlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  youtube_id text not null,            -- 유튜브 플레이리스트 ID, 좋아요 목록은 'LIKED'
  title text not null,
  thumbnail text,
  track_count int not null default 0,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (user_id, youtube_id)
);

create table public.tracks (
  id uuid primary key default gen_random_uuid(),
  playlist_id uuid not null references public.playlists(id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  video_id text not null,
  title text not null,
  channel text,
  thumbnail text,
  position int not null,
  created_at timestamptz not null default now()
);

create index tracks_playlist_id_position_idx on public.tracks (playlist_id, position);
create index tracks_user_id_idx on public.tracks (user_id);

alter table public.playlists enable row level security;
alter table public.tracks enable row level security;

create policy "own playlists select" on public.playlists for select to authenticated using ((select auth.uid()) = user_id);
create policy "own playlists insert" on public.playlists for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own playlists update" on public.playlists for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own playlists delete" on public.playlists for delete to authenticated using ((select auth.uid()) = user_id);

create policy "own tracks select" on public.tracks for select to authenticated using ((select auth.uid()) = user_id);
create policy "own tracks insert" on public.tracks for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "own tracks update" on public.tracks for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "own tracks delete" on public.tracks for delete to authenticated using ((select auth.uid()) = user_id);
