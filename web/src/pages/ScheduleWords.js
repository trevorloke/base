// Words the week screen and its sheets share. Every time here is read on
// the campaign's clock (shared/dayparts.js), never the device's.
import { addDays, clockOf, dayOf, spanWords, weekdayIndex } from '@starbase/shared/dayparts';

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

// A shift's hours: "6:30–8:30 am"; just its start when it has no end; and
// when it ends on a later day, which: "8 pm–1 am next day".
export const shiftSpan = (s, tz) => {
  const later = endsLater(s, tz);
  return later ? `${clockSpan(s, tz)}${later === 'next day' ? ' ' : ', '}${later}` : clockSpan(s, tz);
};
export const clockSpan = (s, tz) => spanWords(clockOf(s.starts_at, tz), s.ends_at ? clockOf(s.ends_at, tz) : null);
// "next day", "ends Tue, Nov 19", or null on its own day. A shift that
// ends at midnight is that evening's (its last minute is on its day).
export const endsLater = (s, tz) => {
  if (!s.ends_at) return null;
  const from = dayOf(s.starts_at, tz);
  const to = dayOf(new Date(Date.parse(s.ends_at) - 60e3).toISOString(), tz);
  if (to <= from) return null;
  return to === addDays(from, 1) ? 'next day' : `ends ${dayWords(to).wd}, ${dayWords(to).md}`;
};
// Its start and end as clock times on its day ('HH:MM'); end null when it
// has none, or runs past midnight (then its length is left alone).
export const shiftClock = (s, tz) => ({
  start: clockOf(s.starts_at, tz),
  end: s.ends_at && dayOf(s.ends_at, tz) === dayOf(s.starts_at, tz) ? clockOf(s.ends_at, tz) : null,
});

export const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString('en-CA')} ${n === 1 ? one : many}`;
export const peopleWords = (n) => plural(n, 'person', 'people');

// Who is on a shift, the short way a card says it. Nothing asks how many
// people a shift takes, so with no number set it is just "2 on" — and
// nothing at all while nobody is. "3 of 4" only against a target someone
// set (or, on an older shift, its limit).
export const countWords = (s) => {
  const filled = Number(s.filled) || 0;
  const want = s.need ?? s.capacity;
  if (want) return `${filled} of ${want}`;
  return filled ? `${filled} on` : '';
};
// The same with room for words: "3 of 4 — one more" against a target.
export const countLong = (s) => {
  const filled = Number(s.filled) || 0;
  const more = s.need ? Math.max(0, s.need - filled) : 0;
  return more ? `${filled} of ${s.need} — ${more === 1 ? 'one' : more} more` : countWords(s);
};
