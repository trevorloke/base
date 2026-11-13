// How much of Google's map services the campaign used today, and the daily
// ceilings that keep it inside Google's free monthly use.
//
//   count(kind, n = 1, user?)  kinds: tiles, autocomplete, details, probe
//   today()          → { day, tiles, autocomplete, details, probe,
//                        ceilings: { places, tiles, perPerson }, tilesFullAt }
//   placesLeft()     false once today's autocomplete or details reached
//                    GOOGLE_PLACES_DAILY_MAX (default 300)
//   personLeft(user) false once that person made GOOGLE_PLACES_PER_PERSON
//                    Places asks today (default 50)
//   tilesLeft()      false once today's tiles reached GOOGLE_TILES_DAILY_MAX
//                    (default none: no ceiling)
//   secondsToMidnight()  until the campaign's next day starts
//
// A day is the campaign's day: midnight in its own time zone (org.js
// timeZone(), Pacific time for Surrey). Whether Google's own daily quotas
// reset at the same hour is not known; this ceiling works on its own day.
//
// Kept in the database (google_usage, ext/addresses/sql.js), so a deploy or
// a restart doesn't start the count again and two servers share it: counts
// gather in memory and are added to today's row every 60 s and on shutdown;
// today's rows are read back at start and every 60 s. At most a minute's
// count can be lost in a crash. The table holds a date, a kind and a number
// only: never a person (the per-person share stays in memory, on purpose).
// Writing to it is not an action and not on the event log.
import { getDb } from '../db/client.js';
import { timeZone } from './org.js';

const KINDS = ['tiles', 'autocomplete', 'details', 'probe'];
const SYNC_MS = 60_000;
const KEEP_DAYS = 40;

let now = () => Date.now();
// Tests: a fake clock.
export const _setNowForTest = (fn) => { now = fn || (() => Date.now()); };

// 'YYYY-MM-DD' in the campaign's time zone.
export const dayOf = (ms = now(), tz = timeZone()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(ms));

// The zone's offset from UTC at an instant, in ms (local − UTC).
const offsetAt = (ms, tz) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
};

// The instant the campaign's next day starts (its next local midnight).
export const nextMidnight = (ms = now(), tz = timeZone()) => {
  const [y, m, d] = dayOf(ms, tz).split('-').map(Number);
  const local = Date.UTC(y, m - 1, d + 1); // tomorrow 00:00, as if UTC
  // Twice: the offset at midnight may differ from now's (a clock change).
  let at = local - offsetAt(local, tz);
  at = local - offsetAt(at, tz);
  return at;
};
export const secondsToMidnight = (ms = now()) => Math.max(1, Math.ceil((nextMidnight(ms) - ms) / 1000));

// ── The ceilings (read on every ask: a restart is all a change needs) ──
const warned = new Set();
const ceiling = (name, fallback) => {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return { value: fallback, bad: null };
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 10_000_000) return { value: n, bad: null };
  const bad = `${name} isn’t a number — ${fallback == null ? 'no limit' : `using ${fallback.toLocaleString('en-CA')}`}`;
  if (!warned.has(name)) { warned.add(name); console.warn(`google usage: ${bad}`); }
  return { value: fallback, bad };
};
export const ceilings = () => {
  const places = ceiling('GOOGLE_PLACES_DAILY_MAX', 300);
  const perPerson = ceiling('GOOGLE_PLACES_PER_PERSON', 50);
  const tiles = ceiling('GOOGLE_TILES_DAILY_MAX', null);
  return {
    places: places.value, perPerson: perPerson.value, tiles: tiles.value,
    problems: [places.bad, perPerson.bad, tiles.bad].filter(Boolean),
  };
};

// ── Counts ──
let day = null;
let stored = {};   // kind → today's count in the table, as last read
let pending = {};  // kind → counted here, not yet added to the table
let people = new Map(); // user id → Places asks today (memory only)
let tilesFullAt = null; // when today's tile ceiling was reached (ms)
let timer = null;
let started = null;

