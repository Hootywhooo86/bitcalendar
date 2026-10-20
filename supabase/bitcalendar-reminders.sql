-- Runs the push-reminder function every minute. Run once in Supabase → SQL Editor, after
-- bitcalendar.sql and after deploying supabase/functions/bitcal-reminders (safe to run again).
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule(jobid) from cron.job where jobname = 'bitcal-reminders';
-- The bearer is the project's public anon key (the same one every app ships). The function only
-- sends reminders that are due, once, so anyone poking it early changes nothing.
select cron.schedule('bitcal-reminders', '* * * * *', $$
  select net.http_post(
    url := 'https://wvflpwtaszpstmjpkrhu.supabase.co/functions/v1/bitcal-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization',
      'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind2Zmxwd3Rhc3pwc3RtanBrcmh1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTExMTUwNjQsImV4cCI6MjEwNjY5MTA2NH0.VC_vrAPryE2XB6zOyWILPZ3qcUJG9NNmxmARaRfWtqM'),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000)
$$);
-- Old sent-reminder rows are cleared by the function itself. To stop reminders:
--   select cron.unschedule('bitcal-reminders');

-- With Clerk: the server syncs Google for everyone who linked it, every 10 minutes
-- (supabase/functions/bitcal-google; it skips anyone synced in the last 9 minutes).
select cron.unschedule(jobid) from cron.job where jobname = 'bitcal-google';
select cron.schedule('bitcal-google', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://wvflpwtaszpstmjpkrhu.supabase.co/functions/v1/bitcal-google',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{"action":"cron"}'::jsonb,
    timeout_milliseconds := 60000)
$$);
