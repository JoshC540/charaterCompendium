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
