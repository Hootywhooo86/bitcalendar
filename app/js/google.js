// Google sign-in (Google Identity Services token model) and the Calendar + Tasks REST APIs.
// Runs entirely in the browser: no server, tokens never leave this tab.
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

// ---- Calendar (read for the mirror; write only to answer invites) ----

export const listCalendars = acc => pages(acc, `${CAL}/users/me/calendarList?${qs({ maxResults: 250 })}`);

// Everything in a calendar (series as one item, plus their changed/cancelled days), or with a
// syncToken just what changed since. Resolves {items, nextSyncToken}; a 410 means start over.
export async function syncEvents(acc, calId, syncToken) {
  const items = [];
  let pageToken = '', next = null;
  do {
    const page = await api(acc, 'GET', `${calUrl(calId)}?${qs({
      maxResults: 2500, showDeleted: true, singleEvents: false, syncToken: syncToken || null, pageToken: pageToken || null,
    })}`);
    items.push(...(page.items || []));
    pageToken = page.nextPageToken;
    next = page.nextSyncToken || next;
  } while (pageToken);
  return { items, nextSyncToken: next };
}

export const patchEvent = (acc, calId, id, body) => api(acc, 'PATCH', `${calUrl(calId)}/${encodeURIComponent(id)}`, body);

// ---- Tasks (read for the mirror) ----

export const listTaskLists = acc => pages(acc, `${TASKS}/users/@me/lists?${qs({ maxResults: 100 })}`);

export const listTasksSince = (acc, listId, updatedMin) => pages(acc, `${TASKS}/lists/${encodeURIComponent(listId)}/tasks?${qs({
  maxResults: 100, showCompleted: true, showHidden: true, showDeleted: true, updatedMin: updatedMin || null,
})}`);
