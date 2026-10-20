-- Bitcalendar's own storage in the 128bit Supabase project. Run once in Supabase → SQL Editor (safe to run again).
-- Every row belongs to one account; row-level security keeps it that way. The owner is the signed-in
-- token's "sub": a Clerk user ID (user_…) when signing in with Clerk (Supabase → Authentication →
-- Third-party auth → Clerk), or a Supabase user's ID. Hence text, and no link to auth.users.

-- Calendars (kind 'events') and task lists (kind 'tasks'). ext is set when mirrored from Google:
-- {provider:'google', email, id, syncToken | lastSync}.
create table if not exists public.bitcal_calendars (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default (auth.jwt() ->> 'sub'),
  kind text not null default 'events' check (kind in ('events', 'tasks')),
  name text not null check (length(name) between 1 and 200),
  color text not null default '#ff9f1c',
  position int not null default 0,
  hidden boolean not null default false,
  default_reminder int,
  ext jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, id)
);
create unique index if not exists bitcal_calendars_ext on public.bitcal_calendars
  (user_id, (ext ->> 'provider'), (ext ->> 'email'), (ext ->> 'id'), kind) where ext is not null;

-- Events. All-day events store midnight UTC of their first day; end is exclusive.
-- rrule: RFC 5545 rule without "RRULE:"; exdates: skipped days (YYYY-MM-DD in tz).
-- until_at: last occurrence start (null = forever), so range queries can skip ended series.
-- edited: changed in Bitcalendar, so the Google mirror leaves it alone.
create table if not exists public.bitcal_events (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default (auth.jwt() ->> 'sub'),
  calendar_id uuid not null,
  title text not null default '',
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  all_day boolean not null default false,
  tz text not null default 'UTC',
  rrule text,
  until_at timestamptz,
  exdates text[] not null default '{}',
  location text not null default '',
  notes text not null default '',
  color_id text,
  reminder int,
  attendees jsonb,
  meet text,
  ext jsonb,
  ext_id text,
  edited boolean not null default false,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (user_id, calendar_id) references public.bitcal_calendars (user_id, id) on delete cascade,
  unique (calendar_id, ext_id)
);
create index if not exists bitcal_events_range on public.bitcal_events (user_id, starts_at);
create index if not exists bitcal_events_cal on public.bitcal_events (calendar_id);

create table if not exists public.bitcal_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id text not null default (auth.jwt() ->> 'sub'),
  list_id uuid not null,
  title text not null default '',
  notes text not null default '',
  due date,
  done boolean not null default false,
  done_at timestamptz,
  ext_id text,
  edited boolean not null default false,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (user_id, list_id) references public.bitcal_calendars (user_id, id) on delete cascade,
  unique (list_id, ext_id)
);
create index if not exists bitcal_tasks_list on public.bitcal_tasks (list_id);
create index if not exists bitcal_tasks_user on public.bitcal_tasks (user_id);

