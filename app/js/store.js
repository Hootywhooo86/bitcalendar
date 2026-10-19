// One place for calendars, events and tasks. Signed in, everything lives in the 128bit account
// (cloud.js) and syncs across devices; signed out, in this browser (local.js). Google accounts are
// sources only: gsync.js copies them in. Views read from here; every edit goes through here.
import * as C from './cloud.js';
import * as D from './dates.js';
import * as G from './google.js';
import * as L from './local.js';
import * as N from './native.js';
import { syncAccount } from './gsync.js';
import { expand, lastStart, wall } from './recur.js';

const read = (s, k, fallback) => { try { return JSON.parse(s.getItem(k)) ?? fallback; } catch { return fallback; } };
const write = (s, k, v) => { try { s.setItem(k, JSON.stringify(v)); } catch {} };

const DEFAULTS = { weekStart: 0, h24: false, showTasks: true, notify: false, push: false, duration: 60, clientId: '' };
const LOCAL_ACC = { key: 'local', kind: 'local', name: 'ON THIS DEVICE', email: '' };
const LOCAL_CAL = { key: 'local|local', account: 'local', id: 'local', name: 'ON THIS DEVICE', color: '#ff9f1c', writable: true, defaultReminder: 10 };
const LOCAL_LIST = { key: 'local|quests', account: 'local', id: 'quests', title: 'MY QUESTS' };
export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const pad = n => String(n).padStart(2, '0');

const listeners = new Set();
const cache = new Map();   // `${source}|${YYYY-MM}` → events
const pending = new Map();
const OFFLINE = 'bitcal.offline.v1'; // last rows seen per month, for opening without a connection

const utcMidnight = d => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString();
const dayKey = (start, allDay, tz) => {
  if (allDay) return D.ymd(start);
  const w = wall(start, tz);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
};

