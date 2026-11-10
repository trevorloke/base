// Words the week screen and its sheets share. Every time here is read on
// the campaign's clock (shared/dayparts.js), never the device's.
import { clockOf, dayOf, spanWords, weekdayIndex } from '@starbase/shared/dayparts';

// '2026-11-16' → { wd: 'Mon', md: 'Nov 16', num: '16', long: 'Monday, November 16' }
// (a calendar day: no time zone in it).
export const dayWords = (day) => {
  const d = new Date(`${day}T12:00:00Z`);
  const f = (o) => d.toLocaleDateString('en-CA', { timeZone: 'UTC', ...o });
  return { wd: f({ weekday: 'short' }), md: f({ month: 'short', day: 'numeric' }), num: f({ day: 'numeric' }), long: f({ weekday: 'long', month: 'long', day: 'numeric' }) };
};

// "Mon–Fri", "Tue, Thu", or one day with its date: "Tue, Nov 17".
export const daysWords = (days) => {
  const list = [...days].sort();
  if (list.length === 1) return `${dayWords(list[0]).wd}, ${dayWords(list[0]).md}`;
  const idx = list.map(weekdayIndex);
  const run = list.length > 2 && idx.every((n, i) => i === 0 || n === idx[i - 1] + 1);
  return run ? `${dayWords(list[0]).wd}–${dayWords(list[list.length - 1]).wd}` : list.map((d) => dayWords(d).wd).join(', ');
};

// A shift's hours: "6:30–8:30 am"; just its start when it has no end.
export const shiftSpan = (s, tz) => spanWords(clockOf(s.starts_at, tz), s.ends_at ? clockOf(s.ends_at, tz) : null);
// Its start and end as clock times on its day ('HH:MM'); end null when it
// has none, or runs past midnight (then its length is left alone).
export const shiftClock = (s, tz) => ({
  start: clockOf(s.starts_at, tz),
  end: s.ends_at && dayOf(s.ends_at, tz) === dayOf(s.starts_at, tz) ? clockOf(s.ends_at, tz) : null,
});

export const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString('en-CA')} ${n === 1 ? one : many}`;
export const peopleWords = (n) => plural(n, 'person', 'people');

// How many are on a shift, the short way a card says it: "3 of 4" against
// its target (or, on an older shift, its limit), "3 on" with neither.
export const countWords = (s) => {
  const filled = Number(s.filled) || 0;
  const want = s.need ?? s.capacity;
  return want ? `${filled} of ${want}` : `${filled} on`;
};
