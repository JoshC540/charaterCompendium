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

-- ---------- admin password reset (no email needed) ----------
-- Lets the admin set a player's password from the site's account menu.
create or replace function public.admin_set_password(target_email text, new_password text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.is_admin() then raise exception 'Only the admin can reset passwords'; end if;
  if length(coalesce(new_password, '')) < 8 then raise exception 'Use at least 8 characters'; end if;
  update auth.users
     set encrypted_password = crypt(new_password, gen_salt('bf')), updated_at = now()
   where lower(email) = lower(trim(target_email));
  if not found then raise exception 'No player has that email'; end if;
end $$;
revoke all on function public.admin_set_password(text, text) from public, anon;
grant execute on function public.admin_set_password(text, text) to authenticated;

-- ---------- characters (character builder) ----------
-- Each player sees and edits their own characters; the admin can see (and delete) everyone's.
create table if not exists public.characters (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  name       text not null check (length(trim(name)) between 1 and 80),
  summary    text check (summary is null or length(summary) <= 200),
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists characters_owner_idx on public.characters(owner_id);
drop trigger if exists characters_touch on public.characters;
create trigger characters_touch before update on public.characters
  for each row execute function public.touch_updated_at();

alter table public.characters enable row level security;
revoke all on public.characters from anon;
revoke update on public.characters from authenticated;
grant  update (name, summary, data) on public.characters to authenticated;
drop policy if exists "owner or admin reads" on public.characters;
drop policy if exists "owner adds"          on public.characters;
drop policy if exists "owner edits"         on public.characters;
drop policy if exists "owner/admin deletes" on public.characters;
create policy "owner or admin reads" on public.characters for select to authenticated using (owner_id = auth.uid() or public.is_admin());
create policy "owner adds"          on public.characters for insert to authenticated with check (owner_id = auth.uid());
create policy "owner edits"         on public.characters for update to authenticated using (owner_id = auth.uid());
create policy "owner/admin deletes" on public.characters for delete to authenticated using (owner_id = auth.uid() or public.is_admin());

-- =====================================================================
--  Campaign members, and party money
--  Players are added to campaigns by the admin. A character can belong to one campaign.
--  Money moves only through the functions below, so the rules (two approvals, no overdrawing)
--  can't be bypassed from the browser.
-- =====================================================================

-- ---------- campaign members ----------
create table if not exists public.campaign_members (
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  added_at    timestamptz not null default now(),
  primary key (campaign_id, user_id)
);
alter table public.campaign_members enable row level security;
revoke all on public.campaign_members from anon;
drop policy if exists "signed in can read" on public.campaign_members;
drop policy if exists "admin adds"         on public.campaign_members;
drop policy if exists "admin removes"      on public.campaign_members;
create policy "signed in can read" on public.campaign_members for select to authenticated using (true);
create policy "admin adds"         on public.campaign_members for insert to authenticated with check (public.is_admin());
create policy "admin removes"      on public.campaign_members for delete to authenticated using (public.is_admin());

create or replace function public.is_member(c uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.campaign_members where campaign_id = c and user_id = auth.uid())
$$;

-- ---------- which campaign a character is in ----------
alter table public.characters add column if not exists campaign_id uuid references public.campaigns(id) on delete set null;
grant update (name, summary, data, campaign_id) on public.characters to authenticated;

create or replace function public.characters_campaign_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.campaign_id is not null and not public.is_admin()
     and not exists (select 1 from public.campaign_members where campaign_id = new.campaign_id and user_id = new.owner_id) then
    raise exception 'You''re not a player in that campaign';
  end if;
  return new;
end $$;
drop trigger if exists characters_campaign on public.characters;
create trigger characters_campaign before insert or update of campaign_id on public.characters
  for each row execute function public.characters_campaign_check();

-- ---------- party money ----------
-- One ledger for every account: character_id null = the campaign's shared party account,
-- otherwise that character's purse. Amounts are in copper (100 cp = 1 sp, 100 sp = 1 gp, 100 gp = 1 pp).
create table if not exists public.money_tx (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.campaigns(id) on delete cascade,
  character_id uuid references public.characters(id) on delete cascade,
  amount_cp    bigint not null check (amount_cp <> 0),
  kind         text not null check (kind in ('deposit', 'withdrawal', 'gift', 'spend', 'adjust')),
  reason       text check (reason is null or length(reason) <= 200),
  game_date    text check (game_date is null or length(game_date) <= 60),
  request_id   uuid,
  created_by   uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists money_tx_account_idx on public.money_tx(campaign_id, character_id);

create table if not exists public.money_requests (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.campaigns(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  amount_cp    bigint not null check (amount_cp > 0),
  reason       text check (reason is null or length(reason) <= 200),
  game_date    text check (game_date is null or length(game_date) <= 60),
  requested_by uuid references public.profiles(id) on delete set null,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'cancelled')),
  resolved_by  uuid references public.profiles(id) on delete set null,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists money_requests_campaign_idx on public.money_requests(campaign_id, status);

create table if not exists public.money_votes (
  request_id uuid not null references public.money_requests(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  voted_at   timestamptz not null default now(),
  primary key (request_id, user_id)
);

alter table public.money_tx       enable row level security;
alter table public.money_requests enable row level security;
alter table public.money_votes    enable row level security;
revoke all on public.money_tx, public.money_requests, public.money_votes from anon, authenticated;
grant select on public.money_tx, public.money_requests, public.money_votes to authenticated;
drop policy if exists "who can see" on public.money_tx;
drop policy if exists "who can see" on public.money_requests;
drop policy if exists "who can see" on public.money_votes;
-- the party account and its requests: the campaign's players; a purse: its owner; everything: the admin
create policy "who can see" on public.money_tx for select to authenticated using (
  public.is_admin()
  or (character_id is null and public.is_member(campaign_id))
  or exists (select 1 from public.characters ch where ch.id = character_id and ch.owner_id = auth.uid()));
create policy "who can see" on public.money_requests for select to authenticated using (public.is_admin() or public.is_member(campaign_id));
create policy "who can see" on public.money_votes for select to authenticated using (
  public.is_admin() or exists (select 1 from public.money_requests r where r.id = request_id and public.is_member(r.campaign_id)));

-- internal helpers (not callable from the site)
create or replace function public._money_balance(c uuid, ch uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount_cp), 0)::bigint from public.money_tx where campaign_id = c and character_id is not distinct from ch
$$;
create or replace function public._money_lock(c uuid) returns void
language sql security definer set search_path = public as $$ select pg_advisory_xact_lock(hashtextextended(c::text, 0)) $$;
create or replace function public._money_member(c uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if not (public.is_member(c) or public.is_admin()) then raise exception 'You''re not a player in this campaign'; end if;
end $$;
create or replace function public._money_own(c uuid, ch uuid) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.characters where id = ch and campaign_id = c and (owner_id = auth.uid() or public.is_admin())) then
    raise exception 'That character isn''t yours, or isn''t in this campaign';
  end if;
end $$;
create or replace function public._money_fmt(cp bigint) returns text
language sql immutable as $$
  select coalesce(nullif(concat_ws(' ',
    case when cp / 1000000 > 0 then (cp / 1000000) || ' pp' end,
    case when cp % 1000000 / 10000 > 0 then (cp % 1000000 / 10000) || ' gp' end,
    case when cp % 10000 / 100 > 0 then (cp % 10000 / 100) || ' sp' end,
    case when cp % 100 > 0 then (cp % 100) || ' cp' end), ''), '0 cp')
$$;
create or replace function public._money_pay(r public.money_requests) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.money_tx (campaign_id, character_id, amount_cp, kind, reason, game_date, request_id)
  values (r.campaign_id, null, -r.amount_cp, 'withdrawal', r.reason, r.game_date, r.id),
         (r.campaign_id, r.character_id, r.amount_cp, 'withdrawal', r.reason, r.game_date, r.id);
  update public.money_requests set status = 'approved', resolved_by = auth.uid(), resolved_at = now() where id = r.id;
end $$;
revoke all on function public._money_balance(uuid, uuid), public._money_lock(uuid), public._money_member(uuid),
  public._money_own(uuid, uuid), public._money_pay(public.money_requests) from public, anon, authenticated;

-- put coin from a character's purse into the party account
create or replace function public.money_deposit(c uuid, ch uuid, amount bigint, reason text default null, game_date text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._money_member(c); perform public._money_own(c, ch);
  if coalesce(amount, 0) <= 0 then raise exception 'Enter an amount'; end if;
  perform public._money_lock(c);
  if public._money_balance(c, ch) < amount then raise exception 'Not enough in this purse (it has %)', public._money_fmt(public._money_balance(c, ch)); end if;
  insert into public.money_tx (campaign_id, character_id, amount_cp, kind, reason, game_date)
  values (c, ch, -amount, 'deposit', reason, game_date), (c, null, amount, 'deposit', reason, game_date);
end $$;

-- ask to take coin from the party account into a character's purse; asking counts as the first approval
create or replace function public.money_request(c uuid, ch uuid, amount bigint, reason text default null, game_date text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare rid uuid; bal bigint;
begin
  perform public._money_member(c); perform public._money_own(c, ch);
  if coalesce(amount, 0) <= 0 then raise exception 'Enter an amount'; end if;
  bal := public._money_balance(c, null);
  if bal < amount then raise exception 'The party account only has %', public._money_fmt(bal); end if;
  insert into public.money_requests (campaign_id, character_id, amount_cp, reason, game_date, requested_by)
  values (c, ch, amount, reason, game_date, auth.uid()) returning id into rid;
  insert into public.money_votes (request_id, user_id) values (rid, auth.uid());
  if public.is_admin() then perform public.money_approve(rid); end if;   -- the DM's own requests go straight through
  return rid;
end $$;

-- approve a request: a second player's approval pays it out; the admin's approval pays it out at once.
-- Returns 'approved', 'waiting' (needs another player) or 'short' (approved, but the party account can't cover it yet)
create or replace function public.money_approve(rid uuid) returns text
language plpgsql security definer set search_path = public as $$
declare r public.money_requests; votes int;
begin
  select * into r from public.money_requests where id = rid for update;
  if not found then raise exception 'That request no longer exists'; end if;
  perform public._money_member(r.campaign_id);
  if r.status <> 'pending' then raise exception 'That request is already %', r.status; end if;
  insert into public.money_votes (request_id, user_id) values (rid, auth.uid()) on conflict do nothing;
  select count(*) into votes from public.money_votes v
   where v.request_id = rid and exists (select 1 from public.campaign_members m where m.campaign_id = r.campaign_id and m.user_id = v.user_id);
  if not public.is_admin() and votes < 2 then return 'waiting'; end if;
  if not exists (select 1 from public.characters where id = r.character_id and campaign_id = r.campaign_id) then
    update public.money_requests set status = 'cancelled', resolved_by = auth.uid(), resolved_at = now() where id = rid;
    raise exception 'That character has left the campaign, so the request was cancelled';
  end if;
  perform public._money_lock(r.campaign_id);
  if public._money_balance(r.campaign_id, null) < r.amount_cp then return 'short'; end if;
  perform public._money_pay(r);
  return 'approved';
end $$;

-- withdraw a request (whoever asked), or turn it down (the admin)
create or replace function public.money_cancel(rid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.money_requests;
begin
  select * into r from public.money_requests where id = rid for update;
  if not found then raise exception 'That request no longer exists'; end if;
  if not (r.requested_by = auth.uid() or public.is_admin()) then raise exception 'Only the player who asked, or the DM, can cancel this'; end if;
  if r.status <> 'pending' then raise exception 'That request is already %', r.status; end if;
  update public.money_requests set status = 'cancelled', resolved_by = auth.uid(), resolved_at = now() where id = rid;
end $$;

-- hand coin from one character's purse to another character in the same campaign
create or replace function public.money_give(c uuid, from_ch uuid, to_ch uuid, amount bigint, reason text default null, game_date text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._money_member(c); perform public._money_own(c, from_ch);
  if from_ch = to_ch then raise exception 'Choose another character'; end if;
  if not exists (select 1 from public.characters where id = to_ch and campaign_id = c) then raise exception 'That character isn''t in this campaign'; end if;
  if coalesce(amount, 0) <= 0 then raise exception 'Enter an amount'; end if;
  perform public._money_lock(c);
  if public._money_balance(c, from_ch) < amount then raise exception 'Not enough in this purse (it has %)', public._money_fmt(public._money_balance(c, from_ch)); end if;
  insert into public.money_tx (campaign_id, character_id, amount_cp, kind, reason, game_date)
  values (c, from_ch, -amount, 'gift', reason, game_date), (c, to_ch, amount, 'gift', reason, game_date);
end $$;

-- spend coin from a character's purse (shops, inns, bribes…)
create or replace function public.money_spend(c uuid, ch uuid, amount bigint, reason text default null, game_date text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public._money_member(c); perform public._money_own(c, ch);
  if coalesce(amount, 0) <= 0 then raise exception 'Enter an amount'; end if;
  perform public._money_lock(c);
  if public._money_balance(c, ch) < amount then raise exception 'Not enough in this purse (it has %)', public._money_fmt(public._money_balance(c, ch)); end if;
  insert into public.money_tx (campaign_id, character_id, amount_cp, kind, reason, game_date) values (c, ch, -amount, 'spend', reason, game_date);
end $$;

-- the DM adds or removes coin (loot, rewards, fines, fees); ch null = the party account
create or replace function public.money_adjust(c uuid, ch uuid, amount bigint, reason text default null, game_date text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Only the DM can add or remove coin'; end if;
  if coalesce(amount, 0) = 0 then raise exception 'Enter an amount'; end if;
  if ch is not null and not exists (select 1 from public.characters where id = ch and campaign_id = c) then raise exception 'That character isn''t in this campaign'; end if;
  perform public._money_lock(c);
  if public._money_balance(c, ch) + amount < 0 then raise exception 'That would leave the account below zero (it has %)', public._money_fmt(public._money_balance(c, ch)); end if;
  insert into public.money_tx (campaign_id, character_id, amount_cp, kind, reason, game_date) values (c, ch, amount, 'adjust', reason, game_date);
end $$;

revoke all on function public.money_deposit(uuid, uuid, bigint, text, text), public.money_request(uuid, uuid, bigint, text, text),
  public.money_approve(uuid), public.money_cancel(uuid), public.money_give(uuid, uuid, uuid, bigint, text, text),
  public.money_spend(uuid, uuid, bigint, text, text), public.money_adjust(uuid, uuid, bigint, text, text) from public, anon;
grant execute on function public.money_deposit(uuid, uuid, bigint, text, text), public.money_request(uuid, uuid, bigint, text, text),
  public.money_approve(uuid), public.money_cancel(uuid), public.money_give(uuid, uuid, uuid, bigint, text, text),
  public.money_spend(uuid, uuid, bigint, text, text), public.money_adjust(uuid, uuid, bigint, text, text) to authenticated;

-- the characters in a campaign (names only), for choosing who to give coin to
create or replace function public.campaign_characters(c uuid) returns table (id uuid, name text, owner_id uuid)
language sql stable security definer set search_path = public as $$
  select ch.id, ch.name, ch.owner_id from public.characters ch
  where ch.campaign_id = c and (public.is_member(c) or public.is_admin()) order by ch.name
$$;
revoke all on function public.campaign_characters(uuid) from public, anon;
grant execute on function public.campaign_characters(uuid) to authenticated;

-- =====================================================================
--  Live character sheets (HP, temporary HP, statuses, trackers at the table)
--  One row per character. The owner and the DM can change it, and only through
--  play_change(), so damage from the DM and healing from the player never overwrite
--  each other. Players in the same campaign can see each other's.
-- =====================================================================
create table if not exists public.character_play (
  character_id uuid primary key references public.characters(id) on delete cascade,
  data         jsonb not null default '{}'::jsonb,
  updated_by   uuid default auth.uid() references public.profiles(id) on delete set null,
  updated_at   timestamptz not null default now()
);
alter table public.character_play enable row level security;
revoke all on public.character_play from anon, authenticated;
grant select on public.character_play to authenticated;
-- (a function, so it can look at the character even when the reader can't open its sheet)
create or replace function public.play_visible(ch uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (select 1 from public.characters c where c.id = ch
    and (c.owner_id = auth.uid() or (c.campaign_id is not null and public.is_member(c.campaign_id))))
$$;
drop policy if exists "who can see" on public.character_play;
create policy "who can see" on public.character_play for select to authenticated using (public.play_visible(character_id));

-- change a character's live state: hp_delta is damage (negative, taken from temporary HP first) or
-- healing (positive, up to max HP); patch replaces whole top-level keys (statuses, trackers, temp, max, notes…)
create or replace function public.play_change(ch uuid, hp_delta int default 0, patch jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb; hp int; mx int; tmp int; dmg int; t int;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if not exists (select 1 from public.characters where id = ch and (owner_id = auth.uid() or public.is_admin())) then
    raise exception 'Only the character''s player, or the DM, can change this';
  end if;
  if patch is null or jsonb_typeof(patch) <> 'object' then patch := '{}'::jsonb; end if;
  if length(patch::text) > 20000 then raise exception 'That''s too much to save at once'; end if;
  insert into public.character_play (character_id) values (ch) on conflict do nothing;
  select data into d from public.character_play where character_id = ch for update;
  d := d || (patch - 'hp');
  if patch ? 'hp' then d := d || jsonb_build_object('hp', greatest(0, (patch->>'hp')::int)); end if;
  if coalesce(hp_delta, 0) <> 0 then
    mx  := coalesce((d->>'max')::int, 0);
    hp  := coalesce((d->>'hp')::int, mx);
    tmp := greatest(0, coalesce((d->>'temp')::int, 0));
    if hp_delta < 0 then
      dmg := -hp_delta; t := least(tmp, dmg); tmp := tmp - t; dmg := dmg - t;
      hp := greatest(0, hp - dmg);
    else
      hp := case when mx > 0 then least(mx, hp + hp_delta) else hp + hp_delta end;
    end if;
    d := d || jsonb_build_object('hp', hp, 'temp', tmp);
  end if;
  update public.character_play set data = d, updated_by = auth.uid(), updated_at = now() where character_id = ch;
  return d;
end $$;
revoke all on function public.play_change(uuid, int, jsonb) from public, anon;
grant execute on function public.play_change(uuid, int, jsonb) to authenticated;

-- live updates for the combat tracker and the play view (Supabase Realtime), where it's available
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'character_play') then
    execute 'alter publication supabase_realtime add table public.character_play';
  end if;
end $$;

-- =====================================================================
--  The atlas: places, factions, people, creatures, items and lore the party uncovers
--  The DM writes every entry; players only ever receive entries the DM has revealed.
--  The DM's private notes live in a separate table only the DM can read.
-- =====================================================================
create table if not exists public.atlas (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'place' check (kind in ('place', 'faction', 'person', 'creature', 'item', 'lore')),
  name        text not null check (length(trim(name)) between 1 and 120),
  region      text check (region is null or length(region) <= 80),
  summary     text not null default '' check (length(summary) <= 20000),
  image_url   text check (image_url is null or (length(image_url) <= 500 and image_url ~* '^https://')),
  revealed    boolean not null default false,
  revealed_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create table if not exists public.atlas_dm (
  id    uuid primary key references public.atlas(id) on delete cascade,
  notes text not null default '' check (length(notes) <= 20000)
);
drop trigger if exists atlas_touch on public.atlas;
create trigger atlas_touch before update on public.atlas for each row execute function public.touch_updated_at();
create or replace function public.atlas_reveal_time() returns trigger
language plpgsql as $$ begin
  if new.revealed and (tg_op = 'INSERT' or not old.revealed) then new.revealed_at = now(); end if;
  return new;
end $$;
drop trigger if exists atlas_reveal on public.atlas;
create trigger atlas_reveal before insert or update of revealed on public.atlas for each row execute function public.atlas_reveal_time();

alter table public.atlas    enable row level security;
alter table public.atlas_dm enable row level security;
revoke all on public.atlas, public.atlas_dm from anon;
do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies where schemaname = 'public' and tablename in ('atlas', 'atlas_dm')
  loop execute format('drop policy %I on public.%I', p.policyname, p.tablename); end loop;
end $$;
create policy "revealed, or the DM" on public.atlas for select to authenticated using (revealed or public.is_admin());
create policy "DM adds"     on public.atlas for insert to authenticated with check (public.is_admin());
create policy "DM edits"    on public.atlas for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "DM deletes"  on public.atlas for delete to authenticated using (public.is_admin());
create policy "DM only"     on public.atlas_dm for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- pins on an atlas entry's picture (a map). Players see a pin only when the map and the entry it
-- points to are both revealed: the atlas rules above already hide unrevealed entries from them.
create table if not exists public.atlas_pins (
  id         uuid primary key default gen_random_uuid(),
  map_id     uuid not null references public.atlas(id) on delete cascade,
  entry_id   uuid not null references public.atlas(id) on delete cascade,
  x          real not null check (x >= 0 and x <= 100),
  y          real not null check (y >= 0 and y <= 100),
  created_at timestamptz not null default now(),
  check (map_id <> entry_id)
);
alter table public.atlas_pins enable row level security;
revoke all on public.atlas_pins from anon;
drop policy if exists "both revealed, or the DM" on public.atlas_pins;
drop policy if exists "DM only" on public.atlas_pins;
create policy "both revealed, or the DM" on public.atlas_pins for select to authenticated using (
  public.is_admin() or (exists (select 1 from public.atlas a where a.id = map_id and a.revealed)
                        and exists (select 1 from public.atlas a where a.id = entry_id and a.revealed)));
create policy "DM only" on public.atlas_pins for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- =====================================================================
--  The DM's planning space: the session screen (planned encounters, reveal queue, loot, notes),
--  one row per campaign. Only the DM can read or write it.
-- =====================================================================
create table if not exists public.dm_store (
  key        text primary key check (length(key) between 1 and 80),
  data       jsonb not null default '{}'::jsonb check (length(data::text) <= 500000),
  updated_at timestamptz not null default now()
);
drop trigger if exists dm_store_touch on public.dm_store;
create trigger dm_store_touch before update on public.dm_store for each row execute function public.touch_updated_at();
alter table public.dm_store enable row level security;
revoke all on public.dm_store from anon;
drop policy if exists "DM only" on public.dm_store;
create policy "DM only" on public.dm_store for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- per-campaign rules the DM sets on the session screen (for now: how players roll stats)
alter table public.campaigns add column if not exists settings jsonb not null default '{}'::jsonb;

-- =====================================================================
--  Atlas pictures, uploaded straight to Supabase Storage (bucket "atlas", private).
--  Files sit under the entry's id ("<entry id>/<file>"). Players can load a picture only when its
--  entry is revealed (the atlas rules above decide that); only the DM can upload or delete.
-- =====================================================================
alter table public.atlas add column if not exists image_path text
  check (image_path is null or image_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$');

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('atlas', 'atlas', false, 8388608, array['image/webp', 'image/jpeg', 'image/png', 'image/gif'])
      on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
    execute 'drop policy if exists "atlas pictures: revealed entries" on storage.objects';
    execute 'drop policy if exists "atlas pictures: DM uploads" on storage.objects';
    execute 'drop policy if exists "atlas pictures: DM changes" on storage.objects';
    execute 'drop policy if exists "atlas pictures: DM deletes" on storage.objects';
    execute $p$create policy "atlas pictures: revealed entries" on storage.objects for select to authenticated using (
      bucket_id = 'atlas' and (public.is_admin() or exists (
        select 1 from public.atlas a where a.id::text = split_part(storage.objects.name, '/', 1) and a.revealed)))$p$;
    execute $p$create policy "atlas pictures: DM uploads" on storage.objects for insert to authenticated with check (bucket_id = 'atlas' and public.is_admin())$p$;
    execute $p$create policy "atlas pictures: DM changes" on storage.objects for update to authenticated using (bucket_id = 'atlas' and public.is_admin())$p$;
    execute $p$create policy "atlas pictures: DM deletes" on storage.objects for delete to authenticated using (bucket_id = 'atlas' and public.is_admin())$p$;
  end if;
end $$;

-- =====================================================================
--  The table's dice log. Rolls are made on the server (roll_dice below), so nobody can type in a result,
--  and saved per campaign. Everyone in the campaign sees players' rolls; the DM's hidden rolls only the DM sees.
-- =====================================================================
create table if not exists public.rolls (
  id           bigint generated always as identity primary key,
  campaign_id  uuid not null references public.campaigns(id) on delete cascade,
  character_id uuid references public.characters(id) on delete set null,
  user_id      uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  who          text not null check (length(who) <= 80),
  what         text not null check (length(what) <= 120),
  total        int not null,
  detail       jsonb not null default '{}'::jsonb,
  hidden       boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists rolls_campaign_time on public.rolls (campaign_id, created_at desc);
alter table public.rolls enable row level security;
revoke all on public.rolls from anon;
revoke insert, update on public.rolls from authenticated;
grant select, delete on public.rolls to authenticated;
drop policy if exists "the table sees its rolls" on public.rolls;
drop policy if exists "DM clears rolls" on public.rolls;
create policy "the table sees its rolls" on public.rolls for select to authenticated
  using (public.is_admin() or (not hidden and public.is_member(campaign_id)));
create policy "DM clears rolls" on public.rolls for delete to authenticated using (public.is_admin());

-- dice: up to six terms like 2d6, d20, +3, -1 (at most 50 dice of up to 1000 sides each).
-- A d20 check against a stat ("need") succeeds on a d20 of the stat or more after bonuses: a natural 1 fails,
-- a natural 20 succeeds. Advantage keeps the higher of two d20s, disadvantage the lower. Exhaustion 3 rolls 2d3
-- alongside (a 2 fails the roll); exhaustion 4 rolls 1d2 alongside (a 1 means death). Freeze halves the dice.
create or replace function public.roll_dice(c uuid, ch uuid default null, what text default 'Roll', dice text default 'd20',
  need int default null, mode text default 'normal', bonus int default 0, exh int default 0, halve boolean default false, secret boolean default false)
returns public.rolls language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid(); adm boolean := public.is_admin(); nm text; expr text; m text[];
  sign int; n int; sides int; terms jsonb := '[]'::jsonb; dice_total int := 0; flat int := 0; k int; r int; one jsonb;
  d1 int; d2 int; kept int; nat int; outcome text; side jsonb; row public.rolls; is_check boolean;
begin
  if me is null then raise exception 'Sign in first'; end if;
  if not (adm or public.is_member(c)) then raise exception 'You are not in this campaign'; end if;
  if secret and not adm then raise exception 'Only the DM can roll in secret'; end if;
  if ch is not null and not exists (select 1 from characters x where x.id = ch and (x.owner_id = me or adm)) then raise exception 'That is not your character'; end if;
  expr := lower(regexp_replace(coalesce(dice, ''), '\s', '', 'g'));
  if expr !~ '^[+-]?([0-9]{0,2}d[0-9]{1,4}|[0-9]{1,4})([+-]([0-9]{0,2}d[0-9]{1,4}|[0-9]{1,4})){0,5}$' then raise exception 'Write dice like 2d6+3 or d20'; end if;
  what := left(coalesce(nullif(trim(what), ''), 'Roll'), 120);
  mode := case when mode in ('adv', 'dis') then mode else 'normal' end;
  is_check := expr = 'd20' and need is not null;
  if is_check then
    d1 := 1 + floor(random() * 20)::int; d2 := 1 + floor(random() * 20)::int;
    kept := case mode when 'adv' then greatest(d1, d2) when 'dis' then least(d1, d2) else d1 end;
    nat := kept;
    dice_total := kept + coalesce(bonus, 0);
    outcome := case when nat = 1 then 'fail' when nat = 20 then 'success' when dice_total >= need then 'success' else 'fail' end;
    terms := jsonb_build_array(jsonb_build_object('dice', 'd20', 'rolls', case when mode = 'normal' then jsonb_build_array(d1) else jsonb_build_array(d1, d2) end));
  else
    for m in select regexp_matches(expr, '([+-]?)([0-9]{0,2})d([0-9]{1,4})|([+-]?)([0-9]{1,4})', 'g') loop
      if m[3] is not null then
        sign := case when m[1] = '-' then -1 else 1 end; n := greatest(1, coalesce(nullif(m[2], '')::int, 1)); sides := m[3]::int;
        if n > 50 or sides < 2 or sides > 1000 then raise exception 'Up to 50 dice of 2 to 1000 sides'; end if;
        one := '[]'::jsonb;
        for k in 1..n loop r := 1 + floor(random() * sides)::int; one := one || to_jsonb(r); dice_total := dice_total + sign * r; end loop;
        terms := terms || jsonb_build_object('dice', (case when sign < 0 then '-' else '' end) || n || 'd' || sides, 'rolls', one);
      else
        flat := flat + (case when m[4] = '-' then -1 else 1 end) * m[5]::int;
      end if;
    end loop;
    if halve then dice_total := floor(dice_total / 2.0)::int; end if;
    dice_total := dice_total + flat + coalesce(bonus, 0);
  end if;
  if exh = 3 then
    d1 := 1 + floor(random() * 3)::int; d2 := 1 + floor(random() * 3)::int;
    side := jsonb_build_object('exhaustion', 3, 'rolls', jsonb_build_array(d1, d2), 'fails', d1 + d2 = 2);
    if d1 + d2 = 2 then outcome := 'fail'; end if;
  elsif exh = 4 then
    d1 := 1 + floor(random() * 2)::int;
    side := jsonb_build_object('exhaustion', 4, 'rolls', jsonb_build_array(d1), 'death', d1 = 1);
    if d1 = 1 then outcome := 'death'; end if;
  end if;
  select coalesce((select x.name from characters x where x.id = ch), case when adm then 'DM' end, (select display_name from profiles where id = me), 'Someone') into nm;
  insert into rolls (campaign_id, character_id, user_id, who, what, total, detail, hidden)
  values (c, ch, me, left(nm, 80), what, dice_total,
    jsonb_strip_nulls(jsonb_build_object('dice', expr, 'terms', terms, 'flat', nullif(flat, 0), 'bonus', nullif(bonus, 0), 'mode', nullif(mode, 'normal'),
      'need', need, 'nat', nat, 'outcome', outcome, 'side', side, 'halved', case when halve and not is_check then true end)), secret)
  returning * into row;
  -- keep the log to the latest 500 rolls a campaign
  delete from rolls where campaign_id = c and id in (select id from rolls where campaign_id = c order by id desc offset 500);
  return row;
end $$;
revoke all on function public.roll_dice(uuid, uuid, text, text, int, text, int, int, boolean, boolean) from public, anon;
grant execute on function public.roll_dice(uuid, uuid, text, text, int, text, int, int, boolean, boolean) to authenticated;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'rolls') then
    alter publication supabase_realtime add table public.rolls;
  end if;
end $$;

-- =====================================================================
--  The party stash: things the party holds together (spoils, parts, loot). Anyone in the campaign can put
--  something in. Taking something out works like party money: asking counts as the first approval, a second
--  player's approval hands it over, and the DM's approval hands it over at once. What's handed over waits on the
--  character's live sheet ("inbox") until the player adds it to their inventory.
-- =====================================================================
create table if not exists public.stash (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  name        text not null check (length(trim(name)) between 1 and 120),
  qty         int not null check (qty > 0 and qty <= 100000),
  notes       text check (notes is null or length(notes) <= 200),
  added_by    uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists stash_campaign_idx on public.stash(campaign_id);
create table if not exists public.stash_log (
  id           bigint generated always as identity primary key,
  campaign_id  uuid not null references public.campaigns(id) on delete cascade,
  item         text not null,
  qty          int not null,
  character_id uuid references public.characters(id) on delete set null,
  reason       text check (reason is null or length(reason) <= 200),
  by_user      uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create table if not exists public.stash_requests (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references public.campaigns(id) on delete cascade,
  stash_id     uuid references public.stash(id) on delete set null,
  item         text not null,
  character_id uuid not null references public.characters(id) on delete cascade,
  qty          int not null check (qty > 0),
  requested_by uuid references public.profiles(id) on delete set null,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'cancelled')),
  resolved_by  uuid references public.profiles(id) on delete set null,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now()
);
create table if not exists public.stash_votes (
  request_id uuid not null references public.stash_requests(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  voted_at   timestamptz not null default now(),
  primary key (request_id, user_id)
);
alter table public.stash enable row level security;
alter table public.stash_log enable row level security;
alter table public.stash_requests enable row level security;
alter table public.stash_votes enable row level security;
revoke all on public.stash, public.stash_log, public.stash_requests, public.stash_votes from anon, authenticated;
grant select on public.stash, public.stash_log, public.stash_requests, public.stash_votes to authenticated;
drop policy if exists "the party sees it" on public.stash;
drop policy if exists "the party sees it" on public.stash_log;
drop policy if exists "the party sees it" on public.stash_requests;
drop policy if exists "the party sees it" on public.stash_votes;
create policy "the party sees it" on public.stash for select to authenticated using (public.is_admin() or public.is_member(campaign_id));
create policy "the party sees it" on public.stash_log for select to authenticated using (public.is_admin() or public.is_member(campaign_id));
create policy "the party sees it" on public.stash_requests for select to authenticated using (public.is_admin() or public.is_member(campaign_id));
create policy "the party sees it" on public.stash_votes for select to authenticated using (
  public.is_admin() or exists (select 1 from public.stash_requests r where r.id = request_id and public.is_member(r.campaign_id)));

-- put something in (merges with an item of the same name and notes)
create or replace function public.stash_add(c uuid, item text, qty int default 1, notes text default null, reason text default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare sid uuid; nm text := left(trim(coalesce(item, '')), 120); nt text := nullif(left(trim(coalesce(notes, '')), 200), '');
begin
  perform public._money_member(c);
  if nm = '' then raise exception 'Name the item'; end if;
  if coalesce(stash_add.qty, 0) <= 0 or stash_add.qty > 100000 then raise exception 'Enter how many'; end if;
  perform public._money_lock(c);
  select x.id into sid from stash x where x.campaign_id = c and lower(x.name) = lower(nm) and coalesce(x.notes, '') = coalesce(nt, '') limit 1;
  if sid is null then insert into stash (campaign_id, name, qty, notes) values (c, nm, stash_add.qty, nt) returning id into sid;
  else update stash x set qty = x.qty + stash_add.qty, updated_at = now() where x.id = sid; end if;
  insert into stash_log (campaign_id, item, qty, reason) values (c, nm, stash_add.qty, nullif(left(coalesce(stash_add.reason, ''), 200), ''));
  return sid;
end $$;

-- hand an approved request over: out of the stash, into the character's inbox on their live sheet
create or replace function public._stash_give(r public.stash_requests) returns text
language plpgsql security definer set search_path = public as $$
declare s public.stash;
begin
  select * into s from stash where id = r.stash_id for update;
  if not found or s.qty < r.qty then return 'short'; end if;
  if s.qty = r.qty then delete from stash where id = s.id; else update stash set qty = qty - r.qty, updated_at = now() where id = s.id; end if;
  insert into stash_log (campaign_id, item, qty, character_id, reason) values (r.campaign_id, r.item, -r.qty, r.character_id, 'Taken out');
  insert into character_play (character_id, data, updated_by, updated_at) values (r.character_id, '{}'::jsonb, auth.uid(), now()) on conflict (character_id) do nothing;
  update character_play set data = jsonb_set(data, '{inbox}', coalesce(data->'inbox', '[]'::jsonb)
      || jsonb_build_array(jsonb_build_object('name', r.item, 'qty', r.qty, 'notes', coalesce(s.notes, ''), 'from', 'the party stash', 'at', now()))),
    updated_by = auth.uid(), updated_at = now() where character_id = r.character_id;
  update stash_requests set status = 'approved', resolved_by = auth.uid(), resolved_at = now() where id = r.id;
  return 'approved';
end $$;
revoke all on function public._stash_give(public.stash_requests) from public, anon, authenticated;

create or replace function public.stash_approve(rid uuid) returns text
language plpgsql security definer set search_path = public as $$
declare r public.stash_requests; votes int;
begin
  select * into r from stash_requests where id = rid for update;
  if not found then raise exception 'That request no longer exists'; end if;
  perform public._money_member(r.campaign_id);
  if r.status <> 'pending' then raise exception 'That request is already %', r.status; end if;
  insert into stash_votes (request_id, user_id) values (rid, auth.uid()) on conflict do nothing;
  select count(*) into votes from stash_votes v
   where v.request_id = rid and exists (select 1 from campaign_members m where m.campaign_id = r.campaign_id and m.user_id = v.user_id);
  if not public.is_admin() and votes < 2 then return 'waiting'; end if;
  if not exists (select 1 from characters where id = r.character_id and campaign_id = r.campaign_id) then
    update stash_requests set status = 'cancelled', resolved_by = auth.uid(), resolved_at = now() where id = rid;
    raise exception 'That character has left the campaign, so the request was cancelled';
  end if;
  perform public._money_lock(r.campaign_id);
  return public._stash_give(r);
end $$;

create or replace function public.stash_request(s uuid, ch uuid, qty int default 1) returns uuid
language plpgsql security definer set search_path = public as $$
declare it public.stash; rid uuid;
begin
  select * into it from stash where id = s;
  if not found then raise exception 'That item isn''t in the stash any more'; end if;
  perform public._money_member(it.campaign_id); perform public._money_own(it.campaign_id, ch);
  if coalesce(stash_request.qty, 0) <= 0 then raise exception 'Enter how many'; end if;
  if stash_request.qty > it.qty then raise exception 'The stash only has %', it.qty; end if;
  insert into stash_requests (campaign_id, stash_id, item, character_id, qty, requested_by) values (it.campaign_id, s, it.name, ch, stash_request.qty, auth.uid()) returning id into rid;
  insert into stash_votes (request_id, user_id) values (rid, auth.uid());
  if public.is_admin() then perform public.stash_approve(rid); end if;
  return rid;
end $$;

create or replace function public.stash_cancel(rid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare r public.stash_requests;
begin
  select * into r from stash_requests where id = rid for update;
  if not found then raise exception 'That request no longer exists'; end if;
  if not (r.requested_by = auth.uid() or public.is_admin()) then raise exception 'Only the player who asked, or the DM, can cancel this'; end if;
  if r.status <> 'pending' then raise exception 'That request is already %', r.status; end if;
  update stash_requests set status = 'cancelled', resolved_by = auth.uid(), resolved_at = now() where id = rid;
end $$;

-- the DM takes something out without a request (used up, lost, sold)
create or replace function public.stash_remove(s uuid, qty int, reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare it public.stash;
begin
  if not public.is_admin() then raise exception 'Only the DM can do that'; end if;
  select * into it from stash where id = s for update;
  if not found then raise exception 'That item isn''t in the stash any more'; end if;
  if coalesce(stash_remove.qty, 0) <= 0 or stash_remove.qty > it.qty then raise exception 'Enter how many (up to %)', it.qty; end if;
  if stash_remove.qty = it.qty then delete from stash x where x.id = s; else update stash x set qty = it.qty - stash_remove.qty, updated_at = now() where x.id = s; end if;
  insert into stash_log (campaign_id, item, qty, reason) values (it.campaign_id, it.name, -stash_remove.qty, coalesce(nullif(left(coalesce(stash_remove.reason, ''), 200), ''), 'Removed by the DM'));
end $$;

revoke all on function public.stash_add(uuid, text, int, text, text), public.stash_approve(uuid), public.stash_request(uuid, uuid, int),
  public.stash_cancel(uuid), public.stash_remove(uuid, int, text) from public, anon;
grant execute on function public.stash_add(uuid, text, int, text, text), public.stash_approve(uuid), public.stash_request(uuid, uuid, int),
  public.stash_cancel(uuid), public.stash_remove(uuid, int, text) to authenticated;

-- =====================================================================
--  What players see of a fight the DM is running: the turn order, whose turn it is, and how hurt everyone looks
--  (words for enemies, never their numbers). The DM's combat tracker writes it; the campaign's players read it.
-- =====================================================================
create table if not exists public.fight_view (
  campaign_id uuid primary key references public.campaigns(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb check (length(data::text) <= 100000),
  updated_at  timestamptz not null default now()
);
alter table public.fight_view enable row level security;
revoke all on public.fight_view from anon;
drop policy if exists "the party follows it" on public.fight_view;
drop policy if exists "DM runs it" on public.fight_view;
create policy "the party follows it" on public.fight_view for select to authenticated using (public.is_admin() or public.is_member(campaign_id));
create policy "DM runs it" on public.fight_view for all to authenticated using (public.is_admin()) with check (public.is_admin());
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'fight_view') then
    alter publication supabase_realtime add table public.fight_view;
  end if;
end $$;

-- =====================================================================
--  Shops. The DM opens a shop for a campaign, with stock and prices. Players buy straight from a character's purse;
--  what they buy waits on that character's sheet to add to their inventory. Selling to a shop is an offer the DM
--  accepts (the coin goes into the purse) or turns down (the item goes back to the sheet).
-- =====================================================================
alter table public.money_tx drop constraint if exists money_tx_kind_check;
alter table public.money_tx add constraint money_tx_kind_check check (kind in ('deposit', 'withdrawal', 'gift', 'spend', 'adjust', 'sale', 'reward'));

create table if not exists public.shops (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  name        text not null check (length(name) between 1 and 80),
  place       text check (place is null or length(place) <= 80),
  blurb       text check (blurb is null or length(blurb) <= 1000),
  price_pct   int not null default 100 check (price_pct between 1 and 1000),
  sell_pct    int not null default 50 check (sell_pct between 0 and 100),
  open        boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create table if not exists public.shop_stock (
  id         uuid primary key default gen_random_uuid(),
  shop_id    uuid not null references public.shops(id) on delete cascade,
  ref        text check (ref is null or length(ref) <= 80),
  name       text not null check (length(name) between 1 and 120),
  quality    text not null default 'Normal' check (length(quality) <= 20),
  price_cp   bigint not null check (price_cp >= 0),
  qty        int check (qty is null or qty >= 0),
  notes      text check (notes is null or length(notes) <= 300),
  gear       jsonb check (gear is null or length(gear::text) <= 2000),
  created_at timestamptz not null default now()
);
create index if not exists shop_stock_shop_idx on public.shop_stock(shop_id);
create table if not exists public.shop_log (
  id           bigserial primary key,
  shop_id      uuid references public.shops(id) on delete set null,
  campaign_id  uuid not null references public.campaigns(id) on delete cascade,
  character_id uuid references public.characters(id) on delete set null,
  kind         text not null check (kind in ('buy', 'sell')),
  item         text not null,
  qty          int not null,
  total_cp     bigint not null,
  created_by   uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists shop_log_campaign_idx on public.shop_log(campaign_id, id desc);
create table if not exists public.shop_offers (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  campaign_id  uuid not null references public.campaigns(id) on delete cascade,
  character_id uuid not null references public.characters(id) on delete cascade,
  item         jsonb not null check (length(item::text) <= 4000),
  qty          int not null check (qty > 0),
  ask_cp       bigint not null check (ask_cp >= 0),
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  offered_by   uuid default auth.uid() references public.profiles(id) on delete set null,
  resolved_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists shop_offers_campaign_idx on public.shop_offers(campaign_id, status);
drop trigger if exists shops_touch on public.shops;
create trigger shops_touch before update on public.shops for each row execute function public.touch_updated_at();

alter table public.shops       enable row level security;
alter table public.shop_stock  enable row level security;
alter table public.shop_log    enable row level security;
alter table public.shop_offers enable row level security;
revoke all on public.shops, public.shop_stock, public.shop_log, public.shop_offers from anon;
revoke insert, update, delete on public.shop_log, public.shop_offers from authenticated;
drop policy if exists "open shops" on public.shops;
drop policy if exists "DM runs shops" on public.shops;
drop policy if exists "stock of open shops" on public.shop_stock;
drop policy if exists "DM stocks shops" on public.shop_stock;
drop policy if exists "the party sees it" on public.shop_log;
drop policy if exists "the party sees it" on public.shop_offers;
create policy "open shops" on public.shops for select to authenticated using (public.is_admin() or (open and public.is_member(campaign_id)));
create policy "DM runs shops" on public.shops for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "stock of open shops" on public.shop_stock for select to authenticated using (
  public.is_admin() or exists (select 1 from public.shops s where s.id = shop_id and s.open and public.is_member(s.campaign_id)));
create policy "DM stocks shops" on public.shop_stock for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "the party sees it" on public.shop_log for select to authenticated using (public.is_admin() or public.is_member(campaign_id));
create policy "the party sees it" on public.shop_offers for select to authenticated using (public.is_admin() or public.is_member(campaign_id));

-- something arrives on a character's sheet (bought, or handed back), to add to their inventory
create or replace function public._sheet_inbox(ch uuid, thing jsonb) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into character_play (character_id, data, updated_by, updated_at) values (ch, '{}'::jsonb, auth.uid(), now()) on conflict (character_id) do nothing;
  update character_play set data = jsonb_set(data, '{inbox}', coalesce(data->'inbox', '[]'::jsonb) || jsonb_build_array(thing || jsonb_build_object('at', now()))),
    updated_by = auth.uid(), updated_at = now() where character_id = ch;
end $$;
revoke all on function public._sheet_inbox(uuid, jsonb) from public, anon, authenticated;

create or replace function public.shop_buy(st uuid, ch uuid, n int default 1) returns text
language plpgsql security definer set search_path = public as $$
declare k public.shop_stock; s public.shops; total bigint;
begin
  select * into k from shop_stock where id = st for update;
  if not found then raise exception 'That isn''t for sale any more'; end if;
  select * into s from shops where id = k.shop_id;
  perform public._money_member(s.campaign_id); perform public._money_own(s.campaign_id, ch);
  if not s.open and not public.is_admin() then raise exception 'This shop is closed'; end if;
  if coalesce(n, 0) < 1 or n > 999 then raise exception 'Choose how many'; end if;
  if k.qty is not null and k.qty < n then raise exception 'They only have % left', k.qty; end if;
  total := k.price_cp * n;
  perform public._money_lock(s.campaign_id);
  if total > 0 then
    if public._money_balance(s.campaign_id, ch) < total then raise exception 'Not enough in this purse (it has %)', public._money_fmt(public._money_balance(s.campaign_id, ch)); end if;
    insert into money_tx (campaign_id, character_id, amount_cp, kind, reason)
    values (s.campaign_id, ch, -total, 'spend', left(format('Bought %s%s at %s', case when n > 1 then n || ' × ' else '' end, k.name, s.name), 200));
  end if;
  if k.qty is not null then update shop_stock x set qty = k.qty - n where x.id = k.id; end if;
  insert into shop_log (shop_id, campaign_id, character_id, kind, item, qty, total_cp) values (s.id, s.campaign_id, ch, 'buy', k.name, n, total);
  perform public._sheet_inbox(ch, jsonb_strip_nulls(jsonb_build_object('name', k.name, 'qty', n, 'notes', coalesce(k.notes, ''), 'from', s.name,
    'ref', k.ref, 'q', nullif(k.quality, 'Normal'), 'g', k.gear)));
  return public._money_fmt(total);
end $$;

create or replace function public.shop_offer(sh uuid, ch uuid, item jsonb, n int, ask bigint) returns uuid
language plpgsql security definer set search_path = public as $$
declare s public.shops; rid uuid;
begin
  select * into s from shops where id = sh;
  if not found then raise exception 'That shop isn''t there any more'; end if;
  perform public._money_member(s.campaign_id); perform public._money_own(s.campaign_id, ch);
  if not s.open and not public.is_admin() then raise exception 'This shop is closed'; end if;
  if coalesce(n, 0) < 1 then raise exception 'Choose how many'; end if;
  if item is null or coalesce(item->>'name', '') = '' then raise exception 'Choose what to sell'; end if;
  insert into shop_offers (shop_id, campaign_id, character_id, item, qty, ask_cp) values (sh, s.campaign_id, ch, item, n, greatest(0, coalesce(ask, 0)))
  returning id into rid;
  return rid;
end $$;

create or replace function public.shop_offer_answer(oid uuid, accept boolean) returns void
language plpgsql security definer set search_path = public as $$
declare o public.shop_offers; s public.shops;
begin
  if not public.is_admin() then raise exception 'Only the DM can answer an offer'; end if;
  select * into o from shop_offers where id = oid for update;
  if not found or o.status <> 'pending' then raise exception 'That offer has already been answered'; end if;
  select * into s from shops where id = o.shop_id;
  if accept then
    perform public._money_lock(o.campaign_id);
    if o.ask_cp > 0 then
      insert into money_tx (campaign_id, character_id, amount_cp, kind, reason)
      values (o.campaign_id, o.character_id, o.ask_cp, 'sale', left(format('Sold %s%s to %s', case when o.qty > 1 then o.qty || ' × ' else '' end, o.item->>'name', coalesce(s.name, 'a shop')), 200));
    end if;
    insert into shop_log (shop_id, campaign_id, character_id, kind, item, qty, total_cp) values (o.shop_id, o.campaign_id, o.character_id, 'sell', o.item->>'name', o.qty, o.ask_cp);
  else
    perform public._sheet_inbox(o.character_id, o.item || jsonb_build_object('qty', o.qty, 'from', coalesce(s.name, 'the shop') || ' (not sold)'));
  end if;
  update shop_offers set status = case when accept then 'accepted' else 'declined' end, resolved_at = now() where id = oid;
end $$;

create or replace function public.shop_offer_cancel(oid uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.shop_offers;
begin
  select * into o from shop_offers where id = oid for update;
  if not found or o.status <> 'pending' then raise exception 'That offer has already been answered'; end if;
  if not (public.is_admin() or o.offered_by = auth.uid()) then raise exception 'Only whoever made the offer can take it back'; end if;
  perform public._sheet_inbox(o.character_id, o.item || jsonb_build_object('qty', o.qty, 'from', 'your offer (taken back)'));
  update shop_offers set status = 'cancelled', resolved_at = now() where id = oid;
end $$;
revoke all on function public.shop_buy(uuid, uuid, int), public.shop_offer(uuid, uuid, jsonb, int, bigint), public.shop_offer_answer(uuid, boolean), public.shop_offer_cancel(uuid) from public, anon;
grant execute on function public.shop_buy(uuid, uuid, int), public.shop_offer(uuid, uuid, jsonb, int, bigint), public.shop_offer_answer(uuid, boolean), public.shop_offer_cancel(uuid) to authenticated;

-- =====================================================================
--  The guild's contract board. The DM posts contracts; the campaign's players see them and take one on.
--  When the DM marks one done, its reward goes into the party account.
-- =====================================================================
create table if not exists public.contracts (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  title       text not null check (length(title) between 1 and 120),
  client      text check (client is null or length(client) <= 80),
  tier        int check (tier is null or tier between 0 and 20),
  reward_cp   bigint not null default 0 check (reward_cp >= 0),
  details     text check (details is null or length(details) <= 3000),
  deadline    text check (deadline is null or length(deadline) <= 60),
  status      text not null default 'open' check (status in ('draft', 'open', 'taken', 'done', 'failed', 'withdrawn')),
  taken_by    uuid references public.profiles(id) on delete set null,
  taken_at    timestamptz,
  closed_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists contracts_campaign_idx on public.contracts(campaign_id, status);
drop trigger if exists contracts_touch on public.contracts;
create trigger contracts_touch before update on public.contracts for each row execute function public.touch_updated_at();
alter table public.contracts enable row level security;
revoke all on public.contracts from anon;
drop policy if exists "the party reads the board" on public.contracts;
drop policy if exists "DM posts contracts" on public.contracts;
create policy "the party reads the board" on public.contracts for select to authenticated using (
  public.is_admin() or (status not in ('draft', 'withdrawn') and public.is_member(campaign_id)));
create policy "DM posts contracts" on public.contracts for all to authenticated using (public.is_admin()) with check (public.is_admin());

create or replace function public.contract_take(k uuid, take boolean default true) returns void
language plpgsql security definer set search_path = public as $$
declare x public.contracts;
begin
  select * into x from contracts where id = k for update;
  if not found or x.status in ('draft', 'withdrawn') then raise exception 'That contract isn''t on the board'; end if;
  perform public._money_member(x.campaign_id);
  if take then
    if x.status <> 'open' then raise exception 'That contract has already been taken'; end if;
    update contracts set status = 'taken', taken_by = auth.uid(), taken_at = now() where id = k;
  else
    if x.status <> 'taken' then raise exception 'That contract isn''t taken'; end if;
    update contracts set status = 'open', taken_by = null, taken_at = null where id = k;
  end if;
end $$;

create or replace function public.contract_close(k uuid, done boolean, pay boolean default true) returns text
language plpgsql security definer set search_path = public as $$
declare x public.contracts;
begin
  if not public.is_admin() then raise exception 'Only the DM can close a contract'; end if;
  select * into x from contracts where id = k for update;
  if not found then raise exception 'That contract isn''t there any more'; end if;
  if x.status in ('done', 'failed') then raise exception 'That contract is already closed'; end if;
  update contracts set status = case when done then 'done' else 'failed' end, closed_at = now() where id = k;
  if done and pay and x.reward_cp > 0 then
    perform public._money_lock(x.campaign_id);
    insert into money_tx (campaign_id, character_id, amount_cp, kind, reason) values (x.campaign_id, null, x.reward_cp, 'reward', left('Contract: ' || x.title, 200));
    return public._money_fmt(x.reward_cp);
  end if;
  return '';
end $$;
revoke all on function public.contract_take(uuid, boolean), public.contract_close(uuid, boolean, boolean) from public, anon;
grant execute on function public.contract_take(uuid, boolean), public.contract_close(uuid, boolean, boolean) to authenticated;

-- =====================================================================
--  Handouts: a letter, a note or a picture the DM shows the campaign's players during a session.
--  Players only see one once it's shown; it pops up on their screens and stays in their notes.
-- =====================================================================
create table if not exists public.handouts (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  title       text not null check (length(title) between 1 and 120),
  body        text check (body is null or length(body) <= 5000),
  image_path  text check (image_path is null or image_path ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,100}$'),
  image_url   text check (image_url is null or (length(image_url) <= 1000 and image_url ~* '^https://')),
  shown       boolean not null default false,
  shown_at    timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists handouts_campaign_idx on public.handouts(campaign_id, shown_at desc);
alter table public.handouts enable row level security;
revoke all on public.handouts from anon;
drop policy if exists "shown to the party" on public.handouts;
drop policy if exists "DM writes handouts" on public.handouts;
create policy "shown to the party" on public.handouts for select to authenticated using (public.is_admin() or (shown and public.is_member(campaign_id)));
create policy "DM writes handouts" on public.handouts for all to authenticated using (public.is_admin()) with check (public.is_admin());
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
      values ('handouts', 'handouts', false, 8388608, array['image/webp', 'image/jpeg', 'image/png', 'image/gif'])
      on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
    execute 'drop policy if exists "handout pictures: shown to the party" on storage.objects';
    execute 'drop policy if exists "handout pictures: DM uploads" on storage.objects';
    execute 'drop policy if exists "handout pictures: DM changes" on storage.objects';
    execute 'drop policy if exists "handout pictures: DM deletes" on storage.objects';
    execute $p$create policy "handout pictures: shown to the party" on storage.objects for select to authenticated using (
      bucket_id = 'handouts' and (public.is_admin() or exists (
        select 1 from public.handouts h where h.id::text = split_part(storage.objects.name, '/', 1) and h.shown and public.is_member(h.campaign_id))))$p$;
    execute $p$create policy "handout pictures: DM uploads" on storage.objects for insert to authenticated with check (bucket_id = 'handouts' and public.is_admin())$p$;
    execute $p$create policy "handout pictures: DM changes" on storage.objects for update to authenticated using (bucket_id = 'handouts' and public.is_admin())$p$;
    execute $p$create policy "handout pictures: DM deletes" on storage.objects for delete to authenticated using (bucket_id = 'handouts' and public.is_admin())$p$;
  end if;
end $$;

-- =====================================================================
--  The next session: the DM offers some dates, players say yes, maybe or no to each, and the DM picks one.
--  And the table screen (a TV at the table): which map it shows, set by the DM.
-- =====================================================================
create table if not exists public.next_session (
  campaign_id uuid primary key references public.campaigns(id) on delete cascade,
  options     jsonb not null default '[]'::jsonb check (jsonb_typeof(options) = 'array' and length(options::text) <= 4000),
  chosen      text check (chosen is null or length(chosen) <= 20),
  note        text check (note is null or length(note) <= 300),
  updated_at  timestamptz not null default now()
);
create table if not exists public.next_session_votes (
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  user_id     uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  option_id   text not null check (length(option_id) <= 20),
  answer      text not null check (answer in ('yes', 'maybe', 'no')),
  updated_at  timestamptz not null default now(),
  primary key (campaign_id, user_id, option_id)
);
create table if not exists public.table_screen (
  campaign_id uuid primary key references public.campaigns(id) on delete cascade,
  data        jsonb not null default '{}'::jsonb check (length(data::text) <= 4000),
  updated_at  timestamptz not null default now()
);
alter table public.next_session       enable row level security;
alter table public.next_session_votes enable row level security;
alter table public.table_screen       enable row level security;
revoke all on public.next_session, public.next_session_votes, public.table_screen from anon;
drop policy if exists "the party sees it" on public.next_session;
drop policy if exists "DM sets it" on public.next_session;
drop policy if exists "the party sees votes" on public.next_session_votes;
drop policy if exists "players vote for themselves" on public.next_session_votes;
drop policy if exists "players change their vote" on public.next_session_votes;
drop policy if exists "players take back their vote" on public.next_session_votes;
drop policy if exists "the party sees it" on public.table_screen;
drop policy if exists "DM sets it" on public.table_screen;
create policy "the party sees it" on public.next_session for select to authenticated using (public.is_admin() or public.is_member(campaign_id));
create policy "DM sets it" on public.next_session for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "the party sees votes" on public.next_session_votes for select to authenticated using (public.is_admin() or public.is_member(campaign_id));
create policy "players vote for themselves" on public.next_session_votes for insert to authenticated with check (user_id = auth.uid() and (public.is_member(campaign_id) or public.is_admin()));
create policy "players change their vote" on public.next_session_votes for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and (public.is_member(campaign_id) or public.is_admin()));
create policy "players take back their vote" on public.next_session_votes for delete to authenticated using (user_id = auth.uid() or public.is_admin());
create policy "the party sees it" on public.table_screen for select to authenticated using (public.is_admin() or public.is_member(campaign_id));
create policy "DM sets it" on public.table_screen for all to authenticated using (public.is_admin()) with check (public.is_admin());

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'handouts') then
      alter publication supabase_realtime add table public.handouts;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'table_screen') then
      alter publication supabase_realtime add table public.table_screen;
    end if;
  end if;
end $$;

-- =====================================================================
--  From the DM: feats, soft skill ranks, traits, Marks and anything else the DM gives a character.
--  Kept apart from the character itself: only the DM writes it, and the character's owner reads it,
--  so a player can't change or remove what they were given, and an open sheet can't overwrite it.
-- =====================================================================
create table if not exists public.character_grants (
  character_id uuid primary key references public.characters(id) on delete cascade,
  data         jsonb not null default '{}'::jsonb check (jsonb_typeof(data) = 'object' and length(data::text) <= 20000),
  updated_at   timestamptz not null default now(),
  updated_by   uuid default auth.uid() references public.profiles(id) on delete set null
);
alter table public.character_grants enable row level security;
revoke all on public.character_grants from anon;
drop policy if exists "owner or DM reads" on public.character_grants;
drop policy if exists "DM gives" on public.character_grants;
create policy "owner or DM reads" on public.character_grants for select to authenticated using (
  public.is_admin() or exists (select 1 from public.characters c where c.id = character_id and c.owner_id = auth.uid()));
create policy "DM gives" on public.character_grants for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- =====================================================================
--  Final classes: DM-only until the DM lets a player see them.
--  The text itself isn't in this repo (it's loaded from the separate finals-data folder, like the bestiary):
--  this only makes the tables. A player reads a class's finals once final_access has a row for them with that
--  class, or with '*' (every class). The new Mage schools are drafts and stay with the DM.
-- =====================================================================
create table if not exists public.finals (
  id         text primary key,
  kind       text not null check (kind in ('class', 'school')),
  class_id   text not null,
  sort       int  not null default 0,
  data       jsonb not null check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null default now()
);
create table if not exists public.final_access (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  class_id   text not null check (length(class_id) between 1 and 60),
  granted_at timestamptz not null default now(),
  primary key (user_id, class_id)
);
alter table public.finals enable row level security;
alter table public.final_access enable row level security;
revoke all on public.finals from anon;
revoke all on public.final_access from anon;
drop policy if exists "DM, or a player let in" on public.finals;
drop policy if exists "DM loads finals" on public.finals;
drop policy if exists "DM or the player reads" on public.final_access;
drop policy if exists "DM lets players in" on public.final_access;
create policy "DM, or a player let in" on public.finals for select to authenticated using (
  public.is_admin() or (kind = 'class' and exists (select 1 from public.final_access a
    where a.user_id = auth.uid() and (a.class_id = '*' or a.class_id = finals.class_id))));
create policy "DM loads finals" on public.finals for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "DM or the player reads" on public.final_access for select to authenticated using (public.is_admin() or user_id = auth.uid());
create policy "DM lets players in" on public.final_access for all to authenticated using (public.is_admin()) with check (public.is_admin());
