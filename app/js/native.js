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

// Google: the web uses Google's popup; the desktop app signs in through the real browser and keeps
// a refresh token (so Google keeps syncing all day). Android leaves Google to the other two.
export const googleHere = platform !== 'android';
export const googleRefreshes = platform === 'desktop';
export const googleSignIn = hint => desk.googleSignIn(hint);       // → {access_token, expires_in, scope}
export const googleToken = email => desk.googleToken(email);       // → same, or null when signed out
export const googleForget = email => desk?.googleForget(email);
