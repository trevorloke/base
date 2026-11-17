// The campaign's clock in JavaScript, by B.C.'s current rule whatever this
// runtime's own copy of the time-zone rules says (the same rule as
// lib/tzsql.js, which takes its two moments from here). B.C. stays on UTC-7
// all year from March 8, 2026; an older tzdata (Node's or a browser's)
// still falls back on Nov 1, 2026 and is an hour off after it. So for
// America/Vancouver from that moment on the offset is −7 h, and before it
// (and for any other zone) Intl's, where every copy of the rules agrees.
//
//   offsetAt(ms, tz)            the zone's offset from UTC at that moment, in ms
//   atLocal('YYYY-MM-DD', 'HH:MM', tz) → the moment (epoch ms) of that wall time
//   localDay(ms, tz) → 'YYYY-MM-DD'   localHm(ms, tz) → 'HH:MM'
//
// The voter guide (ext/voteguide) turns its days and hours into moments
// here, on the server only; the browser just compares them with the
// server's clock (shared/voteguide.js).
export const BC = 'America/Vancouver';
export const SINCE_UTC = '2026-03-08T10:00:00Z'; // 3 a.m. PDT, the last spring-forward
export const SINCE_LOCAL = '2026-03-08 03:00:00';
const SINCE_MS = Date.parse(SINCE_UTC);
const SINCE_WALL_MS = Date.UTC(2026, 2, 8, 3, 0, 0); // the same wall time, read as if UTC
const UTC7 = -7 * 3600 * 1000;

const fmts = new Map();
const fmt = (tz) => {
  if (!fmts.has(tz)) {
    fmts.set(tz, new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return fmts.get(tz);
};
// Intl's offset: its wall time for the moment, read as if UTC, less the moment.
const intlOffset = (ms, tz) => {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return wall - Math.floor(ms / 1000) * 1000;
};

export const offsetAt = (ms, tz = BC) => (tz === BC && ms >= SINCE_MS ? UTC7 : intlOffset(ms, tz));

const wallMs = (day, hm = '00:00') => {
  const [y, mo, d] = String(day).split('-').map(Number);
  const [h, mi] = String(hm).split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi);
};

export const atLocal = (day, hm = '00:00', tz = BC) => {
  const wall = wallMs(day, hm);
  if (tz === BC && wall >= SINCE_WALL_MS) return wall - UTC7;
  // A guess, then corrected twice (an offset that changes between the
  // guess and the answer settles on the second).
  let t = wall - intlOffset(wall, tz);
  t = wall - offsetAt(t, tz);
  return wall - offsetAt(t, tz);
};

const shifted = (ms, tz) => new Date(ms + offsetAt(ms, tz)).toISOString();
export const localDay = (ms, tz = BC) => shifted(ms, tz).slice(0, 10);
export const localHm = (ms, tz = BC) => shifted(ms, tz).slice(11, 16);
// The day after a 'YYYY-MM-DD' (no zone involved).
export const nextDay = (day) => new Date(wallMs(day) + 86_400_000).toISOString().slice(0, 10);
