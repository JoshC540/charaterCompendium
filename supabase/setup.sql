-- =====================================================================
--  Player's Handbook — shared notes
--  Run this once: Supabase dashboard → SQL Editor → New query → paste → Run.
--  Safe to re-run: it drops and recreates only its own policies/triggers.
-- =====================================================================

-- ---------- tables ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (length(trim(display_name)) between 1 and 40),
  is_admin     boolean not null default false,
  created_at   timestamptz not null default now()
);

create table if not exists public.campaigns (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (length(trim(name)) between 1 and 80),
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  number      int  not null check (number >= 0),
  title       text check (title is null or length(title) <= 120),
  played_on   date,
  created_by  uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (campaign_id, number)
);

create table if not exists public.notes (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  author_id  uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body       text not null check (length(trim(body)) between 1 and 20000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sessions_campaign_idx on public.sessions(campaign_id);
create index if not exists notes_session_idx     on public.notes(session_id);

-- ---------- helpers ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

-- every new login account gets a profile; Josh's account is the admin
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, is_admin)
  values (
    new.id,
    coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), initcap(split_part(new.email, '@', 1))),
    lower(new.email) = 'joshcronin540@gmail.com'
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- accounts created before this script ran
insert into public.profiles (id, display_name, is_admin)
select id, initcap(split_part(email, '@', 1)), lower(email) = 'joshcronin540@gmail.com'
from auth.users
on conflict (id) do update set is_admin = excluded.is_admin;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists notes_touch on public.notes;
create trigger notes_touch before update on public.notes
  for each row execute function public.touch_updated_at();

-- ---------- permissions ----------
alter table public.profiles  enable row level security;
alter table public.campaigns enable row level security;
alter table public.sessions  enable row level security;
alter table public.notes     enable row level security;

-- signed-out visitors get nothing
revoke all on public.profiles, public.campaigns, public.sessions, public.notes from anon;

-- only these columns can ever be changed after creation
revoke update on public.profiles, public.sessions, public.notes from authenticated;
grant  update (display_name)              on public.profiles to authenticated;
grant  update (number, title, played_on)  on public.sessions to authenticated;
grant  update (body)                      on public.notes    to authenticated;

do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies
           where schemaname = 'public' and tablename in ('profiles','campaigns','sessions','notes')
  loop execute format('drop policy %I on public.%I', p.policyname, p.tablename); end loop;
end $$;

-- everyone signed in can read everything
create policy "signed in can read" on public.profiles  for select to authenticated using (true);
create policy "signed in can read" on public.campaigns for select to authenticated using (true);
create policy "signed in can read" on public.sessions  for select to authenticated using (true);
create policy "signed in can read" on public.notes     for select to authenticated using (true);

-- profiles: rename yourself (the admin can rename anyone)
create policy "rename self or admin" on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());

-- campaigns: admin only
create policy "admin adds"    on public.campaigns for insert to authenticated with check (public.is_admin());
create policy "admin edits"   on public.campaigns for update to authenticated using (public.is_admin());
create policy "admin deletes" on public.campaigns for delete to authenticated using (public.is_admin());

-- sessions: any player can add one; its creator or the admin can edit; only the admin deletes
create policy "players add"        on public.sessions for insert to authenticated with check (created_by = auth.uid());
create policy "creator/admin edit" on public.sessions for update to authenticated using (created_by = auth.uid() or public.is_admin());
create policy "admin deletes"      on public.sessions for delete to authenticated using (public.is_admin());

-- notes: write your own; edit/delete your own; the admin can edit/delete any
create policy "players add own"     on public.notes for insert to authenticated with check (author_id = auth.uid());
create policy "author/admin edit"   on public.notes for update to authenticated using (author_id = auth.uid() or public.is_admin());
create policy "author/admin delete" on public.notes for delete to authenticated using (author_id = auth.uid() or public.is_admin());
