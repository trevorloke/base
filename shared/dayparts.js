// Days, weeks and clock times on the campaign's clock (workspace
// settings.tz, Vancouver by default — the same zone shift emails are
// written in) — defined once, used by the screens and the server.
//
// Three parts of the day, as the first week board had them as slots:
//   before noon → Morning, noon to 5pm → Afternoon, 5pm on → Evening.
// `start`/`end` are the hours a shift made from such a slot got. The week
// screen's day lists have four (WEEK_PARTS, further down): an early start
// is Early there.
export const DAY_PARTS = [
  { code: 'morning', label: 'Morning', start: 9, end: 12 },
  { code: 'afternoon', label: 'Afternoon', start: 12, end: 17 },
  { code: 'evening', label: 'Evening', start: 17, end: 21 },
];
export const DAY_PART_CODES = DAY_PARTS.map((p) => p.code);
export const CAMPAIGN_TZ = 'America/Vancouver';

const pad = (n) => String(n).padStart(2, '0');

// A zone the runtime knows, else Vancouver.
export const safeZone = (tz) => {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz || CAMPAIGN_TZ });
    return tz || CAMPAIGN_TZ;
  } catch {
    return CAMPAIGN_TZ;
  }
};

// B.C. stays on UTC-7 all year from March 8, 2026 (no fall-back on Nov 1,
// 2026). A phone, a browser or a server whose own copy of the time-zone
// rules is older still falls back, and would put every time after that an
// hour off — half of a 6:30–8:30 shift. So for Vancouver the rule is
// applied here, the way server/lib/tzsql.js applies it in SQL: UTC-7 from
// that moment on, and the runtime's own rules before it (where every copy
// agrees).
const BC_SINCE = Date.UTC(2026, 2, 8, 10); // 3 a.m. PDT, the last spring-forward
const BC_SINCE_WALL = Date.UTC(2026, 2, 8, 3); // the same moment, as the wall clock read
const BC_OFFSET_MS = -7 * 3600e3;
const bcByRule = (zone, ms) => zone === CAMPAIGN_TZ && ms >= BC_SINCE;

// The wall clock in `tz` at an instant: { day: 'YYYY-MM-DD', hour, minute }.
export const wallClock = (when, tz = CAMPAIGN_TZ) => {
  const d = when instanceof Date ? when : new Date(when);
  const zone = safeZone(tz);
  if (bcByRule(zone, d.getTime())) {
    const w = new Date(d.getTime() + BC_OFFSET_MS);
    return { day: w.toISOString().slice(0, 10), hour: w.getUTCHours(), minute: w.getUTCMinutes() };
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
};

export const dayOf = (when, tz) => wallClock(when, tz).day;

// 'morning' | 'afternoon' | 'evening' for a start time.
export const partOf = (when, tz) => {
  const { hour } = wallClock(when, tz);
  if (hour < DAY_PARTS[1].start) return 'morning';
  if (hour < DAY_PARTS[2].start) return 'afternoon';
  return 'evening';
};

// Calendar arithmetic on 'YYYY-MM-DD' (no time zone involved).
export const addDays = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
// A real calendar day ('YYYY-MM-DD'; never Feb 30) and a clock time
// ('HH:MM', 00:00–23:59), as the scheduling actions take them.
export const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) && addDays(String(v), 0) === String(v);
export const isClock = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v ?? ''));
// 0 = Monday … 6 = Sunday
export const weekdayIndex = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
};
// The Monday of the week holding `day`.
export const weekStart = (day) => addDays(day, -weekdayIndex(day));

