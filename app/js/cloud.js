// The 128bit account: sign-in plus Bitcalendar's tables in the shared Supabase project
// (supabase/bitcalendar.sql). Rows go in and out as-is; store.js turns them into events.
import { createClient } from '../vendor/supabase.js';
import { authRedirect } from './native.js';

const cfg = window.BITCAL_CONFIG || {};
export const configured = !!(cfg.supabaseUrl && cfg.supabaseKey);

// ---- Clerk (when config.js has clerkPublishableKey) ----
// Clerk does the signing in; Supabase trusts Clerk's session token (Supabase → Authentication →
// Third-party auth → Clerk), so each request carries it. Google comes through Clerk too: signing in
// with Google (with Calendar + Tasks allowed) lets the bitcal-google function sync from the server.
export const usesClerk = !!cfg.clerkPublishableKey;
const CLERK_JS = '6.37.0', CLERK_UI = '1.38.1';
export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/tasks'];
// The publishable key carries Clerk's frontend address: pk_test_<base64("host$")>.
const clerkHost = usesClerk ? atob(cfg.clerkPublishableKey.split('_')[2] || '').replace(/\$$/, '') : '';
const APPEARANCE = {
  variables: {
    colorPrimary: '#b388ff', colorBackground: '#1a1a2e', colorForeground: '#f5f5f5', colorText: '#f5f5f5',
    colorMutedForeground: '#9e9e9e', colorTextSecondary: '#9e9e9e', colorInput: '#101024', colorInputBackground: '#101024',
    colorInputForeground: '#f5f5f5', colorInputText: '#f5f5f5', colorDanger: '#ff5c7a',
    fontFamily: "'Press Start 2P', monospace", fontSize: '11px', borderRadius: '6px',
  },
};
const script = (src, attrs = {}) => new Promise((resolve, reject) => {
  const el = document.createElement('script');
  el.src = src;
  el.async = true;
  el.crossOrigin = 'anonymous';
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.onload = resolve;
  el.onerror = () => reject(new Error('Could not reach Clerk'));
  document.head.appendChild(el);
});
let clerkReady = null;
export function clerk() {
  return clerkReady ||= (async () => {
    await script(`https://${clerkHost}/npm/@clerk/ui@${CLERK_UI}/dist/ui.browser.js`);
    await script(`https://${clerkHost}/npm/@clerk/clerk-js@${CLERK_JS}/dist/clerk.browser.js`, { 'data-clerk-publishable-key': cfg.clerkPublishableKey });
    await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor }, appearance: APPEARANCE });
    return window.Clerk;
  })().catch(e => { clerkReady = null; throw e; });
}
const clerkToken = async () => {
  try { const c = await clerk(); return c.session ? await c.session.getToken() : null; } catch { return null; }
};
const asUser = u => u && { id: u.id, email: u.primaryEmailAddress?.emailAddress || u.emailAddresses?.[0]?.emailAddress || '' };

const sb = !configured ? null : usesClerk
  ? createClient(cfg.supabaseUrl, cfg.supabaseKey, { accessToken: clerkToken })
  : createClient(cfg.supabaseUrl, cfg.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });

// PostgREST's answer when a table doesn't exist (supabase/bitcalendar.sql not run yet).
export const isMissingDb = e => /schema cache|does not exist|PGRST205|42P01/i.test(String(e?.message || e));

const need = () => { if (!sb) throw new Error('128bit account isn\'t set up in config.js'); };
const check = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const q = s => `"${s}"`;

// ---- account ----

