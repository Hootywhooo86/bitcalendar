// Main calendar views, rendered as HTML strings. app.js wires up clicks and drag-and-drop.
import * as D from './dates.js';
import { store } from './store.js';

export const HOUR = 48; // px per hour in week/day view

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The dates a view covers. Week view on a phone shows three days from the cursor.
export function rangeFor(mode, cursor, narrow, agendaDays = 30) {
  const ws = store.settings.weekStart;
  if (mode === 'month') {
    const min = D.startOfWeek(D.startOfMonth(cursor), ws);
    return { min, max: D.addDays(min, 42) };
  }
  if (mode === 'week') {
    const min = narrow ? D.startOfDay(cursor) : D.startOfWeek(cursor, ws);
    return { min, max: D.addDays(min, narrow ? 3 : 7) };
  }
  if (mode === 'day') { const min = D.startOfDay(cursor); return { min, max: D.addDays(min, 1) }; }
  const min = D.startOfDay(cursor);
  return { min, max: D.addDays(min, agendaDays) };
}

export function titleFor(mode, cursor, narrow) {
  const { min, max } = rangeFor(mode, cursor, narrow);
  const last = D.addDays(max, -1);
  if (mode === 'month') return `${D.MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;
  if (mode === 'day') return `${D.DOW3[min.getDay()]} ${D.MON3[min.getMonth()]} ${min.getDate()} ${min.getFullYear()}`;
  if (mode === 'agenda') return `FROM ${D.MON3[min.getMonth()]} ${min.getDate()}`;
  return min.getMonth() === last.getMonth()
    ? `${D.MON3[min.getMonth()]} ${min.getDate()}–${last.getDate()} ${last.getFullYear()}`
    : `${D.MON3[min.getMonth()]} ${min.getDate()} – ${D.MON3[last.getMonth()]} ${last.getDate()}`;
}

const dayItems = (events, tasks, day) => {
  const next = D.addDays(day, 1);
  return {
    events: events.filter(e => e.start < next && (e.end > day || (+e.start === +e.end && e.start >= day))),
    tasks: tasks.filter(t => D.sameDay(t.due, day)),
  };
};

export const eventChip = (e, day) => {
  const h24 = store.settings.h24;
  const continues = !e.allDay && day && !D.sameDay(e.start, day);
  const time = e.allDay ? '' : `<b>${continues ? '…' : D.fmtTime(e.start, h24)}</b>`;
  return `<div class="chip${e.allDay ? ' ad' : ''}" data-uid="${esc(e.uid)}" draggable="${e.editable}" style="--c:${esc(e.color)}" title="${esc(e.title)}">${time}${esc(e.title)}</div>`;
};
export const taskChip = t =>
  `<div class="chip task${t.completed ? ' done' : ''}" data-task="${esc(t.uid)}" draggable="true" title="${esc(t.title)}"><i>${t.completed ? '&#9635;' : '&#9633;'}</i>${esc(t.title)}</div>`;

export function monthView(cursor, narrow) {
  const { min, max } = rangeFor('month', cursor);
  const events = store.eventsBetween(min, max), tasks = store.tasksBetween(min, max);
  const ws = store.settings.weekStart;
  const dow = Array.from({ length: 7 }, (_, i) => `<span>${D.DOW3[(i + ws) % 7]}</span>`).join('');
  const today = new Date();
  const fit = narrow ? 2 : 3;
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const day = D.addDays(min, i);
    const { events: evs, tasks: ts } = dayItems(events, tasks, day);
    const all = [...evs.map(e => eventChip(e, day)), ...ts.map(taskChip)];
    const shown = all.length > fit ? all.slice(0, fit - 1) : all;
    const cls = ['mcell', day.getMonth() !== cursor.getMonth() && 'other', D.sameDay(day, today) && 'today'].filter(Boolean).join(' ');
    cells += `<div class="${cls}" data-date="${D.ymd(day)}">
      <button class="mnum" data-goto="${D.ymd(day)}">${day.getDate()}</button>
      ${shown.join('')}
      ${all.length > shown.length ? `<button class="more" data-goto="${D.ymd(day)}">+${all.length - shown.length} MORE</button>` : ''}
    </div>`;
  }
  return `<div class="month"><div class="mdow">${dow}</div><div class="mgrid">${cells}</div></div>`;
}

// Side-by-side columns for overlapping timed events in one day.
function layoutDay(events, day) {
  const dayStart = +day, dayEnd = +D.addDays(day, 1);
  const segs = events.filter(e => !e.allDay).map(e => {
    const s = Math.max(+e.start, dayStart), en = Math.min(+e.end, dayEnd);
    return { ev: e, s: (s - dayStart) / 60000, e: Math.max((en - dayStart) / 60000, (s - dayStart) / 60000 + 20) };
  }).sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [], cols = [], clusterEnd = -1;
  const flush = () => { cluster.forEach(g => g.n = cols.length); cluster = []; cols = []; };
  for (const g of segs) {
    if (g.s >= clusterEnd) flush();
    let c = cols.findIndex(end => end <= g.s);
    if (c < 0) { c = cols.length; cols.push(g.e); } else cols[c] = g.e;
    g.col = c;
    cluster.push(g);
    clusterEnd = Math.max(clusterEnd, g.e);
  }
  flush();
  return segs;
}

export function weekView(cursor, mode, narrow) {
  const { min, max } = rangeFor(mode, cursor, narrow);
  const days = [];
  for (let d = min; d < max; d = D.addDays(d, 1)) days.push(d);
  const events = store.eventsBetween(min, max), tasks = store.tasksBetween(min, max);
  const h24 = store.settings.h24;
  const now = new Date();
  const head = days.map(d => `<button class="wday${D.sameDay(d, now) ? ' today' : ''}" data-goto="${D.ymd(d)}">${D.DOW3[d.getDay()]} <b>${d.getDate()}</b></button>`).join('');
  const allDay = days.map(d => {
    const { events: evs, tasks: ts } = dayItems(events, tasks, d);
    return `<div class="adcell" data-date="${D.ymd(d)}">${evs.filter(e => e.allDay).map(e => eventChip(e, d)).join('')}${ts.map(taskChip).join('')}</div>`;
  }).join('');
  const hours = Array.from({ length: 24 }, (_, h) => `<div class="hour"><span>${h ? D.fmtTime(new Date(2000, 0, 1, h), h24) : ''}</span></div>`).join('');
  const cols = days.map(d => {
    const blocks = layoutDay(dayItems(events, [], d).events, d).map(g => {
      const e = g.ev, height = (g.e - g.s) / 60 * HOUR - 2;
      return `<div class="block${e.end < now ? ' past' : ''}" data-uid="${esc(e.uid)}" draggable="${e.editable}"
        style="--c:${esc(e.color)};top:${g.s / 60 * HOUR}px;height:${height}px;left:calc(${g.col / g.n * 100}% + 1px);width:calc(${100 / g.n}% - 3px)">
        <b>${esc(e.title)}</b>${height > 30 ? `<span>${D.fmtTime(e.start, h24)}–${D.fmtTime(e.end, h24)}</span>` : ''}${height > 56 && e.location ? `<span>${esc(e.location)}</span>` : ''}
      </div>`;
    }).join('');
    const line = D.sameDay(d, now) ? `<div class="now" style="top:${D.minutesOfDay(now) / 60 * HOUR}px"></div>` : '';
    return `<div class="wcol${D.sameDay(d, now) ? ' today' : ''}" data-col="${D.ymd(d)}">${blocks}${line}</div>`;
  }).join('');
  return `<div class="week" style="--n:${days.length};--hour:${HOUR}px">
    <div class="whead"><div class="gutter"></div>${head}</div>
    <div class="wallday"><div class="gutter">ALL<br>DAY</div>${allDay}</div>
    <div class="wscroll"><div class="wbody"><div class="gutter hours">${hours}</div>${cols}</div></div>
  </div>`;
}

function listRows(events, tasks, from, days, emptyText, showToday = true) {
  const h24 = store.settings.h24;
  const today = new Date();
  let html = '';
  for (let i = 0; i < days; i++) {
    const day = D.addDays(from, i);
    const { events: evs, tasks: ts } = dayItems(events, tasks, day);
    if (!evs.length && !ts.length && !(showToday && D.sameDay(day, today))) continue;
    html += `<div class="aday${D.sameDay(day, today) ? ' today' : ''}"><button class="ahead" data-goto="${D.ymd(day)}">${D.sameDay(day, today) ? 'TODAY · ' : ''}${D.fmtDay(day)}</button>`;
    if (!evs.length && !ts.length) html += `<p class="none">no quests scheduled...</p>`;
    html += evs.map(e => `<div class="arow" data-uid="${esc(e.uid)}" style="--c:${esc(e.color)}">
        <span class="atime">${e.allDay ? 'ALL DAY' : D.sameDay(e.start, day) ? D.fmtTime(e.start, h24) : '…'}</span>
        <span class="adot"></span>
        <span class="atitle">${esc(e.title)}${e.location ? `<small>${esc(e.location)}</small>` : ''}</span>
        <span class="acal">${esc(e.calName)}</span></div>`).join('');
    html += ts.map(t => `<div class="arow task${t.completed ? ' done' : ''}" data-task="${esc(t.uid)}">
        <span class="atime">TASK</span><button class="tick" data-toggle="${esc(t.uid)}" aria-label="complete">${t.completed ? '&#9635;' : '&#9633;'}</button>
        <span class="atitle">${esc(t.title)}</span><span class="acal">${esc(store.taskList(t.listKey)?.title)}</span></div>`).join('');
    html += '</div>';
  }
  return html || `<p class="none pad">${emptyText}</p>`;
}

export function agendaView(cursor, days) {
  const { min, max } = rangeFor('agenda', cursor, false, days);
  const body = listRows(store.eventsBetween(min, max), store.tasksBetween(min, max), min, days, 'no quests scheduled...');
  return `<div class="agenda">${body}<button class="btn wide" id="moreDays">LOAD 30 MORE DAYS</button></div>`;
}

export function searchView(q, results) {
  if (results === null) return `<div class="agenda"><p class="none pad">searching for "${esc(q)}"...</p></div>`;
  const tasks = store.visibleTasks().filter(t => `${t.title} ${t.notes}`.toLowerCase().includes(q.toLowerCase()));
  const all = [...results, ...tasks.filter(t => t.due)];
  const first = all.length ? D.startOfDay(new Date(Math.min(...all.map(x => +(x.start || x.due))))) : new Date();
  const last = all.length ? Math.max(...all.map(x => +(x.end || x.due))) : +first;
  const days = Math.min(800, D.daysBetween(first, new Date(last)) + 1);
  const undated = tasks.filter(t => !t.due);
  return `<div class="agenda"><h3 class="shead">${results.length + tasks.length} RESULTS FOR "${esc(q)}"</h3>
    ${results.length || tasks.some(t => t.due) ? listRows(results, tasks.filter(t => t.due), first, days, '', false) : ''}
    ${undated.length ? `<div class="aday"><div class="ahead">NO DATE</div>${undated.map(t => `<div class="arow task" data-task="${esc(t.uid)}"><span class="atime">TASK</span><span class="atitle">${esc(t.title)}</span></div>`).join('')}</div>` : ''}
    ${!results.length && !tasks.length ? '<p class="none pad">nothing found...</p>' : ''}</div>`;
}
