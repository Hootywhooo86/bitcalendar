// What the installed apps add on top of the web app. Android = Capacitor (android/), Windows = Electron
// (desktop/, whose preload puts window.bitcalDesktop here). On the web every call quietly does nothing.
const desk = window.bitcalDesktop;
export const platform = desk ? 'desktop' : window.Capacitor?.isNativePlatform?.() ? 'android' : 'web';
export const isNative = platform !== 'web';

let lib;
const cap = () => lib ||= import('../vendor/capacitor.js');
const widget = async () => (await cap()).registerPlugin('BitcalWidget');

// Where emailed sign-in links send people back to. The apps catch this scheme.
export const AUTH_SCHEME = 'app.bit128.bitcalendar';
export const authRedirect = () => isNative ? `${AUTH_SCHEME}://auth` : location.href.split('#')[0].split('?')[0];

// Small stable number for a reminder, so rescheduling replaces rather than duplicates.
const idOf = key => { let h = 0; for (const c of key) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) || 1; };

let channelMade = false, asked = false;

// Puts the next reminders on the device itself: Android alarms or the desktop app's timers.
// list: [{key, at: Date, title, body, day, event}]. Replaces whatever was scheduled before.
export async function scheduleReminders(list) {
  if (platform === 'desktop') return desk.scheduleReminders(list.map(r => ({ ...r, at: +r.at })));
  if (platform !== 'android') return;
  const { LocalNotifications } = await cap();
  if (!asked) {
    asked = true;
    const p = await LocalNotifications.checkPermissions();
    if (p.display !== 'granted') await LocalNotifications.requestPermissions();
  }
  if (!channelMade) {
    channelMade = true;
    await LocalNotifications.createChannel({ id: 'reminders', name: 'Reminders', description: 'Event reminders', importance: 5, visibility: 1, vibration: true }).catch(() => {});
  }
  const pending = await LocalNotifications.getPending();
  if (pending.notifications.length) await LocalNotifications.cancel({ notifications: pending.notifications.map(n => ({ id: n.id })) });
  if (!list.length) return;
  await LocalNotifications.schedule({
    notifications: list.slice(0, 60).map(r => ({
      id: idOf(r.key), title: r.title, body: r.body, channelId: 'reminders', smallIcon: 'ic_stat_bitcal', iconColor: '#b388ff',
      schedule: { at: r.at, allowWhileIdle: true }, extra: { day: r.day, event: r.event },
    })),
  });
}

// fn(day, eventId) when someone taps a reminder or a widget day.
export async function onOpen(fn) {
  if (platform === 'desktop') return desk.onOpen(fn);
  if (platform !== 'android') return;
  const { LocalNotifications, App } = await cap();
  LocalNotifications.addListener('localNotificationActionPerformed', a => fn(a.notification.extra?.day, a.notification.extra?.event));
  const open = url => {
    const u = new URL(url);
    if (u.host === 'open') fn(u.searchParams.get('day'), u.searchParams.get('event'));
  };
  App.addListener('appUrlOpen', e => e.url.startsWith(`${AUTH_SCHEME}://open`) && open(e.url));
  const launch = await App.getLaunchUrl();
  if (launch?.url?.startsWith(`${AUTH_SCHEME}://open`)) open(launch.url);
}

// fn(url) with an emailed sign-in link that opened the app.
export async function onAuthLink(fn) {
  if (platform === 'desktop') return desk.onAuthLink(fn);
  if (platform !== 'android') return;
  const { App } = await cap();
  App.addListener('appUrlOpen', e => e.url.startsWith(`${AUTH_SCHEME}://auth`) && fn(e.url));
  const launch = await App.getLaunchUrl();
  if (launch?.url?.startsWith(`${AUTH_SCHEME}://auth`)) fn(launch.url);
}

// fn() when the app comes back to the front.
export async function onResume(fn) {
  if (platform === 'desktop') return desk.onShow(fn);
  if (platform !== 'android') return;
  (await cap()).App.addListener('resume', fn);
}

// fn('new' | 'sync') from the desktop tray menu.
export function onCommand(fn) { if (platform === 'desktop') desk.onCommand(fn); }

// Hands the home-screen widgets what to draw (Android).
export async function updateWidget(snapshot) {
  if (platform !== 'android') return;
  (await widget()).update({ data: JSON.stringify(snapshot) }).catch(() => {});
}

export async function openExternal(url) {
  if (platform === 'desktop') return desk.openExternal(url);
  if (platform === 'android') return (await cap()).Browser.open({ url });
  window.open(url, '_blank', 'noopener');
}

// Google: the web uses Google's popup. The apps sign in the way Google allows for apps — Android with
// the phone's own account picker (GooglePlugin.java), Windows through the real browser — and both get
// fresh tokens without asking again, so Google keeps syncing.
const googlePlugin = async () => (await cap()).registerPlugin('BitcalGoogle');
export const googleHere = true;
export const googleRefreshes = platform !== 'web';
// → {access_token, expires_in, scope}
export async function googleSignIn(hint, creds) {
  if (platform === 'desktop') return desk.googleSignIn(hint, creds);
  return (await googlePlugin()).authorize({ interactive: true, email: hint || '' });
}
// → same, or null when Google wants the person to sign in again
export async function googleToken(email, creds) {
  if (platform === 'desktop') return desk.googleToken(email, creds);
  try { return await (await googlePlugin()).authorize({ interactive: false, email }); } catch { return null; }
}
export const googleForget = email => desk?.googleForget(email);

// ---- updates ----

const REPO = 'Hootywhooo86/bitcalendar';
export async function appVersion() {
  if (platform === 'desktop') return desk.appVersion();
  if (platform === 'android') return (await (await cap()).App.getInfo()).version;
  return null;
}
const newer = (a, b) => {
  const pa = a.replace(/^v/, '').split('.').map(Number), pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
// The newest GitHub release, if it's newer than this app: {version, url} (the APK or the Windows installer).
// Asks GitHub at most every 6 hours (its API allows 60 calls an hour per connection).
export async function checkUpdate() {
  const mine = await appVersion().catch(() => null);
  if (!mine) return null;
  let rel = null;
  try { const c = JSON.parse(localStorage.getItem('bitcal.release')); if (c && Date.now() - c.at < 6 * 3600_000) rel = c.rel; } catch {}
  if (!rel) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return null;
    const r = await res.json();
    rel = { tag_name: r.tag_name, assets: (r.assets || []).map(a => ({ name: a.name, browser_download_url: a.browser_download_url })) };
    try { localStorage.setItem('bitcal.release', JSON.stringify({ at: Date.now(), rel })); } catch {}
  }
  if (!rel.tag_name || !newer(rel.tag_name, mine)) return null;
  const want = platform === 'android' ? /\.apk$/i : /Setup.*\.exe$/i;
  const asset = (rel.assets || []).find(a => want.test(a.name));
  return asset ? { version: rel.tag_name.replace(/^v/, ''), url: asset.browser_download_url } : null;
}
