// Google → Bitcalendar on the server, with the Google token Clerk keeps for each person (they signed in
// with Google through Clerk and allowed Calendar + Tasks). Phones and computers only read the result.
//
//   POST {action: 'sync'}   (Authorization: Bearer <Clerk session token>)  → sync me now
//   POST {action: 'rsvp', calendar, event, attendees}  (same auth)         → answer an invite in Google
//   POST {action: 'cron'}   (pg_cron, every 10 min)                         → sync everyone who's due
//
// Pure: index.ts hands in the database and Clerk pieces, so this runs in tests too.
import { patchEvent, AuthError } from './google.js';
import { syncAccount } from './gsync.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const DUE_MS = 9 * 60_000;

// deps: verify(token) → user id; dbFor(userId) → gsync's db for that person; status: {get, set, due};
// clerkSecret; fetch.
export function createHandler({ verify, dbFor, status, clerkSecret, fetch = globalThis.fetch, now = () => Date.now() }) {
  // Clerk's Backend API hands out (and renews when asked) the person's Google token.
  async function googleToken(userId) {
    let lastStatus = 0;
    for (const provider of ['oauth_google', 'google']) {
      const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}/oauth_access_tokens/${provider}`, {
        headers: { Authorization: `Bearer ${clerkSecret}` },
      });
      lastStatus = res.status;
      if (!res.ok) continue;
      const body = await res.json();
      const t = (Array.isArray(body) ? body : body.data || []).find(x => x.token);
      if (t) return { token: t.token, scopes: t.scopes || [] };
    }
    if (lastStatus === 401 || lastStatus === 403) throw new Error('Clerk refused the secret key (CLERK_SECRET_KEY)');
    return null;
  }

  async function syncUser(userId) {
    const tok = await googleToken(userId);
    if (!tok) return status.set(userId, { status: 'NOT CONNECTED', error: 'Sign in with Google (or connect Google) in Bitcalendar' });
    if (tok.scopes.length && !tok.scopes.some(s => s.includes('/auth/calendar'))) {
      return status.set(userId, { status: 'NEEDS CALENDAR ACCESS', error: 'Connect Google again and allow Calendar + Tasks' });
    }
    const me = await (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${tok.token}` } })).json().catch(() => ({}));
    const acc = { email: me.email || 'google', token: tok.token, expiresAt: Date.now() + 50 * 60_000, fetch };
    const db = dbFor(userId);
    try {
      const n = await syncAccount(acc, await db.listCalendars(), db);
      return status.set(userId, { email: acc.email, status: 'SYNCED', error: null, synced_at: new Date(now()).toISOString(), changes: n.events + n.tasks });
    } catch (e) {
      const signedOut = e instanceof AuthError;
      return status.set(userId, { email: acc.email, status: signedOut ? 'GOOGLE SIGNED OUT' : 'SYNC FAILED', error: signedOut ? 'Connect Google again in Bitcalendar' : String(e.message || e) });
    }
  }

  async function caller(req) {
    const auth = req.headers.get('Authorization') || '';
    if (!auth.startsWith('Bearer ')) return null;
    try { return await verify(auth.slice(7)); } catch { return null; }
  }

  return async function handle(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
    const body = await req.json().catch(() => ({}));
    try {
      if (body.action === 'cron') {
        const due = await status.due(new Date(now() - DUE_MS).toISOString(), 25);
        const out = [];
        for (const id of due) out.push((await syncUser(id)).status);
        return json({ synced: out.length, statuses: out });
      }
      const userId = await caller(req);
      if (!userId) return json({ error: 'Sign in first' }, 401);
      if (body.action === 'sync') return json(await syncUser(userId));
      if (body.action === 'rsvp') {
        const tok = await googleToken(userId);
        if (!tok) return json({ error: 'Connect Google first' }, 409);
        await patchEvent({ token: tok.token, expiresAt: Date.now() + 50 * 60_000, fetch }, body.calendar, body.event, { attendees: body.attendees });
        return json({ ok: true });
      }
      return json({ error: 'unknown action' }, 400);
    } catch (e) {
      console.error(e);
      return json({ error: String(e.message || e) }, 500);
    }
  };
}
