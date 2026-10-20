-- 128bit shared block: accounts, settings, TVs and the family feed, for every 128bit app.
-- Run once in Supabase → SQL Editor (safe to run again), before any app's own SQL.
-- The same file in every 128bit repo (128bitPlay's SETUP_SQL in app/src/lib/account.ts,
-- 128bittracker's supabase/family.sql, the others' supabase/family-feed.sql); keep them in step.

-- ---------- 128bit accounts ----------
-- One sign-in for every 128bit app, through Clerk (Supabase → Authentication → Third-party auth →
-- Clerk). An account is the token's "sub": a Clerk user ID (user_…), or the uuid of a sign-in from
-- before Clerk. Hence text owner columns with no link to auth.users.

-- One-time move from the uuid owner columns of the Supabase sign-in days. Does nothing once done.
do $$
declare r record; readd text[] := '{}'; s text;
begin
  if to_regclass('auth.users') is null then return; end if;
  -- Functions whose arguments or result change type (the rest are replaced in place below).
  for r in select p.oid::regprocedure as sig from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('family_owner', 'family_insert', 'settings_owner', 'tracker_me', 'tracker_bump_usage',
                                'tracker_ensure', 'tracker_find', 'tracker_find_show', 'tracker_show_watch')
              and (p.prorettype = 'uuid'::regtype or 'uuid'::regtype = any(p.proargtypes)) loop
    execute format('drop function %s', r.sig);
  end loop;
  -- Owner columns: the uuid columns that point at auth.users.
  create temp table account_cols on commit drop as
    select distinct c.conrelid as rel, a.attnum, a.attname
      from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
     where c.contype = 'f' and c.confrelid = 'auth.users'::regclass and c.connamespace = 'public'::regnamespace
       and a.atttypid = 'uuid'::regtype;
  if not exists (select 1 from account_cols) then return; end if;
  -- Foreign keys on them come off; those between 128bit tables go back on afterwards.
  for r in select distinct c.conrelid::regclass as tbl, c.conname, pg_get_constraintdef(c.oid) as def,
                  c.confrelid = 'auth.users'::regclass as to_users
             from pg_constraint c join account_cols x
               on (x.rel = c.conrelid and x.attnum = any(c.conkey)) or (x.rel = c.confrelid and x.attnum = any(c.confkey))
            where c.contype = 'f' loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    if not r.to_users then readd := readd || format('alter table %s add constraint %I %s', r.tbl, r.conname, r.def); end if;
  end loop;
  -- Policies and defaults that use the columns are made again by each app's SQL.
  for r in select distinct p.polrelid::regclass as tbl, p.polname from pg_policy p join account_cols x on x.rel = p.polrelid loop
    execute format('drop policy %I on %s', r.polname, r.tbl);
  end loop;
  for r in select rel::regclass as tbl, attname from account_cols loop
    execute format('alter table %s alter column %I drop default, alter column %I type text using %I::text', r.tbl, r.attname, r.attname, r.attname);
  end loop;
  foreach s in array readd loop execute s; end loop;
end $$;

-- Pre-Clerk accounts and the Clerk account they became. Sign-ins with an old token still find their data.
create table if not exists public.account_links (
  old_id text primary key,
  new_id text not null,
  linked_at timestamptz not null default now()
);
create index if not exists account_links_new on public.account_links (new_id);
alter table public.account_links enable row level security;

-- TVs waiting to be signed in: the TV shows code, a phone signed in to 128bit enters it (owner), and
-- the TV, holding the secret, collects a one-time Clerk sign-in. Only the account server touches this.
create table if not exists public.account_tv (
  code text primary key,
  secret_hash bytea not null,
  owner text,
  created_at timestamptz not null default now()
);
alter table public.account_tv enable row level security;

-- Who is signed in.
create or replace function public.account_sub() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select l.new_id from account_links l where l.old_id = auth.jwt() ->> 'sub'), nullif(auth.jwt() ->> 'sub', ''))
$$;

create or replace function public.account_me() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', account_sub(), 'sub', auth.jwt() ->> 'sub',
                            'anonymous', coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false))
$$;

