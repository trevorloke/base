// The campaign's clock in SQL (lib/tzsql.js): B.C. on UTC-7 all year from
// March 8, 2026, whatever the database's own time-zone rules say; before
// that, the database's rules (PST in winter); another zone, its own rules.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { fromLocal, toLocal } from '../lib/tzsql.js';

let db;
before(async () => { db = await freshDb(); });

const local = async (iso, zone) => (await db.query(
  `select to_char(${toLocal('$1::timestamptz', '$2::text')}, 'YYYY-MM-DD HH24:MI') as t`, [iso, zone],
)).rows[0].t;
const moment = async (wall, zone) => new Date((await db.query(
  `select ${fromLocal('$1::timestamp', '$2::text')} as t`, [wall, zone],
)).rows[0].t).toISOString();

test('after Nov 1, 2026 B.C. no longer falls back: 07:30 UTC is 00:30 the next day', async () => {
  assert.equal(await local('2026-11-15T07:30:00Z', 'America/Vancouver'), '2026-11-15 00:30');
  assert.equal(await moment('2026-11-15 00:00', 'America/Vancouver'), '2026-11-15T07:00:00.000Z');
});

test('summer 2026 (PDT) and winter before it (PST) read as they always did', async () => {
  assert.equal(await local('2026-07-01T19:00:00Z', 'America/Vancouver'), '2026-07-01 12:00');
  assert.equal(await local('2026-01-15T07:30:00Z', 'America/Vancouver'), '2026-01-14 23:30');
  assert.equal(await moment('2026-01-15 00:00', 'America/Vancouver'), '2026-01-15T08:00:00.000Z');
});

test('another zone keeps the database’s own rules', async () => {
  assert.equal(await local('2026-11-15T12:00:00Z', 'America/Toronto'), '2026-11-15 07:00');
  assert.equal(await local('2026-11-15T12:00:00Z', 'UTC'), '2026-11-15 12:00');
});
