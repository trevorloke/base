// One clock for shifts: the campaign's (shared/dayparts.js), never the
// device's and never the server's. This file runs as a laptop set to Toronto
// time, and part of it with time-zone rules that predate B.C.'s change (no
// more fall-back from Nov 1, 2026): every answer must still be Surrey's.
process.env.TZ = 'America/Toronto';
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import {
  WEEK_PARTS, addClock, clockOf, clockWords, dayOf, fmtIn, fromInput, instantOf, partOf, spanWords, toInput, wallClock,
  weekBounds, weekPartOf, zonedISO,
} from '@starbase/shared/dayparts';
import { shiftMessage } from '../lib/notify.js';

const BC = 'America/Vancouver';
// 6:30 am in Surrey on Monday Nov 16, 2026 (UTC-7: B.C. no longer falls back).
const AT = '2026-11-16T13:30:00Z';

// A runtime whose rules are older still falls back on Nov 1, 2026 — exactly
// what Los Angeles still does. So "old rules" here is Vancouver read as LA.
const RealFormat = Intl.DateTimeFormat;
const withOldRules = (fn) => {
  Intl.DateTimeFormat = function OldRules(locale, opts = {}) {
    return new RealFormat(locale, opts.timeZone === BC ? { ...opts, timeZone: 'America/Los_Angeles' } : opts);
  };
  try { return fn(); } finally { Intl.DateTimeFormat = RealFormat; }
};

let c;
before(async () => {
  await freshDb();
  c = new Client();
  await c.signup({ workspaceName: 'Clock WS', jurisdiction: 'bc-municipal' });
});

test('B.C. is on UTC-7 after Nov 1, 2026, even where the device’s time-zone rules are old', () => {
  withOldRules(() => {
    const stale = new Intl.DateTimeFormat('en-CA', { timeZone: BC, hour: 'numeric', hourCycle: 'h23' }).format(new Date(AT));
    assert.equal(stale, '05', 'the stand-in really is an hour off');
    assert.deepEqual(wallClock(AT), { day: '2026-11-16', hour: 6, minute: 30 });
    assert.equal(zonedISO('2026-11-16', 6, BC, 30), '2026-11-16T06:30:00-07:00');
    assert.deepEqual(weekBounds('2026-11-16'), { from: '2026-11-16T00:00:00-07:00', to: '2026-11-23T00:00:00-07:00' });
    assert.equal(partOf('2026-11-16T19:30:00Z'), 'afternoon', '12:30 pm');
    assert.equal(dayOf('2026-11-16T06:30:00Z'), '2026-11-15', '11:30 pm the evening before');
    // Before the change every copy of the rules agrees: PST that winter, PDT that summer.
    assert.deepEqual(wallClock('2026-01-15T16:00:00Z'), { day: '2026-01-15', hour: 8, minute: 0 });
    assert.equal(zonedISO('2026-01-15', 8), '2026-01-15T08:00:00-08:00');
    assert.equal(zonedISO('2026-07-01', 8), '2026-07-01T08:00:00-07:00');
  });
  // Another zone keeps the runtime's own rules.
  assert.equal(zonedISO('2026-11-16', 9, 'America/Los_Angeles'), '2026-11-16T09:00:00-08:00');
  assert.equal(zonedISO('2026-11-16', 9, 'America/Toronto'), '2026-11-16T09:00:00-05:00');
});

test('times read and are typed on the campaign’s clock, not this laptop’s', () => {
  assert.equal(new Date(AT).getHours(), 8, 'this process is on Toronto time');
  withOldRules(() => {
    assert.equal(clockOf(AT, BC), '06:30');
    assert.equal(clockWords(AT, BC), '6:30am');
    assert.equal(clockWords('2026-11-16T17:00:00Z', BC), '10am');
    assert.equal(clockWords('2026-11-17T01:00:00Z', BC), '6pm');
    assert.equal(toInput(AT, BC), '2026-11-16T06:30', 'what a date-and-time box shows');
    assert.equal(new Date(fromInput('2026-11-16T06:30', BC)).toISOString(), '2026-11-16T13:30:00.000Z', 'and what typing 06:30 into it means');
    assert.equal(fromInput('', BC), null);
    assert.equal(toInput(null, BC), '');
    assert.equal(new Date(instantOf('2026-11-16', '06:30', BC)).toISOString(), '2026-11-16T13:30:00.000Z');
    assert.equal(fmtIn(AT, BC, { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }), 'Monday, November 16 at 6:30 a.m.');
    assert.equal(fmtIn(AT, BC, { weekday: 'short', month: 'short', day: 'numeric' }), 'Mon, Nov 16');
  });
  // An unknown zone reads as Vancouver, as before.
  assert.equal(clockWords(AT, 'Not/AZone'), '6:30am');
  // Another campaign's zone is its own.
  assert.equal(clockWords(AT, 'America/Toronto'), '8:30am');
});

