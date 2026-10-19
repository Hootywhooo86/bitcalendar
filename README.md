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

Live at https://hootywhooo86.github.io/bitcalendar/app/ — a static page, no server or build step. Same look as the landing mock.

- **Google accounts:** connect one or more Google accounts. Every calendar on each account shows up (colors, show/hide toggles), plus Google Tasks with due dates.
- **Views:** month, week (3 days on phones), day, and list. The landing widget is the sidebar: mini month with event dots, the picked day's quests, and **Up next** with countdowns.
- **Events:** create, edit, duplicate, delete; all-day or timed; repeat (daily / weekdays / weekly / monthly / yearly); reminders; Google event colors; location and notes. Repeating events ask "this event or all events". Drag events (and tasks) to a new day or time. Click an empty square or time slot to add one there. RSVP to invites, join links, open in Google.
- **Tasks:** side panel grouped Overdue / Today / Upcoming / Someday / Done; add, tick off, edit, move between lists, delete.
- **Search** across all calendars (a year either way), **keyboard shortcuts** (M W D A, T, N, ← →, /), browser **reminder notifications** while the app is open (Settings).
- **On this device:** a built-in calendar and task list saved in the browser, so it works before anyone signs in.

### Connect Google (one-time setup)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. **APIs & Services → Library:** enable **Google Calendar API** and **Google Tasks API**.
3. **OAuth consent screen:** External; add the scopes `.../auth/calendar` and `.../auth/tasks`. While the app is in *Testing*, add each Google account that will sign in under **Test users** (Google requires verification before anyone else can use these scopes).
4. **Credentials → Create credentials → OAuth client ID → Web application.** Under **Authorized JavaScript origins** add `https://hootywhooo86.github.io` (and `http://localhost:8000` for local testing).
5. Put the client ID in `app/config.js` (`googleClientId`). It isn't a secret. Without it, the app asks for one in **Settings** / on **Connect Google**.

Sign-in uses Google Identity Services in the browser. Access tokens last an hour and stay in that tab (`sessionStorage`); when one runs out the app shows **RECONNECT**, which is one click. Nothing goes to a 128bit server.

Run locally: `python3 -m http.server 8000` in the repo root, then open http://localhost:8000/app/.

Code: `app/js/google.js` (sign-in + Calendar/Tasks REST), `local.js` (device calendar), `store.js` (merges accounts, caches by month, all edits), `views.js` (month/week/day/list), `modals.js` (dialogs), `app.js` (wiring, drag-and-drop, keys, reminders).

## Architecture (128bit family standard)

- **One 128bit account** across all apps from day one.
- **Shared event schema** — Bitcalendar emits `event.created`, `event.reminded` and reads the family feed (e.g. `workout.logged` → streak day marked).
- **Family event feed** — `supabase/family-feed.sql` in this repo (same block as 128bitPlay's setup SQL — keep them in step). Run once in the Supabase SQL Editor.
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
- [x] Web app: Google Calendar + Tasks, month/week/day/list, full event editing (`app/`)
- [ ] Google OAuth client ID in `app/config.js` + test users added
- [ ] Emit `event.created` to the family feed (needs the 128bit account sign-in)
- [ ] Full app behind the widget (native)