export const store = {
  settings: { ...DEFAULTS, ...read(localStorage, 'bitcal.settings', {}) },
  user: null,
  accounts: [LOCAL_ACC],
  calendars: [LOCAL_CAL],
  taskLists: [LOCAL_LIST],
  tasks: [],
  google: [],          // Google accounts feeding in: {email, name, picture, token, expiresAt, expired, syncing, status}
  visibility: read(localStorage, 'bitcal.visible', {}),
  offline: false,

  on(fn) { listeners.add(fn); },
  emit() { listeners.forEach(fn => fn()); },
  notice(msg) { listeners.forEach(fn => fn(msg)); },

  get cloud() { return !!this.user; },
  clientId() { return this.settings.clientId || window.BITCAL_CONFIG?.googleClientId || ''; },
  setSettings(patch) {
    Object.assign(this.settings, patch);
    write(localStorage, 'bitcal.settings', this.settings);
    if (patch.clientId) G.loadGis().catch(() => {});
    this.emit();
  },

  account(key) { return this.accounts.find(a => a.key === key); },
  calendar(key) { return this.calendars.find(c => c.key === key); },
  taskList(key) { return this.taskLists.find(l => l.key === key); },
  googleAccounts() { return this.google; },
  googleAccount(email) { return this.google.find(g => g.email === email); },
  writableCalendars() { return this.calendars.filter(c => c.writable); },

  // Calendars (or task lists) grouped for pickers and the sidebar: yours first, then each Google source.
  groups(kind = 'events') {
    const items = kind === 'events' ? this.calendars : this.taskLists;
    const out = [];
    const mine = items.filter(c => !c.ext);
    if (mine.length) out.push({ label: this.cloud ? 'MY CALENDARS' : 'ON THIS DEVICE', items: mine });
    for (const email of [...new Set(items.filter(c => c.ext).map(c => c.ext.email))]) {
      out.push({ label: `FROM ${email}`, email, items: items.filter(c => c.ext?.email === email) });
    }
    return out;
  },

  isVisible(key) {
    const c = this.calendar(key) || this.taskList(key);
    if (c && 'hidden' in c) return !c.hidden;
    return this.visibility[key] ?? true;
  },
  async toggle(key) {
    const c = this.calendar(key) || this.taskList(key);
    if (c && 'hidden' in c) {
      c.hidden = !c.hidden;
      this.emit();
      try { await C.updateCalendar(c.id, { hidden: c.hidden }); }
      catch (e) { c.hidden = !c.hidden; this.emit(); this.notice(e.message); }
      return;
    }
    this.visibility[key] = !this.isVisible(key);
    write(localStorage, 'bitcal.visible', this.visibility);
    this.emit();
  },

  // ---- start up / sign in ----

  async init() {
    for (const g of read(localStorage, 'bitcal.google', [])) {
      const t = read(sessionStorage, 'bitcal.tokens', {})[g.email];
      const valid = t && Date.now() < t.expiresAt - 60000;
      this.google.push({ ...g, ...(valid ? t : {}), expired: !valid });
    }
    if (this.clientId()) G.loadGis().catch(() => {});
    C.onAuth((event, user) => {
      if (event === 'SIGNED_IN' && user && user.id !== this.user?.id) this.useAccount(user);
      if (event === 'SIGNED_OUT' && this.user) this.useDevice();
    });
    const user = await C.user().catch(() => null);
    if (user) await this.useAccount(user);
    else this.useDevice();
  },

  useDevice() {
    this.unsubscribe?.();
    this.user = null;
    this.accounts = [LOCAL_ACC];
    this.calendars = [LOCAL_CAL];
    this.taskLists = [LOCAL_LIST];
    this.tasks = L.listTasks().map(t => this.wrapTask(t, LOCAL_LIST));
    cache.clear();
    this.emit();
  },

  async useAccount(user) {
    this.user = user;
    this.accounts = [{ key: 'cloud', kind: 'cloud', name: '128BIT ACCOUNT', email: user.email }];
    cache.clear();
    await this.loadCalendars();
    await this.ensureDefaults();
    await this.moveDeviceData();
    await this.loadTasks();
    this.unsubscribe?.();
    this.unsubscribe = C.subscribe(user.id, table => this.remoteChange(table));
    this.emit();
    this.syncAllGoogle();
  },

  // Changes from other devices (and our own echoes), batched.
  remoteChange(table) {
    this.changed = this.changed || new Set();
    this.changed.add(table);
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(async () => {
      const t = this.changed; this.changed = null;
      if (t.has('bitcal_calendars')) await this.loadCalendars();
      if (t.has('bitcal_events')) cache.clear();
      if (t.has('bitcal_tasks')) await this.loadTasks();
      this.emit();
    }, 700);
  },

  async signIn(email, password) { await C.signIn(email, password); },
  async handleAuthLink(url) { await C.handleAuthLink(url); },
  async signUp(email, password) { return C.signUp(email, password); },
  async sendLink(email) { await C.sendLink(email); },
  async signOut() {
    await this.disablePush().catch(() => {});
    await C.signOut();
    this.useDevice();
  },

  async loadCalendars() {
    let rows;
    try {
      rows = await C.listCalendars();
      write(localStorage, 'bitcal.offline.cals', rows);
      this.offline = false;
    } catch (e) {
      rows = read(localStorage, 'bitcal.offline.cals', []);
      this.offline = true;
    }
    const events = rows.filter(r => r.kind === 'events'), lists = rows.filter(r => r.kind === 'tasks');
    this.calendars = events.map(r => ({
      key: `cloud|${r.id}`, account: 'cloud', id: r.id, name: r.name, color: r.color, hidden: r.hidden,
      writable: true, defaultReminder: r.default_reminder, ext: r.ext, position: r.position,
    }));
    this.taskLists = lists.map(r => ({ key: `cloud|${r.id}`, account: 'cloud', id: r.id, title: r.name, color: r.color, hidden: r.hidden, ext: r.ext }));
  },

  // Every account gets a calendar and a task list of its own, apart from anything copied from Google.
  async ensureDefaults() {
    if (this.offline) return;
    let made = false;
    if (!this.calendars.some(c => !c.ext)) { await C.insertCalendar({ kind: 'events', name: 'MY CALENDAR', color: '#ff9f1c', default_reminder: 10 }); made = true; }
    if (!this.taskLists.some(l => !l.ext)) { await C.insertCalendar({ kind: 'tasks', name: 'MY QUESTS', color: '#b388ff' }); made = true; }
    if (made) await this.loadCalendars();
  },

  // Whatever was added on this device before signing in moves into the account.
  async moveDeviceData() {
    const { events, tasks } = L.ownData();
    if (this.offline || (!events.length && !tasks.length)) return;
    const cal = this.calendars.find(c => !c.ext), list = this.taskLists.find(l => !l.ext);
    for (const e of events) {
      const start = new Date(e.start), end = new Date(e.end);
      const tz = e.allDay ? 'UTC' : TZ;
      await C.insertEvent({
        calendar_id: cal.id, title: e.title, all_day: e.allDay, tz,
        starts_at: e.allDay ? utcMidnight(start) : start.toISOString(), ends_at: e.allDay ? utcMidnight(end) : end.toISOString(),
        rrule: e.rrule, exdates: e.exdates || [], location: e.location || '', notes: e.description || '',
        color_id: e.colorId, reminder: e.reminder ?? null, until_at: this.untilOf(start, end, e.allDay, tz, e.rrule),
      });
    }
    for (const t of tasks) await C.insertTask({ list_id: list.id, title: t.title, notes: t.notes || '', due: t.due, done: !!t.completed });
    L.wipe();
    this.notice(`MOVED ${events.length} EVENTS + ${tasks.length} TASKS FROM THIS DEVICE INTO YOUR 128BIT ACCOUNT`);
  },

  untilOf(start, end, allDay, tz, rrule) {
    if (!rrule) return null;
    const last = lastStart({ start: allDay ? new Date(utcMidnight(start)) : start, end, allDay, tz, rrule });
    return last ? last.toISOString() : null;
  },

  // ---- Google sources ----

  persistGoogle() {
    write(localStorage, 'bitcal.google', this.google.map(({ email, name, picture }) => ({ email, name, picture })));
    write(sessionStorage, 'bitcal.tokens', Object.fromEntries(this.google.filter(g => g.token).map(g => [g.email, { token: g.token, expiresAt: g.expiresAt, scope: g.scope }])));
  },

  // Sign in to Google (a popup; call from a click), then copy everything in.
  async connectGoogle(hint) {
    if (!this.cloud) throw new Error('Sign in to your 128bit account first, so there is somewhere to put it');
    const clientId = this.clientId();
    if (!clientId && !N.googleRefreshes) throw new Error('Add a Google client ID first');
    const g = N.googleRefreshes ? await G.withToken(await N.googleSignIn(hint)) : await G.signIn(clientId, hint);
    let acc = this.googleAccount(g.email);
    if (acc) Object.assign(acc, g, { expired: false });
    else this.google.push(acc = { ...g, expired: false });
    this.persistGoogle();
    this.emit();
    await this.syncGoogle(acc);
    return acc;
  },

  // The desktop app keeps a refresh token, so it never has to ask again.
  async freshToken(acc) {
    if (!N.googleRefreshes || (acc.token && Date.now() < acc.expiresAt - 120000)) return;
    const r = await N.googleToken(acc.email).catch(() => null);
    if (r?.access_token) Object.assign(acc, { token: r.access_token, expiresAt: Date.now() + r.expires_in * 1000, scope: r.scope, expired: false });
    else this.expireGoogle(acc);
  },

  async syncGoogle(acc) {
    if (!this.cloud || acc.syncing) return;
    await this.freshToken(acc);
    if (acc.expired) { this.emit(); return; }
    acc.syncing = true;
    acc.status = 'SYNCING...';
    this.emit();
    try {
      const rows = await C.listCalendars();
      const n = await syncAccount(acc, rows, text => { acc.status = text; this.emit(); });
      acc.status = `SYNCED ${D.fmtTime(new Date(), this.settings.h24)}${n.events + n.tasks ? ` · ${n.events + n.tasks} CHANGES` : ''}`;
      acc.lastSync = Date.now();
      await this.loadCalendars();
      await this.loadTasks();
      cache.clear();
    } catch (e) {
      if (e instanceof G.AuthError) this.expireGoogle(acc);
      else { acc.status = 'SYNC FAILED'; this.notice(`${acc.email}: ${e.message}`); }
    } finally {
      acc.syncing = false;
      this.emit();
    }
  },

  syncAllGoogle() { return Promise.all(this.google.filter(g => N.googleRefreshes || !g.expired).map(g => this.syncGoogle(g))); },

  expireGoogle(acc) {
    acc.expired = true;
    acc.token = null;
    acc.status = 'SIGNED OUT';
    this.persistGoogle();
  },

  // Stops syncing an account. Its calendars stay unless removeData.
  async disconnectGoogle(email, removeData) {
    const acc = this.googleAccount(email);
    if (acc?.token && !N.googleRefreshes) G.revoke(acc.token);
    N.googleForget(email);
    this.google = this.google.filter(g => g.email !== email);
    this.persistGoogle();
    if (removeData && this.cloud) {
      for (const c of [...this.calendars, ...this.taskLists].filter(c => c.ext?.email === email)) await C.deleteCalendar(c.id);
      await this.loadCalendars();
      await this.loadTasks();
      cache.clear();
    }
    this.emit();
  },

  async refreshAll() {
    if (this.cloud) {
      await this.loadCalendars();
      await this.loadTasks();
      await this.syncAllGoogle();
    } else this.tasks = L.listTasks().map(t => this.wrapTask(t, LOCAL_LIST));
    cache.clear();
    this.lastRefresh = Date.now();
    this.emit();
  },

  // ---- calendars ----

  async saveCalendar(draft, orig) {
    const row = { name: draft.name, color: draft.color, default_reminder: draft.defaultReminder ?? null };
    if (orig) await C.updateCalendar(orig.id, row);
    else await C.insertCalendar({ ...row, kind: draft.kind || 'events' });
    await this.loadCalendars();
    this.emit();
  },

  async deleteCalendar(c) {
    await C.deleteCalendar(c.id);
    await this.loadCalendars();
    if (this.taskLists.length) await this.loadTasks();
    cache.clear();
    this.emit();
  },

  // ---- events ----

  visibleCalendars() { return this.calendars.filter(c => this.isVisible(c.key)); },

  // Fetches any months of [min, max) not cached yet. Resolves true when something new arrived.
  async ensureRange(min, max) {
    const src = this.cloud ? 'cloud' : 'local';
    const jobs = [];
    for (const m of D.monthsIn(min, max)) {
      const k = `${src}|${D.monthKey(m)}`;
      if (cache.has(k)) continue;
      if (!pending.has(k)) pending.set(k, this.fetchMonth(src, m, k).finally(() => pending.delete(k)));
      jobs.push(pending.get(k));
    }
    if (!jobs.length) return false;
    await Promise.all(jobs);
    return true;
  },

  async fetchMonth(src, m, k) {
    const min = m, max = D.addMonths(m, 1);
    if (src === 'local') { cache.set(k, L.listEvents(LOCAL_CAL, min, max)); return; }
    let rows;
    try {
      rows = await C.eventsInRange(min, max);
      // Read after the await: months load in parallel and each adds itself.
      const saved = read(localStorage, OFFLINE, {});
      saved[k] = rows;
      const keys = Object.keys(saved);
      if (keys.length > 14) keys.sort().slice(0, keys.length - 14).forEach(x => delete saved[x]);
      write(localStorage, OFFLINE, saved);
      if (this.offline) { this.offline = false; this.emit(); }
    } catch (e) {
      rows = read(localStorage, OFFLINE, {})[k];
      if (!rows) { this.notice(`couldn't load ${D.MONTHS[m.getMonth()]}: ${e.message}`); return; }
      if (!this.offline) { this.offline = true; this.notice('OFFLINE · SHOWING WHAT WAS SAVED ON THIS DEVICE'); }
    }
    if (this.user?.id && src === 'cloud') cache.set(k, rows.flatMap(r => this.occurrences(r, min, max)));
  },

  // One stored row → the occurrences of it inside [min, max).
  occurrences(r, min, max) {
    const cal = this.calendar(`cloud|${r.calendar_id}`);
    if (!cal) return [];
    const start = new Date(r.starts_at), end = new Date(r.ends_at);
    const tz = r.all_day ? 'UTC' : r.tz;
    const self = (r.attendees || []).find(a => a.self);
    return expand({ start, end, allDay: r.all_day, tz, rrule: r.rrule, exdates: r.exdates }, min, max).map(o => {
      const day = dayKey(o.start, r.all_day, tz);
      const id = r.rrule ? `${r.id}::${day}` : r.id;
      return {
        uid: `${cal.key}|${id}`, id, rowId: r.id, calKey: cal.key, title: r.title || '(no title)', start: o.start, end: o.end,
        allDay: r.all_day, tz, day, location: r.location, description: r.notes, colorId: r.color_id,
        seriesId: r.rrule ? r.id : null, rrule: r.rrule, reminder: r.reminder, attendees: r.attendees || [],
        meet: r.meet || '', htmlLink: r.ext?.link || null, organizer: { self: !!r.ext?.organizerSelf },
        selfStatus: self?.responseStatus || null, ext: r.ext, extId: r.ext_id, editable: true,
      };
    });
  },

  decorate(ev) {
    const cal = this.calendar(ev.calKey);
    return { ...ev, color: ev.colorId ? G.EVENT_COLORS[ev.colorId] || cal.color : cal.color, calName: cal.name, account: cal.account };
  },

  eventsBetween(min, max) {
    const src = this.cloud ? 'cloud' : 'local';
    const seen = new Map();
    for (const m of D.monthsIn(min, max)) {
      for (const ev of cache.get(`${src}|${D.monthKey(m)}`) || []) {
        if (seen.has(ev.uid) || !this.isVisible(ev.calKey) || !this.calendar(ev.calKey)) continue;
        if (ev.start < max && (ev.end > min || (+ev.start === +ev.end && ev.start >= min))) seen.set(ev.uid, this.decorate(ev));
      }
    }
    return [...seen.values()].sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start) || (b.end - a.end));
  },

  byUid(uid) {
    for (const evs of cache.values()) {
      const ev = evs.find(e => e.uid === uid);
      if (ev) return this.decorate(ev);
    }
    return null;
  },

  async search(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    if (!this.cloud) return L.search(LOCAL_CAL, q).map(e => this.decorate(e));
    const rows = await C.searchEvents(q).catch(e => { this.notice(e.message); return []; });
    const now = new Date(), min = D.addDays(now, -365), max = D.addDays(now, 365);
    const seen = new Map();
    rows.flatMap(r => this.occurrences(r, min, max)).filter(e => this.isVisible(e.calKey)).forEach(e => seen.set(e.uid, this.decorate(e)));
    return [...seen.values()].sort((a, b) => a.start - b.start).slice(0, 300);
  },

  // Editor draft → row fields. Leaves the repeat rule alone when draft.rrule is undefined.
  rowOf(draft, rrule) {
    const tz = draft.allDay ? 'UTC' : TZ;
    const cal = this.calendar(draft.calKey);
    const row = {
      calendar_id: cal.id, title: draft.title, all_day: draft.allDay, tz,
      starts_at: draft.allDay ? utcMidnight(draft.start) : draft.start.toISOString(),
      ends_at: draft.allDay ? utcMidnight(draft.end) : draft.end.toISOString(),
      location: draft.location || '', notes: draft.description || '', color_id: draft.colorId || null,
      until_at: this.untilOf(draft.start, draft.end, draft.allDay, tz, rrule),
    };
    if (draft.reminder !== undefined) row.reminder = draft.reminder === 'default' ? cal.defaultReminder ?? null : draft.reminder;
    if (draft.rrule !== undefined) row.rrule = draft.rrule || null;
    return row;
  },

  async saveEvent(draft, orig, scope = 'all') {
    if (!this.cloud) return this.saveLocal(draft, orig, scope);
    if (!orig) {
      const row = await C.insertEvent(this.rowOf(draft, draft.rrule || null));
      C.logFamily([{ id: `bitcal:${row.id}`, app: 'bitcalendar', type: 'event.created', at: Date.now(), data: { title: row.title, starts_at: row.starts_at, all_day: row.all_day } }]);
    } else if (orig.seriesId && scope === 'one') {
      // This day only: cross it off the series and give it its own event.
      const master = await C.getEvent(orig.rowId);
      await C.updateEvent(orig.rowId, { exdates: [...new Set([...(master.exdates || []), orig.day])], edited: true });
      await C.insertEvent(this.rowOf({ ...draft, rrule: null }, null));
    } else if (orig.seriesId) {
      // The whole series moves by however far this occurrence moved.
      const master = await C.getEvent(orig.rowId);
      const mStart = master.all_day ? D.parseYmd(master.starts_at) : new Date(master.starts_at);
      let start, end;
      if (draft.allDay) {
        start = D.addDays(D.startOfDay(mStart), D.daysBetween(orig.start, draft.start));
        end = D.addDays(start, D.daysBetween(draft.start, draft.end));
      } else {
        start = new Date(+mStart + (draft.start - orig.start));
        end = new Date(+start + (draft.end - draft.start));
      }
      const rule = draft.rrule !== undefined ? draft.rrule : master.rrule;
      await C.updateEvent(orig.rowId, { ...this.rowOf({ ...draft, start, end }, rule), edited: true });
    } else {
      const rule = draft.rrule !== undefined ? draft.rrule : orig.rrule;
      await C.updateEvent(orig.rowId, { ...this.rowOf(draft, rule), edited: true });
    }
    cache.clear();
    this.emit();
  },

  saveLocal(draft, orig, scope) {
    if (!orig) L.insertEvent(draft);
    else if (orig.seriesId && scope === 'all') {
      const m = L.getSeries(orig.seriesId);
      const mStart = new Date(m.start);
      let start, end;
      if (draft.allDay) {
        start = D.addDays(D.startOfDay(mStart), D.daysBetween(orig.start, draft.start));
        end = D.addDays(start, D.daysBetween(draft.start, draft.end));
      } else {
        start = new Date(+mStart + (draft.start - orig.start));
        end = new Date(+start + (draft.end - draft.start));
      }
      L.updateSeries(orig.seriesId, { ...draft, start, end });
    } else if (orig.seriesId) {
      L.skipOccurrence(orig.seriesId, orig.start);
      L.insertEvent({ ...draft, rrule: null });
    } else L.updateSeries(orig.id, draft);
    cache.clear();
    this.emit();
  },

  // Drag-and-drop: same event, new times.
  moveEvent(ev, start, scope) {
    const end = new Date(+start + (ev.end - ev.start));
    const draft = { calKey: ev.calKey, title: ev.title, allDay: ev.allDay, start, end, location: ev.location, description: ev.description, colorId: ev.colorId };
    return this.saveEvent(draft, ev, scope);
  },

  async deleteEvent(ev, scope = 'all') {
    const one = ev.seriesId && scope === 'one';
    if (!this.cloud) {
      if (one) L.skipOccurrence(ev.seriesId, ev.start);
      else L.removeSeries(ev.seriesId || ev.id);
    } else if (one) {
      const master = await C.getEvent(ev.rowId);
      await C.updateEvent(ev.rowId, { exdates: [...new Set([...(master.exdates || []), ev.day])], edited: true });
    } else await C.deleteEvent(ev.rowId, !!ev.extId);
    cache.clear();
    this.emit();
  },

  // Answering an invite goes to Google (the organizer is there), then the copy here follows.
  async rsvp(ev, status) {
    const acc = this.googleAccount(ev.ext?.email);
    if (acc) await this.freshToken(acc);
    if (!acc || acc.expired) throw new Error(`Reconnect ${ev.ext?.email || 'Google'} to answer invites`);
    const attendees = ev.attendees.map(a => a.self ? { ...a, responseStatus: status } : a);
    try { await G.patchEvent(acc, ev.ext.cal, ev.extId, { attendees }); }
    catch (e) { if (e instanceof G.AuthError) { this.expireGoogle(acc); this.emit(); } throw e; }
    await C.updateEvent(ev.rowId, { attendees });
    cache.clear();
    this.emit();
  },

  // ---- tasks ----

  wrapTask(t, list) { return { ...t, uid: `${list.key}|${t.id}`, listKey: list.key, account: list.account }; },

  async loadTasks() {
    if (!this.cloud) { this.tasks = L.listTasks().map(t => this.wrapTask(t, LOCAL_LIST)); return; }
    let rows;
    try { rows = await C.listTasks(); write(localStorage, 'bitcal.offline.tasks', rows); }
    catch { rows = read(localStorage, 'bitcal.offline.tasks', []); }
    this.tasks = rows.map(r => {
      const list = this.taskList(`cloud|${r.list_id}`);
      return list && this.wrapTask({ id: r.id, title: r.title, notes: r.notes, due: r.due ? D.parseYmd(r.due) : null, completed: r.done, extId: r.ext_id }, list);
    }).filter(Boolean);
  },

  tasksBetween(min, max) {
    if (!this.settings.showTasks) return [];
    return this.visibleTasks().filter(t => t.due && t.due >= D.startOfDay(min) && t.due < max);
  },
  visibleTasks() { return this.tasks.filter(t => this.isVisible(t.listKey)); },

  async saveTask(draft, orig) {
    if (!this.cloud) {
      orig ? L.updateTask(orig.id, draft) : L.insertTask(draft);
    } else {
      const row = {
        list_id: this.taskList(draft.listKey).id, title: draft.title, notes: draft.notes || '',
        due: draft.due ? D.ymd(draft.due) : null, done: !!draft.completed, done_at: draft.completed ? new Date().toISOString() : null,
      };
      if (orig) await C.updateTask(orig.id, { ...row, edited: true });
      else await C.insertTask(row);
    }
    await this.loadTasks();
    this.emit();
  },

  async toggleTask(task) {
    task.completed = !task.completed; // show it straight away
    this.emit();
    try { await this.saveTask({ ...task }, { ...task, completed: !task.completed }); }
    catch (e) { task.completed = !task.completed; this.emit(); throw e; }
  },

  async deleteTask(task) {
    if (!this.cloud) L.deleteTask(task.id);
    else await C.deleteTask(task.id, !!task.extId);
    this.tasks = this.tasks.filter(t => t.uid !== task.uid);
    this.emit();
  },

  wipeLocal() { L.wipe(); cache.clear(); if (!this.cloud) this.tasks = []; this.emit(); },

  // ---- push reminders ----

  async enablePush() {
    if (!this.cloud) throw new Error('Sign in to your 128bit account first');
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser can\'t do push reminders. On iPhone, add Bitcalendar to your home screen first.');
    if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked for this site');
    const key = await C.vapidPublic();
    if (!key) throw new Error('The reminder server isn\'t running yet (see README → Push reminders)');
    const reg = await navigator.serviceWorker.ready;
    const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    let sub = await reg.pushManager.getSubscription();
    if (sub && btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey || []))) !== btoa(String.fromCharCode(...raw))) { await sub.unsubscribe(); sub = null; }
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: raw });
    await C.savePush(sub, TZ, this.settings.h24);
    this.setSettings({ push: true });
  },

  async disablePush() {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) { await C.removePush(sub.endpoint).catch(() => {}); await sub.unsubscribe(); }
    this.setSettings({ push: false });
  },
};
