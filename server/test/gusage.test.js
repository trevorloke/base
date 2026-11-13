// Today's Google counts and the daily ceilings (lib/gusage.js): the
// campaign's own day, kept in google_usage so a restart or a second server
// doesn't start them again; no person in the table.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import {
  count, today, sync, start, flush, dayOf, secondsToMidnight, placesLeft, personLeft, ceilings,
  _setNowForTest, _resetForTest,
} from '../lib/gusage.js';
import { placesFor, _setPlacesLogoForTest } from '../lib/places.js';

const env = { ...process.env };
const KEYS = ['GOOGLE_PLACES_DAILY_MAX', 'GOOGLE_PLACES_PER_PERSON', 'GOOGLE_TILES_DAILY_MAX', 'STARBASE_TZ', 'ADDRESS_SUGGEST', 'GOOGLE_MAPS_SERVER_KEY'];
let db;
let now = Date.parse('2026-11-13T19:00:00Z'); // 11 am in Surrey

before(async () => {
  for (const k of KEYS) delete process.env[k];
  db = await freshDb();
  _setNowForTest(() => now);
});
after(() => {
  _setNowForTest(null);
  _resetForTest();
  _setPlacesLogoForTest(null);
  for (const k of KEYS) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
});
beforeEach(async () => {
  for (const k of KEYS) delete process.env[k];
  await db.query('delete from google_usage');
  now = Date.parse('2026-11-13T19:00:00Z');
  _resetForTest();
  await start();
});
// A restart: memory gone, the table kept.
const restart = async () => { await flush(); _resetForTest(); await start(); };

test('the campaign’s day: midnight in its own time zone, either side, and across a clock change', () => {
  // Surrey is UTC-7 all year since March 2026.
  assert.equal(dayOf(Date.parse('2026-11-14T06:59:59Z')), '2026-11-13');
  assert.equal(dayOf(Date.parse('2026-11-14T07:00:00Z')), '2026-11-14');
  assert.equal(secondsToMidnight(Date.parse('2026-11-14T06:59:00Z')), 60);
  // A zone that still changes its clocks: Toronto falls back on 1 Nov 2026,
  // so 31 Oct 23:00 (EDT, UTC-4) is 1 h from midnight, and that day lasts 25 h.
  process.env.STARBASE_TZ = 'America/Toronto';
  assert.equal(secondsToMidnight(Date.parse('2026-11-01T03:00:00Z')), 3600);
  assert.equal(dayOf(Date.parse('2026-11-01T03:59:59Z')), '2026-10-31');
  assert.equal(dayOf(Date.parse('2026-11-01T04:00:00Z')), '2026-11-01');
  // 1 Nov 00:00 EDT → 2 Nov 00:00 EST is 25 hours.
  assert.equal(secondsToMidnight(Date.parse('2026-11-01T04:00:00Z')), 25 * 3600);
  assert.equal(dayOf(Date.parse('2026-11-02T04:59:59Z')), '2026-11-01');
});

test('counts survive a restart; two servers add to the same row; the day rolls over at the campaign’s midnight', async () => {
  count('tiles', 5);
  count('autocomplete', 2, 'user-a');
  await restart();
  assert.deepEqual([today().tiles, today().autocomplete], [5, 2], 'read back after a restart');
  // Another server added its own (straight to the table, as its sync does).
  await db.query(`insert into google_usage (day, kind, n) values ($1, 'tiles', 7)
                  on conflict (day, kind) do update set n = google_usage.n + excluded.n`, ['2026-11-13']);
  count('tiles', 1);
  await sync();
  assert.equal(today().tiles, 13, 'theirs and ours');
  assert.equal((await db.query(`select n from google_usage where day = '2026-11-13' and kind = 'tiles'`)).rows[0].n, 13);
  // Just past the campaign's midnight: a new day.
  now = Date.parse('2026-11-14T07:00:05Z');
  assert.deepEqual([today().day, today().tiles], ['2026-11-14', 0]);
});

