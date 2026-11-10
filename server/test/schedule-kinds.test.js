// Kinds of shift (shared/shiftkinds.js) and names made from kind and place:
// "Burma Shave — King George Blvd & 88 Ave". A typed name wins and is kept;
// a shift made before kinds shows as its role implies and is never
// rewritten.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { VOLUNTEER_ROLE_CODES } from '@starbase/shared/canvass';
import {
  SHIFT_KINDS, SHIFT_KIND_CODES, isPinName, kindOf, madeTitle, pinName, placeLabel, repeatDays, shiftKind, siteListOf,
} from '@starbase/shared/shiftkinds';
import { isClock, isDay } from '@starbase/shared/dayparts';

let c, db;
const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.json)}`); return r.json; };
const row = async (id) => (await db.query('select * from shifts where id = $1', [id])).rows[0];
const DAY = '2030-05-06'; // a Monday, always ahead

before(async () => {
  db = await freshDb();
  c = new Client();
  await c.signup({ workspaceName: 'Kinds WS', jurisdiction: 'bc-municipal' });
});

test('the catalogue: nine kinds, their words, usual hours, and colours from the app’s own', () => {
  assert.deepEqual(SHIFT_KIND_CODES, ['canvass', 'phone_bank', 'mainstreet', 'burma_shave', 'lit_drop', 'signs', 'event', 'office', 'other']);
  assert.deepEqual(SHIFT_KINDS.map((k) => k.label), ['Canvass', 'Phone bank', 'Mainstreet', 'Burma Shave', 'Lit drop', 'Signs', 'Event', 'Office', 'Other']);
  const hours = (code) => shiftKind(code).slots.map((s) => `${s.start}-${s.end}`);
  assert.deepEqual(hours('burma_shave'), ['06:30-08:30', '16:00-18:00']);
  assert.deepEqual(hours('mainstreet'), ['07:00-09:00', '16:30-18:30']);
  assert.deepEqual(hours('canvass'), ['10:00-13:00', '14:00-17:00', '18:00-20:00']);
  assert.deepEqual(hours('phone_bank'), ['18:00-20:00']);
  assert.deepEqual(hours('lit_drop'), ['10:00-12:00']);
  assert.deepEqual(hours('signs'), ['09:00-12:00']);
  assert.deepEqual(hours('office'), ['09:00-12:00', '13:00-16:00']);
  assert.deepEqual([hours('event'), hours('other')], [[], []]);
  // The app's own colour variables (web/src/app.css): a campaign's brand and a new look re-value these.
  const APP_COLOURS = ['--mark', '--mark-ink', '--mark-soft', '--mark-deep', '--text-1', '--text-2', '--text-3', '--text-4', '--ink', '--ok', '--warn', '--danger'];
  for (const k of SHIFT_KINDS) {
    assert.match(k.color, /^--[a-z0-9-]+$/, `${k.code}: a CSS variable, never a hex`);
    assert.ok(APP_COLOURS.includes(k.color), `${k.code}: ${k.color} is one the app already has`);
    assert.ok(k.icon && k.minutes >= 60, `${k.code}: an icon and a usual length`);
    assert.ok(k.role === null || VOLUNTEER_ROLE_CODES.includes(k.role), `${k.code}: a real volunteer role`);
    assert.ok(k.slots.every((s) => isClock(s.start) && isClock(s.end) && s.start < s.end));
    assert.ok(['opening', 'event'].includes(k.site));
  }
  assert.deepEqual(SHIFT_KINDS.filter((k) => k.turfs).map((k) => k.code), ['canvass', 'lit_drop'], 'the kinds whose place is a turf');
  assert.deepEqual(SHIFT_KINDS.filter((k) => k.site === 'event').map((k) => k.code), ['event']);
});

test('a shift with no kind shows as its role implies, else Other', () => {
  assert.equal(kindOf({ kind: 'lit_drop', role: 'doorknocking' }).code, 'lit_drop', 'its own kind first');
  assert.equal(kindOf({ role: 'doorknocking' }).code, 'canvass');
  assert.equal(kindOf({ role: 'phoning' }).code, 'phone_bank');
  assert.equal(kindOf({ role: 'mainstreeting' }).code, 'mainstreet');
  assert.equal(kindOf({ role: 'burmashave' }).code, 'burma_shave');
  assert.equal(kindOf({ role: 'event_hosting' }).code, 'event');
  assert.equal(kindOf({ role: 'driver' }).code, 'other');
  assert.equal(kindOf({}).code, 'other');
  assert.equal(kindOf({ kind: 'not-a-kind' }).code, 'other');
  // The website: a kind decides; a shift with none is in both lists, as before.
  assert.deepEqual([siteListOf({ kind: 'event' }), siteListOf({ kind: 'burma_shave' }), siteListOf({ role: 'event_hosting' }), siteListOf({})], ['event', 'opening', 'both', 'both']);
});

test('names are made, not typed', () => {
  assert.equal(madeTitle('burma_shave', 'King George Blvd & 88 Ave'), 'Burma Shave — King George Blvd & 88 Ave');
  assert.equal(madeTitle('canvass', 'Newton block'), 'Canvass — Newton block');
  assert.equal(madeTitle('phone_bank', 'Campaign office'), 'Phone bank — Campaign office');
  assert.equal(madeTitle('phone_bank', ''), 'Phone bank', 'no place: just what it is');
  assert.equal(madeTitle('other', 'Campaign office'), 'Shift — Campaign office');
  assert.equal(madeTitle(null, null), 'Shift');
});

test('a point nothing could name is "Pinned place" on a card, a chip and in a made name — never its coordinates', () => {
  assert.equal(pinName(49.1451, -122.8599), 'Pin at 49.1451, −122.8599', 'what the place is saved as: its details');
  assert.ok(isPinName('Pin at 49.1451, −122.8599') && isPinName(' Pin at 49.1630, -122.8447 '));
  assert.ok(!isPinName('Pin at the corner') && !isPinName('King George Blvd & 88 Ave') && !isPinName('') && !isPinName(null));
  assert.equal(placeLabel('Pin at 49.1451, −122.8599'), 'Pinned place');
  assert.equal(placeLabel('  Campaign office '), 'Campaign office', 'a named place is its name');
  assert.equal(placeLabel(null), '');
  assert.equal(madeTitle('mainstreet', 'Pin at 49.1451, −122.8599'), 'Mainstreet — Pinned place');
});

test('no kind brings a number of its own: a suggestion is only ever offered', () => {
  // The catalogue may suggest a target (the first chip under "We need"); the
  // server never writes one unasked (schedule-need.test.js, schedule-many.test.js).
  assert.deepEqual(SHIFT_KINDS.filter((k) => k.need).map((k) => [k.code, k.need]), [['mainstreet', 2], ['burma_shave', 4]]);
  for (const k of SHIFT_KINDS) assert.ok(!('capacity' in k), `${k.code}: no kind has a limit`);
});

test('days and repeats: each chosen day, then weekly — n weeks in all, or until a day', () => {
  assert.ok(isDay('2026-11-16') && !isDay('2026-02-30') && !isDay('2026-1-5') && !isDay('tomorrow'));
  assert.ok(isClock('06:30') && isClock('23:59') && !isClock('24:00') && !isClock('6:30') && !isClock('06:60'));
  assert.deepEqual(repeatDays(['2026-11-17', '2026-11-16', '2026-11-16'], null), ['2026-11-16', '2026-11-17'], 'just this week, each day once');
  assert.deepEqual(repeatDays(['2026-11-16'], { weeks: 4 }), ['2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07']);
  assert.deepEqual(repeatDays(['2026-11-16', '2026-11-20'], { until: '2026-11-30' }), ['2026-11-16', '2026-11-20', '2026-11-23', '2026-11-27', '2026-11-30']);
  assert.deepEqual(repeatDays(['2026-11-20'], { until: '2026-11-18' }), ['2026-11-20'], 'a chosen day is always made itself');
  assert.equal(repeatDays(['2026-11-16'], { until: '2036-01-01' }).length, 26, '26 weeks at most');
  assert.equal(repeatDays(['2026-11-16'], { weeks: 1 }).length, 1);
  assert.deepEqual(repeatDays(['2026-11-16', '2026-11-23'], { weeks: 3 }), ['2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07'],
    'two chosen days a week apart: each day once, never two shifts on one');
});

test('shift.create takes a kind and a target; a wrong kind is refused; old shifts stay as they were', async () => {
  const made = ok(await c.action('shift.create', {
    title: 'Morning wave', kind: 'burma_shave', need: 4, starts_at: `${DAY}T06:30:00-07:00`, ends_at: `${DAY}T08:30:00-07:00`,
  })).shift;
  const s = await row(made.id);
  assert.deepEqual([s.kind, s.need, s.capacity, s.title, s.title_custom], ['burma_shave', 4, null, 'Morning wave', true]);
  assert.equal((await c.action('shift.create', { title: 'x', kind: 'parade', starts_at: `${DAY}T06:30:00-07:00` })).status, 400);
  assert.equal((await c.action('shift.create', { title: 'x', need: 0, starts_at: `${DAY}T06:30:00-07:00` })).status, 400);
  assert.equal((await c.action('shift.create', { title: 'x', role: 'lit_drop', starts_at: `${DAY}T06:30:00-07:00` })).status, 400, 'a kind is not a role');
  // Made the old way: no kind, and nothing is filled in after.
  const old = ok(await c.action('shift.create', { title: 'Saturday doorknock — Fleetwood', role: 'doorknocking', starts_at: `${DAY}T10:00:00-07:00` })).shift;
  const o = await row(old.id);
  assert.deepEqual([o.kind, o.need, o.place_id, o.series_id], [null, null, null, null]);
  // Every read hands the new columns on.
  const list = ok(await c.get('/api/shifts')).shifts.find((x) => x.id === made.id);
  assert.deepEqual([list.kind, list.need, list.place_id, list.place_lat], ['burma_shave', 4, null, null]);
  const from = `${DAY}T00:00:00-07:00`; const to = '2030-05-13T00:00:00-07:00';
  const board = ok(await c.get(`/api/shifts/board?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).shifts.find((x) => x.id === made.id);
  assert.deepEqual([board.kind, board.need, board.place_id, board.series_id, board.public], ['burma_shave', 4, null, null, false]);
});

