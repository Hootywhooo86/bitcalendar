-- Bitcalendar's tables on the shared 128bit accounts: each account sees only its own, a pre-Clerk
-- account's calendars (and their events and tasks) move into its Clerk account, and deleting removes them.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
grant select, insert, update, delete on all tables in schema public to authenticated;
create or replace function pg_temp.expect(ok boolean, what text) returns void language plpgsql as $$
begin if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if; end $$;
create or replace function pg_temp.as_user(uid text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claim.sub', uid, false); end $$;
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000000001', 'a@x.com');

-- An app not yet on Clerk (old token, uuid) makes a calendar with an event and a task list with a task.
select pg_temp.as_user('aaaaaaaa-0000-0000-0000-000000000001');
set role authenticated;
insert into bitcal_calendars (id, name) values ('11111111-0000-0000-0000-000000000001', 'Home');
insert into bitcal_calendars (id, name, kind) values ('11111111-0000-0000-0000-000000000002', 'Todo', 'tasks');
insert into bitcal_events (calendar_id, title, starts_at, ends_at) values ('11111111-0000-0000-0000-000000000001', 'Dentist', now(), now() + interval '1 hour');
insert into bitcal_tasks (list_id, title) values ('11111111-0000-0000-0000-000000000002', 'Milk');
select public.bitcal_save_push('https://push/1', 'k', 'a', 'UTC', false);
reset role;

-- Someone else, on Clerk.
select pg_temp.as_user('user_2other');
set role authenticated;
insert into bitcal_calendars (name) values ('Work');
select pg_temp.expect((select count(*) from bitcal_calendars) = 1, 'sees only own calendars');
select pg_temp.expect((select count(*) from bitcal_events) = 0, 'sees no one else''s events');
do $$ begin
  insert into bitcal_events (calendar_id, title, starts_at, ends_at) values ('11111111-0000-0000-0000-000000000001', 'x', now(), now());
  raise exception 'FAILED: wrote into someone else''s calendar';
exception when foreign_key_violation or insufficient_privilege then null; end $$;
do $$ begin perform public.bitcal_mirror('11111111-0000-0000-0000-000000000001', '[]'); raise exception 'FAILED: mirrored into someone else''s calendar';
exception when raise_exception then if sqlerrm like 'FAILED%' then raise; end if; end $$;
reset role;

-- A signs in with Clerk; the account server moves the old account in.
set role service_role;
select pg_temp.expect((public.account_claim('user_2A', array['a@x.com']) ->> 'moved')::int >= 3, 'moved');
reset role;
select pg_temp.as_user('user_2A');
set role authenticated;
select pg_temp.expect((select count(*) from bitcal_calendars) = 2, 'calendars moved');
select pg_temp.expect((select title from bitcal_events) = 'Dentist', 'events followed their calendar');
select pg_temp.expect((select title from bitcal_tasks) = 'Milk', 'tasks followed their list');
select pg_temp.expect((select count(*) from bitcal_push) = 1, 'push moved');
insert into bitcal_events (calendar_id, title, starts_at, ends_at) values ('11111111-0000-0000-0000-000000000001', 'New', now(), now());
select pg_temp.expect((select user_id from bitcal_events where title = 'New') = 'user_2A', 'new rows owned by the clerk id');
select pg_temp.expect(public.bitcal_mirror('11111111-0000-0000-0000-000000000001', '[{"ext_id": "g1", "title": "From Google", "starts_at": "2026-10-20T10:00:00Z", "ends_at": "2026-10-20T11:00:00Z"}]') = 1, 'mirror');
select public.delete_my_account();
reset role;
select pg_temp.expect(not exists (select 1 from bitcal_calendars where user_id in ('user_2A', 'aaaaaaaa-0000-0000-0000-000000000001')), 'calendars gone');
select pg_temp.expect(not exists (select 1 from bitcal_events where user_id = 'user_2A'), 'events gone');
select pg_temp.expect(not exists (select 1 from bitcal_push where user_id = 'user_2A'), 'push gone');
select pg_temp.expect(exists (select 1 from bitcal_calendars where user_id = 'user_2other'), 'other account kept');