-- Every table that holds someone's things, and its owner column. A new 128bit table goes here.
-- (Bitcalendar's events and tasks follow their calendar.)
create or replace function public.account_columns() returns table (tbl regclass, col text)
language sql stable set search_path = public as $$
  select to_regclass('public.' || t), c from (values
    ('family_events', 'user_id'), ('family_keys', 'user_id'), ('user_settings', 'user_id'), ('tv_devices', 'owner_id'),
    ('tracker_items', 'user_id'), ('tracker_lists', 'user_id'), ('tracker_list_items', 'user_id'),
    ('tracker_calendar', 'user_id'), ('tracker_trophies', 'user_id'), ('tracker_profiles', 'user_id'),
    ('tracker_connections', 'user_id'), ('tracker_oauth_states', 'user_id'), ('tracker_proxy_usage', 'user_id'),
    ('bitcal_calendars', 'user_id'), ('bitcal_push', 'user_id'), ('bitcal_google', 'user_id')) v(t, c)
   where to_regclass('public.' || t) is not null
$$;

-- Moves everything from one account to another. Where both have the same thing (one settings row,
-- the same feed event), the old account's copy wins: it's the one with the history.
create or replace function public.account_move(old_id text, new_id text) returns int
language plpgsql security definer set search_path = public as $$
declare t record; ix record; same text; n int; moved int := 0;
begin
  for t in select * from account_columns() loop
    for ix in select i.indkey::int2[] as k from pg_index i
               where i.indrelid = t.tbl and i.indisunique and i.indexprs is null and i.indpred is null
                 and (select a.attnum from pg_attribute a where a.attrelid = t.tbl and a.attname = t.col) = any(i.indkey::int2[]) loop
      select string_agg(format(' and n.%1$I is not distinct from o.%1$I', a.attname), '') into same
        from pg_attribute a where a.attrelid = t.tbl and a.attnum = any(ix.k) and a.attname <> t.col;
      execute format('delete from %s n using %s o where n.%I = $1 and o.%I = $2', t.tbl, t.tbl, t.col, t.col) || coalesce(same, '')
        using new_id, old_id;
    end loop;
    execute format('update %s set %I = $1 where %I = $2', t.tbl, t.col, t.col) using new_id, old_id;
    get diagnostics n = row_count;
    moved := moved + n;
  end loop;
  return moved;
end $$;

-- The account server, after Clerk vouches for these email addresses: pre-Clerk accounts with the
-- same confirmed email become part of the Clerk account. → {linked: [old ids], moved: rows}
create or replace function public.account_claim(new_id text, emails text[]) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare old text; ids text[] := '{}'; moved int := 0;
begin
  if coalesce(new_id, '') = '' then raise exception 'No account'; end if;
  for old in select u.id::text from auth.users u
              where u.email_confirmed_at is not null and lower(u.email) in (select lower(e) from unnest(emails) e)
                and u.id::text <> new_id and not exists (select 1 from account_links l where l.old_id = u.id::text) loop
    moved := moved + account_move(old, new_id);
    insert into account_links (old_id, new_id) values (old, new_id);
    ids := ids || old;
  end loop;
  return jsonb_build_object('linked', to_jsonb(ids), 'moved', moved);
end $$;

-- Deletes an account and everything it stored in every 128bit app, including its pre-Clerk sign-ins.
create or replace function public.account_erase(who text) returns void
language plpgsql security definer set search_path = public, auth as $$
declare ids text[]; t record;
begin
  if coalesce(who, '') = '' then raise exception 'Sign in first'; end if;
  ids := array(select old_id from account_links where new_id = who) || who;
  for t in select * from account_columns() loop
    execute format('delete from %s where %I = any($1)', t.tbl, t.col) using ids;
  end loop;
  if to_regclass('public.tv_devices') is not null then delete from tv_devices where device_id = any(ids); end if;
  delete from account_tv where owner = any(ids);
  delete from account_links where new_id = who;
  if to_regclass('auth.users') is not null then delete from auth.users where id::text = any(ids); end if;
end $$;

revoke all on function public.account_sub(), public.account_me(), public.account_columns(), public.account_move(text, text),
  public.account_claim(text, text[]), public.account_erase(text) from public, anon, authenticated;
grant execute on function public.account_sub(), public.account_me() to authenticated;
grant execute on function public.account_sub(), public.account_me(), public.account_claim(text, text[]), public.account_erase(text) to service_role;
-- ---------- End of accounts ----------

-- ---------- Settings and TVs ----------
-- Each app keeps its own settings (app_key).
create table if not exists public.user_settings (
  user_id text not null,
  app text not null default '128bit-play',
  data jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, app)
);
create table if not exists public.tv_devices (
  device_id text primary key,
  owner_id text,
  code text unique,
  created_at timestamptz not null default now()
);
-- No direct access to the tables: everything goes through the functions below.
alter table public.user_settings enable row level security;
alter table public.tv_devices enable row level security;

