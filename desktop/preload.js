// What the page can ask of the desktop app (app/js/native.js uses it as window.bitcalDesktop).
const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel, fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload));

contextBridge.exposeInMainWorld('bitcalDesktop', {
  version: process.versions.electron,
  appVersion: () => ipcRenderer.invoke('app-version'),
  scheduleReminders: list => ipcRenderer.invoke('reminders', list),
  openExternal: url => ipcRenderer.invoke('open-external', url),
  googleSignIn: (hint, creds) => ipcRenderer.invoke('google-sign-in', hint, creds),
  googleToken: (email, creds) => ipcRenderer.invoke('google-token', email, creds),
  googleForget: email => ipcRenderer.invoke('google-forget', email),
  getAutoStart: () => ipcRenderer.invoke('get-auto-start'),
  setAutoStart: on => ipcRenderer.invoke('set-auto-start', on),
  onOpen: fn => listen('open', p => fn(p?.day, p?.event)),
  onShow: fn => listen('shown', fn),
  onCommand: fn => listen('command', fn),
  onAuthLink: fn => {
    listen('auth-link', fn);
    ipcRenderer.invoke('take-links').then(links => links.forEach(fn));
  },
});
