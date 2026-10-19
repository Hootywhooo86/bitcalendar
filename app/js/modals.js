// Dialogs: event details + editor, task editor, accounts, settings, Google setup.
import * as D from './dates.js';
import * as G from './google.js';
import * as N from './native.js';
import { store } from './store.js';
import { esc } from './views.js';

const $ = (sel, el = document) => el.querySelector(sel);

export function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 4200);
}
// Runs an async action, reporting failures instead of throwing them.
export async function run(fn, done) {
  try { await fn(); if (done) toast(done); return true; }
  catch (e) { toast(e.message || String(e)); return false; }
}

export function openModal(html, cls = '') {
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `<div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div>`;
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) closeModal(wrap); });
  $('#modalRoot').appendChild(wrap);
  setTimeout(() => $('input:not([type=checkbox]):not([type=radio]), select, button', wrap)?.focus(), 0);
  return wrap;
}
export function closeModal(wrap) {
  (wrap || $('#modalRoot').lastElementChild)?.remove();
}
export const modalOpen = () => !!$('#modalRoot').lastElementChild;

// Small "pick one" dialog. Resolves with the chosen value, or null.
export function choose(title, text, options) {
  return new Promise(resolve => {
    const m = openModal(`<h2>${esc(title)}</h2>${text ? `<p class="mtext">${esc(text)}</p>` : ''}
      <div class="mbtns">${options.map((o, i) => `<button class="btn${o.primary ? ' primary' : ''}${o.danger ? ' danger' : ''}" data-i="${i}">${esc(o.label)}</button>`).join('')}
      <button class="btn" data-i="-1">CANCEL</button></div>`, 'small');
    const obs = new MutationObserver(() => { if (!m.isConnected) { obs.disconnect(); resolve(null); } });
    obs.observe($('#modalRoot'), { childList: true });
    m.addEventListener('click', e => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      obs.disconnect();
      closeModal(m);
      resolve(+b.dataset.i < 0 ? null : options[+b.dataset.i].value);
    });
  });
}

export const askScope = verb => choose(`${verb} REPEATING EVENT`, '', [
  { label: 'THIS EVENT', value: 'one' },
  { label: 'ALL EVENTS', value: 'all', primary: true },
]);

