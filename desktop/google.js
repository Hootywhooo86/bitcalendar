// Google sign-in for the desktop app: the person signs in in their own browser (Google doesn't allow
// it inside apps), Google sends them back to a one-time page on 127.0.0.1, and we keep the refresh
// token, encrypted with Windows' own protection (safeStorage). After that, fresh access tokens come
// without asking again, so Google keeps syncing while Bitcalendar sits in the tray.
const crypto = require('node:crypto');
const http = require('node:http');

const SCOPES = 'openid email profile https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/tasks';
const b64u = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const DONE_PAGE = (ok, msg) => `<!doctype html><meta charset="utf-8"><title>Bitcalendar</title>
<body style="background:#0d0d1a;color:#f5f5f5;font:16px monospace;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;border:6px solid #3d3d5c;border-radius:18px;padding:32px 40px;background:#1a1a2e">
<h1 style="color:${ok ? '#b388ff' : '#ff5c7a'};font-size:22px">${ok ? 'YOU\'RE IN' : 'THAT DIDN\'T WORK'}</h1>
<p style="color:#9e9e9e">${msg}</p></div>`;

function createGoogle({ config, openBrowser, fetch, store }) {
  const need = () => {
    if (!config.googleClientId) throw new Error('Add the Google desktop client ID to desktop/config.json (README → Windows app)');
  };

  async function token(params) {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.googleClientId, ...(config.googleClientSecret ? { client_secret: config.googleClientSecret } : {}), ...params }).toString(),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(j.error_description || j.error || `Google said ${res.status}`);
      err.code = j.error;
      throw err;
    }
    return j;
  }

  // Opens Google in the browser; resolves {access_token, expires_in, scope} once the person is back.
  async function signIn(hint) {
    need();
    const verifier = b64u(crypto.randomBytes(32));
    const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
    const state = b64u(crypto.randomBytes(16));
    const server = http.createServer();
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const redirect = `http://127.0.0.1:${server.address().port}`;
    try {
      const code = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Google sign-in timed out')), 5 * 60_000);
        server.on('request', (req, res) => {
          const u = new URL(req.url, redirect);
          if (u.pathname !== '/') { res.writeHead(404).end(); return; }
          const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(DONE_PAGE(!!ok, ok ? 'Go back to Bitcalendar. You can close this tab.' : (u.searchParams.get('error') || 'Close this tab and try again.')));
          clearTimeout(timeout);
          ok ? resolve(u.searchParams.get('code')) : reject(new Error(u.searchParams.get('error') === 'access_denied' ? 'Google sign-in was cancelled' : 'Google sign-in failed'));
        });
        openBrowser(`https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
          client_id: config.googleClientId, redirect_uri: redirect, response_type: 'code', scope: SCOPES,
          code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent',
          include_granted_scopes: 'true', state, ...(hint ? { login_hint: hint } : {}),
        })}`);
      });
      const t = await token({ code, code_verifier: verifier, redirect_uri: redirect, grant_type: 'authorization_code' });
      const me = await (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${t.access_token}` } })).json();
      if (t.refresh_token && me.email) store.set(me.email, t.refresh_token);
      return { access_token: t.access_token, expires_in: t.expires_in, scope: t.scope };
    } finally {
      server.close();
    }
  }

  // A fresh access token for an account signed in before, or null if Google signed it out.
  async function accessToken(email) {
    need();
    const refresh = store.get(email);
    if (!refresh) return null;
    try {
      const t = await token({ refresh_token: refresh, grant_type: 'refresh_token' });
      return { access_token: t.access_token, expires_in: t.expires_in, scope: t.scope };
    } catch (e) {
      if (e.code === 'invalid_grant') { store.delete(email); return null; }
      throw e;
    }
  }

  async function forget(email) {
    const refresh = store.get(email);
    store.delete(email);
    if (refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST' }).catch(() => {});
  }

  return { signIn, accessToken, forget };
}

module.exports = { createGoogle, SCOPES };
