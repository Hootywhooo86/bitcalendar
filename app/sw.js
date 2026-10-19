// Bitcalendar service worker: opens offline (app shell cached), shows push reminders,
// and opens the event when one is tapped.
const CACHE = 'bitcal-v3';
const SHELL = [
  './', 'index.html', 'style.css', 'config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  'js/app.js', 'js/store.js', 'js/views.js', 'js/modals.js', 'js/dates.js', 'js/recur.js',
  'js/local.js', 'js/cloud.js', 'js/google.js', 'js/gsync.js', 'js/native.js',
  'vendor/supabase.js', 'fonts/PressStart2P.ttf',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Own files: network first so updates land straight away, cache when offline.
// Libraries + fonts: cache first. API calls (Supabase, Google): never cached here.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const lib = /^(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(url.hostname);
  if (url.origin !== location.origin && !lib) return;
  if (lib) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('index.html'))));
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data.json(); } catch { d = { title: e.data?.text() || 'Bitcalendar' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Bitcalendar', {
    body: d.body || '', tag: d.tag, renotify: true, icon: 'icon-192.png', badge: 'icon-192.png',
    data: { day: d.day, event: d.event },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const { day, event } = e.notification.data || {};
  e.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = tabs.find(t => new URL(t.url).pathname.startsWith(new URL(self.registration.scope).pathname));
    if (tab) { await tab.focus(); tab.postMessage({ type: 'open', day, event }); return; }
    await self.clients.openWindow(`./${day ? `?day=${day}&event=${encodeURIComponent(event || '')}` : ''}`);
  })());
});