const textOf = html => new DOMParser().parseFromString(html.replace(/<br\s*\/?>/gi, '\n'), 'text/html').body.textContent;
const linkify = s => esc(s).replace(/https?:\/\/[^\s<]+/g, u => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
const REMINDERS = [[0, 'AT START'], [5, '5 MIN'], [10, '10 MIN'], [15, '15 MIN'], [30, '30 MIN'], [60, '1 HOUR'], [120, '2 HOURS'], [1440, '1 DAY']];
const RSVP = { accepted: 'GOING', tentative: 'MAYBE', declined: 'NOT GOING', needsAction: 'NO REPLY' };

// ---- event details ----

export function openEvent(ev, onEdit) {
  const cal = store.calendar(ev.calKey);
  const desc = ev.description ? textOf(ev.description).trim() : '';
  const m = openModal(`
    <div class="dhead" style="--c:${esc(ev.color)}"><h2>${esc(ev.title)}</h2></div>
    <p class="drow">&#9719; ${D.fmtRange(ev, store.settings.h24)}${ev.seriesId ? '<br>&#8635; REPEATS' : ''}</p>
    ${ev.location ? `<p class="drow">&#9873; <a href="https://maps.google.com/?q=${encodeURIComponent(ev.location)}" target="_blank" rel="noopener">${esc(ev.location)}</a></p>` : ''}
    ${ev.meet ? `<p class="drow">&#9654; <a href="${esc(ev.meet)}" target="_blank" rel="noopener">JOIN VIDEO CALL</a></p>` : ''}
    ${desc ? `<div class="ddesc">${linkify(desc)}</div>` : ''}
    ${ev.attendees?.length ? `<div class="dguests"><h3>GUESTS (${ev.attendees.length})</h3>${ev.attendees.map(a =>
      `<p><span class="rs ${esc(a.responseStatus)}"></span>${esc(a.displayName || a.email)}${a.organizer ? ' · HOST' : ''}</p>`).join('')}</div>` : ''}
    <p class="drow dim"><span class="sq" style="background:${esc(cal.color)}"></span>${esc(cal.name)}${ev.ext?.email ? ` · FROM GOOGLE (${esc(ev.ext.email)})` : ''}</p>
    ${ev.selfStatus && !ev.organizer?.self ? `<div class="rsvp"><span>GOING?</span>${['accepted', 'tentative', 'declined'].map(s =>
      `<button class="btn${ev.selfStatus === s ? ' primary' : ''}" data-rsvp="${s}">${RSVP[s]}</button>`).join('')}</div>` : ''}
    <div class="mbtns">
      ${ev.htmlLink ? `<a class="btn" href="${esc(ev.htmlLink)}" target="_blank" rel="noopener">OPEN IN GOOGLE</a>` : ''}
      ${ev.editable ? '<button class="btn danger" data-act="delete">DELETE</button><button class="btn" data-act="copy">DUPLICATE</button><button class="btn primary" data-act="edit">EDIT</button>' : ''}
      <button class="btn" data-act="close">CLOSE</button>
    </div>`);
  m.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const rsvp = e.target.closest('[data-rsvp]')?.dataset.rsvp;
    if (rsvp) { if (await run(() => store.rsvp(ev, rsvp), `REPLIED: ${RSVP[rsvp]}`)) closeModal(m); }
    if (act === 'close') closeModal(m);
    if (act === 'edit') { closeModal(m); onEdit(ev); }
    if (act === 'copy') { closeModal(m); openEditor(null, { ...ev, seriesId: null, rrule: null }); }
    if (act === 'delete') {
      const scope = ev.seriesId ? await askScope('DELETE') : await choose('DELETE EVENT?', ev.title, [{ label: 'DELETE', value: 'all', danger: true }]);
      if (scope && await run(() => store.deleteEvent(ev, scope), 'EVENT DELETED')) closeModal(m);
    }
  });
}

// ---- event editor ----

const REPEATS = [
  ['', 'DOES NOT REPEAT'], ['FREQ=DAILY', 'EVERY DAY'], ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'EVERY WEEKDAY'],
  ['FREQ=WEEKLY', 'EVERY WEEK'], ['FREQ=MONTHLY', 'EVERY MONTH'], ['FREQ=YEARLY', 'EVERY YEAR'],
];
const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// Maps a Google RRULE onto one of the simple choices above, or 'custom'.
function simpleRule(rrule, start) {
  const r = rrule.replace(/^RRULE:/, '');
  if (REPEATS.some(([v]) => v === r)) return r;
  if (r === `FREQ=WEEKLY;BYDAY=${BYDAY[start.getDay()]}`) return 'FREQ=WEEKLY';
  return 'custom';
}

// orig: event being edited (null for new). preset: starting values for a new event.
export function openEditor(orig, preset = {}) {
  const src = orig || preset;
  const cals = store.writableCalendars();
  if (!cals.length) return toast('No calendar to add to yet');
  const lastCal = store.calendar(store.settings.lastCal);
  const calKey = src.calKey && store.calendar(src.calKey)?.writable ? src.calKey
    : (lastCal && cals.includes(lastCal) ? lastCal.key : (cals.find(c => !c.ext) || cals[0]).key);
  const allDay = !!src.allDay;
  const start = src.start || D.withTime(new Date(), (D.minutesOfDay(new Date()) / 30 + 1 | 0) * 30);
  const end = src.end || (allDay ? D.addDays(start, 1) : D.addMinutes(start, store.settings.duration));
  const endShown = allDay ? D.addDays(end, -1) : end;
  const calOpts = store.groups('events').map(g =>
    `<optgroup label="${esc(g.label)}">${g.items.map(c => `<option value="${esc(c.key)}"${c.key === calKey ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>`).join('');
  const colors = [['', 'var(--cal)'], ...Object.entries(G.EVENT_COLORS)];

  const m = openModal(`<form class="editor" novalidate>
    <h2>${orig ? 'EDIT EVENT' : 'NEW EVENT'}</h2>
    <input name="title" class="big" placeholder="WHAT'S THE QUEST?" value="${esc(src.title || '')}" maxlength="500" required>
    <label class="field"><span>CALENDAR</span><select name="cal">${calOpts}</select></label>
    <label class="check"><input type="checkbox" name="allDay"${allDay ? ' checked' : ''}><span></span>ALL DAY</label>
    <div class="when">
      <label class="field"><span>START</span><input type="date" name="sdate" value="${D.ymd(start)}" required><input type="time" name="stime" value="${D.hm(start)}" step="300"></label>
      <label class="field"><span>END</span><input type="date" name="edate" value="${D.ymd(endShown)}" required><input type="time" name="etime" value="${D.hm(end)}" step="300"></label>
    </div>
    <div class="row2">
      <label class="field"><span>REPEAT</span><select name="repeat">${REPEATS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></label>
      <label class="field"><span>REMINDER</span><select name="reminder"></select></label>
    </div>
    <div class="field"><span>COLOR</span><div class="swatches">${colors.map(([id, c]) =>
      `<label title="${id ? 'color ' + id : 'calendar color'}"><input type="radio" name="color" value="${id}"${(src.colorId || '') === id ? ' checked' : ''}><i style="background:${c}"></i></label>`).join('')}</div></div>
    <label class="field"><span>WHERE</span><input name="location" placeholder="ADD A PLACE" value="${esc(src.location || '')}"></label>
    <label class="field"><span>NOTES</span><textarea name="description" rows="3" placeholder="ADD NOTES">${esc(src.description ? textOf(src.description) : '')}</textarea></label>
    <p class="err" hidden></p>
    <div class="mbtns">
      ${orig ? '<button type="button" class="btn danger" data-act="delete">DELETE</button>' : ''}
      <button type="button" class="btn" data-act="cancel">CANCEL</button>
      <button type="submit" class="btn primary">SAVE</button>
    </div></form>`, 'wide');
  const f = $('form', m);
  const el = n => f.elements[n];

  const setCalColor = () => f.style.setProperty('--cal', store.calendar(el('cal').value).color);
  // New events start with their calendar's usual reminder.
  const fillReminders = keep => {
    const cur = keep ?? String(store.calendar(el('cal').value).defaultReminder ?? 10);
    el('reminder').innerHTML = '<option value="none">NONE</option>' + REMINDERS.map(([v, l]) => `<option value="${v}">${l} BEFORE</option>`).join('');
    if (![...el('reminder').options].some(o => o.value === cur)) el('reminder').insertAdjacentHTML('beforeend', `<option value="${esc(cur)}">${esc(cur)} MIN BEFORE</option>`);
    el('reminder').value = cur;
  };
  const syncAllDay = () => m.querySelectorAll('input[type=time]').forEach(i => i.hidden = el('allDay').checked);
  setCalColor();
  fillReminders(orig || src.reminder !== undefined ? (src.reminder == null ? 'none' : String(src.reminder === 'default' ? store.calendar(calKey).defaultReminder ?? 10 : src.reminder)) : null);
  syncAllDay();

  // Show the series' repeat rule. Rules the box can't show stay exactly as they are.
  const initialRepeat = orig?.seriesId && orig.rrule ? simpleRule(orig.rrule, orig.start) : '';
  if (initialRepeat === 'custom') el('repeat').insertAdjacentHTML('beforeend', '<option value="custom">CUSTOM (KEEP AS IS)</option>');
  el('repeat').value = initialRepeat;

  // Moving the start drags the end along, keeping the length.
  const readStart = () => new Date(`${el('sdate').value}T${el('allDay').checked ? '00:00' : el('stime').value || '00:00'}`);
  const readEnd = () => el('allDay').checked ? D.addDays(D.parseYmd(el('edate').value), 1) : new Date(`${el('edate').value}T${el('etime').value || '00:00'}`);
  let prevStart = readStart();
  const onStart = () => {
    const s = readStart();
    if (isNaN(s)) return;
    const e = readEnd();
    if (!isNaN(e) && !isNaN(prevStart)) {
      const ne = new Date(+e + (s - prevStart));
      el('edate').value = D.ymd(el('allDay').checked ? D.addDays(ne, -1) : ne);
      el('etime').value = D.hm(ne);
    }
    prevStart = s;
  };
  el('sdate').addEventListener('change', onStart);
  el('stime').addEventListener('change', onStart);
  el('allDay').addEventListener('change', () => { syncAllDay(); prevStart = readStart(); });
  el('cal').addEventListener('change', () => { setCalColor(); if (!orig) fillReminders(); });

  m.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'cancel') closeModal(m);
    if (act === 'delete') {
      const scope = orig.seriesId ? await askScope('DELETE') : await choose('DELETE EVENT?', orig.title, [{ label: 'DELETE', value: 'all', danger: true }]);
      if (scope && await run(() => store.deleteEvent(orig, scope), 'EVENT DELETED')) closeModal(m);
    }
  });

  f.addEventListener('submit', async e => {
    e.preventDefault();
    const err = $('.err', f);
    const start = readStart(), end = readEnd();
    const fail = msg => { err.textContent = msg; err.hidden = false; };
    if (!el('title').value.trim()) return fail('GIVE IT A NAME');
    if (isNaN(start) || isNaN(end)) return fail('CHECK THE DATES');
    if (end <= start) return fail('END HAS TO BE AFTER START');
    const rv = el('reminder').value;
    const repeat = el('repeat').value;
    const draft = {
      calKey: el('cal').value, title: el('title').value.trim(), allDay: el('allDay').checked, start, end,
      location: el('location').value.trim(), description: el('description').value,
      colorId: f.elements.color.value || null,
      reminder: rv === 'none' ? null : +rv,
    };
    if (repeat !== initialRepeat && repeat !== 'custom') draft.rrule = repeat || null;
    let scope = 'all';
    if (orig?.seriesId && repeat === initialRepeat) {
      scope = await askScope('EDIT');
      if (!scope) return;
    }
    store.setSettings({ lastCal: draft.calKey });
    const btn = $('[type=submit]', f);
    btn.disabled = true;
    if (await run(() => store.saveEvent(draft, orig, scope), orig ? 'EVENT SAVED' : 'EVENT ADDED')) closeModal(m);
    btn.disabled = false;
  });
}

