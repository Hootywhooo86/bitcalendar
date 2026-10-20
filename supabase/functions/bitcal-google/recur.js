// Repeat rules (RFC 5545 RRULE subset that Google and Bitcalendar write), expanded in the event's own
// time zone so 9am stays 9am across daylight saving. No imports: the reminder Edge Function uses this
// same file (supabase/functions/bitcal-reminders/recur.js is a copy; keep them in step).
//
// Supports FREQ DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY (with ordinals like 2TU, -1FR),
// BYMONTHDAY, BYMONTH, BYSETPOS (single), WKST.

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const fmts = new Map();
const pad = n => String(n).padStart(2, '0');

// Wall clock of an instant in a time zone.
export function wall(date, tz) {
  if (tz === 'UTC') {
    return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), h: date.getUTCHours(), mi: date.getUTCMinutes(), s: date.getUTCSeconds() };
  }
  let f = fmts.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    fmts.set(tz, f);
  }
  const p = {};
  for (const x of f.formatToParts(date)) p[x.type] = +x.value;
  return { y: p.year, m: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

const offset = (t, tz) => { const w = wall(new Date(t), tz); return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - t; };

// The instant a wall clock time happens in a time zone.
export function fromWall(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  if (tz === 'UTC') return new Date(guess);
  const o1 = offset(guess, tz);
  let t = guess - o1;
  const o2 = offset(t, tz);
  // Offsets differ near a DST change. Keep the second guess unless that wall time doesn't exist
  // (the spring-forward gap), where it moves forward an hour like Google does.
  if (o2 !== o1 && wall(new Date(guess - o2), tz).h === h) t = guess - o2;
  return new Date(t);
}

export const safeTz = tz => { try { if (tz) { wall(new Date(), tz); return tz; } } catch {} return 'UTC'; };

export function parseRule(rule) {
  const r = {};
  for (const part of String(rule).replace(/^RRULE:/i, '').split(';')) {
    const [k, v] = part.split('=');
    if (k && v != null) r[k.toUpperCase()] = v.toUpperCase();
  }
  const list = k => r[k] ? r[k].split(',') : [];
  return {
    freq: r.FREQ, interval: Math.max(1, +r.INTERVAL || 1), count: r.COUNT ? +r.COUNT : null, until: r.UNTIL || null,
    byday: list('BYDAY').map(s => { const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s); return m && { n: m[1] ? +m[1] : 0, dow: DAYS.indexOf(m[2]) }; }).filter(Boolean),
    bymonthday: list('BYMONTHDAY').map(Number), bymonth: list('BYMONTH').map(Number),
    setpos: r.BYSETPOS ? +r.BYSETPOS.split(',')[0] : null, wkst: r.WKST ? DAYS.indexOf(r.WKST) : 1,
  };
}

