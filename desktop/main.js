// Bitcalendar for Windows. Same app as the web (../app, packed as resources/app-web), plus:
// lives in the tray, can start with Windows, shows reminders as Windows notifications,
// and keeps Google syncing in the background (google.js).
const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage, net, protocol, safeStorage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createGoogle } = require('./google');
const { createReminders } = require('./reminders');

const SCHEME = 'app.bit128.bitcalendar'; // emailed sign-in links + "open this day" links
const WEB = app.isPackaged ? path.join(process.resourcesPath, 'app-web') : path.join(__dirname, '..', 'app');
const ICON = path.join(__dirname, 'build', 'icon.png');
const config = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch { return {}; } })();

let win = null, tray = null, quitting = false, toldAboutTray = false;
const pendingLinks = [];

// One copy only: a second launch (or a link click) hands its link to the running one.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', (_e, argv) => {
  const link = argv.find(a => a.startsWith(`${SCHEME}://`));
  show();
  if (link) handleLink(link);
});
if (process.defaultApp && process.argv[1]) app.setAsDefaultProtocolClient(SCHEME, process.execPath, [path.resolve(process.argv[1])]);
else app.setAsDefaultProtocolClient(SCHEME);

protocol.registerSchemesAsPrivileged([{ scheme: 'bitcal', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

// ---- refresh tokens, encrypted by Windows for this user ----
const tokenFile = () => path.join(app.getPath('userData'), 'google-tokens.json');
const tokenStore = {
  all() { try { return JSON.parse(fs.readFileSync(tokenFile(), 'utf8')); } catch { return {}; } },
  get(email) {
    const v = this.all()[email];
    if (!v) return null;
    try { return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : null; } catch { return null; }
  },
  set(email, token) {
    if (!safeStorage.isEncryptionAvailable()) return;
    const all = this.all();
    all[email] = safeStorage.encryptString(token).toString('base64');
    fs.writeFileSync(tokenFile(), JSON.stringify(all), { mode: 0o600 });
  },
  delete(email) { const all = this.all(); delete all[email]; fs.writeFileSync(tokenFile(), JSON.stringify(all), { mode: 0o600 }); },
};
const google = createGoogle({ config, store: tokenStore, fetch: (...a) => net.fetch(...a), openBrowser: url => shell.openExternal(url) });

// ---- reminders ----
const reminders = createReminders(r => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: r.title, body: r.body, icon: ICON, silent: false });
  n.on('click', () => { show(); send('open', { day: r.day, event: r.event }); });
  n.show();
});

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function handleLink(link) {
  const u = new URL(link.replace(`${SCHEME}://`, 'https://x/'));
  if (u.pathname.startsWith('/open')) send('open', { day: u.searchParams.get('day'), event: u.searchParams.get('event') });
  else { pendingLinks.push(link); send('auth-link', link); }
}

function show() {
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 380, minHeight: 560, show: !process.argv.includes('--hidden'),
    backgroundColor: '#0d0d1a', title: 'Bitcalendar', icon: ICON, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.removeMenu();
  win.loadURL('bitcal://app/index.html');
  // Links leave for the real browser; the window itself never navigates away from the app.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:|^mailto:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('bitcal://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.on('show', () => send('shown'));
  // Closing hides to the tray, so reminders + Google sync keep going. Quit from the tray menu.
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!toldAboutTray && Notification.isSupported()) {
      toldAboutTray = true;
      new Notification({ title: 'Bitcalendar is still here', body: 'It keeps your reminders and Google sync going from the tray. Right-click the tray icon to quit.', icon: ICON }).show();
    }
  });
}

function trayMenu() {
  const next = reminders.next();
  return Menu.buildFromTemplate([
    { label: 'Open Bitcalendar', click: show },
    { label: 'New event', click: () => { show(); send('command', 'new'); } },
    { label: 'Sync now', click: () => send('command', 'sync') },
    { type: 'separator' },
    ...(next ? [{ label: `Next reminder: ${next.title}`.slice(0, 60), enabled: false }, { type: 'separator' }] : []),
    { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: m => setAutoStart(m.checked) },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]);
}

function setAutoStart(on) { app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] }); }

ipcMain.handle('reminders', (_e, list) => { reminders.set(list); tray?.setContextMenu(trayMenu()); });
ipcMain.handle('open-external', (_e, url) => { if (/^(https?|mailto):/.test(url)) return shell.openExternal(url); });
ipcMain.handle('google-sign-in', async (_e, hint) => { try { return await google.signIn(hint); } finally { show(); } });
ipcMain.handle('google-token', (_e, email) => google.accessToken(email));
ipcMain.handle('google-forget', (_e, email) => google.forget(email));
ipcMain.handle('get-auto-start', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('set-auto-start', (_e, on) => { setAutoStart(on); tray?.setContextMenu(trayMenu()); });
ipcMain.handle('take-links', () => pendingLinks.splice(0));

app.whenReady().then(() => {
  // Serves ../app at bitcal://app/ (a real origin, so storage, modules and fetch behave like the web).
  protocol.handle('bitcal', req => {
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (p === '/' || p === '') p = '/index.html';
    const file = path.normalize(path.join(WEB, p));
    if (!file.startsWith(WEB)) return new Response('no', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  app.setAppUserModelId('app.bit128.bitcalendar'); // Windows notifications show the right name + icon
  createWindow();
  const img = nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png'));
  img.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(path.join(__dirname, 'build', 'tray@2x.png')) });
  tray = new Tray(img);
  tray.setToolTip('Bitcalendar');
  tray.setContextMenu(trayMenu());
  tray.on('click', () => (win && win.isVisible() && win.isFocused() ? win.hide() : show()));
  tray.on('right-click', () => tray.setContextMenu(trayMenu()));
  const link = process.argv.find(a => a.startsWith(`${SCHEME}://`));
  if (link) handleLink(link);
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', e => e.preventDefault()); // stays in the tray