// ---- tasks ----

export function openTaskEditor(task, preset = {}) {
  const src = task || preset;
  const last = store.taskList(store.settings.lastList);
  const listKey = src.listKey || last?.key || (store.taskLists.find(l => !l.ext) || store.taskLists[0])?.key;
  const opts = store.groups('tasks').map(g =>
    `<optgroup label="${esc(g.label)}">${g.items.map(l => `<option value="${esc(l.key)}"${l.key === listKey ? ' selected' : ''}>${esc(l.title)}</option>`).join('')}</optgroup>`).join('');
  const m = openModal(`<form class="editor" novalidate>
    <h2>${task ? 'EDIT TASK' : 'NEW TASK'}</h2>
    <input name="title" class="big" placeholder="WHAT NEEDS DOING?" value="${esc(src.title || '')}" required>
    <label class="field"><span>LIST</span><select name="list">${opts}</select></label>
    <label class="field"><span>DUE</span><input type="date" name="due" value="${src.due ? D.ymd(src.due) : ''}"></label>
    <label class="check"><input type="checkbox" name="done"${src.completed ? ' checked' : ''}><span></span>DONE</label>
    <label class="field"><span>NOTES</span><textarea name="notes" rows="3" placeholder="ADD NOTES">${esc(src.notes || '')}</textarea></label>
    <p class="err" hidden></p>
    <div class="mbtns">
      ${task?.link ? `<a class="btn" href="${esc(task.link)}" target="_blank" rel="noopener">OPEN IN GOOGLE</a>` : ''}
      ${task ? '<button type="button" class="btn danger" data-act="delete">DELETE</button>' : ''}
      <button type="button" class="btn" data-act="cancel">CANCEL</button>
      <button type="submit" class="btn primary">SAVE</button>
    </div></form>`);
  const f = $('form', m);
  m.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'cancel') closeModal(m);
    if (act === 'delete' && await run(() => store.deleteTask(task), 'TASK DELETED')) closeModal(m);
  });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const title = f.elements.title.value.trim();
    if (!title) { const err = $('.err', f); err.textContent = 'GIVE IT A NAME'; err.hidden = false; return; }
    const draft = { listKey: f.elements.list.value, title, notes: f.elements.notes.value, due: f.elements.due.value ? D.parseYmd(f.elements.due.value) : null, completed: f.elements.done.checked };
    store.setSettings({ lastList: draft.listKey });
    if (await run(() => store.saveTask(draft, task), task ? 'TASK SAVED' : 'TASK ADDED')) closeModal(m);
  });
}

