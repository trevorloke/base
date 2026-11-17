// The campaign's clock in JavaScript (lib/tzrule.js): B.C. on UTC-7 all
// year from March 8, 2026, whatever Intl's copy of the rules says; before
// that and elsewhere, Intl's. lib/tzsql.js takes its two moments from here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { atLocal, localDay, localHm, offsetAt, SINCE_UTC, SINCE_LOCAL, nextDay } from '../lib/tzrule.js';

const iso = (ms) => new Date(ms).toISOString();

test('a January 2027 close at 8 p.m. is 03:00Z the next day (UTC-7, no fall-back)', () => {
  assert.equal(iso(atLocal('2027-01-16', '20:00', 'America/Vancouver')), '2027-01-17T03:00:00.000Z');
  assert.equal(iso(atLocal('2027-07-01', '08:00', 'America/Vancouver')), '2027-07-01T15:00:00.000Z');
  assert.equal(offsetAt(Date.parse('2027-01-17T03:00:00Z')), -7 * 3600e3);
});

test('before March 8, 2026 the rules every copy agrees on: PST in winter', () => {
  assert.equal(iso(atLocal('2026-01-15', '00:00', 'America/Vancouver')), '2026-01-15T08:00:00.000Z');
  assert.equal(localHm(Date.parse('2026-01-15T07:30:00Z')), '23:30');
  assert.equal(localDay(Date.parse('2026-01-15T07:30:00Z')), '2026-01-14');
});

test('another zone follows Intl', () => {
  assert.equal(iso(atLocal('2027-01-16', '20:00', 'America/Toronto')), '2027-01-17T01:00:00.000Z');
  assert.equal(iso(atLocal('2027-07-01', '08:00', 'America/Toronto')), '2027-07-01T12:00:00.000Z');
});

test('with Intl stubbed to the old rule (UTC-8 in winter) the January close is still 03:00Z', () => {
  const Real = Intl.DateTimeFormat;
  // A stale copy of the rules: B.C. falls back on Nov 1, 2026 as it used to.
  Intl.DateTimeFormat = function Stale(locale, opts = {}) {
    const real = new Real(locale, { ...opts, timeZone: 'UTC' });
    const shift = (d) => {
      const t = d.getTime();
      const pdt = t >= Date.UTC(2026, 2, 8, 10) && t < Date.UTC(2026, 10, 1, 9);
      return new Date(t - (pdt ? 7 : 8) * 3600e3);
    };
    return { format: (d) => real.format(shift(d)), formatToParts: (d) => real.formatToParts(shift(d)), resolvedOptions: () => real.resolvedOptions() };
  };
  try {
    assert.equal(iso(atLocal('2027-01-16', '20:00', 'America/Vancouver')), '2027-01-17T03:00:00.000Z');
    assert.equal(localHm(Date.parse('2027-01-17T03:00:00Z')), '20:00');
  } finally { Intl.DateTimeFormat = Real; }
});

test('localDay and localHm round-trip atLocal', () => {
  for (const [d, hm] of [['2026-10-17', '08:00'], ['2027-01-16', '23:59'], ['2026-11-01', '00:30'], ['2026-03-08', '04:00']]) {
    const t = atLocal(d, hm);
    assert.equal(localDay(t), d);
    assert.equal(localHm(t), hm);
  }
  assert.equal(nextDay('2026-12-31'), '2027-01-01');
});

test('lib/tzsql.js uses the same two moments', () => {
  const src = readFileSync(new URL('../lib/tzsql.js', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/tzrule\.js'/);
  assert.equal(SINCE_UTC, '2026-03-08T10:00:00Z');
  assert.equal(SINCE_LOCAL, '2026-03-08 03:00:00');
});
