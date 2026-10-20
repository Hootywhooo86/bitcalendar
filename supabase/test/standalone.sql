-- bitcalendar.sql on its own, on the pre-Clerk 128bit database (as live today): a 128bit sign-in
-- (uuid) keeps its calendars to itself, and the other apps' functions are untouched.
\set ON_ERROR_STOP 1
set client_min_messages = warning;
grant select, insert, update, delete on all tables in schema public to authenticated;
create or replace function pg_temp.expect(ok boolean, what text) returns void language plpgsql as $$
begin if not coalesce(ok, false) then raise exception 'FAILED: %', what; end if; end $$;
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000000001', 'a@x.com'), ('bbbbbbbb-0000-0000-0000-000000000002', 'b@x.com');
select set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', false);
set role authenticated;
insert into bitcal_calendars (id, name) values ('22222222-0000-0000-0000-000000000001', 'Home');
select pg_temp.expect(public.bitcal_mirror('22222222-0000-0000-0000-000000000001', '[{"ext_id": "g1", "title": "From Google", "starts_at": "2026-10-20T10:00:00Z", "ends_at": "2026-10-20T11:00:00Z"}]') = 1, 'Google mirror');
select pg_temp.expect((select user_id from bitcal_events) = 'aaaaaaaa-0000-0000-0000-000000000001', 'owned by the sign-in');
select public.put_settings('{"theme": "green"}');   -- 128bitPlay still works
select pg_temp.expect(public.get_settings() ->> 'theme' = 'green', 'Play settings untouched');
reset role;
select set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-0000-0000-000000000002', false);
set role authenticated;
select pg_temp.expect((select count(*) from bitcal_calendars) = 0, 'B sees none of A''s');
reset role;
-- Clean up for the run on top.
delete from bitcal_calendars; delete from public.user_settings; delete from auth.users;