// Days are counted as UTC "day numbers" so arithmetic never trips over DST.
const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);
const fromDayNum = n => { const t = new Date(n * 86400000); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
const dowOf = n => (n + 4) % 7; // 1970-01-01 was a Thursday
const monthLen = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

// Candidate days (day numbers) of one month for MONTHLY/YEARLY rules.
function monthDays(y, m, r, startDay) {
  const len = monthLen(y, m), first = dayNum(y, m, 1);
  let out = [];
  if (r.bymonthday.length) {
    for (const md of r.bymonthday) { const d = md > 0 ? md : len + md + 1; if (d >= 1 && d <= len) out.push(first + d - 1); }
  } else if (r.byday.length) {
    for (const { n, dow } of r.byday) {
      const all = [];
      for (let d = 0; d < len; d++) if (dowOf(first + d) === dow) all.push(first + d);
      if (!n) out.push(...all);
      else { const pick = n > 0 ? all[n - 1] : all[all.length + n]; if (pick != null) out.push(pick); }
    }
  } else if (startDay <= len) out.push(first + startDay - 1);
  out = [...new Set(out)].sort((a, b) => a - b);
  if (r.setpos) { const p = r.setpos > 0 ? out[r.setpos - 1] : out[out.length + r.setpos]; out = p != null ? [p] : []; }
  return out;
}

// ev: {start: Date, end: Date, allDay, tz, rrule, exdates: ['YYYY-MM-DD']}
// Returns [{start, end}] overlapping [min, max). All-day results are local-midnight Dates, like the rest of the app.
export function expand(ev, min, max, limit = 2000) {
  const allDay = !!ev.allDay;
  const tz = allDay ? 'UTC' : safeTz(ev.tz);
  const s0 = wall(ev.start, tz);
  const spanMs = ev.end - ev.start;
  const spanDays = Math.max(1, Math.round(spanMs / 86400000));
  const toOcc = n => {
    const { y, m, d } = fromDayNum(n);
    if (allDay) { const s = new Date(y, m - 1, d); const e = new Date(y, m - 1, d + spanDays); return { start: s, end: e }; }
    const s = fromWall(y, m, d, s0.h, s0.mi, tz);
    return { start: s, end: new Date(+s + spanMs) };
  };
  const ymdOf = n => { const { y, m, d } = fromDayNum(n); return `${y}-${pad(m)}-${pad(d)}`; };
  const startN = dayNum(s0.y, s0.m, s0.d);
  if (!ev.rrule) { const o = toOcc(startN); return o.start < max && o.end > min ? [o] : []; }

  const r = parseRule(ev.rrule);
  const ex = new Set(ev.exdates || []);
  let untilT = Infinity;
  if (r.until) {
    const u = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(r.until);
    if (u) untilT = u[4] == null
      ? (allDay ? dayNum(+u[1], +u[2], +u[3]) : +fromWall(+u[1], +u[2], +u[3], 23, 59, tz))
      : u[7] ? Date.UTC(+u[1], u[2] - 1, +u[3], +u[4], +u[5], +u[6]) : +fromWall(+u[1], +u[2], +u[3], +u[4], +u[5], tz);
  }
  const afterUntil = n => allDay && r.until && r.until.length === 8 ? n > untilT : +toOcc(n).start > untilT;
  const minN = Math.floor(+min / 86400000) - spanDays - 2;
  const maxN = Math.ceil(+max / 86400000) + 2;
  const out = [];
  let seen = 0;
  const take = n => {
    if (n < startN) return true;
    if (afterUntil(n)) return false;
    seen++;
    if (r.count && seen > r.count) return false;
    if (!ex.has(ymdOf(n))) {
      const o = toOcc(n);
      if (o.start < max && o.end > min) out.push(o);
    }
    return out.length < limit;
  };

  // Periods before the range can be skipped when nothing is counted.
  const skip = !r.count;
  if (r.freq === 'DAILY') {
    let k = skip ? Math.max(0, Math.floor((minN - startN) / r.interval)) : 0;
    for (let i = 0; i < 200000; i++, k++) {
      const n = startN + k * r.interval;
      if (n > maxN) break;
      const { m, d } = fromDayNum(n);
      if (r.bymonth.length && !r.bymonth.includes(m)) continue;
      if (r.bymonthday.length && !r.bymonthday.includes(d)) continue;
      if (r.byday.length && !r.byday.some(b => b.dow === dowOf(n))) continue;
      if (!take(n)) break;
    }
  } else if (r.freq === 'WEEKLY') {
    const days = r.byday.length ? r.byday.map(b => b.dow) : [dowOf(startN)];
    const week0 = startN - ((dowOf(startN) - r.wkst + 7) % 7);
    let k = skip ? Math.max(0, Math.floor((minN - week0) / 7 / r.interval)) : 0;
    outer: for (let i = 0; i < 50000; i++, k++) {
      const ws = week0 + k * 7 * r.interval;
      if (ws > maxN) break;
      const cands = days.map(dw => ws + ((dw - r.wkst + 7) % 7)).sort((a, b) => a - b);
      for (const n of cands) if (!take(n)) break outer;
    }
  } else if (r.freq === 'MONTHLY' || r.freq === 'YEARLY') {
    const yearly = r.freq === 'YEARLY';
    let k = 0;
    if (skip) {
      const { y, m } = fromDayNum(Math.max(minN, startN));
      const months = (y - s0.y) * 12 + (m - s0.m);
      k = Math.max(0, Math.floor(months / (yearly ? 12 : 1) / r.interval) - 1);
    }
    outer: for (let i = 0; i < 20000; i++, k++) {
      const months = yearly ? [] : [k * r.interval];
      if (yearly) for (const bm of (r.bymonth.length ? r.bymonth : [s0.m])) months.push(k * r.interval * 12 + bm - s0.m);
      let any = false;
      for (const off of months) {
        const t = s0.m - 1 + off, y = s0.y + Math.floor(t / 12), m = (t % 12 + 12) % 12 + 1;
        if (dayNum(y, m, 1) > maxN) break outer;
        any = true;
        if (!yearly && r.bymonth.length && !r.bymonth.includes(m)) continue;
        for (const n of monthDays(y, m, r, s0.d)) if (!take(n)) break outer;
      }
      if (!any) break;
    }
  } else {
    const o = toOcc(startN);
    if (o.start < max && o.end > min) out.push(o);
  }
  return out;
}

// Start of the last occurrence, or null when the rule never ends.
export function lastStart(ev) {
  if (!ev.rrule) return ev.start;
  const r = parseRule(ev.rrule);
  if (!r.count && !r.until) return null;
  const all = expand({ ...ev, exdates: [] }, ev.start, new Date(Date.UTC(2200, 0, 1)), r.count || 100000);
  return all.length ? all[all.length - 1].start : ev.start;
}