-- Whose settings this sign-in uses: a TV paired the pre-Clerk way uses its owner's, everyone else their own.
create or replace function public.settings_owner() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select owner_id from tv_devices where device_id = public.account_sub() and owner_id is not null),
    public.account_sub())
$$;

create or replace function public.get_settings(app_key text default '128bit-play') returns jsonb
language sql stable security definer set search_path = public as $$
  select data from user_settings where user_id = settings_owner() and app = app_key
$$;

create or replace function public.put_settings(new_data jsonb, app_key text default '128bit-play') returns void
language sql security definer set search_path = public as $$
  insert into user_settings (user_id, app, data, updated_at) values (settings_owner(), app_key, new_data, now())
  on conflict (user_id, app) do update set data = excluded.data, updated_at = now()
$$;

create or replace function public.start_tv_pairing(pair_code text) returns void
language sql security definer set search_path = public as $$
  insert into tv_devices (device_id, code, created_at) values (public.account_sub(), upper(pair_code), now())
  on conflict (device_id) do update set code = excluded.code, created_at = now(), owner_id = null
$$;

create or replace function public.claim_tv(pair_code text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if public.account_sub() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Sign in on the phone first';
  end if;
  update tv_devices set owner_id = public.account_sub(), code = null
   where code = upper(pair_code) and owner_id is null
     and created_at > now() - interval '15 minutes';
  get diagnostics n = row_count;
  return n > 0;
end $$;

create or replace function public.tv_status() returns text
language sql stable security definer set search_path = public, auth as $$
  select coalesce(u.email, d.owner_id) from tv_devices d left join auth.users u on u.id::text = d.owner_id
   where d.device_id = public.account_sub()
$$;

revoke all on function public.settings_owner(), public.get_settings(text), public.put_settings(jsonb, text),
  public.start_tv_pairing(text), public.claim_tv(text), public.tv_status() from public, anon, authenticated;
grant execute on function public.get_settings(text), public.put_settings(jsonb, text),
  public.start_tv_pairing(text), public.claim_tv(text), public.tv_status() to authenticated;

-- ---------- The family feed ----------
-- What you do in every 128bit app, for 128bit Tracker's timeline.
create table if not exists public.family_events (
  user_id text not null,
  id text not null,
  app text not null,
  type text not null,
  at timestamptz not null,
  data jsonb not null default '{}',
  primary key (user_id, id)
);
create index if not exists family_events_at on public.family_events (user_id, at desc);
alter table public.family_events enable row level security;

-- Keys for apps without a sign-in (Zapier, Tasker, Shortcuts, scripts). Only a hash is kept.
create table if not exists public.family_keys (
  key_hash bytea primary key,
  user_id text not null,
  label text not null default '',
  created_at timestamptz not null default now()
);
alter table public.family_keys enable row level security;

-- Whose feed this sign-in writes to: a TV paired in 128bitPlay posts to its owner's.
create or replace function public.family_owner() returns text
language plpgsql stable security definer set search_path = public as $$
declare o text;
begin
  if to_regclass('public.tv_devices') is not null then
    execute 'select owner_id from tv_devices where device_id = $1 and owner_id is not null' into o using public.account_sub();
  end if;
  return coalesce(o, public.account_sub());
end $$;

-- Same id again replaces the event (a day's step count keeps going up). No id: a new event.
create or replace function public.family_insert(owner text, events jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if owner is null then raise exception 'Sign in first'; end if;
  if jsonb_typeof(events) <> 'array' or jsonb_array_length(events) > 500 then
    raise exception 'Send a list of at most 500 events';
  end if;
  insert into family_events (user_id, id, app, type, at, data)
  select owner, coalesce(left(e ->> 'id', 200), gen_random_uuid()::text), left(coalesce(e ->> 'app', 'custom'), 40), left(e ->> 'type', 80),
         coalesce(to_timestamp((e ->> 'at')::bigint / 1000.0), now()), coalesce(e -> 'data', '{}')
    from jsonb_array_elements(events) e
   where e ->> 'type' is not null
  on conflict (user_id, id) do update
    set app = excluded.app, type = excluded.type, at = excluded.at, data = excluded.data;
  get diagnostics n = row_count;
  return n;
end $$;

-- (log_events used to return nothing; the return type can only change by dropping it.)
drop function if exists public.log_events(jsonb);
create or replace function public.log_events(events jsonb) returns int
language sql security definer set search_path = public as $$
  select family_insert(family_owner(), events)
$$;

create or replace function public.log_events_with_key(ingest_key text, events jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare owner text;
begin
  select user_id into owner from family_keys where key_hash = sha256(convert_to(ingest_key, 'UTF8'));
  if owner is null then raise exception 'Unknown key'; end if;
  return family_insert(owner, events);
end $$;

create or replace function public.delete_event(event_id text) returns void
language sql security definer set search_path = public as $$
  delete from family_events where user_id = family_owner() and id = event_id
$$;

-- Newest first; before_ms (ms since 1970) pages back.
create or replace function public.get_events(before_ms bigint default null, max_rows int default 200) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'app', app, 'type', type,
           'at', (extract(epoch from at) * 1000)::bigint, 'data', data) order by at desc), '[]')
    from (select * from family_events
           where user_id = family_owner() and (before_ms is null or at < to_timestamp(before_ms / 1000.0))
           order by at desc limit least(max_rows, 1000)) e
$$;

-- A new key, shown once. Only its hash is stored.
create or replace function public.create_family_key(key_label text default '') returns text
language plpgsql security definer set search_path = public as $$
declare k text := '128bit_' || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if public.account_sub() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Sign in first';
  end if;
  insert into family_keys (key_hash, user_id, label) values (sha256(convert_to(k, 'UTF8')), public.account_sub(), coalesce(key_label, ''));
  return k;
end $$;

create or replace function public.list_family_keys() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', encode(key_hash, 'hex'), 'label', label,
           'created', (extract(epoch from created_at) * 1000)::bigint) order by created_at), '[]')
    from family_keys where user_id = public.account_sub()
