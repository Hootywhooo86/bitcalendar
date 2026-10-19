// Bitcalendar app: wires the store, views and dialogs to the page.
import * as D from './dates.js';
import { store } from './store.js';
import * as V from './views.js';
import * as M from './modals.js';

const $ = (sel, el = document) => el.querySelector(sel);
const MODES = ['month', 'week', 'day', 'agenda'];
const narrow = () => matchMedia('(max-width: 760px)').matches;
const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch {} };

const today = () => D.startOfDay(new Date());
const state = {
  mode: MODES.includes(pref('bitcal.mode')) ? pref('bitcal.mode') : 'month',
  cursor: today(),
  mini: D.startOfMonth(new Date()),
  selected: today(),
  agendaDays: 30,
  query: '',
  results: null,
  drag: null,
  scrolled: false,
};

// ---- rendering ----

function render() {
  renderTop();
  renderMain();
  renderSidebar();
  renderTasks();
  renderBanner();
}

function renderTop() {
  $('#rangeTitle').textContent = state.query ? 'SEARCH' : V.titleFor(state.mode, state.cursor, narrow());
  document.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('on', b.dataset.mode === state.mode && !state.query));
  const u = store.user;
  $('#acctBtn').innerHTML = u ? `<span class="me">${V.esc(u.email[0].toUpperCase())}</span>` : '<span>SIGN IN</span>';
  $('#acctBtn').title = u ? u.email : 'sign in';
  $('#acctBtn').classList.toggle('warn', store.googleAccounts().some(a => a.expired) || store.offline);
}

function renderMain() {
  const main = $('#main');
  const prevScroll = $('.wscroll', main)?.scrollTop;
  if (state.query) main.innerHTML = V.searchView(state.query, state.results);
  else if (state.mode === 'month') main.innerHTML = V.monthView(state.cursor, narrow());
  else if (state.mode === 'agenda') main.innerHTML = V.agendaView(state.cursor, state.agendaDays);
  else main.innerHTML = V.weekView(state.cursor, state.mode, narrow());
  const scroller = $('.wscroll', main);
  if (scroller) {
    if (prevScroll !== undefined && state.scrolled) scroller.scrollTop = prevScroll;
    else { scroller.scrollTop = Math.max(0, (Math.min(D.minutesOfDay(new Date()), 18 * 60) / 60 - 1.5) * V.HOUR); state.scrolled = true; }
  }
}