export async function user() {
  if (!sb) return null;
  if (usesClerk) {
    try {
      const u = asUser((await clerk()).user);
      try { localStorage.setItem('bitcal.clerk.user', JSON.stringify(u)); } catch {}
      return u;
    } catch {
      // Offline (or Clerk unreachable): the last person signed in here, so saved calendars still show.
      try { return JSON.parse(localStorage.getItem('bitcal.clerk.user')); } catch { return null; }
    }
  }
  const { data } = await sb.auth.getSession();
  return data.session?.user || null;
}
export function onAuth(fn) {
  if (usesClerk) {
    clerk().then(c => c.addListener(({ user: u }) => {
      try { localStorage.setItem('bitcal.clerk.user', JSON.stringify(asUser(u) || null)); } catch {}
      fn(u ? 'SIGNED_IN' : 'SIGNED_OUT', asUser(u));
    })).catch(() => {});
    return;
  }
  sb?.auth.onAuthStateChange((event, session) => fn(event, session?.user || null));
}
// Clerk's own sign-in (email, password or Google), in the app's colours.
export async function openClerkSignIn() { (await clerk()).openSignIn({ appearance: APPEARANCE, fallbackRedirectUrl: location.href }); }
export async function openClerkProfile() { (await clerk()).openUserProfile({ appearance: APPEARANCE, additionalOAuthScopes: { google: GOOGLE_SCOPES } }); }
export async function signIn(email, password) { need(); return check(await sb.auth.signInWithPassword({ email, password })).user; }
export async function signUp(email, password) {
  need();
  const data = check(await sb.auth.signUp({ email, password, options: { emailRedirectTo: authRedirect() } }));
  return { user: data.session ? data.user : null, confirm: !data.session };
}
export async function sendLink(email) {
  need();
  check(await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: authRedirect(), shouldCreateUser: true } }));
}
// An emailed sign-in link that opened the Android or desktop app (…://auth#access_token=…).
export async function handleAuthLink(url) {
  need();
  const u = new URL(url.replace(/^[\w.+-]+:\/\//, 'https://x/'));
  const p = new URLSearchParams(u.hash.slice(1) || u.search.slice(1));
  if (p.get('error_description')) throw new Error(p.get('error_description'));
  if (p.get('code')) return check(await sb.auth.exchangeCodeForSession(p.get('code'))).user;
  if (p.get('access_token')) return check(await sb.auth.setSession({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token') })).user;
  throw new Error('That sign-in link is missing its key, ask for a new one');
}
export async function signOut() {
  if (usesClerk) { await (await clerk()).signOut(); return; }
  if (sb) await sb.auth.signOut();
}

// ---- Google through Clerk (usesClerk) ----

// The Google account linked in Clerk: {email, scopes}, or null.
export async function googleLink() {
  const ea = (await clerk()).user?.externalAccounts?.find(a => a.provider === 'google');
  return ea ? { email: ea.emailAddress, scopes: String(ea.approvedScopes || '') } : null;
}
// Links Google (or asks again for Calendar + Tasks). Resolves 'ready', or the Google page to go to.
export async function linkGoogle(redirectUrl) {
  const u = (await clerk()).user;
  if (!u) throw new Error('Sign in first');
  const ea = u.externalAccounts.find(a => a.provider === 'google');
  let res;
  if (!ea) res = await u.createExternalAccount({ strategy: 'oauth_google', redirectUrl, additionalScopes: GOOGLE_SCOPES });
  else if (!GOOGLE_SCOPES.every(sc => String(ea.approvedScopes || '').includes(sc))) res = await ea.reauthorize({ redirectUrl, additionalScopes: GOOGLE_SCOPES });
  else return 'ready';
  const url = res?.verification?.externalVerificationRedirectURL;
  if (!url) throw new Error('Clerk didn\'t hand over a Google sign-in page');
  return String(url.href || url);
}
export async function unlinkGoogle() {
  const ea = (await clerk()).user?.externalAccounts?.find(a => a.provider === 'google');
  if (ea) await ea.destroy();
}
// The server function that syncs Google with Clerk's token (supabase/functions/bitcal-google).
export async function googleServer(action = 'sync', extra = {}) {
  const token = await clerkToken();
  if (!token) throw new Error('Sign in first');
  const res = await fetch(`${cfg.supabaseUrl}/functions/v1/bitcal-google`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: cfg.supabaseKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 404) throw new Error('The Google sync server isn\'t set up yet (README → Clerk → bitcal-google)');
  if (!res.ok) throw new Error(body.error || `Server said ${res.status}`);
  return body;
}
export const googleStatus = async () => check(await sb.from('bitcal_google').select('*').maybeSingle());

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
