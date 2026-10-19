// The "ON THIS DEVICE" calendar: events and tasks kept in this browser's localStorage.
import { addDays, daysBetween, parseYmd, startOfDay, ymd, withTime } from './dates.js';

const KEY = 'bitcal.local.v1';
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return seed();
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch {} }

// First launch gets the same squares the landing page mock shows, so the grid isn't empty.
function seed() {
  const today = startOfDay(new Date());
  const sat = addDays(today, (6 - today.getDay() + 7) % 7);
  const ev = (title, day, from, to, extra = {}) => ({
    id: newId(), title, start: withTime(day, from).toISOString(), end: withTime(day, to).toISOString(),
    allDay: false, location: '', description: '', colorId: null, rrule: null, exdates: [], reminder: 10, ...extra,
  });
  return {
    events: [
      ev('Morning quest: log workout', today, 7 * 60, 8 * 60, { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' }),
      ev("Birthday dinner @ Nana's", sat, 17 * 60, 19 * 60, { location: "Nana's" }),
    ],
    tasks: [{ id: newId(), title: 'Call mom back', notes: '', due: ymd(today), completed: false }],
  };
}

let db = load();
save();

const FREQ_STEP = { DAILY: 1, WEEKLY: 7 };

// Yields [start, end] for each occurrence of a stored event that overlaps [min, max).
function* occurrences(e, min, max) {
  const start = new Date(e.start), end = new Date(e.end);
  const span = e.allDay ? daysBetween(start, end) : end - start;
  const endOf = s => e.allDay ? addDays(s, span) : new Date(s.getTime() + span);
  if (!e.rrule) { if (start < max && end > min) yield [start, end]; return; }
  const freq = /FREQ=(\w+)/.exec(e.rrule)?.[1];
  const weekdays = /BYDAY=MO,TU,WE,TH,FR/.test(e.rrule);
  const until = /UNTIL=(\d{8})/.exec(e.rrule)?.[1];
  const last = until ? addDays(parseYmd(`${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6)}`), 1) : null;
  const step = weekdays ? 1 : FREQ_STEP[freq];
  // Skip straight to the range for day-based rules instead of walking from the first occurrence.
  const spanDays = e.allDay ? span : Math.ceil(span / 86400000);
  let i = step ? Math.max(0, Math.floor(daysBetween(start, min) / step) - Math.ceil(spanDays / step) - 1) : 0;
  for (let n = 0; n < 4000; i++, n++) {
    let s;
    if (step) s = addDays(start, i * step);
    else if (freq === 'MONTHLY') s = new Date(start.getFullYear(), start.getMonth() + i, start.getDate(), start.getHours(), start.getMinutes());
    else if (freq === 'YEARLY') s = new Date(start.getFullYear() + i, start.getMonth(), start.getDate(), start.getHours(), start.getMinutes());
    else return;
    if (s >= max || (last && s >= last)) return;
    if (!step && s.getDate() !== start.getDate()) continue; // no Feb 30th
    if (weekdays && (s.getDay() === 0 || s.getDay() === 6)) continue;
    if (e.exdates?.includes(ymd(s))) continue;
    const eEnd = endOf(s);
    if (eEnd > min) yield [s, eEnd];
  }
}

export function listEvents(cal, min, max) {
  const out = [];
  for (const e of db.events) {
    for (const [s, en] of occurrences(e, min, max)) {
      const id = e.rrule ? `${e.id}::${ymd(s)}` : e.id;
      out.push({
        uid: `${cal.key}|${id}`, id, calKey: cal.key, title: e.title || '(no title)', start: s, end: en,
        allDay: e.allDay, location: e.location, description: e.description, colorId: e.colorId,
        seriesId: e.rrule ? e.id : null, reminder: e.reminder, editable: true,
      });
    }
  }
  return out;
}

export function search(cal, q) {
  const now = new Date();
  return listEvents(cal, addDays(now, -365), addDays(now, 365))
    .filter(e => `${e.title} ${e.location} ${e.description}`.toLowerCase().includes(q));
}

export const getSeries = id => db.events.find(e => e.id === id);

// Fields the draft leaves undefined stay as they are.
function fromDraft(d) {
  const f = {
    title: d.title, start: d.start.toISOString(), end: d.end.toISOString(), allDay: d.allDay,
    location: d.location || '', description: d.description || '', colorId: d.colorId || null,
  };
  if (d.reminder !== undefined) f.reminder = d.reminder === 'default' ? 10 : d.reminder;
  return f;
}

export function insertEvent(draft) {
  const e = { id: newId(), exdates: [], rrule: draft.rrule || null, reminder: null, ...fromDraft(draft) };
  db.events.push(e); save();
  return e.id;
}

// Rewrites a whole stored event (a series when it repeats).
export function updateSeries(id, draft) {
  const e = getSeries(id);
  if (!e) throw new Error('Event not found');
  Object.assign(e, fromDraft(draft));
  if (draft.rrule !== undefined) e.rrule = draft.rrule || null;
  save();
}

export function removeSeries(id) { db.events = db.events.filter(e => e.id !== id); save(); }

export function skipOccurrence(id, day) {
  const e = getSeries(id);
  if (e) { e.exdates = [...(e.exdates || []), ymd(day)]; save(); }
}

// Tasks: one list, "MY QUESTS".
export const taskLists = () => [{ id: 'quests', title: 'MY QUESTS' }];
export const listTasks = () => db.tasks.map(t => ({ ...t, listId: 'quests', due: t.due ? parseYmd(t.due) : null }));
const taskFields = d => ({ title: d.title, notes: d.notes || '', due: d.due ? ymd(d.due) : null, completed: !!d.completed });
export function insertTask(draft) { db.tasks.push({ id: newId(), ...taskFields(draft) }); save(); }
export function updateTask(id, draft) {
  const t = db.tasks.find(x => x.id === id);
  if (t) { Object.assign(t, taskFields(draft)); save(); }
}
export function deleteTask(id) { db.tasks = db.tasks.filter(t => t.id !== id); save(); }

export function wipe() { localStorage.removeItem(KEY); db = { events: [], tasks: [] }; save(); }