const roll = () => {
  const d = dayOf();
  if (d === day) return;
  // A new day: yesterday's unsaved counts still go to yesterday's row.
  if (day && Object.values(pending).some((n) => n > 0)) {
    const old = { day, pending };
    flushRows(old.day, old.pending).catch(() => {});
  }
  day = d;
  stored = {};
  pending = {};
  people = new Map();
  tilesFullAt = null;
};
const n = (kind) => (stored[kind] || 0) + (pending[kind] || 0);

export const count = (kind, by = 1, user = null) => {
  if (!KINDS.includes(kind)) return;
  roll();
  ensureStarted();
  pending[kind] = (pending[kind] || 0) + by;
  if (user && (kind === 'autocomplete' || kind === 'details')) people.set(user, (people.get(user) || 0) + by);
  if (kind === 'tiles' && !tilesFullAt && !tilesLeft()) tilesFullAt = now();
};

export const placesLeft = () => {
  roll();
  const max = ceilings().places;
  return n('autocomplete') < max && n('details') < max;
};
export const personLeft = (user) => {
  roll();
  return !user || (people.get(user) || 0) < ceilings().perPerson;
};
export const tilesLeft = () => {
  roll();
  const max = ceilings().tiles;
  return max == null || n('tiles') < max;
};

export const today = () => {
  roll();
  ensureStarted();
  const c = ceilings();
  return {
    day,
    ...Object.fromEntries(KINDS.map((k) => [k, n(k)])),
    ceilings: { places: c.places, tiles: c.tiles, perPerson: c.perPerson },
    problems: c.problems,
    tilesFullAt: tilesFullAt ? new Date(tilesFullAt).toISOString() : null,
  };
};

// ── The table ──
const flushRows = async (d, counts) => {
  const rows = Object.entries(counts).filter(([, v]) => v > 0);
  if (!rows.length) return;
  const db = await getDb();
  for (const [kind, v] of rows) {
    await db.query(
      `insert into google_usage (day, kind, n) values ($1, $2, $3)
       on conflict (day, kind) do update set n = google_usage.n + excluded.n`,
      [d, kind, v],
    );
  }
};

// Add what was counted here to today's rows, then read today's rows back
// (other servers' counts included).
export const sync = async () => {
  roll();
  const d = day;
  const sent = { ...pending };
  await flushRows(d, sent);
  // Only what was sent comes off: counts made meanwhile wait for the next.
  if (day === d) for (const [k, v] of Object.entries(sent)) pending[k] = (pending[k] || 0) - v;
  const db = await getDb();
  const { rows } = await db.query('select kind, n from google_usage where day = $1', [d]);
  if (day === d) {
    stored = Object.fromEntries(rows.map((r) => [r.kind, Number(r.n)]));
    if (!tilesFullAt && !tilesLeft()) tilesFullAt = now();
  }
};

// At start: rows older than 40 days go, today's are read, and the minute's
// sync begins. Started by the first count or read (and by the server).
export const start = () => {
  if (started) return started;
  started = (async () => {
    const db = await getDb();
    await db.query(`delete from google_usage where day < ($1::date - ${KEEP_DAYS})`, [dayOf()]);
    await sync();
  })().catch((e) => { console.warn(`google usage: couldn’t read today’s counts (${String(e.message).slice(0, 120)})`); });
  if (!timer) {
    timer = setInterval(() => { sync().catch(() => {}); }, SYNC_MS);
    timer.unref?.();
  }
  return started;
};
const ensureStarted = () => { if (!started) start(); };

// On shutdown: what was counted since the last minute.
export const flush = async () => {
  roll();
  const sent = { ...pending };
  pending = {};
  await flushRows(day, sent);
};

// Tests: a restart (memory gone, the table kept).
export const _resetForTest = () => {
  if (timer) clearInterval(timer);
  timer = null;
  started = null;
  day = null;
  stored = {};
  pending = {};
  people = new Map();
  tilesFullAt = null;
  warned.clear();
};