-- Browsers that get push reminders.
create table if not exists public.bitcal_push (
  endpoint text primary key,
  user_id text not null default (auth.jwt() ->> 'sub'),
  p256dh text not null,
  auth text not null,
  tz text not null default 'UTC',
  h24 boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists bitcal_push_user on public.bitcal_push (user_id);

-- Google accounts the server syncs for each person (bitcal-google function, with the Google token
-- Clerk keeps for them). People can read their own row for the status; only the server writes.
create table if not exists public.bitcal_google (
  user_id text primary key,
  email text,
  status text,
  error text,
  synced_at timestamptz,
  wanted_at timestamptz not null default now()
);

-- Server-only: reminders already sent, and the push signing key.
create table if not exists public.bitcal_sent (
  event_id uuid not null references public.bitcal_events on delete cascade,
  occurs_at timestamptz not null,
  sent_at timestamptz not null default now(),
  primary key (event_id, occurs_at)
);
create table if not exists public.bitcal_vapid (
  id int primary key default 1 check (id = 1),
  public_key text not null,
  private_jwk jsonb not null
);

create or replace function public.bitcal_touch() returns trigger language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists bitcal_events_touch on public.bitcal_events;
create trigger bitcal_events_touch before update on public.bitcal_events for each row execute function public.bitcal_touch();
drop trigger if exists bitcal_tasks_touch on public.bitcal_tasks;
create trigger bitcal_tasks_touch before update on public.bitcal_tasks for each row execute function public.bitcal_touch();

alter table public.bitcal_calendars enable row level security;
alter table public.bitcal_events enable row level security;
alter table public.bitcal_tasks enable row level security;
alter table public.bitcal_push enable row level security;
alter table public.bitcal_sent enable row level security;
alter table public.bitcal_vapid enable row level security;
alter table public.bitcal_google enable row level security;
drop policy if exists own_read on public.bitcal_google;
create policy own_read on public.bitcal_google for select to authenticated using (user_id = (select auth.jwt() ->> 'sub'));

do $$
declare t text;
begin
  foreach t in array array['bitcal_calendars', 'bitcal_events', 'bitcal_tasks', 'bitcal_push'] loop
    execute format('drop policy if exists own on public.%I', t);
    execute format('create policy own on public.%I for all to authenticated using (user_id = (select auth.jwt() ->> ''sub'')) with check (user_id = (select auth.jwt() ->> ''sub''))', t);
  end loop;
end $$;

-- Google → Bitcalendar mirror. rows: [{ext_id, title, starts_at, …} | {ext_id, cancelled:true}],
-- optionally with skip_master/skip_date to drop one day from a series. Rows edited in
-- Bitcalendar (or deleted here) are left alone.
create or replace function public.bitcal_mirror(cal uuid, rows jsonb) returns int
language plpgsql security invoker set search_path = public as $$
declare r jsonb; n int := 0; owner text;
begin
  -- The calendar's owner (row-level security only shows a person their own; the server sees all).
  select user_id into owner from bitcal_calendars where id = cal;
  if owner is null then raise exception 'No such calendar'; end if;
  for r in select * from jsonb_array_elements(rows) loop
    if r ? 'skip_master' then
      update bitcal_events set exdates = array(select distinct unnest(exdates || array[r ->> 'skip_date']))
       where calendar_id = cal and ext_id = r ->> 'skip_master' and not (r ->> 'skip_date' = any(exdates));
    end if;
    if coalesce((r ->> 'cancelled')::boolean, false) then
      update bitcal_events set deleted_at = now()
       where calendar_id = cal and ext_id = r ->> 'ext_id' and not edited and deleted_at is null;
    else
      insert into bitcal_events (user_id, calendar_id, ext_id, title, starts_at, ends_at, all_day, tz, rrule, until_at, exdates,
                                 location, notes, color_id, reminder, attendees, meet, ext)
      values (owner, cal, r ->> 'ext_id', coalesce(r ->> 'title', ''), (r ->> 'starts_at')::timestamptz, (r ->> 'ends_at')::timestamptz,
              coalesce((r ->> 'all_day')::boolean, false), coalesce(r ->> 'tz', 'UTC'), r ->> 'rrule', (r ->> 'until_at')::timestamptz,
              coalesce(array(select jsonb_array_elements_text(r -> 'exdates')), '{}'), coalesce(r ->> 'location', ''),
              coalesce(r ->> 'notes', ''), r ->> 'color_id', (r ->> 'reminder')::int, r -> 'attendees', r ->> 'meet', r -> 'ext')
      on conflict (calendar_id, ext_id) do update set
        title = excluded.title, starts_at = excluded.starts_at, ends_at = excluded.ends_at, all_day = excluded.all_day,
        tz = excluded.tz, rrule = excluded.rrule, until_at = excluded.until_at,
        exdates = array(select distinct unnest(bitcal_events.exdates || excluded.exdates)),
        location = excluded.location, notes = excluded.notes, color_id = excluded.color_id, reminder = excluded.reminder,
        attendees = excluded.attendees, meet = excluded.meet, ext = excluded.ext
      where not bitcal_events.edited and bitcal_events.deleted_at is null;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.bitcal_mirror_tasks(list uuid, rows jsonb) returns int
language plpgsql security invoker set search_path = public as $$
declare r jsonb; n int := 0; owner text;
begin
  select user_id into owner from bitcal_calendars where id = list;
  if owner is null then raise exception 'No such task list'; end if;
  for r in select * from jsonb_array_elements(rows) loop
    if coalesce((r ->> 'cancelled')::boolean, false) then
      update bitcal_tasks set deleted_at = now() where list_id = list and ext_id = r ->> 'ext_id' and not edited and deleted_at is null;
    else
      insert into bitcal_tasks (user_id, list_id, ext_id, title, notes, due, done, done_at)
      values (owner, list, r ->> 'ext_id', coalesce(r ->> 'title', ''), coalesce(r ->> 'notes', ''), (r ->> 'due')::date,
              coalesce((r ->> 'done')::boolean, false), (r ->> 'done_at')::timestamptz)
      on conflict (list_id, ext_id) do update set
        title = excluded.title, notes = excluded.notes, due = excluded.due, done = excluded.done, done_at = excluded.done_at
      where not bitcal_tasks.edited and bitcal_tasks.deleted_at is null;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

-- A browser signing up for reminders. An endpoint moves to whoever signs in on that browser.
-- SQL (not plpgsql) so the parameters can share the column names; signed out, user_id's
-- not-null check refuses it.
create or replace function public.bitcal_save_push(endpoint text, p256dh text, auth text, tz text, h24 boolean) returns void
language sql security definer set search_path = public as $$
  insert into bitcal_push (endpoint, user_id, p256dh, auth, tz, h24)
  values ($1, auth.jwt() ->> 'sub', $2, $3, coalesce($4, 'UTC'), coalesce($5, false))
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
    tz = excluded.tz, h24 = excluded.h24;
$$;

create or replace function public.bitcal_vapid_public() returns text
language sql stable security definer set search_path = public as $$ select public_key from bitcal_vapid where id = 1 $$;

revoke all on function public.bitcal_save_push(text, text, text, text, boolean), public.bitcal_vapid_public() from public, anon;
grant execute on function public.bitcal_save_push(text, text, text, text, boolean), public.bitcal_vapid_public() to authenticated;
revoke all on function public.bitcal_mirror(uuid, jsonb), public.bitcal_mirror_tasks(uuid, jsonb) from public, anon;
grant execute on function public.bitcal_mirror(uuid, jsonb), public.bitcal_mirror_tasks(uuid, jsonb) to authenticated, service_role;

-- Other devices see changes as they happen.
do $$
declare t text;
begin
  foreach t in array array['bitcal_calendars', 'bitcal_events', 'bitcal_tasks'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
