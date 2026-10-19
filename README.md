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
- [ ] Full app behind the widget