test('the week’s day lists: an early start is Early, and a time is said the short way', () => {
  assert.deepEqual(WEEK_PARTS.map((p) => p.label), ['Early', 'Morning', 'Afternoon', 'Evening']);
  withOldRules(() => {
    assert.equal(weekPartOf(AT, BC), 'early', '6:30 am — not “Morning 9am–12pm”');
    assert.equal(weekPartOf('2026-11-16T15:59:00Z', BC), 'early', '8:59 am');
    assert.equal(weekPartOf('2026-11-16T16:00:00Z', BC), 'morning', '9 am');
    assert.equal(weekPartOf('2026-11-16T19:00:00Z', BC), 'afternoon', 'noon');
    assert.equal(weekPartOf('2026-11-17T00:00:00Z', BC), 'evening', '5 pm');
    assert.equal(weekPartOf('2026-11-16T12:00:00Z', BC), 'early', '5 am: before the list’s 6 am, still at its top');
    assert.equal(weekPartOf('2026-11-17T06:30:00Z', BC), 'evening', '11:30 pm');
  });
  assert.equal(weekPartOf('07:00'), 'early', 'a clock time too');
  assert.equal(weekPartOf('16:30'), 'afternoon');
  // What the chips and cards say.
  assert.equal(spanWords('06:30', '08:30'), '6:30–8:30 am');
  assert.equal(spanWords('07:00', '09:00'), '7–9 am');
  assert.equal(spanWords('10:00', '13:00'), '10 am–1 pm');
  assert.equal(spanWords('16:30', '18:30'), '4:30–6:30 pm');
  assert.equal(spanWords('12:00', '13:30'), '12–1:30 pm');
  assert.equal(spanWords('00:00', '12:00'), '12 am–12 pm');
  assert.equal(spanWords('18:00'), '6 pm', 'no end');
  assert.equal(spanWords('18:00', null), '6 pm');
  // A start and how long: the end, or null once it would run past the day.
  assert.equal(addClock('06:30', 120), '08:30');
  assert.equal(addClock('06:00', 90), '07:30');
  assert.equal(addClock('21:30', 120), '23:30');
  assert.equal(addClock('21:30', 180), null, 'past midnight');
  assert.equal(addClock('23:00', 60), null, 'midnight is the next day');
});

test('a shift notice says the campaign’s hour', () => {
  const words = shiftMessage({ title: 'Burma Shave — King George Blvd & 88 Ave', starts_at: AT, ends_at: '2026-11-16T15:30:00Z', location: 'King George Blvd & 88 Ave' }, 'Clock WS', BC);
  assert.match(words, /Monday, November 16 at 6:30 a\.m\. – 8:30 a\.m\./);
});

test('a shift moved by day and clock time lands on the campaign’s clock', async () => {
  const made = await c.action('shift.create', {
    title: 'Burma Shave', starts_at: '2026-11-16T06:30:00-07:00', ends_at: '2026-11-16T08:30:00-07:00',
  });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  const id = made.json.shift.id;
  const read = async () => (await c.get(`/api/shifts/${id}`)).json.shift;
  const iso = (v) => new Date(v).toISOString();

  // Another day: the same clock times, both ends.
  let r = await c.action('shift.update', { id, day: '2026-11-18' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let s = await read();
  assert.deepEqual([iso(s.starts_at), iso(s.ends_at)], ['2026-11-18T13:30:00.000Z', '2026-11-18T15:30:00.000Z']);
  assert.equal(iso(r.json.shift.starts_at), '2026-11-18T13:30:00.000Z', 'the answer carries the moment it now starts');

  // Other hours, as 'HH:MM': 7:00–9:00 in Surrey is 15:00–17:00 UTC (not Toronto's 12:00–14:00).
  r = await c.action('shift.update', { id, start: '07:00', end: '09:00' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  s = await read();
  assert.deepEqual([iso(s.starts_at), iso(s.ends_at)], ['2026-11-18T14:00:00.000Z', '2026-11-18T16:00:00.000Z']);

  // Across the old fall-back date and back: summer is still UTC-7.
  r = await c.action('shift.update', { id, day: '2026-07-06' });
  s = await read();
  assert.deepEqual([iso(s.starts_at), iso(s.ends_at)], ['2026-07-06T14:00:00.000Z', '2026-07-06T16:00:00.000Z']);

  // An end at or before the start is refused; so are both ways of saying when at once.
  assert.equal((await c.action('shift.update', { id, start: '09:00' })).status, 400, '9:00–9:00');
  assert.equal((await c.action('shift.update', { id, start: '10:00', end: '09:30' })).status, 400);
  assert.equal((await c.action('shift.update', { id, day: '2026-07-07', starts_at: '2026-07-07T07:00:00-07:00' })).status, 400);
  assert.equal((await c.action('shift.update', { id, day: '2026-02-30' })).status, 400, 'not a day');
  assert.equal((await c.action('shift.update', { id, start: '25:00' })).status, 400, 'not a time');
  s = await read();
  assert.deepEqual([iso(s.starts_at), iso(s.ends_at)], ['2026-07-06T14:00:00.000Z', '2026-07-06T16:00:00.000Z'], 'nothing moved');

  // No end any more.
  r = await c.action('shift.update', { id, end: null });
  assert.equal(r.status, 200);
  assert.equal((await read()).ends_at, null);
});

test('a shift that ends at or before it starts is refused when it is made', async () => {
  const same = await c.action('shift.create', { title: 'Backwards', starts_at: '2026-11-16T08:30:00-07:00', ends_at: '2026-11-16T08:30:00-07:00' });
  assert.equal(same.status, 400);
  assert.match(same.json.error, /end has to be after the start/);
  const before = await c.action('shift.create', { title: 'Backwards', starts_at: '2026-11-16T08:30:00-07:00', ends_at: '2026-11-16T06:30:00-07:00' });
  assert.equal(before.status, 400);
  assert.equal((await c.action('shift.create', { title: 'No end', starts_at: '2026-11-16T08:30:00-07:00' })).status, 200, 'no end is still fine');
});