test('a typed name is kept; without one the name follows the kind and the place', async () => {
  const id = ok(await c.action('shift.create', {
    title: 'Typed by hand', kind: 'burma_shave', location: 'King George Blvd & 88 Ave', starts_at: `${DAY}T06:30:00-07:00`, ends_at: `${DAY}T08:30:00-07:00`,
  })).shift.id;
  // Typed: a new kind or place leaves the name alone.
  ok(await c.action('shift.update', { id, kind: 'mainstreet', location: 'Newton Exchange' }));
  let s = await row(id);
  assert.deepEqual([s.title, s.title_custom, s.kind, s.location, s.role], ['Typed by hand', true, 'mainstreet', 'Newton Exchange', 'mainstreeting']);

  // No typed name any more: it is made, and follows.
  let r = ok(await c.action('shift.update', { id, title: null }));
  assert.equal(r.shift.title, 'Mainstreet — Newton Exchange', 'the answer says the name it now has');
  ok(await c.action('shift.update', { id, kind: 'burma_shave' }));
  s = await row(id);
  assert.deepEqual([s.title, s.title_custom, s.role], ['Burma Shave — Newton Exchange', false, 'burmashave']);
  ok(await c.action('shift.update', { id, location: '152 St & 64 Ave' }));
  assert.equal((await row(id)).title, 'Burma Shave — 152 St & 64 Ave');
  ok(await c.action('shift.update', { id, capacity: 6 }));
  assert.equal((await row(id)).title, 'Burma Shave — 152 St & 64 Ave', 'nothing to do with the name');
  // A form that sends the made name back as it was shown hasn't typed one: it still follows.
  ok(await c.action('shift.update', { id, title: 'Burma Shave — 152 St & 64 Ave', location: 'Scott Rd & 72 Ave' }));
  s = await row(id);
  assert.deepEqual([s.title, s.title_custom], ['Burma Shave — Scott Rd & 72 Ave', false]);
  ok(await c.action('shift.update', { id, location: '152 St & 64 Ave' }));

  // Typing a name again wins again.
  ok(await c.action('shift.update', { id, title: 'Sign wave with the candidates' }));
  ok(await c.action('shift.update', { id, kind: 'event' }));
  s = await row(id);
  assert.deepEqual([s.title, s.title_custom, s.kind], ['Sign wave with the candidates', true, 'event']);

  // A shift from before kinds: its name was typed, so it is kept.
  const old = ok(await c.action('shift.create', { title: 'Phone night', role: 'phoning', starts_at: `${DAY}T18:00:00-07:00` })).shift.id;
  await db.query('update shifts set title_custom = null where id = $1', [old]);
  ok(await c.action('shift.update', { id: old, kind: 'phone_bank', location: 'Campaign office' }));
  s = await row(old);
  assert.deepEqual([s.title, s.title_custom, s.kind], ['Phone night', null, 'phone_bank']);

  // The log carries what was stored.
  const events = (await db.query(
    `select payload from events where entity_id = $1 and op = 'update' order by seq`, [id],
  )).rows.map((e) => e.payload);
  assert.deepEqual(events[1], { title: 'Mainstreet — Newton Exchange', title_custom: false });
  assert.deepEqual(events[2], { kind: 'burma_shave', role: 'burmashave', title: 'Burma Shave — Newton Exchange' });
});
