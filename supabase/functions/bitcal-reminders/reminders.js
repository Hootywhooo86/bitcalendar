// Which reminders are due right now. Pure: index.ts does the database + sending.
import { expand, fromWall, wall } from './recur.js';

export const CATCH_UP = 10 * 60000; // a missed minute (cold start, slow run) still gets sent

const pad = n => String(n).padStart(2, '0');

// events: bitcal_events rows (reminder not null). tzOf(user_id) → that person's time zone.
// Returns [{ev, at: Date (occurrence start)}] whose reminder time is in (now - CATCH_UP, now].
export function due(events, now, tzOf) {
  const out = [];
  for (const ev of events) {
    const rem = ev.reminder * 60000;
    const lo = now - CATCH_UP + rem, hi = now + rem;
    const userTz = tzOf(ev.user_id) || 'UTC';
    // All-day events are pinned to midnight where the person is; widen the search a day each way.
    const pad1 = ev.all_day ? 86400000 * 2 : 0;
    const occs = expand({
      start: new Date(ev.starts_at), end: new Date(ev.ends_at), allDay: ev.all_day,
      tz: ev.all_day ? 'UTC' : ev.tz, rrule: ev.rrule, exdates: ev.exdates,
    }, new Date(lo - pad1), new Date(hi + 1 + pad1), 50);
    for (const o of occs) {
      // expand() hands all-day days back as midnight in the server's zone (UTC on Supabase).
      const at = ev.all_day
        ? fromWall(o.start.getFullYear(), o.start.getMonth() + 1, o.start.getDate(), 0, 0, userTz)
        : o.start;
      if (+at >= lo && +at <= hi) out.push({ ev, at });
    }
  }
  return out;
}

export function message(ev, at, now, tz, h24) {
  const mins = Math.round((at - now) / 60000);
  const when = mins <= 0 ? 'NOW' : mins < 60 ? `IN ${mins} MIN` : mins < 1440 ? `IN ${Math.round(mins / 60)} H` : `IN ${Math.round(mins / 1440)} DAYS`;
  const w = wall(at, tz);
  const time = ev.all_day ? 'ALL DAY' : h24 ? `${pad(w.h)}:${pad(w.mi)}` : `${w.h % 12 || 12}:${pad(w.mi)}${w.h < 12 ? 'AM' : 'PM'}`;
  return {
    title: ev.title || 'Bitcalendar',
    body: [when, time, ev.location].filter(Boolean).join(' · '),
    tag: `${ev.id}@${+at}`,
    day: `${w.y}-${pad(w.m)}-${pad(w.d)}`,
    event: ev.id,
  };
}
