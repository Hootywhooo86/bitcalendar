// Dialogs: event details + editor, task editor, accounts, settings, Google setup.
import * as D from './dates.js';
import * as G from './google.js';
import * as L from './local.js';
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
  const acc = store.account(cal.account);
  const desc = ev.description ? textOf(ev.description).trim() : '';
  const m = openModal(`
    <div class="dhead" style="--c:${esc(ev.color)}"><h2>${esc(ev.title)}</h2></div>
    <p class="drow">&#9719; ${D.fmtRange(ev, store.settings.h24)}${ev.seriesId ? '<br>&#8635; REPEATS' : ''}</p>
    ${ev.location ? `<p class="drow">&#9873; <a href="https://maps.google.com/?q=${encodeURIComponent(ev.location)}" target="_blank" rel="noopener">${esc(ev.location)}</a></p>` : ''}
    ${ev.meet ? `<p class="drow">&#9654; <a href="${esc(ev.meet)}" target="_blank" rel="noopener">JOIN VIDEO CALL</a></p>` : ''}
    ${desc ? `<div class="ddesc">${linkify(desc)}</div>` : ''}
    ${ev.attendees?.length ? `<div class="dguests"><h3>GUESTS (${ev.attendees.length})</h3>${ev.attendees.map(a =>
      `<p><span class="rs ${esc(a.responseStatus)}"></span>${esc(a.displayName || a.email)}${a.organizer ? ' · HOST' : ''}</p>`).join('')}</div>` : ''}
    <p class="drow dim"><span class="sq" style="background:${esc(cal.color)}"></span>${esc(cal.name)}${acc.email && acc.email !== cal.name ? ` · ${esc(acc.email)}` : ''}</p>
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
    if (act === 'copy') { closeModal(m); openEditor(null, { ...ev, title: ev.title, seriesId: null }); }
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
  if (!cals.length) return toast('No calendar you can write to. Reconnect your Google account.');
  const lastCal = store.calendar(store.settings.lastCal);
  const calKey = src.calKey && store.calendar(src.calKey)?.writable ? src.calKey
    : (lastCal && cals.includes(lastCal) ? lastCal.key : (cals.find(c => c.primary) || cals[0]).key);
  const allDay = !!src.allDay;
  const start = src.start || D.withTime(new Date(), (D.minutesOfDay(new Date()) / 30 + 1 | 0) * 30);
  const end = src.end || (allDay ? D.addDays(start, 1) : D.addMinutes(start, store.settings.duration));
  const endShown = allDay ? D.addDays(end, -1) : end;
  const reminder = src.reminder !== undefined ? src.reminder : null;
  const calOpts = store.accounts.map(a => {
    const cs = cals.filter(c => c.account === a.key);
    return cs.length ? `<optgroup label="${esc(a.email || a.name)}">${cs.map(c => `<option value="${esc(c.key)}"${c.key === calKey ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</optgroup>` : '';
  }).join('');
  const colors = [['', 'var(--cal)'], ...Object.entries(G.EVENT_COLORS)];

  const m = openModal(`<form class="editor" novalidate>
    <h2>${orig ? 'EDIT EVENT' : 'NEW EVENT'}</h2>
    <input name="title" class="big" placeholder="WHAT'S THE QUEST?" value="${esc(src.title || '')}" maxlength="500" required>
    <label class="field"><span>CALENDAR</span><select name="cal"${orig?.seriesId ? ' disabled title="Repeating events stay on their calendar"' : ''}>${calOpts}</select></label>
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
  const fillReminders = keep => {
    const google = store.calendar(el('cal').value).account !== 'local';
    const cur = keep ?? el('reminder').value;
    el('reminder').innerHTML = `<option value="none">NONE</option>${google ? '<option value="default">CALENDAR DEFAULT</option>' : ''}`
      + REMINDERS.map(([v, l]) => `<option value="${v}">${l} BEFORE</option>`).join('');
    el('reminder').value = [...el('reminder').options].some(o => o.value === String(cur)) ? String(cur) : (google ? 'default' : '10');
  };
  const syncAllDay = () => m.querySelectorAll('input[type=time]').forEach(i => i.hidden = el('allDay').checked);
  setCalColor();
  fillReminders(orig ? (reminder == null ? 'none' : reminder) : null);
  syncAllDay();

  // Load the series' repeat rule so the REPEAT box shows it.
  let initialRepeat = '', original = null;
  if (orig?.seriesId) {
    el('repeat').disabled = true;
    (async () => {
      const cal = store.calendar(orig.calKey);
      let rule = '';
      if (cal.account === 'local') rule = L.getSeries(orig.seriesId)?.rrule || '';
      else {
        const acc = store.account(cal.account);
        const master = await G.getEvent(acc, cal.id, orig.seriesId).catch(() => null);
        original = master?.recurrence || null;
        rule = (original || []).find(r => r.startsWith('RRULE:')) || '';
      }
      initialRepeat = rule ? simpleRule(rule, orig.start) : '';
      if (initialRepeat === 'custom') el('repeat').insertAdjacentHTML('beforeend', '<option value="custom">CUSTOM (KEEP AS IS)</option>');
      el('repeat').value = initialRepeat;
      el('repeat').disabled = false;
    })();
  }

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
  el('cal').addEventListener('change', () => { setCalColor(); fillReminders(); });

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
      reminder: rv === 'none' ? null : rv === 'default' ? 'default' : +rv,
    };
    if (orig?.seriesId && repeat === initialRepeat) {
      if (original) draft.recurrence = original; // keep Google's exact rule (end dates, skipped days)
    } else if (repeat !== 'custom') draft.rrule = repeat || null;
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
  const lists = store.taskLists.filter(l => !store.account(l.account)?.expired);
  const src = task || preset;
  const listKey = src.listKey || store.settings.lastList || lists[0]?.key;
  const opts = store.accounts.map(a => {
    const ls = lists.filter(l => l.account === a.key);
    return ls.length ? `<optgroup label="${esc(a.email || a.name)}">${ls.map(l => `<option value="${esc(l.key)}"${l.key === listKey ? ' selected' : ''}>${esc(l.title)}</option>`).join('')}</optgroup>` : '';
  }).join('');
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
  if (!store.clientId()) return openSetup();
  if (!G.gisReady()) { G.loadGis().catch(() => {}); return toast('Google sign-in is still loading, tap again in a sec'); }
  return run(async () => {
    const acc = await store.connectGoogle(hint);
    toast(`CONNECTED ${acc.email}`);
  });
}

export function openAccounts(openSettingsFn) {
  const gs = store.googleAccounts();
  const m = openModal(`<h2>ACCOUNTS</h2>
    <div class="accts">
      ${gs.map(a => `<div class="acct">
        ${a.picture ? `<img src="${esc(a.picture)}" alt="" referrerpolicy="no-referrer">` : '<span class="ph">G</span>'}
        <div><b>${esc(a.name)}</b><small>${esc(a.email)}</small><small class="${a.expired ? 'warn' : 'ok'}">${a.expired ? 'SIGNED OUT · RECONNECT TO SYNC' : `SYNCING ${store.calendars.filter(c => c.account === a.key).length} CALENDARS${a.tasksOk === false ? ' · NO TASKS ACCESS' : ''}`}</small></div>
        <div class="aact">${a.expired || a.tasksOk === false ? `<button class="btn primary" data-re="${esc(a.email)}">RECONNECT</button>` : ''}<button class="btn" data-out="${esc(a.key)}">REMOVE</button></div>
      </div>`).join('') || '<p class="none">no google accounts yet. connect one to see your calendars and tasks.</p>'}
      <div class="acct"><span class="ph local">&#9635;</span><div><b>ON THIS DEVICE</b><small>events & quests kept in this browser</small></div></div>
    </div>
    <div class="mbtns"><button class="btn" data-act="settings">SETTINGS</button><button class="btn primary" data-act="add">+ CONNECT GOOGLE</button><button class="btn" data-act="close">CLOSE</button></div>`);
  m.addEventListener('click', async e => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.re) { await connect(t.dataset.re); closeModal(m); }
    if (t.dataset.out) {
      const a = store.account(t.dataset.out);
      if (await choose('REMOVE ACCOUNT?', `${a.email} will stop syncing here. Nothing is deleted from Google.`, [{ label: 'REMOVE', value: 1, danger: true }])) {
        store.disconnect(a.key); closeModal(m); openAccounts(openSettingsFn);
      }
    }
    if (t.dataset.act === 'add') { const ok = await connect(); if (ok !== undefined) closeModal(m); }
    if (t.dataset.act === 'settings') { closeModal(m); openSettingsFn(); }
    if (t.dataset.act === 'close') closeModal(m);
  });
}

