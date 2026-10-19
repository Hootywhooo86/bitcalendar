// Google sign-in (Google Identity Services token model) and the Calendar + Tasks REST APIs.
// Runs entirely in the browser: no server, tokens never leave this tab.
import { addDays, parseYmd, ymd } from './dates.js';

const SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/tasks',
].join(' ');
const CAL = 'https://www.googleapis.com/calendar/v3';
const TASKS = 'https://tasks.googleapis.com/tasks/v1';
export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Google Calendar's fixed event colors (colorId → background).
export const EVENT_COLORS = {
  1: '#a4bdfc', 2: '#7ae7bf', 3: '#dbadff', 4: '#ff887c', 5: '#fbd75b', 6: '#ffb878',
  7: '#46d6db', 8: '#e1e1e1', 9: '#5484ed', 10: '#51b749', 11: '#dc2127',
};

export class AuthError extends Error {}

let gisLoading = null;
export function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return gisLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => { gisLoading = null; reject(new Error('Could not load Google sign-in')); };
    document.head.appendChild(s);
  });
}
export const gisReady = () => !!window.google?.accounts?.oauth2;

// Opens Google's account chooser. Must run inside a click handler (popup), with GIS already loaded.
export function requestToken(clientId, hint) {
  return new Promise((resolve, reject) => {
    if (!gisReady()) return reject(new Error('Google sign-in is still loading, try again'));
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      include_granted_scopes: true,
      prompt: hint ? '' : 'select_account',
      login_hint: hint || undefined,
      callback: r => r.error ? reject(new Error(r.error_description || r.error)) : resolve(r),
      error_callback: e => reject(new Error(e.type === 'popup_closed' ? 'Sign-in window closed' : e.message || e.type)),
    });
    client.requestAccessToken();
  });
}

export async function signIn(clientId, hint) {
  const r = await requestToken(clientId, hint);
  const acc = { token: r.access_token, expiresAt: Date.now() + r.expires_in * 1000, scope: r.scope };
  const me = await api(acc, 'GET', 'https://www.googleapis.com/oauth2/v3/userinfo');
  return { ...acc, email: me.email, name: me.name || me.email, picture: me.picture || '' };
}

export function revoke(token) { try { google.accounts.oauth2.revoke(token, () => {}); } catch {} }

