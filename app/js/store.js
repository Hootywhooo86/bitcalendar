// One place for every account's calendars, events and tasks. Views read from here; edits go through here.
import * as D from './dates.js';
import * as G from './google.js';
import * as L from './local.js';

const read = (s, k, fallback) => { try { return JSON.parse(s.getItem(k)) ?? fallback; } catch { return fallback; } };
const write = (s, k, v) => { try { s.setItem(k, JSON.stringify(v)); } catch {} };

const DEFAULTS = { weekStart: 0, h24: false, showTasks: true, notify: false, duration: 60, clientId: '' };
const LOCAL_ACC = { key: 'local', kind: 'local', name: 'ON THIS DEVICE', email: '' };
const LOCAL_CAL = { key: 'local|local', account: 'local', id: 'local', name: 'ON THIS DEVICE', color: '#ff9f1c', writable: true, defaultReminder: 10 };
const LOCAL_LIST = { key: 'local|quests', account: 'local', id: 'quests', title: 'MY QUESTS' };

const listeners = new Set();
const cache = new Map();   // `${calKey}|${YYYY-MM}` → events
const pending = new Map(); // same key → fetch promise

export const store = {
  settings: { ...DEFAULTS, ...read(localStorage, 'bitcal.settings', {}) },
  accounts: [LOCAL_ACC],
  calendars: [LOCAL_CAL],
  taskLists: [LOCAL_LIST],
  tasks: [],
  visibility: read(localStorage, 'bitcal.visible', {}),

  on(fn) { listeners.add(fn); },
  emit() { listeners.forEach(fn => fn()); },
  notice(msg) { listeners.forEach(fn => fn(msg)); },

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
  googleAccounts() { return this.accounts.filter(a => a.kind === 'google'); },
  writableCalendars() { return this.calendars.filter(c => c.writable && !this.account(c.account)?.expired); },

  isVisible(key) {
    if (key in this.visibility) return this.visibility[key];
    return this.calendar(key)?.selected ?? true;
  },
  toggle(key) {
    this.visibility[key] = !this.isVisible(key);
    write(localStorage, 'bitcal.visible', this.visibility);
    this.emit();
  },

  async init() {
    const saved = read(localStorage, 'bitcal.accounts', []);
    const tokens = read(sessionStorage, 'bitcal.tokens', {});
    for (const a of saved) {
      const t = tokens[a.email];
      const valid = t && Date.now() < t.expiresAt - 60000;
      this.accounts.push({ ...a, key: `g:${a.email}`, kind: 'google', ...(valid ? t : {}), expired: !valid });
    }
    this.tasks = L.listTasks().map(t => this.wrapTask(t, LOCAL_LIST));
    if (this.clientId()) G.loadGis().catch(() => {});
    await Promise.all(this.googleAccounts().filter(a => !a.expired).map(a => this.loadAccount(a)));
    this.emit();
  },

  persistAccounts() {
    const g = this.googleAccounts();
    write(localStorage, 'bitcal.accounts', g.map(({ email, name, picture }) => ({ email, name, picture })));
    write(sessionStorage, 'bitcal.tokens', Object.fromEntries(g.filter(a => a.token).map(a => [a.email, { token: a.token, expiresAt: a.expiresAt, scope: a.scope }])));
  },

  // Sign in (or back in) to a Google account. Call from a click: Google opens a popup.
  async connectGoogle(hint) {
    const clientId = this.clientId();
    if (!clientId) throw new Error('Add a Google client ID first');
    const g = await G.signIn(clientId, hint);
    let acc = this.account(`g:${g.email}`);
    if (acc) Object.assign(acc, g, { expired: false });
    else this.accounts.push(acc = { ...g, key: `g:${g.email}`, kind: 'google', expired: false });
    this.persistAccounts();
    this.dropCache(c => c.account === acc.key);
    await this.loadAccount(acc);
    this.emit();
    return acc;
  },

  disconnect(key) {
    const acc = this.account(key);
    if (!acc || acc.kind !== 'google') return;
    if (acc.token) G.revoke(acc.token);
    this.accounts = this.accounts.filter(a => a !== acc);
    this.calendars = this.calendars.filter(c => c.account !== key);
    this.taskLists = this.taskLists.filter(l => l.account !== key);
    this.tasks = this.tasks.filter(t => t.account !== key);
    this.dropCache(c => c.account === key);
    this.persistAccounts();
    this.emit();
  },

  expire(acc) {
    if (acc.expired) return;
    acc.expired = true;
    acc.token = null;
    this.persistAccounts();
    this.notice(`${acc.email}: Google session ended. Reconnect to keep syncing.`);
  },

  // Runs a Google call, turning an expired token into a "reconnect" state instead of an error.
  async guard(acc, fn) {
    try { return await fn(); }
    catch (e) {
      if (e instanceof G.AuthError) { this.expire(acc); this.emit(); }
      throw e;
    }
  },

  async loadAccount(acc) {
    try {
      const cals = await this.guard(acc, () => G.listCalendars(acc));
      this.calendars = this.calendars.filter(c => c.account !== acc.key).concat(cals.map(c => ({
        key: `${acc.key}|${c.id}`, account: acc.key, id: c.id,
        name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor || '#b388ff',
        writable: c.accessRole === 'owner' || c.accessRole === 'writer',
        primary: !!c.primary, selected: c.selected !== false,
        defaultReminder: (c.defaultReminders || []).find(r => r.method === 'popup')?.minutes ?? null,
      })).sort((a, b) => (b.primary - a.primary) || a.name.localeCompare(b.name)));
    } catch (e) {
      if (!(e instanceof G.AuthError)) this.notice(`${acc.email}: couldn't load calendars (${e.message})`);
      return;
    }
    await this.loadTasks(acc);
  },

  async loadTasks(acc) {
    if (acc.kind === 'local') {
      this.tasks = this.tasks.filter(t => t.account !== 'local').concat(L.listTasks().map(t => this.wrapTask(t, LOCAL_LIST)));
      return;
    }
    try {
      const lists = await this.guard(acc, () => G.listTaskLists(acc));
      const wrapped = lists.map(l => ({ key: `${acc.key}|${l.id}`, account: acc.key, id: l.id, title: l.title }));
      const all = await Promise.all(wrapped.map(l => this.guard(acc, () => G.listTasks(acc, l.id)).then(ts => ts.map(t => this.wrapTask(t, l)))));
      this.taskLists = this.taskLists.filter(l => l.account !== acc.key).concat(wrapped);
      this.tasks = this.tasks.filter(t => t.account !== acc.key).concat(all.flat());
      acc.tasksOk = true;
    } catch (e) {
      acc.tasksOk = false;
      if (e.status === 403) this.notice(`${acc.email}: Tasks access wasn't granted. Reconnect and allow Google Tasks.`);
      else if (!(e instanceof G.AuthError)) this.notice(`${acc.email}: couldn't load tasks (${e.message})`);
    }
  },

  wrapTask(t, list) { return { ...t, uid: `${list.key}|${t.id}`, listKey: list.key, account: list.account }; },

  async refreshAll() {
    this.dropCache(() => true);
    await Promise.all(this.accounts.filter(a => !a.expired).map(a => this.loadAccount(a).catch(() => {})));
    this.lastRefresh = Date.now();
    this.emit();
  },

  // ---- events ----

  dropCache(pred) {
    for (const k of [...cache.keys()]) {
      const cal = this.calendar(k.slice(0, k.lastIndexOf('|')));
      if (!cal || pred(cal)) cache.delete(k);
    }
  },

  visibleCalendars() {
    return this.calendars.filter(c => this.isVisible(c.key) && !this.account(c.account)?.expired);
  },

  // Fetches any months of [min, max) not cached yet. Resolves true when something new arrived.
  async ensureRange(min, max) {
    const jobs = [];
    for (const cal of this.visibleCalendars()) {
      for (const m of D.monthsIn(min, max)) {
        const k = `${cal.key}|${D.monthKey(m)}`;
        if (cache.has(k)) continue;
        if (!pending.has(k)) pending.set(k, this.fetchMonth(cal, m, k).finally(() => pending.delete(k)));
        jobs.push(pending.get(k));
      }
    }
    if (!jobs.length) return false;
    await Promise.all(jobs);
    return true;
  },

  async fetchMonth(cal, m, k) {
    const min = m, max = D.addMonths(m, 1);
    if (cal.account === 'local') { cache.set(k, L.listEvents(cal, min, max)); return; }
    const acc = this.account(cal.account);
    try { cache.set(k, await this.guard(acc, () => G.listEvents(acc, cal, min, max))); }
    catch (e) { if (!(e instanceof G.AuthError)) this.notice(`${cal.name}: ${e.message}`); }
  },

  decorate(ev) {
    const cal = this.calendar(ev.calKey);
    return { ...ev, color: ev.colorId ? G.EVENT_COLORS[ev.colorId] || cal.color : cal.color, calName: cal.name, account: cal.account };
  },

  eventsBetween(min, max) {
    const seen = new Map();
    for (const cal of this.visibleCalendars()) {
      for (const m of D.monthsIn(min, max)) {
        for (const ev of cache.get(`${cal.key}|${D.monthKey(m)}`) || []) {
          if (ev.start < max && (ev.end > min || +ev.start === +ev.end && ev.start >= min) && !seen.has(ev.uid)) seen.set(ev.uid, this.decorate(ev));
        }
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

  tasksBetween(min, max) {
    if (!this.settings.showTasks) return [];
    return this.visibleTasks().filter(t => t.due && t.due >= D.startOfDay(min) && t.due < max);
  },
  visibleTasks() { return this.tasks.filter(t => this.isVisible(t.listKey) && !this.account(t.account)?.expired); },

  async search(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    const results = await Promise.all(this.visibleCalendars().map(async cal => {
      if (cal.account === 'local') return L.search(cal, q);
      const acc = this.account(cal.account);
      try { return await this.guard(acc, () => G.searchEvents(acc, cal, q)); } catch { return []; }
    }));
    const seen = new Map();
    results.flat().forEach(e => seen.set(e.uid, this.decorate(e)));
    return [...seen.values()].sort((a, b) => a.start - b.start);
  },

  async saveEvent(draft, orig, scope = 'all') {
    const cal = this.calendar(draft.calKey);
    if (!orig) await this.createEvent(cal, draft);
    else if (orig.calKey !== draft.calKey) await this.changeCalendar(orig, cal, draft);
    else if (orig.seriesId && scope === 'all') await this.updateSeries(cal, orig, draft);
    else await this.updateOne(cal, orig, draft);
    this.dropCache(c => c.key === cal.key || c.key === orig?.calKey);
    this.emit();
  },

  createEvent(cal, draft) {
    if (cal.account === 'local') return L.insertEvent(draft);
    const acc = this.account(cal.account);
    return this.guard(acc, () => G.insertEvent(acc, cal.id, G.toGoogle(draft, true)));
  },

  async changeCalendar(orig, cal, draft) {
    const from = this.calendar(orig.calKey);
    if (from.account === cal.account && cal.account !== 'local') {
      const acc = this.account(cal.account);
      const id = orig.seriesId || orig.id;
      await this.guard(acc, () => G.moveEvent(acc, from.id, id, cal.id));
      if (!orig.seriesId) await this.guard(acc, () => G.patchEvent(acc, cal.id, id, G.toGoogle(draft, true)));
      return;
    }
    // Different account: copy across, then remove the original.
    await this.createEvent(cal, draft);
    await this.deleteEvent(orig, 'all', true);
  },

  // Shifts the whole series by however far this occurrence moved.
  async updateSeries(cal, orig, draft) {
    const shift = master => {
      if (draft.allDay) {
        const s = D.addDays(D.startOfDay(master), D.daysBetween(orig.start, draft.start));
        return { start: s, end: D.addDays(s, D.daysBetween(draft.start, draft.end)) };
      }
      const s = new Date(+master + (draft.start - orig.start));
      return { start: s, end: new Date(+s + (draft.end - draft.start)) };
    };
    if (cal.account === 'local') {
      const m = L.getSeries(orig.seriesId);
      return L.updateSeries(orig.seriesId, { ...draft, ...shift(new Date(m.start)) });
    }
    const acc = this.account(cal.account);
    const m = await this.guard(acc, () => G.getEvent(acc, cal.id, orig.seriesId));
    const mStart = m.start.date ? D.parseYmd(m.start.date) : new Date(m.start.dateTime);
    await this.guard(acc, () => G.patchEvent(acc, cal.id, orig.seriesId, G.toGoogle({ ...draft, ...shift(mStart) }, true)));
  },

  updateOne(cal, orig, draft) {
    if (cal.account === 'local') {
      if (!orig.seriesId) return L.updateSeries(orig.id, draft);
      L.skipOccurrence(orig.seriesId, orig.start);
      return L.insertEvent({ ...draft, rrule: null });
    }
    const acc = this.account(cal.account);
    return this.guard(acc, () => G.patchEvent(acc, cal.id, orig.id, G.toGoogle(draft, !orig.seriesId)));
  },

  // Drag-and-drop: same event, new times.
  moveEvent(ev, start, scope) {
    const end = new Date(+start + (ev.end - ev.start));
    const draft = { calKey: ev.calKey, title: ev.title, allDay: ev.allDay, start, end, location: ev.location, description: ev.description, colorId: ev.colorId };
    return this.saveEvent(draft, ev, scope);
  },

  async deleteEvent(ev, scope = 'all', quiet) {
    const cal = this.calendar(ev.calKey);
    const one = ev.seriesId && scope === 'one';
    if (cal.account === 'local') {
      if (one) L.skipOccurrence(ev.seriesId, ev.start);
      else L.removeSeries(ev.seriesId || ev.id);
    } else {
      const acc = this.account(cal.account);
      await this.guard(acc, () => G.deleteEvent(acc, cal.id, one ? ev.id : ev.seriesId || ev.id));
    }
    if (!quiet) { this.dropCache(c => c.key === cal.key); this.emit(); }
  },

  async rsvp(ev, status) {
    const cal = this.calendar(ev.calKey);
    const acc = this.account(cal.account);
    const attendees = ev.attendees.map(a => a.self ? { ...a, responseStatus: status } : a);
    await this.guard(acc, () => G.patchEvent(acc, cal.id, ev.id, { attendees }));
    this.dropCache(c => c.key === cal.key);
    this.emit();
  },

  // ---- tasks ----

  async saveTask(draft, orig) {
    const list = this.taskList(draft.listKey);
    const acc = this.account(list.account);
    if (orig && orig.listKey !== draft.listKey) {
      await this.saveTask(draft, null);
      return this.deleteTask(orig);
    }
    if (acc.kind === 'local') orig ? L.updateTask(orig.id, draft) : L.insertTask(draft);
    else if (orig) await this.guard(acc, () => G.patchTask(acc, list.id, orig.id, draft));
    else await this.guard(acc, () => G.insertTask(acc, list.id, draft));
    await this.loadTasks(acc);
    this.emit();
  },

  async toggleTask(task) {
    task.completed = !task.completed; // show it straight away
    this.emit();
    try { await this.saveTask({ ...task }, { ...task, completed: !task.completed }); }
    catch (e) { task.completed = !task.completed; this.emit(); throw e; }
  },

  async deleteTask(task) {
    const list = this.taskList(task.listKey);
    const acc = this.account(list.account);
    if (acc.kind === 'local') L.deleteTask(task.id);
    else await this.guard(acc, () => G.deleteTask(acc, list.id, task.id));
    this.tasks = this.tasks.filter(t => t.uid !== task.uid);
    this.emit();
  },

  wipeLocal() { L.wipe(); this.dropCache(c => c.account === 'local'); this.tasks = this.tasks.filter(t => t.account !== 'local'); this.emit(); },
};