function renderSidebar() {
  // The landing page's widget, for real.
  const m = state.mini, ws = store.settings.weekStart;
  const gridStart = D.startOfWeek(m, ws);
  const evs = store.eventsBetween(gridStart, D.addDays(gridStart, 42));
  const tasks = store.tasksBetween(gridStart, D.addDays(gridStart, 42));
  const busy = new Set();
  evs.forEach(e => { for (let d = D.startOfDay(e.start); d < e.end || D.sameDay(d, e.start); d = D.addDays(d, 1)) busy.add(D.ymd(d)); });
  tasks.forEach(t => !t.completed && busy.add(D.ymd(t.due)));
  $('#miniTitle').textContent = `${D.MONTHS[m.getMonth()]} ${m.getFullYear()}`;
  $('#miniDow').innerHTML = Array.from({ length: 7 }, (_, i) => `<span>${D.DOW1[(i + ws) % 7]}</span>`).join('');
  const last = D.addDays(D.startOfMonth(D.addMonths(m, 1)), -1);
  const cells = Math.ceil((D.daysBetween(gridStart, last) + 1) / 7) * 7;
  let html = '';
  for (let i = 0; i < cells; i++) {
    const d = D.addDays(gridStart, i), k = D.ymd(d);
    const cls = ['day', d.getMonth() !== m.getMonth() && 'other', busy.has(k) && 'has-event', D.sameDay(d, new Date()) && 'today', D.sameDay(d, state.selected) && 'sel'].filter(Boolean).join(' ');
    html += `<button class="${cls}" data-mini="${k}">${d.getDate()}</button>`;
  }
  $('#miniDays').innerHTML = html;

  // Selected day's list, like the mock's events box.
  const sel = state.selected, next = D.addDays(sel, 1);
  const dayEvs = store.eventsBetween(sel, next);
  const dayTasks = store.tasksBetween(sel, next);
  $('#dayTitle').textContent = D.sameDay(sel, new Date()) ? 'TODAY' : `${D.MONTHS[sel.getMonth()]} ${sel.getDate()}`;
  $('#dayList').innerHTML = dayEvs.length || dayTasks.length
    ? dayEvs.map(e => `<p data-uid="${V.esc(e.uid)}" style="--c:${V.esc(e.color)}">+ ${e.allDay ? '' : D.fmtTime(e.start, store.settings.h24) + ' '}${V.esc(e.title)}</p>`).join('')
      + dayTasks.map(t => `<p data-task="${V.esc(t.uid)}" class="${t.completed ? 'done' : ''}">${t.completed ? '&#9635;' : '&#9633;'} ${V.esc(t.title)}</p>`).join('')
    : '<p class="none">no quests scheduled...</p>';

  // Up next: the next three things, with a countdown.
  const now = new Date();
  const up = store.eventsBetween(now, D.addDays(now, 30)).filter(e => e.allDay ? e.start >= D.startOfDay(now) : e.end > now)
    .sort((a, b) => a.start - b.start).slice(0, 3);
  $('#upNext').innerHTML = up.length ? up.map(e => `<div class="up" data-uid="${V.esc(e.uid)}" style="--c:${V.esc(e.color)}">
      <span class="cd">${e.start <= now ? 'NOW' : e.allDay ? (D.sameDay(e.start, now) ? 'TODAY' : D.countdown(e.start - D.startOfDay(now)).replace(/ \d+M$/, '')) : D.countdown(e.start - now)}</span>
      <b>${V.esc(e.title)}</b><small>${e.allDay ? D.fmtDay(e.start) : `${D.fmtDay(e.start)} · ${D.fmtTime(e.start, store.settings.h24)}`}</small></div>`).join('')
    : '<p class="none">nothing coming up...</p>';

  // Calendars + task lists: yours, then each Google account feeding in.
  const row = (c, isList) => `<div class="cal"><label><input type="checkbox" data-vis="${V.esc(c.key)}"${store.isVisible(c.key) ? ' checked' : ''}><i class="${isList ? 'tl' : ''}" style="--c:${V.esc(c.color || '#b388ff')}"></i><span>${V.esc(c.name ?? c.title)}</span></label>${store.cloud ? `<button class="edit" data-editcal="${V.esc(c.key)}" aria-label="edit ${V.esc(c.name ?? c.title)}">&#9998;</button>` : ''}</div>`;
  const evGroups = store.groups('events'), taskGroups = store.groups('tasks');
  const labels = [...new Set([...evGroups, ...taskGroups].map(g => g.label))];
  $('#calList').innerHTML = labels.map(label => {
    const eg = evGroups.find(g => g.label === label), tg = taskGroups.find(g => g.label === label);
    const email = (eg || tg).email;
    const g = email && store.googleAccount(email);
    const status = email ? (g ? (g.expired ? `<button class="btn tiny primary" data-reconnect="${V.esc(email)}">RECONNECT</button>` : `<small class="gstat">${V.esc(g.status || 'CONNECTED')}</small>`) : '<small class="gstat">NOT SYNCING</small>') : '';
    return `<div class="cgroup"><h4 title="${V.esc(label)}">${V.esc(label)}</h4>${status}
      ${(eg?.items || []).map(c => row(c)).join('')}${(tg?.items || []).map(l => row(l, true)).join('')}</div>`;
  }).join('') + (store.cloud
    ? '<div class="addcal"><button class="btn tiny" data-newcal="events">+ CALENDAR</button><button class="btn tiny" data-newcal="tasks">+ TASK LIST</button></div>'
    : '<p class="hint">SIGN IN TO SYNC ACROSS DEVICES, ADD CALENDARS AND BRING IN GOOGLE.</p>');
  $('#connectBtn').textContent = store.cloud ? '+ CONNECT GOOGLE' : 'SIGN IN';
}