async function api(acc, method, url, body) {
  if (!acc.token || Date.now() > acc.expiresAt - 30000) throw new AuthError('Google session expired');
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${acc.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new AuthError('Google session expired');
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error?.message || `Google said ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function pages(acc, url, key = 'items') {
  const out = [];
  let token = '';
  do {
    const sep = url.includes('?') ? '&' : '?';
    const page = await api(acc, 'GET', url + (token ? `${sep}pageToken=${encodeURIComponent(token)}` : ''));
    out.push(...(page[key] || []));
    token = page.nextPageToken;
  } while (token);
  return out;
}

const qs = o => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null)).toString();
const calUrl = id => `${CAL}/calendars/${encodeURIComponent(id)}/events`;

// ---- Calendar ----

export const listCalendars = acc => pages(acc, `${CAL}/users/me/calendarList?${qs({ maxResults: 250 })}`);

export function fromGoogle(ev, cal) {
  const allDay = !!ev.start?.date;
  const reminders = ev.reminders || {};
  const self = (ev.attendees || []).find(a => a.self);
  return {
    uid: `${cal.key}|${ev.id}`, id: ev.id, calKey: cal.key,
    title: ev.summary || '(no title)',
    start: allDay ? parseYmd(ev.start.date) : new Date(ev.start.dateTime),
    end: allDay ? parseYmd(ev.end.date) : new Date(ev.end.dateTime),
    allDay, location: ev.location || '', description: ev.description || '',
    colorId: ev.colorId || null, seriesId: ev.recurringEventId || null,
    reminder: reminders.useDefault ? 'default' : (reminders.overrides || []).find(o => o.method === 'popup')?.minutes ?? null,
    htmlLink: ev.htmlLink, meet: ev.hangoutLink || '', attendees: ev.attendees || [],
    organizer: ev.organizer, selfStatus: self?.responseStatus || null,
    editable: cal.writable, raw: ev,
  };
}

export async function listEvents(acc, cal, min, max) {
  const items = await pages(acc, `${calUrl(cal.id)}?${qs({
    timeMin: min.toISOString(), timeMax: max.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 2500,
  })}`);
  return items.filter(e => e.status !== 'cancelled' && e.start).map(e => fromGoogle(e, cal));
}

export async function searchEvents(acc, cal, q) {
  const now = new Date();
  const items = await pages(acc, `${calUrl(cal.id)}?${qs({
    q, timeMin: addDays(now, -365).toISOString(), timeMax: addDays(now, 365).toISOString(),
    singleEvents: true, orderBy: 'startTime', maxResults: 250,
  })}`);
  return items.filter(e => e.status !== 'cancelled' && e.start).map(e => fromGoogle(e, cal));
}

export const getEvent = (acc, calId, id) => api(acc, 'GET', `${calUrl(calId)}/${encodeURIComponent(id)}`);

// Draft (from the editor) → Google event fields. withRecurrence only for new events and whole-series edits.
export function toGoogle(d, withRecurrence) {
  const when = t => d.allDay ? { date: ymd(t), dateTime: null, timeZone: null } : { dateTime: t.toISOString(), timeZone: TZ, date: null };
  const body = {
    summary: d.title, location: d.location || '', description: d.description || '',
    colorId: d.colorId || null, start: when(d.start), end: when(d.end),
  };
  if (d.reminder !== undefined) body.reminders = d.reminder === 'default'
    ? { useDefault: true }
    : { useDefault: false, overrides: d.reminder == null ? [] : [{ method: 'popup', minutes: +d.reminder }] };
  // rrule undefined means "leave the repeat alone" (drag-and-drop moves).
  if (withRecurrence && (d.recurrence || d.rrule !== undefined)) body.recurrence = d.recurrence || (d.rrule ? [`RRULE:${d.rrule}`] : []);
  return body;
}

const strip = o => JSON.parse(JSON.stringify(o, (k, v) => v === null ? undefined : v));

export const insertEvent = (acc, calId, body) => api(acc, 'POST', calUrl(calId), strip(body));
export const patchEvent = (acc, calId, id, body) => api(acc, 'PATCH', `${calUrl(calId)}/${encodeURIComponent(id)}`, body);
export const deleteEvent = (acc, calId, id) => api(acc, 'DELETE', `${calUrl(calId)}/${encodeURIComponent(id)}`);
export const moveEvent = (acc, calId, id, dest) =>
  api(acc, 'POST', `${calUrl(calId)}/${encodeURIComponent(id)}/move?${qs({ destination: dest })}`);

// ---- Tasks ----

export const listTaskLists = acc => pages(acc, `${TASKS}/users/@me/lists?${qs({ maxResults: 100 })}`);

export async function listTasks(acc, listId) {
  const items = await pages(acc, `${TASKS}/lists/${encodeURIComponent(listId)}/tasks?${qs({
    maxResults: 100, showCompleted: true, showHidden: true,
  })}`);
  return items.filter(t => !t.deleted && (t.title || t.notes)).map(t => ({
    id: t.id, listId, title: t.title || '(no title)', notes: t.notes || '',
    due: t.due ? parseYmd(t.due) : null, completed: t.status === 'completed', link: t.webViewLink,
  }));
}

// Tasks only keep the date of "due"; Google stores it as midnight UTC.
const taskBody = d => ({
  title: d.title, notes: d.notes || '', due: d.due ? `${ymd(d.due)}T00:00:00.000Z` : null,
  status: d.completed ? 'completed' : 'needsAction', ...(d.completed ? {} : { completed: null }),
});
const taskUrl = listId => `${TASKS}/lists/${encodeURIComponent(listId)}/tasks`;
export const insertTask = (acc, listId, d) => api(acc, 'POST', taskUrl(listId), strip(taskBody(d)));
export const patchTask = (acc, listId, id, d) => api(acc, 'PATCH', `${taskUrl(listId)}/${encodeURIComponent(id)}`, taskBody(d));
export const deleteTask = (acc, listId, id) => api(acc, 'DELETE', `${taskUrl(listId)}/${encodeURIComponent(id)}`);