// ---- accounts / settings / setup ----

export function connect(hint) {
  if (!N.googleHere) return toast('Connect Google from the computer app or the web. Once it\'s in, it shows up here too.');
  if (!store.cloud) {
    toast('Sign in to your 128bit account first, then Google can pour in');
    return openSignIn();
  }
  if (!store.clientId() && !N.googleRefreshes) return openSetup();
  if (!N.googleRefreshes && !G.gisReady()) { G.loadGis().catch(() => {}); return toast('Google sign-in is still loading, tap again in a sec'); }
  return run(async () => {
    const acc = await store.connectGoogle(hint);
    toast(N.googleRefreshes ? `${acc.email} IS IN · KEEPS SYNCING IN THE BACKGROUND` : `${acc.email} IS IN · KEEPS SYNCING WHILE BITCALENDAR IS OPEN`);
  });
}

export function openSignIn() {
  const m = openModal(`<form class="editor" novalidate>
    <h2>128BIT ACCOUNT</h2>
    <p class="mtext">One account for every 128bit app (same as 128bit Play and Tracker). Your calendars, events and tasks sync to every device you sign in on.</p>
    <label class="field"><span>EMAIL</span><input name="email" type="email" autocomplete="email" required></label>
    <label class="field"><span>PASSWORD</span><input name="password" type="password" autocomplete="current-password" minlength="6"></label>
    <p class="err" hidden></p>
    <div class="mbtns">
      <button type="button" class="btn" data-act="link">EMAIL ME A LINK</button>
      <button type="button" class="btn" data-act="up">CREATE ACCOUNT</button>
      <button type="submit" class="btn primary">SIGN IN</button>
    </div></form>`, 'small');
  const f = $('form', m);
  const err = msg => { const e = $('.err', f); e.textContent = msg; e.hidden = !msg; };
  const email = () => f.elements.email.value.trim();
  const busy = async (btn, fn) => {
    err('');
    if (!/^\S+@\S+\.\S+$/.test(email())) return err('TYPE YOUR EMAIL');
    btn.disabled = true;
    try { await fn(); } catch (e) { err(e.message); } finally { btn.disabled = false; }
  };
  f.addEventListener('submit', e => {
    e.preventDefault();
    busy($('[type=submit]', f), async () => {
      if (!f.elements.password.value) throw new Error('TYPE YOUR PASSWORD, OR GET A LINK BY EMAIL');
      await store.signIn(email(), f.elements.password.value);
      closeModal(m);
      toast('SIGNED IN');
    });
  });
  m.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'link') busy(e.target, async () => { await store.sendLink(email()); err(''); $('.mtext', f).textContent = `Check ${email()} for a sign-in link. Open it on this device.`; });
    if (act === 'up') busy(e.target, async () => {
      if (f.elements.password.value.length < 6) throw new Error('PICK A PASSWORD (6+ CHARACTERS)');
      const r = await store.signUp(email(), f.elements.password.value);
      if (r.confirm) $('.mtext', f).textContent = `Almost there: confirm the email we sent to ${email()}, then sign in.`;
      else { closeModal(m); toast('ACCOUNT MADE · WELCOME'); }
    });
  });
}

