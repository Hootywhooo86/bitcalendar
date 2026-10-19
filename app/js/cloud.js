// The 128bit account: sign-in plus Bitcalendar's tables in the shared Supabase project
// (supabase/bitcalendar.sql). Rows go in and out as-is; store.js turns them into events.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const cfg = window.BITCAL_CONFIG || {};
export const configured = !!(cfg.supabaseUrl && cfg.supabaseKey);
const sb = configured ? createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } }) : null;

const need = () => { if (!sb) throw new Error('128bit account isn\'t set up in config.js'); };
const check = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const q = s => `"${s}"`;

// ---- account ----

export async function user() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session?.user || null;
}
export function onAuth(fn) { sb?.auth.onAuthStateChange((event, session) => fn(event, session?.user || null)); }
export async function signIn(email, password) { need(); return check(await sb.auth.signInWithPassword({ email, password })).user; }
export async function signUp(email, password) {
  need();
  const data = check(await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.href.split('#')[0] } }));
  return { user: data.session ? data.user : null, confirm: !data.session };
}
export async function sendLink(email) {
  need();
  check(await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split('#')[0].split('?')[0], shouldCreateUser: true } }));
}
export async function signOut() { if (sb) await sb.auth.signOut(); }

// ---- calendars + task lists ----

export const listCalendars = async () => check(await sb.from('bitcal_calendars').select('*').order('position').order('created_at'));
export const insertCalendar = async row => check(await sb.from('bitcal_calendars').insert(row).select().single());
export const updateCalendar = async (id, patch) => check(await sb.from('bitcal_calendars').update(patch).eq('id', id).select().single());
export const deleteCalendar = async id => check(await sb.from('bitcal_calendars').delete().eq('id', id));

// ---- events ----

const EVENT_COLS = 'id,calendar_id,title,starts_at,ends_at,all_day,tz,rrule,until_at,exdates,location,notes,color_id,reminder,attendees,meet,ext,ext_id,edited';

async function all(build) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = check(await build().range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

// Single events overlapping [min, max), and every series that may still have occurrences there.
export function eventsInRange(min, max) {
  const lo = min.toISOString(), hi = max.toISOString(), loSeries = new Date(+min - 32 * 86400000).toISOString();
  return all(() => sb.from('bitcal_events').select(EVENT_COLS).is('deleted_at', null)
    .or(`and(rrule.is.null,starts_at.lt.${q(hi)},ends_at.gt.${q(lo)}),and(rrule.not.is.null,starts_at.lt.${q(hi)},or(until_at.is.null,until_at.gte.${q(loSeries)}))`)
    .order('starts_at'));
}

export async function searchEvents(text) {
  const like = `%${text.replace(/[%_,()"]/g, ' ')}%`;
  return check(await sb.from('bitcal_events').select(EVENT_COLS).is('deleted_at', null)
    .or(`title.ilike.${q(like)},location.ilike.${q(like)},notes.ilike.${q(like)}`).order('starts_at').limit(500));
}

export const getEvent = async id => check(await sb.from('bitcal_events').select(EVENT_COLS).eq('id', id).single());
export const insertEvent = async row => check(await sb.from('bitcal_events').insert(row).select(EVENT_COLS).single());
export const updateEvent = async (id, patch) => check(await sb.from('bitcal_events').update(patch).eq('id', id).select(EVENT_COLS).single());
// Imported events are only marked deleted, so the Google mirror doesn't bring them back.
export const deleteEvent = async (id, soft) => check(soft
  ? await sb.from('bitcal_events').update({ deleted_at: new Date().toISOString() }).eq('id', id)
  : await sb.from('bitcal_events').delete().eq('id', id));

// ---- tasks ----

export const listTasks = () => all(() => sb.from('bitcal_tasks').select('id,list_id,title,notes,due,done,done_at,ext_id').is('deleted_at', null).order('due', { nullsFirst: false }));
export const insertTask = async row => check(await sb.from('bitcal_tasks').insert(row).select().single());
export const updateTask = async (id, patch) => check(await sb.from('bitcal_tasks').update(patch).eq('id', id));
export const deleteTask = async (id, soft) => check(soft
  ? await sb.from('bitcal_tasks').update({ deleted_at: new Date().toISOString() }).eq('id', id)
  : await sb.from('bitcal_tasks').delete().eq('id', id));

// ---- Google mirror ----

export const mirror = async (calId, rows) => check(await sb.rpc('bitcal_mirror', { cal: calId, rows }));
export const mirrorTasks = async (listId, rows) => check(await sb.rpc('bitcal_mirror_tasks', { list: listId, rows }));

// ---- push reminders + family feed ----

export const vapidPublic = async () => check(await sb.rpc('bitcal_vapid_public'));
export async function savePush(sub, tz, h24) {
  const j = sub.toJSON();
  check(await sb.rpc('bitcal_save_push', { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, tz, h24 }));
}
export const removePush = async endpoint => check(await sb.from('bitcal_push').delete().eq('endpoint', endpoint));

// 128bit family feed (supabase/family-feed.sql). Best effort: the feed may not be set up.
export function logFamily(events) { sb?.rpc('log_events', { events }).then(() => {}, () => {}); }

// Calls fn when this account's calendars, events or tasks change on any device.
export function subscribe(userId, fn) {
  if (!sb) return () => {};
  const ch = sb.channel(`bitcal-${userId}`);
  for (const table of ['bitcal_calendars', 'bitcal_events', 'bitcal_tasks']) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: `user_id=eq.${userId}` }, p => fn(table, p));
  }
  ch.subscribe();
  return () => sb.removeChannel(ch);
}