function renderTasks() {
  const panel = $('#taskBody');
  if (!document.body.classList.contains('tasks-open')) return;
  const listSel = $('#taskList');
  const keep = listSel.value || store.settings.lastList;
  listSel.innerHTML = store.groups('tasks').map(g => `<optgroup label="${V.esc(g.label)}">${g.items.map(l => `<option value="${V.esc(l.key)}">${V.esc(l.title)}</option>`).join('')}</optgroup>`).join('');
  if (store.taskLists.some(l => l.key === keep)) listSel.value = keep;
  const now = today(), tasks = store.visibleTasks();
  const groups = [
    ['OVERDUE', t => !t.completed && t.due && t.due < now, 'warn'],
    ['TODAY', t => !t.completed && t.due && D.sameDay(t.due, now)],
    ['UPCOMING', t => !t.completed && t.due && t.due > now],
    ['SOMEDAY', t => !t.completed && !t.due],
    ['DONE', t => t.completed, 'done'],
  ];
  panel.innerHTML = groups.map(([name, fn, cls]) => {
    const ts = tasks.filter(fn).sort((a, b) => (a.due || 0) - (b.due || 0));
    if (!ts.length) return '';
    const body = ts.map(t => `<div class="trow${t.completed ? ' done' : ''}" data-task="${V.esc(t.uid)}">
      <button class="tick" data-toggle="${V.esc(t.uid)}" aria-label="${t.completed ? 'mark not done' : 'mark done'}">${t.completed ? '&#9635;' : '&#9633;'}</button>
      <span>${V.esc(t.title)}${t.due && name !== 'TODAY' ? `<small>${D.fmtDay(t.due)}</small>` : ''}</span></div>`).join('');
    return name === 'DONE'
      ? `<details class="tgroup done"><summary>DONE (${ts.length})</summary>${body}</details>`
      : `<div class="tgroup ${cls || ''}"><h4>${name} (${ts.length})</h4>${body}</div>`;
  }).join('') || '<p class="none">no tasks. nice.</p>';
}

function renderBanner() {
  const expired = store.googleAccounts().filter(a => a.expired);
  $('#banner').innerHTML = (store.offline ? '<div class="bar">&#9888; OFFLINE · SHOWING WHAT THIS DEVICE SAVED. CHANGES NEED A CONNECTION.</div>' : '')
    + expired.map(a => `<div class="bar">&#9888; GOOGLE (${V.esc(a.email)}) STOPPED SYNCING — <button class="btn tiny primary" data-reconnect="${V.esc(a.email)}">RECONNECT</button></div>`).join('');
}

// ---- loading ----

async function load() {
  const { min, max } = V.rangeFor(state.mode, state.cursor, narrow(), state.agendaDays);
  const gridStart = D.startOfWeek(state.mini, store.settings.weekStart);
  const now = new Date();
  document.body.classList.add('busy');
  const got = await Promise.all([
    store.ensureRange(min, max),
    store.ensureRange(gridStart, D.addDays(gridStart, 42)),
    store.ensureRange(state.selected, D.addDays(state.selected, 1)),
    store.ensureRange(now, D.addDays(now, 30)),
  ]);
  document.body.classList.remove('busy');
  if (got.some(Boolean)) render();
}

function refresh() { render(); load(); }

async function runSearch(q) {
  state.query = q;
  state.results = null;
  if (!q) return refresh();
  render();
  const results = await store.search(q);
  if (state.query === q) { state.results = results; render(); }
}

// ---- navigation ----

