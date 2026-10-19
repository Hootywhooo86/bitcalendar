// Date helpers. Everything works in the browser's local time zone.
export const MONTHS = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
export const MON3 = MONTHS.map(m => m.slice(0, 3));
export const DOW1 = ['S','M','T','W','T','F','S'];
export const DOW3 = ['SUN','MON','TUE','WED','THU','FRI','SAT'];

export const pad = n => String(n).padStart(2, '0');
// Local YYYY-MM-DD (the landing mock used toISOString, which is UTC and shifts days at night).
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = s => { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); };
export const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const monthKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

export const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const startOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const addMinutes = (d, n) => new Date(d.getTime() + n * 60000);
export const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
export const sameDay = (a, b) => ymd(a) === ymd(b);
export const startOfWeek = (d, weekStart = 0) => addDays(startOfDay(d), -((d.getDay() - weekStart + 7) % 7));
export const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
export const minutesOfDay = d => d.getHours() * 60 + d.getMinutes();
export const withTime = (day, minutes) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(minutes / 60), minutes % 60);

// Months (as first-of-month dates) that the range [min, max) touches.
export function monthsIn(min, max) {
  const out = [];
  for (let m = startOfMonth(min); m < max; m = addMonths(m, 1)) out.push(m);
  return out;
}

export function fmtTime(d, h24) {
  if (h24) return hm(d);
  const h = d.getHours(), m = d.getMinutes();
  return `${h % 12 || 12}${m ? ':' + pad(m) : ''}${h < 12 ? 'A' : 'P'}`;
}

export const fmtDay = d => `${DOW3[d.getDay()]} ${MON3[d.getMonth()]} ${d.getDate()}`;

// "IN 2H 05M", "IN 3D", "NOW"
export function countdown(ms) {
  if (ms <= 0) return 'NOW';
  const min = Math.ceil(ms / 60000);
  if (min < 60) return `IN ${min}M`;
  const h = Math.floor(min / 60);
  if (h < 24) return `IN ${h}H ${pad(min % 60)}M`;
  return `IN ${Math.floor(h / 24)}D`;
}

export function fmtRange(ev, h24) {
  if (ev.allDay) {
    const last = addDays(ev.end, -1);
    return sameDay(ev.start, last) ? `${fmtDay(ev.start)} · ALL DAY` : `${fmtDay(ev.start)} – ${fmtDay(last)}`;
  }
  if (sameDay(ev.start, ev.end) || +ev.end === +addDays(startOfDay(ev.start), 1))
    return `${fmtDay(ev.start)} · ${fmtTime(ev.start, h24)}–${fmtTime(ev.end, h24)}`;
  return `${fmtDay(ev.start)} ${fmtTime(ev.start, h24)} – ${fmtDay(ev.end)} ${fmtTime(ev.end, h24)}`;
}
