// Google → Bitcalendar. Each Google calendar and task list gets a Bitcalendar twin; events and
// tasks are copied over, then only changes (syncToken / updatedMin) on every later sync.
// Anything changed or deleted in Bitcalendar stays as it is (bitcal_mirror checks `edited`).
import * as C from './cloud.js';
import * as G from './google.js';
import { lastStart, safeTz, wall } from './recur.js';

const pad = n => String(n).padStart(2, '0');
const ymdIn = (date, tz) => { const w = wall(date, tz); return `${w.y}-${pad(w.m)}-${pad(w.d)}`; };

// "20261020T090000" / "20261020T130000Z" / "20261020" → YYYY-MM-DD in the event's zone.
function exdayOf(v, tz) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v.trim());
  if (!m) return null;
  if (m[7]) return ymdIn(new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6])), tz);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

const originalDay = (o, tz) => o.date || ymdIn(new Date(o.dateTime), safeTz(o.timeZone || tz));

export function eventRow(ev, gcal, email) {
  const calTz = safeTz(gcal.timeZone);
  const skip = ev.recurringEventId && ev.originalStartTime
    ? { skip_master: ev.recurringEventId, skip_date: originalDay(ev.originalStartTime, calTz) } : {};
  if (ev.status === 'cancelled' || !ev.start) return { ext_id: ev.id, cancelled: true, ...skip };
  const allDay = !!ev.start.date;
  const tz = allDay ? 'UTC' : safeTz(ev.start.timeZone || gcal.timeZone);
  const start = new Date(allDay ? `${ev.start.date}T00:00:00Z` : ev.start.dateTime);
  const end = new Date(allDay ? `${ev.end.date}T00:00:00Z` : ev.end.dateTime);
  const rec = ev.recurrence || [];
  const rrule = rec.find(l => /^RRULE:/i.test(l))?.slice(6) || null;
  const exdates = rec.filter(l => /^EXDATE/i.test(l)).flatMap(l => l.slice(l.lastIndexOf(':') + 1).split(',')).map(v => exdayOf(v, tz)).filter(Boolean);
  const r = ev.reminders || {};
  const reminder = r.useDefault
    ? (gcal.defaultReminders || []).find(x => x.method === 'popup')?.minutes ?? null
    : (r.overrides || []).find(x => x.method === 'popup')?.minutes ?? null;
  const until = rrule ? lastStart({ start, end, allDay, tz, rrule }) : null;
  return {
    ext_id: ev.id, title: ev.summary || '(no title)', starts_at: start.toISOString(), ends_at: end.toISOString(),
    all_day: allDay, tz, rrule, until_at: rrule ? (until ? until.toISOString() : null) : null, exdates,
    location: ev.location || '', notes: ev.description || '', color_id: ev.colorId || null, reminder,
    attendees: ev.attendees || null, meet: ev.hangoutLink || null,
    ext: { provider: 'google', email, cal: gcal.id, link: ev.htmlLink || null, organizerSelf: !!ev.organizer?.self },
    ...skip,
  };
}

export const taskRow = t => t.deleted
  ? { ext_id: t.id, cancelled: true }
  : { ext_id: t.id, title: t.title || '(no title)', notes: t.notes || '', due: t.due ? t.due.slice(0, 10) : null, done: t.status === 'completed', done_at: t.completed || null };

// Finds (or makes) the Bitcalendar twin of a Google calendar / task list.
async function twin(cals, kind, email, id, fields) {
  const found = cals.find(c => c.kind === kind && c.ext?.provider === 'google' && c.ext.email === email && c.ext.id === id);
  if (found) return found;
  try {
    const row = await C.insertCalendar({ kind, ...fields, ext: { provider: 'google', email, id } });
    cals.push(row);
    return row;
  } catch {
    // Another device made it first.
    const fresh = await C.listCalendars();
    const again = fresh.find(c => c.kind === kind && c.ext?.provider === 'google' && c.ext.email === email && c.ext.id === id);
    if (!again) throw new Error(`couldn't add ${fields.name}`);
    cals.push(again);
    return again;
  }
}

async function send(fn, id, rows) {
  for (let i = 0; i < rows.length; i += 250) await fn(id, rows.slice(i, i + 250));
}

// One sync of one Google account. progress(text) reports what it's on. Returns counts.
export async function syncAccount(acc, cals, progress = () => {}) {
  const email = acc.email;
  let events = 0, tasks = 0;
  const gcals = (await G.listCalendars(acc)).filter(c =>
    c.accessRole === 'owner' || c.accessRole === 'writer' || (c.accessRole === 'reader' && c.selected !== false));
  for (const gcal of gcals) {
    const name = gcal.summaryOverride || gcal.summary || gcal.id;
    progress(`SYNCING ${name}`);
    const cal = await twin(cals, 'events', email, gcal.id, {
      name, color: gcal.backgroundColor || '#b388ff', hidden: gcal.selected === false,
      default_reminder: (gcal.defaultReminders || []).find(r => r.method === 'popup')?.minutes ?? null,
    });
    let res;
    try { res = await G.syncEvents(acc, gcal.id, cal.ext.syncToken); }
    catch (e) { if (e.status !== 410) throw e; res = await G.syncEvents(acc, gcal.id, null); }
    const rows = res.items.map(ev => eventRow(ev, gcal, email));
    // Series first, so their changed days can be crossed off them.
    await send(C.mirror, cal.id, [...rows.filter(r => !r.skip_master), ...rows.filter(r => r.skip_master)]);
    events += rows.length;
    if (res.nextSyncToken) {
      cal.ext = { ...cal.ext, syncToken: res.nextSyncToken, synced: new Date().toISOString() };
      await C.updateCalendar(cal.id, { ext: cal.ext });
    }
  }
  if (acc.tasksOk !== false) {
    let lists = [];
    try { lists = await G.listTaskLists(acc); acc.tasksOk = true; }
    catch (e) { if (e.status === 403) acc.tasksOk = false; else throw e; }
    for (const l of lists) {
      progress(`SYNCING ${l.title}`);
      const list = await twin(cals, 'tasks', email, l.id, { name: l.title, color: '#b388ff' });
      const startedAt = new Date().toISOString();
      const items = await G.listTasksSince(acc, l.id, list.ext.lastSync);
      const rows = items.filter(t => t.title || t.notes || t.deleted).map(taskRow);
      await send(C.mirrorTasks, list.id, rows);
      tasks += rows.length;
      list.ext = { ...list.ext, lastSync: startedAt };
      await C.updateCalendar(list.id, { ext: list.ext });
    }
  }
  return { events, tasks };
}