export function openAccounts(openSettingsFn) {
  const u = store.user;
  const gs = store.googleAccounts();
  const m = openModal(`<h2>ACCOUNTS</h2>
    <div class="accts">
      <div class="acct"><span class="ph local">&#9635;</span><div>
        <b>${u ? esc(u.email) : 'NOT SIGNED IN'}</b>
        <small class="${u ? 'ok' : 'warn'}">${u ? '128BIT ACCOUNT · SYNCS EVERYWHERE' : 'EVERYTHING IS ONLY ON THIS DEVICE'}</small></div>
        <div class="aact">${u ? '<button class="btn" data-act="out">SIGN OUT</button>' : '<button class="btn primary" data-act="in">SIGN IN</button>'}</div>
      </div>
      <h3 class="sub">GOOGLE (FEEDING IN)</h3>
      ${gs.map(a => `<div class="acct">
        ${a.picture ? `<img src="${esc(a.picture)}" alt="" referrerpolicy="no-referrer">` : '<span class="ph">G</span>'}
        <div><b>${esc(a.email)}</b><small class="${a.expired ? 'warn' : 'ok'}">${a.expired ? 'SIGNED OUT · RECONNECT TO KEEP SYNCING' : esc(a.status || 'CONNECTED')}${a.tasksOk === false ? ' · NO TASKS ACCESS' : ''}</small></div>
        <div class="aact">${a.expired || a.tasksOk === false ? `<button class="btn primary" data-re="${esc(a.email)}">RECONNECT</button>` : `<button class="btn" data-sync="${esc(a.email)}"${a.syncing ? ' disabled' : ''}>SYNC NOW</button>`}<button class="btn" data-out="${esc(a.email)}">REMOVE</button></div>
      </div>`).join('') || `<p class="none">${u ? 'connect google to copy in your calendars + tasks. it keeps feeding in new invites until you remove it.' : 'sign in first, then connect google to bring everything over.'}</p>`}
    </div>
    <div class="mbtns"><button class="btn" data-act="settings">SETTINGS</button><button class="btn primary" data-act="add">+ CONNECT GOOGLE</button><button class="btn" data-act="close">CLOSE</button></div>`);
  const reopen = () => { closeModal(m); openAccounts(openSettingsFn); };
  m.addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.re) { closeModal(m); await connect(t.dataset.re); }
    if (t.dataset.sync) { t.disabled = true; await store.syncGoogle(store.googleAccount(t.dataset.sync)); reopen(); }
    if (t.dataset.out) {
      const email = t.dataset.out;
      const how = await choose('REMOVE GOOGLE ACCOUNT?', `${email} stops syncing. Nothing changes in Google.`, [
        { label: 'KEEP ITS EVENTS HERE', value: 'keep', primary: true },
        { label: 'REMOVE THEM TOO', value: 'drop', danger: true },
      ]);
      if (how && await run(() => store.disconnectGoogle(email, how === 'drop'), 'GOOGLE REMOVED')) reopen();
    }
    if (t.dataset.act === 'in') { closeModal(m); openSignIn(); }
    if (t.dataset.act === 'out' && await choose('SIGN OUT?', 'Your calendar stays in your 128bit account. This device goes back to its own calendar.', [{ label: 'SIGN OUT', value: 1, danger: true }])) {
      await run(() => store.signOut(), 'SIGNED OUT'); closeModal(m);
    }
    if (t.dataset.act === 'add') { closeModal(m); await connect(); }
    if (t.dataset.act === 'settings') { closeModal(m); openSettingsFn(); }
    if (t.dataset.act === 'close') closeModal(m);
  });
}