export function openSettings() {
  const s = store.settings;
  const m = openModal(`<form class="editor">
    <h2>SETTINGS</h2>
    <div class="row2">
      <label class="field"><span>WEEK STARTS</span><select name="weekStart"><option value="0">SUNDAY</option><option value="1">MONDAY</option></select></label>
      <label class="field"><span>CLOCK</span><select name="h24"><option value="0">12 HOUR</option><option value="1">24 HOUR</option></select></label>
    </div>
    <label class="field"><span>NEW EVENT LENGTH</span><select name="duration">${[15, 30, 45, 60, 90, 120].map(n => `<option value="${n}">${n} MIN</option>`).join('')}</select></label>
    <label class="check"><input type="checkbox" name="showTasks"${s.showTasks ? ' checked' : ''}><span></span>SHOW TASKS ON THE CALENDAR</label>
    <label class="check"><input type="checkbox" name="notify"${s.notify ? ' checked' : ''}><span></span>REMINDER NOTIFICATIONS (WHILE OPEN)</label>
    <label class="field"><span>GOOGLE CLIENT ID</span><input name="clientId" placeholder="${esc(window.BITCAL_CONFIG?.googleClientId || 'xxxx.apps.googleusercontent.com')}" value="${esc(s.clientId)}"></label>
    <div class="mbtns">
      <button type="button" class="btn danger" data-act="wipe">CLEAR DEVICE CALENDAR</button>
      <button type="submit" class="btn primary">SAVE</button>
    </div></form>`);
  const f = $('form', m);
  f.elements.weekStart.value = s.weekStart;
  f.elements.h24.value = s.h24 ? 1 : 0;
  f.elements.duration.value = s.duration;
  f.elements.notify.addEventListener('change', async () => {
    if (f.elements.notify.checked && 'Notification' in window && Notification.permission !== 'granted') {
      if (await Notification.requestPermission() !== 'granted') { f.elements.notify.checked = false; toast('Notifications are blocked in this browser'); }
    }
  });
  m.addEventListener('click', async e => {
    if (e.target.closest('[data-act=wipe]') && await choose('CLEAR DEVICE CALENDAR?', 'Deletes every event and quest saved in this browser. Google stays as it is.', [{ label: 'CLEAR', value: 1, danger: true }])) {
      store.wipeLocal(); toast('DEVICE CALENDAR CLEARED');
    }
  });
  f.addEventListener('submit', e => {
    e.preventDefault();
    store.setSettings({
      weekStart: +f.elements.weekStart.value, h24: f.elements.h24.value === '1', duration: +f.elements.duration.value,
      showTasks: f.elements.showTasks.checked, notify: f.elements.notify.checked, clientId: f.elements.clientId.value.trim(),
    });
    closeModal(m);
    toast('SAVED');
  });
}

export function openSetup() {
  const m = openModal(`<h2>CONNECT GOOGLE</h2>
    <div class="mtext steps">
      <p>Bitcalendar talks to Google straight from your browser. It needs an OAuth client ID once:</p>
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