$$;

create or replace function public.delete_family_key(key_id text) returns void
language sql security definer set search_path = public as $$
  delete from family_keys where user_id = public.account_sub() and key_hash = decode(key_id, 'hex')
$$;

-- Deletes the signed-in account's data in every 128bit app: settings, TVs, feed, keys, library,
-- calendars. Required by Google Play and the App Store. (The account server also removes the Clerk user.)
create or replace function public.delete_my_account() returns void
language sql security definer set search_path = public as $$
  select account_erase(account_sub())
$$;

revoke all on function public.family_owner(), public.family_insert(text, jsonb), public.log_events(jsonb),
  public.log_events_with_key(text, jsonb), public.delete_event(text), public.get_events(bigint, int),
  public.create_family_key(text), public.list_family_keys(), public.delete_family_key(text),
  public.delete_my_account() from public, anon, authenticated;  -- Supabase grants new functions to everyone; family_insert must stay internal.
grant execute on function public.log_events(jsonb), public.delete_event(text), public.get_events(bigint, int),
  public.create_family_key(text), public.list_family_keys(), public.delete_family_key(text),
  public.delete_my_account() to authenticated;
-- The one call that works without a sign-in: it checks the key itself.
grant execute on function public.log_events_with_key(text, jsonb) to anon, authenticated;
-- End of the family block.