// '2026-10-27' 17:00 in `tz` → '2026-10-27T17:00:00-07:00' (the offset that
// zone has on that day, so DST is right on either side of the change).
export const zonedISO = (day, hour, tz = CAMPAIGN_TZ, minute = 0) => {
  const [y, m, d] = day.split('-').map(Number);
  const want = Date.UTC(y, m - 1, d, hour, minute);
  // B.C. by the rule above: UTC-7, whatever the runtime's rules say.
  if (safeZone(tz) === CAMPAIGN_TZ && want >= BC_SINCE_WALL) return `${day}T${pad(hour)}:${pad(minute)}:00-07:00`;
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const w = wallClock(new Date(guess), tz);
    const [wy, wm, wd] = w.day.split('-').map(Number);
    const seen = Date.UTC(wy, wm - 1, wd, w.hour, w.minute);
    if (seen === want) break;
    guess += want - seen;
  }
  const off = Math.round((want - guess) / 60000); // minutes east of UTC
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return `${day}T${pad(hour)}:${pad(minute)}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
};

// The times a new shift in that slot gets.
export const partRange = (day, code, tz) => {
  const p = DAY_PARTS.find((x) => x.code === code) || DAY_PARTS[0];
  return { starts_at: zonedISO(day, p.start, tz), ends_at: zonedISO(day, p.end, tz) };
};

// The instants a week (Monday 00:00 → next Monday 00:00) covers in `tz`.
export const weekBounds = (monday, tz) => ({
  from: zonedISO(monday, 0, tz),
  to: zonedISO(addDays(monday, 7), 0, tz),
});

// ── One clock for shifts: the campaign's, never the device's ──
// A shift's times are read and typed with these on every screen and in
// every notice, so a laptop set to Toronto time, a phone abroad and the
// server all say the same hour.

// A clock time on a day in `tz` ('2026-11-16', '06:30') → that moment.
export const instantOf = (day, clock, tz) => {
  const [h, m] = String(clock).split(':').map(Number);
  return zonedISO(day, h, tz, m);
};
// The clock a moment shows in `tz`: '06:30' (24-hour) and "6:30am".
export const clockOf = (when, tz) => {
  const w = wallClock(when, tz);
  return `${pad(w.hour)}:${pad(w.minute)}`;
};
export const clockWords = (when, tz) => {
  const { hour, minute } = wallClock(when, tz);
  return `${hour % 12 || 12}${minute ? `:${pad(minute)}` : ''}${hour < 12 ? 'am' : 'pm'}`;
};
// What a date-and-time box (datetime-local) shows for a moment, and the
// moment its value means: '2026-11-16T06:30' ↔ 6:30 am that day in `tz`.
export const toInput = (when, tz) => {
  if (!when) return '';
  const w = wallClock(when, tz);
  return `${w.day}T${pad(w.hour)}:${pad(w.minute)}`;
};
export const fromInput = (value, tz) => {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
  return m ? zonedISO(m[1], Number(m[2]), tz, Number(m[3])) : null;
};
// What Intl is handed to write a moment on the clock of `tz`: [moment,
// zone]. Under the B.C. rule the moment is first put on the campaign's wall
// clock and written as UTC, so old rules can't shift it.
export const onClock = (when, tz) => {
  const d = when instanceof Date ? when : new Date(when);
  const zone = safeZone(tz);
  return bcByRule(zone, d.getTime()) ? [new Date(d.getTime() + BC_OFFSET_MS), 'UTC'] : [d, zone];
};
// A moment in words (Intl's, en-CA: "Monday, November 16 at 6:30 a.m.") on
// the clock of `tz`. opts are Intl.DateTimeFormat's, without timeZone or
// timeZoneName.
export const fmtIn = (when, tz, opts, locale = 'en-CA') => {
  const [d, zone] = onClock(when, tz);
  return new Intl.DateTimeFormat(locale, { ...opts, timeZone: zone }).format(d);
};

// ── The week screen's day lists ──
// Each day is a list in start order with a quiet divider where a part of
// the day begins. Early is everything before 9 (a 6:30 Burma Shave, a 7:00
// Mainstreet); `from` is the hour a part begins.
export const WEEK_PARTS = [
  { code: 'early', label: 'Early', from: 0 },
  { code: 'morning', label: 'Morning', from: 9 },
  { code: 'afternoon', label: 'Afternoon', from: 12 },
  { code: 'evening', label: 'Evening', from: 17 },
];
// The part a start falls in: a moment (on the clock of `tz`) or a clock
// time ('HH:MM').
export const weekPartOf = (when, tz) => {
  const hour = isClock(when) ? Number(String(when).slice(0, 2)) : wallClock(when, tz).hour;
  return WEEK_PARTS.reduce((code, p) => (hour >= p.from ? p.code : code), WEEK_PARTS[0].code);
};

// A clock time some minutes on ('06:30' + 120 → '08:30'), or null once that
// is past the end of the day — a shift made by tap ends the day it starts.
export const addClock = (clock, minutes) => {
  const [h, m] = String(clock).split(':').map(Number);
  const t = h * 60 + m + minutes;
  return t < 24 * 60 ? `${pad(Math.floor(t / 60))}:${pad(t % 60)}` : null;
};

// A start and an end ('HH:MM') said the short way: "6:30–8:30 am",
// "10 am–1 pm", "6 pm" with no end.
const clockBits = (clock) => {
  const [h, m] = String(clock).split(':').map(Number);
  return { words: `${h % 12 || 12}${m ? `:${pad(m)}` : ''}`, half: h < 12 ? 'am' : 'pm' };
};
export const spanWords = (start, end) => {
  const a = clockBits(start);
  if (!end) return `${a.words} ${a.half}`;
  const b = clockBits(end);
  return a.half === b.half ? `${a.words}–${b.words} ${b.half}` : `${a.words} ${a.half}–${b.words} ${b.half}`;
};