function setMode(mode) {
  state.mode = mode;
  pref('bitcal.mode', mode);
  state.query = ''; $('#search').value = '';
  state.scrolled = false;
  refresh();
}
function step(dir) {
  const c = state.cursor;
  if (state.mode === 'month') state.cursor = D.addMonths(c, dir);
  else if (state.mode === 'week') state.cursor = D.addDays(c, dir * (narrow() ? 3 : 7));
  else if (state.mode === 'day') state.cursor = D.addDays(c, dir);
  else state.cursor = D.addDays(c, dir * 30);
  syncMini(state.cursor);
  refresh();
}
function goTo(date, mode) {
  state.cursor = date;
  state.selected = date;
  syncMini(date);
  if (mode) setMode(mode); else refresh();
}
const syncMini = d => { state.mini = D.startOfMonth(d); };

// ---- actions ----

function openEventByUid(uid) {
  const ev = state.results?.find(e => e.uid === uid) || store.byUid(uid);
  if (ev) M.openEvent(ev, e => M.openEditor(e));
}
const taskByUid = uid => store.tasks.find(t => t.uid === uid);

function newEvent(preset = {}) { M.openEditor(null, preset); }

function newEventAt(day, minutes) {
  const start = D.withTime(day, minutes);
  newEvent({ start, end: D.addMinutes(start, store.settings.duration), allDay: false });
}

// ---- events ----

document.addEventListener('click', async e => {
  const t = e.target;
  const btn = sel => t.closest(sel);
  // Phones: a tap outside an open drawer closes it.
  if (narrow() && !btn('#modalRoot')) {
    const b = document.body;
    if (b.classList.contains('side-open') && !btn('#sidebar') && !btn('#menuBtn')) { b.classList.remove('side-open'); return; }
    if (b.classList.contains('tasks-open') && !btn('#tasks') && !btn('#tasksBtn')) { b.classList.remove('tasks-open'); return; }
  }
  if (btn('[data-mode]')) return setMode(btn('[data-mode]').dataset.mode);
  if (btn('#prevBtn')) return step(-1);
  if (btn('#nextBtn')) return step(1);
  if (btn('#todayBtn')) return goTo(today());
  if (btn('#miniPrev')) { state.mini = D.addMonths(state.mini, -1); return refresh(); }
  if (btn('#miniNext')) { state.mini = D.addMonths(state.mini, 1); return refresh(); }
  if (btn('#newBtn')) return newEvent(state.mode === 'month' || D.sameDay(state.cursor, today()) ? {} : { start: D.withTime(state.cursor, 9 * 60), end: D.withTime(state.cursor, 9 * 60 + store.settings.duration) });
  if (btn('#acctBtn')) return M.openAccounts(M.openSettings);
  if (btn('#settingsBtn')) return M.openSettings();
  if (btn('#connectBtn')) return store.cloud ? M.connect() : M.openSignIn();
  if (btn('[data-newcal]')) return M.openCalendarEditor(null, btn('[data-newcal]').dataset.newcal);
  if (btn('[data-editcal]')) { const k = btn('[data-editcal]').dataset.editcal; return M.openCalendarEditor(store.calendar(k) || store.taskList(k)); }
  if (btn('#refreshBtn')) { await M.run(() => store.refreshAll(), 'SYNCED'); return; }
  if (btn('#menuBtn')) return document.body.classList.toggle('side-open');
  if (btn('#tasksBtn') || btn('#tasksClose')) { document.body.classList.toggle('tasks-open'); return renderTasks(); }
  if (btn('#moreDays')) { state.agendaDays += 30; return refresh(); }
  if (btn('[data-reconnect]')) return M.connect(btn('[data-reconnect]').dataset.reconnect);
  if (btn('[data-mini]')) {
    const d = D.parseYmd(btn('[data-mini]').dataset.mini);
    state.selected = d;
    state.cursor = d;
    if (d.getMonth() !== state.mini.getMonth()) syncMini(d);
    if (narrow()) document.body.classList.remove('side-open');
    return refresh();
  }
  if (btn('[data-toggle]')) {
    const task = taskByUid(btn('[data-toggle]').dataset.toggle);
    if (task) M.run(() => store.toggleTask(task));
    return;
  }
  if (btn('[data-uid]')) return openEventByUid(btn('[data-uid]').dataset.uid);
  if (btn('[data-task]')) { const task = taskByUid(btn('[data-task]').dataset.task); if (task) M.openTaskEditor(task); return; }
  if (btn('[data-goto]')) return goTo(D.parseYmd(btn('[data-goto]').dataset.goto), 'day');
  // Empty space: make something there.
  const cell = btn('.mcell');
  if (cell && t === cell) return newEventAt(D.parseYmd(cell.dataset.date), 9 * 60);
  const ad = btn('.adcell');
  if (ad && t === ad) { const d = D.parseYmd(ad.dataset.date); return newEvent({ start: d, end: D.addDays(d, 1), allDay: true }); }
  const col = btn('.wcol');
  if (col && (t === col || t.classList.contains('now'))) {
    const min = Math.floor((e.clientY - col.getBoundingClientRect().top) / V.HOUR * 2) * 30;
    return newEventAt(D.parseYmd(col.dataset.col), Math.min(Math.max(min, 0), 23 * 60 + 30));
  }
});

