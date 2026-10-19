# Bitcalendar

A widget-first pixel calendar app in the **128bit family** — your schedule, but chunkier.

Landing page is live via GitHub Pages: https://hootywhooo86.github.io/bitcalendar/

## What this is

Bitcalendar is Daniel's 128bit-family take on the calendar: month view, events, and reminders with a chunky pixel aesthetic — designed **widget-first**, like Railway Time. The home-screen widget is the product: glanceable month grid, today highlighted, event dots, tap through to the day.

## Product brief (starter — Daniel's call on the concept)

**Core idea:** a pixel calendar where the widget is the hero. Full app behind it for event management.

**Widget (the main event):**
- Month grid widget (small/medium/large sizes) — today highlighted, event dots, pixel styling.
- "Up next" widget — next 1–3 events with countdown.
- Tap a day → opens the day view in the app.

**Full app:**
- Month / week / day views in pixel style.
- Events with pixel categories (quests, family, work, etc.).
- Reminders + notifications.
- Syncs with the 128bit event feed — events from other 128bit apps (workouts, bookings, quests) can land on the calendar.

**Open product questions for Daniel:**
1. iOS / Android / both? (Widget APIs differ — iOS WidgetKit vs Android widgets.)
2. Standalone calendar or a view over the existing family calendar (Google Calendar sync)?
3. Should 128bitlife quests auto-schedule onto the calendar?

## The web app (`app/`)

Live at https://hootywhooo86.github.io/bitcalendar/app/ — a static page, no build step. Same look as the landing mock. **Bitcalendar is the calendar now:** your events live in your 128bit account; Google is just something it can copy from.

- **128bit account:** sign in (email + password, or an emailed link — same account as 128bit Play and Tracker). Calendars, events and tasks sync to every device, live. Signed out, it still works as a calendar on that one device, and whatever you add moves into your account when you sign in.
- **Your own calendars + task lists:** make as many as you like (name, color, usual reminder); show/hide syncs too.
- **Google feeds in:** connect a Google account and every calendar (yours, shared, subscribed), event and task list is copied in — repeats, skipped days and moved occurrences included. After that it pulls only what changed (new invites, edits) whenever Bitcalendar is open (on open, every 10 min, and SYNC). Anything you change or delete in Bitcalendar stays your way; Google won't overwrite it. Answering an invite (GOING / MAYBE / NOT GOING) goes back to Google so the organizer sees it. Remove the Google account when you're done with Google — keep the copied events or drop them.
- **Views:** month, week (3 days on phones), day, list. Sidebar is the landing widget: mini month with dots, the day's quests, **Up next** countdowns.
- **Events:** create, edit, duplicate, delete, drag to move; all-day or timed; repeats (daily / weekdays / weekly / monthly / yearly, and any Google rule is kept as-is); "this event or all events"; reminders; colors; location + notes. Times stay put across daylight saving.
- **Tasks:** Overdue / Today / Upcoming / Someday / Done, on the calendar by due date.
- **Install it:** it's a PWA — "Add to Home Screen" / "Install app". Opens offline with what the device last saw.
- **Push reminders:** Settings → PUSH REMINDERS. Arrive even when the app is closed; tapping one opens the event. (iPhone: add to Home Screen first — iOS only allows push for installed web apps.)
- Search, keyboard shortcuts (M W D A, T, N, ← →, /), and each new event goes onto the 128bit family feed as `event.created`.

### Supabase setup (one time, project "128bit play")

1. **SQL Editor:** run `supabase/bitcalendar.sql` (tables, row-level security, the Google-mirror functions, realtime).
2. **Edge Functions:** deploy `supabase/functions/bitcal-reminders/` (`index.ts`, `push.js`, `reminders.js`, `recur.js`) with **Verify JWT on**. It makes its own push signing key on first run — nothing to paste.
3. **SQL Editor:** run `supabase/bitcalendar-reminders.sql` (pg_cron calls the function every minute).
4. **Authentication → URL Configuration → Redirect URLs:** add `https://hootywhooo86.github.io/bitcalendar/app/` so emailed sign-in links come back to the app.

`config.js` already points at the project (URL + publishable key; neither is secret — row-level security does the protecting). `supabase/functions/bitcal-reminders/recur.js` is a copy of `app/js/recur.js`; keep them in step.

### Connect Google (one-time setup)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. **APIs & Services → Library:** enable **Google Calendar API** and **Google Tasks API**.
3. **OAuth consent screen:** External; add the scopes `.../auth/calendar` and `.../auth/tasks`. While the app is in *Testing*, add each Google account that will sign in under **Test users**.
4. **Credentials → Create credentials → OAuth client ID → Web application.** Under **Authorized JavaScript origins** add `https://hootywhooo86.github.io` (and `http://localhost:8000` for local testing).
5. Put the client ID in `app/config.js` (`googleClientId`). Without it, the app asks for one on **Connect Google**.

Google sign-in happens in the browser and its tokens stay in that tab (an hour at a time; **RECONNECT** is one click). So Google syncs while Bitcalendar is open somewhere — not from a server.

Run locally: `python3 -m http.server 8000` in the repo root, then open http://localhost:8000/app/.

Code: `app/js/cloud.js` (128bit account + tables), `gsync.js` (Google → Bitcalendar mapping + incremental sync), `google.js` (Google sign-in + API), `recur.js` (repeat rules, time-zone aware), `local.js` (signed-out device calendar), `store.js` (everything the views read and every edit), `views.js`, `modals.js`, `app.js`; `sw.js` (offline + push).

## Architecture (128bit family standard)

- **One 128bit account** across all apps from day one.
- **Shared event schema** — Bitcalendar emits `event.created`, `event.reminded` and reads the family feed (e.g. `workout.logged` → streak day marked).
- **Family event feed** — `supabase/family-feed.sql` in this repo (same block as 128bitPlay's setup SQL — keep them in step). Run once in the Supabase SQL Editor.
- **Bitcalendar's tables** — `supabase/bitcalendar.sql` (`bitcal_calendars`, `bitcal_events`, `bitcal_tasks`, `bitcal_push`, plus server-only `bitcal_sent` / `bitcal_vapid`).
- **Monetization:** 128bit Pro bundle subscription across all apps (default assumption).

## For Carlos

- Landing page: `index.html` (live calendar widget mock — real month grid, prev/next month, tap days for events, today highlighted). Needs a Formspree ID in the waitlist form before launch.
- The widget is the product — start with the widget, then the full app behind it.
- This README is the starter brief — build the real thing per Daniel's product call above.
- Rocky codes scaffolding and straightforward builds; Carlos takes the harder features and double-checks Rocky's work.

## Status

- [x] Repo created, landing page live
- [ ] Formspree ID in `index.html`
- [ ] Product direction locked (Daniel)
- [ ] Widget build (per platform call)
- [x] Web app: month/week/day/list, full event editing (`app/`)
- [x] Own storage in the 128bit account, synced across devices; Google import + ongoing sync
- [x] Installable (PWA), offline, push reminders
- [x] Emits `event.created` to the family feed
- [ ] Run `supabase/bitcalendar.sql`, deploy `bitcal-reminders`, run `supabase/bitcalendar-reminders.sql`, add the auth redirect URL
- [ ] Google OAuth client ID in `app/config.js` + test users added
- [ ] Full app behind the widget (native)
