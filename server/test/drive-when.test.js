// Sent to Google Drive's dates (web/src/components/DriveWhen.js): on the
// campaign's clock, with B.C.'s UTC-7-all-year rule applied the way
// shared/dayparts.js applies it everywhere else, so a browser whose own
// time-zone rules still fall back in November shows the same hour.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { driveWhen } = await import('../../web/src/components/DriveWhen.js');

test('after B.C. stopped falling back: 20:04 UTC on 13 Nov 2026 is 1:04 pm in Vancouver', () => {
  assert.equal(driveWhen('2026-11-13T20:04:00Z', 'America/Vancouver'), '13 Nov, 1:04 pm');
  assert.equal(driveWhen('2026-11-13T19:29:00Z', 'America/Vancouver'), '13 Nov, 12:29 pm');
  assert.equal(driveWhen('2026-11-13T20:04:00Z', 'America/Vancouver', false), '13 Nov');
});

test('the date turns over on the campaign’s clock, not UTC’s', () => {
  assert.equal(driveWhen('2026-11-14T03:30:00Z', 'America/Vancouver'), '13 Nov, 8:30 pm');
});

test('other zones and older dates use the runtime’s rules; no zone means Vancouver', () => {
  assert.equal(driveWhen('2026-11-13T20:04:00Z', 'America/Toronto'), '13 Nov, 3:04 pm');
  assert.equal(driveWhen('2025-12-01T20:04:00Z', 'America/Vancouver'), '1 Dec, 12:04 pm');
  assert.equal(driveWhen('2026-11-13T20:04:00Z', null), '13 Nov, 1:04 pm');
  assert.equal(driveWhen('2026-11-13T20:04:00Z', 'Not/AZone'), '13 Nov, 1:04 pm');
});

test('a bad date is blank, not "Invalid Date"', () => {
  assert.equal(driveWhen('nope', 'America/Vancouver'), '');
  assert.equal(driveWhen(null, 'America/Vancouver'), '');
});