const PALETTE = ['#ff9f1c', '#b388ff', '#7ae7bf', '#46d6db', '#5484ed', '#ff887c', '#f691b2', '#fbd75b', '#51b749', '#dc2127', '#e1e1e1', '#cd74e6'];

export function openCalendarEditor(cal, kind = 'events') {
  if (!store.cloud) { toast('Sign in to make more calendars'); return openSignIn(); }
  kind = cal?.title !== undefined ? 'tasks' : kind;
  const name = cal ? (cal.name ?? cal.title) : '';
  const color = cal?.color || (kind === 'tasks' ? '#b388ff' : PALETTE[(store.calendars.length) % PALETTE.length]);
  const m = openModal(`<form class="editor" novalidate>
    <h2>${cal ? 'EDIT' : 'NEW'} ${kind === 'tasks' ? 'TASK LIST' : 'CALENDAR'}</h2>
    <input name="name" class="big" placeholder="${kind === 'tasks' ? 'GROCERIES, CHORES...' : 'WORK, FAMILY, QUESTS...'}" value="${esc(name)}" maxlength="200" required>
    <div class="field"><span>COLOR</span><div class="swatches">${PALETTE.concat(PALETTE.includes(color) ? [] : [color]).map(c =>
      `<label><input type="radio" name="color" value="${c}"${c === color ? ' checked' : ''}><i style="background:${c}"></i></label>`).join('')}</div></div>
    ${kind === 'events' ? `<label class="field"><span>USUAL REMINDER</span><select name="rem"><option value="">NONE</option>${REMINDERS.map(([v, l]) => `<option value="${v}">${l} BEFORE</option>`).join('')}</select></label>` : ''}
    ${cal?.ext ? `<p class="mtext">Copied from Google (${esc(cal.ext.email)}). Changes there keep coming in until you remove that Google account.</p>` : ''}
    <p class="err" hidden></p>
    <div class="mbtns">
      ${cal && !cal.ext ? '<button type="button" class="btn danger" data-act="delete">DELETE</button>' : ''}
      <button type="button" class="btn" data-act="cancel">CANCEL</button>
      <button type="submit" class="btn primary">SAVE</button>
    </div></form>`, 'small');
  const f = $('form', m);
  if (f.elements.rem) f.elements.rem.value = cal ? String(cal.defaultReminder ?? '') : '10';
  m.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'cancel') closeModal(m);
    if (act === 'delete') {
      const mine = kind === 'tasks' ? store.taskLists : store.calendars;
      if (mine.filter(c => !c.ext).length < 2) return toast(`Keep at least one ${kind === 'tasks' ? 'task list' : 'calendar'}`);
      if (await choose(`DELETE ${name}?`, `Everything in it is deleted on every device.`, [{ label: 'DELETE', value: 1, danger: true }])
        && await run(() => store.deleteCalendar(cal), 'DELETED')) closeModal(m);
    }
  });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const n = f.elements.name.value.trim();
    if (!n) { const er = $('.err', f); er.textContent = 'GIVE IT A NAME'; er.hidden = false; return; }
    const rem = f.elements.rem?.value;
    const draft = { name: n, color: f.elements.color.value, kind, defaultReminder: rem ? +rem : null };
    if (await run(() => store.saveCalendar(draft, cal), 'SAVED')) closeModal(m);
  });
}