test('GOOGLE_PLACES_DAILY_MAX=2: two Places asks, then B.C. — and still after a restart', async () => {
  process.env.GOOGLE_PLACES_DAILY_MAX = '2';
  process.env.ADDRESS_SUGGEST = 'google';
  process.env.GOOGLE_MAPS_SERVER_KEY = 'k';
  _setPlacesLogoForTest(true);
  assert.equal(placesFor('u1'), true);
  count('autocomplete', 1, 'u1');
  assert.equal(placesFor('u1'), true);
  count('autocomplete', 1, 'u2');
  assert.equal(placesFor('u1'), 'ceiling');
  assert.equal(placesFor('u3'), 'ceiling', 'for everyone');
  await restart();
  assert.equal(placesLeft(), false, 'held after a restart');
  // Details reach it too.
  await db.query('delete from google_usage');
  _resetForTest();
  await start();
  count('details', 2);
  assert.equal(placesLeft(), false);
  // A probe never counts against it.
  await db.query('delete from google_usage');
  _resetForTest();
  await start();
  count('probe', 50);
  assert.equal(placesLeft(), true);
});

test('GOOGLE_PLACES_PER_PERSON=2: one person gets 2 Places asks, then B.C., while another still gets Places', () => {
  process.env.GOOGLE_PLACES_PER_PERSON = '2';
  process.env.ADDRESS_SUGGEST = 'google';
  process.env.GOOGLE_MAPS_SERVER_KEY = 'k';
  _setPlacesLogoForTest(true);
  count('autocomplete', 1, 'u1');
  count('details', 1, 'u1');
  assert.equal(placesFor('u1'), 'share');
  assert.equal(personLeft('u2'), true);
  assert.equal(placesFor('u2'), true);
  // The next day: a new share.
  now = Date.parse('2026-11-14T08:00:00Z');
  assert.equal(placesFor('u1'), true);
});

test('ceilings: defaults, whole numbers 1–10,000,000, anything else ignored with its words', () => {
  assert.deepEqual(ceilings(), { places: 300, perPerson: 50, tiles: null, problems: [] });
  process.env.GOOGLE_PLACES_DAILY_MAX = '1000';
  process.env.GOOGLE_TILES_DAILY_MAX = '20000';
  process.env.GOOGLE_PLACES_PER_PERSON = '80';
  assert.deepEqual(ceilings(), { places: 1000, perPerson: 80, tiles: 20000, problems: [] });
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    for (const bad of ['lots', '0', '2.5', '10000001', '-3']) {
      process.env.GOOGLE_PLACES_DAILY_MAX = bad;
      const c = ceilings();
      assert.equal(c.places, 300, bad);
      assert.deepEqual(c.problems, ['GOOGLE_PLACES_DAILY_MAX isn’t a number — using 300'], bad);
    }
  } finally { console.warn = realWarn; }
  assert.equal(warns.length, 1, 'said once in the log');
  assert.equal(today().problems[0], 'GOOGLE_PLACES_DAILY_MAX isn’t a number — using 300');
});

test('rows older than 40 days go at start; the table holds a date, a kind and a number — no person', async () => {
  await db.query(`insert into google_usage (day, kind, n) values ('2026-10-03', 'tiles', 9), ('2026-10-04', 'tiles', 8), ('2026-11-12', 'tiles', 1)`);
  _resetForTest();
  await start();
  const days = (await db.query('select day::text as day from google_usage order by day')).rows.map((r) => r.day);
  assert.deepEqual(days, ['2026-10-04', '2026-11-12'], '41 days old: gone; 40: kept');
  const cols = (await db.query(`select column_name from information_schema.columns where table_name = 'google_usage' order by ordinal_position`)).rows.map((r) => r.column_name);
  assert.deepEqual(cols, ['day', 'kind', 'n']);
  count('autocomplete', 1, 'person-uuid-1');
  await sync();
  assert.doesNotMatch(JSON.stringify((await db.query('select * from google_usage')).rows), /person-uuid-1/);
});

test('a sync never shows a count lower than it is, while it writes and reads the table', async () => {
  count('autocomplete', 3, 'user-a');
  let low = Infinity;
  let done = false;
  const p = sync().finally(() => { done = true; });
  while (!done) { low = Math.min(low, today().autocomplete); await new Promise((r) => setImmediate(r)); }
  await p;
  assert.equal(low, 3, 'never fewer than were counted');
  assert.equal(today().autocomplete, 3);
});

test('a sync still out when the counts start again (a test’s reset) leaves the new counts alone', async () => {
  count('autocomplete', 2);
  const p = sync();
  _resetForTest();
  count('autocomplete', 1);
  await p;
  assert.ok(today().autocomplete >= 1, 'the new count is still there');
  await sync();
  assert.equal(today().autocomplete, 1 + 2, 'the new count and the row the old sync wrote — none taken off');
});