document.addEventListener('change', e => {
  const vis = e.target.closest('[data-vis]');
  if (vis) { store.toggle(vis.dataset.vis); }
});

$('#taskAdd').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#taskTitle');
  const title = input.value.trim();
  const listKey = $('#taskList').value;
  if (!title || !listKey) return;
  input.value = '';
  store.setSettings({ lastList: listKey });
  const due = $('#taskToday').checked ? today() : null;
  if (!await M.run(() => store.saveTask({ listKey, title, notes: '', due, completed: false }, null))) input.value = title;
});

let searchTimer;
$('#search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(e.target.value.trim()), 400);
});
$('#search').addEventListener('keydown', e => {
  if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(e.target.value.trim()); }
  if (e.key === 'Escape') { e.target.value = ''; e.target.blur(); runSearch(''); }
});

// Drag events (and tasks) to a new day or time.
document.addEventListener('dragstart', e => {
  const el = e.target.closest?.('[data-uid][draggable=true], [data-task][draggable=true]');
  if (!el) return;
  const rect = el.getBoundingClientRect();
  state.drag = el.dataset.uid
    ? { ev: store.byUid(el.dataset.uid), grab: el.classList.contains('block') ? (e.clientY - rect.top) / V.HOUR * 60 : 0 }
    : { task: taskByUid(el.dataset.task) };
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', el.dataset.uid || el.dataset.task);
  setTimeout(() => el.classList.add('dragging'), 0);
});
document.addEventListener('dragend', () => { state.drag = null; document.querySelectorAll('.dragging, .drop').forEach(x => x.classList.remove('dragging', 'drop')); });
document.addEventListener('dragover', e => {
  if (!state.drag) return;
  const target = e.target.closest('.mcell, .adcell, .wcol');
  if (!target || (state.drag.task && target.classList.contains('wcol'))) return;
  e.preventDefault();
  document.querySelectorAll('.drop').forEach(x => x !== target && x.classList.remove('drop'));
  target.classList.add('drop');
});
document.addEventListener('drop', async e => {
  const drag = state.drag;
  const target = e.target.closest('.mcell, .adcell, .wcol');
  if (!drag || !target) return;
  e.preventDefault();
  state.drag = null;
  target.classList.remove('drop');
  if (drag.task) {
    const due = D.parseYmd(target.dataset.date);
    if (!drag.task.due || !D.sameDay(due, drag.task.due)) M.run(() => store.saveTask({ ...drag.task, due }, drag.task), 'TASK MOVED');
    return;
  }
  const ev = drag.ev;
  if (!ev) return;
  let start, allDayToTimed = false;
  if (target.classList.contains('wcol')) {
    const raw = (e.clientY - target.getBoundingClientRect().top) / V.HOUR * 60 - drag.grab;
    const min = Math.min(Math.max(Math.round(raw / 15) * 15, 0), 24 * 60 - 15);
    start = D.withTime(D.parseYmd(target.dataset.col), min);
    allDayToTimed = ev.allDay;
  } else {
    const day = D.parseYmd(target.dataset.date);
    start = ev.allDay ? day : D.withTime(day, D.minutesOfDay(ev.start));
  }
  if (+start === +ev.start && !allDayToTimed) return;
  const scope = ev.seriesId ? await M.askScope('MOVE') : 'all';
  if (!scope) return;
  if (allDayToTimed) {
    const draft = { calKey: ev.calKey, title: ev.title, allDay: false, start, end: D.addMinutes(start, store.settings.duration), location: ev.location, description: ev.description, colorId: ev.colorId };
    M.run(() => store.saveEvent(draft, ev, scope), 'EVENT MOVED');
  } else M.run(() => store.moveEvent(ev, start, scope), 'EVENT MOVED');
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && M.modalOpen()) return M.closeModal();
  if (M.modalOpen() || e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  const modes = { m: 'month', w: 'week', d: 'day', a: 'agenda' };
  if (modes[k]) setMode(modes[k]);
  else if (k === 't') goTo(today());
  else if (k === 'n' || k === 'c') { e.preventDefault(); newEvent(); }
  else if (k === 'arrowleft' || k === 'j') step(-1);
  else if (k === 'arrowright' || k === 'k') step(1);
  else if (k === '/') { e.preventDefault(); $('#search').focus(); }
});