export function openSettings() {
  const s = store.settings;
  const pushOk = 'serviceWorker' in navigator && 'PushManager' in window;
  const m = openModal(`<form class="editor">
    <h2>SETTINGS</h2>
    <div class="row2">
      <label class="field"><span>WEEK STARTS</span><select name="weekStart"><option value="0">SUNDAY</option><option value="1">MONDAY</option></select></label>
      <label class="field"><span>CLOCK</span><select name="h24"><option value="0">12 HOUR</option><option value="1">24 HOUR</option></select></label>
    </div>
    <label class="field"><span>NEW EVENT LENGTH</span><select name="duration">${[15, 30, 45, 60, 90, 120].map(n => `<option value="${n}">${n} MIN</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" name="showTasks"${s.showTasks ? ' checked' : ''}><span></span>SHOW TASKS ON THE CALENDAR</label>
    ${N.isNative ? `<label class="check"><input type="checkbox" name="deviceReminders"${s.deviceReminders !== false ? ' checked' : ''}><span></span>REMINDERS ON THIS ${N.platform === 'android' ? 'PHONE' : 'COMPUTER'}</label>
    ${N.platform === 'desktop' ? '<label class="check"><input type="checkbox" name="autoStart"><span></span>START WITH WINDOWS (IN THE TRAY)</label>' : ''}` : `
    <label class="check"><input type="checkbox" name="push"${s.push ? ' checked' : ''}${pushOk && store.cloud ? '' : ' disabled'}><span></span>PUSH REMINDERS ON THIS DEVICE (EVEN WHEN CLOSED)</label>
    ${!store.cloud ? '<p class="mtext">Sign in to get push reminders.</p>' : !pushOk ? '<p class="mtext">This browser can\'t do push. On iPhone: Share → Add to Home Screen, then open Bitcalendar from there.</p>' : ''}
    <label class="check"><input type="checkbox" name="notify"${s.notify ? ' checked' : ''}><span></span>POP-UP REMINDERS WHILE THE APP IS OPEN</label>
    <label class="field"><span>GOOGLE CLIENT ID (FOR IMPORT)</span><input name="clientId" placeholder="${esc(window.BITCAL_CONFIG?.googleClientId || 'xxxx.apps.googleusercontent.com')}" value="${esc(s.clientId)}"></label>`}
    <div class="mbtns">
      ${store.cloud ? '' : '<button type="button" class="btn danger" data-act="wipe">CLEAR DEVICE CALENDAR</button>'}
      <button type="submit" class="btn primary">SAVE</button>
    </div></form>`);
  const f = $('form', m);
  f.elements.weekStart.value = s.weekStart;
  f.elements.h24.value = s.h24 ? 1 : 0;
  f.elements.duration.value = s.duration;
  if (f.elements.autoStart) window.bitcalDesktop.getAutoStart().then(on => { f.elements.autoStart.checked = on; });
  f.elements.autoStart?.addEventListener('change', () => window.bitcalDesktop.setAutoStart(f.elements.autoStart.checked));
  f.elements.notify?.addEventListener('change', async () => {
    if (f.elements.notify.checked && 'Notification' in window && Notification.permission !== 'granted') {
      if (await Notification.requestPermission() !== 'granted') { f.elements.notify.checked = false; toast('Notifications are blocked in this browser'); }
    }
  });
  f.elements.push?.addEventListener('change', async () => {
    const box = f.elements.push;
    box.disabled = true;
    const ok = await run(() => box.checked ? store.enablePush() : store.disablePush(), box.checked ? 'PUSH REMINDERS ON' : 'PUSH REMINDERS OFF');
    if (!ok) box.checked = !box.checked;
    box.disabled = false;
  });
  m.addEventListener('click', async e => {
    if (e.target.closest('[data-act=wipe]') && await choose('CLEAR DEVICE CALENDAR?', 'Deletes every event and quest saved in this browser.', [{ label: 'CLEAR', value: 1, danger: true }])) {
      store.wipeLocal(); toast('DEVICE CALENDAR CLEARED');
    }
  });
  f.addEventListener('submit', e => {
    e.preventDefault();
    store.setSettings({
      weekStart: +f.elements.weekStart.value, h24: f.elements.h24.value === '1', duration: +f.elements.duration.value,
      showTasks: f.elements.showTasks.checked,
      ...(N.isNative
        ? { deviceReminders: f.elements.deviceReminders.checked }
        : { notify: f.elements.notify.checked, clientId: f.elements.clientId.value.trim() }),
    });
    closeModal(m);
    toast('SAVED');
  });
}

export function openSetup() {
  const m = openModal(`<h2>CONNECT GOOGLE</h2>
    <div class="mtext steps">
      <p>To copy your Google calendars + tasks in, Bitcalendar needs a Google OAuth client ID once:</p>
      <ol>
        <li>Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Google Cloud → Credentials</a> and make a project.</li>
        <li>Turn on the <b>Google Calendar API</b> and <b>Google Tasks API</b>.</li>
        <li>Create an <b>OAuth client ID</b>, type <b>Web application</b>.</li>
        <li>Add <code>${esc(location.origin)}</code> under <b>Authorized JavaScript origins</b>.</li>
        <li>Paste the client ID here.</li>
      </ol>
    </div>
    <label class="field"><span>CLIENT ID</span><input id="cid" placeholder="xxxx.apps.googleusercontent.com" value="${esc(store.clientId())}"></label>
    <div class="mbtns"><button class="btn" data-act="close">CANCEL</button><button class="btn primary" data-act="save">SAVE</button></div>`);
  m.addEventListener('click', async e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'close') closeModal(m);
    if (act === 'save') {
      const id = $('#cid', m).value.trim();
      if (!/\.apps\.googleusercontent\.com$/.test(id)) return toast('That doesn\'t look like a Google client ID');
      store.setSettings({ clientId: id });
      const btn = e.target.closest('button');
      btn.textContent = 'LOADING...';
      btn.disabled = true;
      await G.loadGis().catch(() => toast('Could not reach Google'));
      btn.textContent = 'CONNECT NOW';
      btn.disabled = false;
      btn.dataset.act = 'go';
    } else if (act === 'go') { closeModal(m); connect(); }
  });
}
