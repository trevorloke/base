// The days letters' screens show (web/src/components/letterWords.js), read in
// Surrey: "Rules checked" and "Published · <day>" are stored as a date alone
// and must show that same day west of UTC, where reading "2026-11-13" as a
// time gives UTC midnight — the evening of the 12th here.
process.env.TZ = 'America/Vancouver';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { dayWords } = await import('../../web/src/components/letterWords.js');

test('a date alone is that day in Surrey; a moment is the day on the reader’s clock', () => {
  assert.equal(new Date('2026-11-13T00:00:00Z').getDate(), 12, 'this file reads in Surrey');
  assert.equal(dayWords('2026-11-13'), '13 Nov');
  assert.equal(dayWords('2026-01-01'), '1 Jan');
  // 02:00 UTC on the 14th is 18:00 on the 13th in Surrey.
  assert.equal(dayWords('2026-11-14T02:00:00.000Z'), '13 Nov');
  assert.equal(dayWords(null), '');
  assert.equal(dayWords(''), '');
  assert.equal(dayWords('not a day'), '');
});