// ---- reminders ----

const notified = new Set(JSON.parse(sessionStorage.getItem('bitcal.notified') || '[]'));
function checkReminders() {
  if (store.settings.push || !store.settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
  const now = new Date();
  for (const ev of store.eventsBetween(now, D.addDays(now, 2))) {
    if (ev.allDay || ev.start < D.addMinutes(now, -5)) continue;
    const mins = ev.reminder === 'default' ? store.calendar(ev.calKey)?.defaultReminder : ev.reminder;
    if (mins == null) continue;
    const key = `${ev.uid}@${+ev.start}`;
    if (notified.has(key) || now < D.addMinutes(ev.start, -mins)) continue;
    notified.add(key);
    sessionStorage.setItem('bitcal.notified', JSON.stringify([...notified].slice(-200)));
    const n = new Notification(ev.title, { body: `${D.countdown(ev.start - now)} · ${D.fmtTime(ev.start, store.settings.h24)}${ev.location ? ' · ' + ev.location : ''}`, tag: key });
    n.onclick = () => { window.focus(); openEventByUid(ev.uid); };
  }
}

// ---- opening an event from a reminder ----

// Reminders link to ?day=YYYY-MM-DD&event=<id>; the service worker also posts them to an open tab.
async function openFromLink(day, rowId) {
  if (!day) return;
  goTo(D.parseYmd(day), 'day');
  await load();
  const ev = store.eventsBetween(D.parseYmd(day), D.addDays(D.parseYmd(day), 1)).find(e => e.rowId === rowId || e.id === rowId);
  if (ev) M.openEvent(ev, e => M.openEditor(e));
}
navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'open') openFromLink(e.data.day, e.data.event); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

// ---- start ----

store.on(msg => msg ? M.toast(msg) : refresh());
let wasNarrow = narrow();
addEventListener('resize', () => { if (narrow() !== wasNarrow) { wasNarrow = narrow(); refresh(); } });
setInterval(() => { if (!state.drag && !M.modalOpen()) { renderSidebar(); if (state.mode === 'week' || state.mode === 'day') renderMain(); } checkReminders(); }, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - (store.lastRefresh || 0) > 5 * 60000) store.refreshAll();
});
// Keep pulling new Google invites in while the app is open.
setInterval(() => { if (document.visibilityState === 'visible') store.syncAllGoogle(); }, 10 * 60000);

render();
store.init().then(async () => {
  store.lastRefresh = Date.now();
  await load();
  checkReminders();
  const p = new URLSearchParams(location.search);
  if (p.get('day')) { history.replaceState(null, '', location.pathname); openFromLink(p.get('day'), p.get('event')); }
});
