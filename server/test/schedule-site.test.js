// The website lists a public shift by what it is (ext/schedule kinds, read
// by ext/site/loaders.js): an Event with the events, every other kind with
// the volunteer openings — so a 6:30 am Burma Shave is no longer the home
// page's "Next event". A shift from before kinds is in both lists, as it
// always was. A place picked on the map gives its card a map link.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dayOf, instantOf } from '@starbase/shared/dayparts';

const { hit, send, ok, campaign } = await import('./site-helpers.js');
const { when, dateOnly } = await import('../../shared/site/components/util.js');
const { loadData } = await import('../ext/site/loaders.js');
const { siteWorkspace } = await import('../ext/site/store.js');

const TZ = 'America/Vancouver';
const ahead = (n) => addDays(dayOf(new Date(), TZ), n);
let db, mgr, ws;
const made = {};

before(async () => {
  ({ db, mgr, ws } = await campaign());
  ok(await mgr.get('/api/site'));
});

test('the data: events hold the Event kind, openings every other kind; a shift with no kind is in both', async () => {
  const corner = ok(await mgr.action('place.save', { name: 'King George Blvd at 88 Ave', lat: 49.163, lng: -122.8447 })).place;
  made.wave = ok(await mgr.action('shift.createMany', {
    kind: 'burma_shave', place_id: corner.id, days: [ahead(2)], start: '06:30', end: '08:30', public: true,
  })).shifts[0];
  made.picnic = ok(await mgr.action('shift.createMany', {
    kind: 'event', location: 'Bear Creek Park', days: [ahead(3)], start: '11:00', end: '14:00', name: 'Family picnic', capacity: 40, public: true,
  })).shifts[0];
  made.old = ok(await mgr.action('shift.create', { title: 'Town hall', location: 'City Centre Library', starts_at: instantOf(ahead(4), '19:00', TZ) })).shift;
  ok(await mgr.action('shift.public', { id: made.old.id, public: true }));
  made.phones = ok(await mgr.action('shift.createMany', {
    kind: 'phone_bank', location: 'Campaign office', days: [ahead(5)], start: '18:00', end: '20:00', public: true,
  })).shifts[0];
  // Not on the website at all: it was never made public.
  ok(await mgr.action('shift.createMany', { kind: 'canvass', location: 'Somewhere quiet', days: [ahead(2)], start: '10:00', end: '13:00' }));

  const data = await loadData(db, await siteWorkspace(db, ws));
  assert.deepEqual(Object.keys(data).sort(), ['campaigns', 'counts', 'events', 'payments', 'posts', 'roles', 'shifts']);
  assert.deepEqual(data.events.map((e) => e.title), ['Family picnic', 'Town hall'], 'the Event, and the one made before kinds');
  assert.deepEqual(data.shifts.map((e) => e.title), ['Burma Shave — King George Blvd at 88 Ave', 'Town hall', 'Phone bank — Campaign office'],
    'every other kind, and the one made before kinds — soonest first');
  // Each row is the shape the site's cards have always read; the pin is the saved place's.
  for (const row of [...data.events, ...data.shifts]) {
    assert.deepEqual(Object.keys(row).sort(), ['ends_at', 'id', 'kind', 'lat', 'lng', 'location', 'spots_left', 'starts_at', 'title']);
  }
  assert.deepEqual([data.shifts[0].lat, data.shifts[0].lng, data.shifts[0].spots_left], [49.163, -122.8447, null], 'no limit: no “spots left”');
  assert.deepEqual([data.events[0].lat, data.events[0].lng, data.events[0].spots_left], [null, null, 40], 'words alone have no pin');
});

test('the pages: Volunteer shows the openings, Events the events, and the home page’s next event is an event', async () => {
  const volunteer = (await hit('/site/volunteer')).text;
  assert.match(volunteer, /Burma Shave — King George Blvd at 88 Ave/);
  assert.match(volunteer, /Phone bank — Campaign office/);
  assert.match(volunteer, /Town hall/);
  assert.doesNotMatch(volunteer, /Family picnic/, 'an event is not a volunteer opening');
  assert.match(volunteer, /href="https:\/\/www\.openstreetmap\.org\/\?mlat=49\.16300&amp;mlon=-122\.84470#map=16\/49\.16300\/-122\.84470"/, 'the pinned place opens a map');

  const events = (await hit('/site/events')).text;
  assert.match(events, /Family picnic/);
  assert.match(events, /Town hall/);
  assert.doesNotMatch(events, /Burma Shave|Phone bank/, 'an opening is not an event');
  assert.match(events, /40 spots left/);

  const home = (await hit('/site/')).text;
  assert.match(home, /Next event/);
  assert.match(home, /Family picnic/);
  assert.doesNotMatch(home, /Burma Shave/, 'the next event is not a 6:30 am sign wave');
});

test('a place nothing could name: the card says "See the map" — its coordinates only inside the link', async () => {
  const spot = ok(await mgr.action('place.save', { name: 'Pin at 49.0200, −123.2500', lat: 49.02, lng: -123.25, source: 'map' })).place;
  made.spot = ok(await mgr.action('shift.createMany', { kind: 'mainstreet', place_id: spot.id, days: [ahead(1)], start: '07:00', end: '09:00', public: true })).shifts[0];
  const row = (await loadData(db, await siteWorkspace(db, ws))).shifts.find((e) => e.id === made.spot.id);
  assert.deepEqual([row.title, row.location, row.lat, row.lng], ['Mainstreet — Pinned place', '', 49.02, -123.25], 'no words for where — the pin is');
  const volunteer = (await hit('/site/volunteer')).text;
  assert.match(volunteer, /Mainstreet — Pinned place/);
  assert.match(volunteer, /<a href="https:\/\/www\.openstreetmap\.org\/\?mlat=49\.02000&amp;mlon=-123\.25000#map=16\/49\.02000\/-123\.25000"[^>]*>(<svg[\s\S]*?<\/svg>)?See the map/, 'the link says “See the map”');
  assert.doesNotMatch(volunteer, /Pin at|49\.0200, /, 'never the coordinates as its name');
});

// A runtime whose time-zone rules predate B.C.'s change still falls back on
// Nov 1, 2026 — exactly what Los Angeles does. So "old rules" here is
// Vancouver read as LA (as in schedule-clock.test.js); production's image
// (node:22-alpine, unpinned) may well be one.
const RealFormat = Intl.DateTimeFormat;
const withOldRules = (fn) => {
  Intl.DateTimeFormat = function OldRules(locale, opts = {}) {
    return new RealFormat(locale, opts.timeZone === TZ ? { ...opts, timeZone: 'America/Los_Angeles' } : opts);
  };
  try { return fn(); } finally { Intl.DateTimeFormat = RealFormat; }
};

test('the website says a shift’s hours on the campaign’s clock, even where the server’s time-zone rules are old', () => {
  // 6:30–8:30 am in Surrey on Monday Nov 16, 2026 (UTC-7: B.C. no longer falls back).
  const stale = withOldRules(() => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date('2026-11-16T13:30:00Z')));
  assert.equal(stale, '05', 'the stand-in really is an hour off');
  const w = withOldRules(() => when('2026-11-16T13:30:00Z', '2026-11-16T15:30:00Z', TZ));
  assert.deepEqual([w.date, w.short, w.day, w.mon], ['Monday, November 16', 'Mon, Nov 16', '16', 'Nov']);
  assert.match(w.time, /^6:30–8:30\s?a\.m\.$/, 'the hours the app and the emails say');
  // Half past midnight on the 17th is the 17th, not 11:30 pm the day before.
  const late = withOldRules(() => when('2026-11-17T07:30:00Z', null, TZ));
  assert.deepEqual([late.date, late.day], ['Tuesday, November 17', '17']);
  assert.match(late.time, /^12:30\s?a\.m\.$/);
  assert.equal(withOldRules(() => dateOnly('2026-11-17T07:30:00Z', TZ)), 'November 17, 2026', 'a post’s date too');
  // Before the change every copy of the rules agrees: summer time as it was.
  assert.match(withOldRules(() => when('2025-07-02T13:30:00Z', '2025-07-02T15:30:00Z', TZ)).time, /^6:30–8:30\s?a\.m\.$/);
  // Another zone is the runtime's own.
  assert.match(when('2026-11-16T13:30:00Z', '2026-11-16T15:30:00Z', 'America/Toronto').time, /^8:30–10:30\s?a\.m\.$/);
});

test('signing up works from either list, and a kind changed later moves the shift', async () => {
  ok(await send('rsvp', { first_name: 'Ana', email: 'ana.site@example.org', shift_id: made.wave.id }));
  ok(await send('rsvp', { first_name: 'Ana', email: 'ana.site@example.org', shift_id: made.picnic.id }));
  const data = await loadData(db, await siteWorkspace(db, ws));
  assert.equal(data.events.find((e) => e.id === made.picnic.id).spots_left, 39);
  // The old shift is given a kind: it leaves the events for the openings only.
  ok(await mgr.action('shift.update', { id: made.old.id, kind: 'office' }));
  const after = await loadData(db, await siteWorkspace(db, ws));
  assert.deepEqual(after.events.map((e) => e.title), ['Family picnic']);
  assert.ok(after.shifts.some((e) => e.id === made.old.id));
  // And back to an event: the events only.
  ok(await mgr.action('shift.update', { id: made.old.id, kind: 'event' }));
  const back = await loadData(db, await siteWorkspace(db, ws));
  assert.deepEqual(back.events.map((e) => e.title), ['Family picnic', 'Town hall']);
  assert.ok(!back.shifts.some((e) => e.id === made.old.id));
  // A place taken off the list keeps its pin on the shifts that used it.
  const place = (await db.query('select place_id from shifts where id = $1', [made.wave.id])).rows[0].place_id;
  ok(await mgr.action('place.remove', { id: place }));
  const kept = (await loadData(db, await siteWorkspace(db, ws))).shifts.find((e) => e.id === made.wave.id);
  assert.deepEqual([kept.lat, kept.lng], [49.163, -122.8447]);
});

test('each list holds its own two dozen: many openings never push the events out', async () => {
  const days = Array.from({ length: 6 }, (_, i) => ahead(i + 1));
  for (const [start, end] of [['06:00', '07:00'], ['07:00', '08:00'], ['08:00', '09:00'], ['09:00', '10:00'], ['16:00', '17:00']]) {
    ok(await mgr.action('shift.createMany', { kind: 'mainstreet', location: 'Newton Exchange', days, start, end, public: true }));
  }
  const data = await loadData(db, await siteWorkspace(db, ws));
  assert.equal(data.shifts.length, 24, 'two dozen openings at most');
  assert.deepEqual(data.events.map((e) => e.title), ['Family picnic', 'Town hall'], 'the events are all still there');
});

test('a drop-in shift: the loader marks it and its card says "Drop in"; any other card is as it was', async () => {
  made.drop = ok(await mgr.action('shift.createMany', {
    // Soonest of all, so the two dozen above don't push it off the list.
    kind: 'office', location: 'Campaign office', days: [ahead(1)], start: '05:00', end: '09:00', drop_in: true, public: true,
  })).shifts[0];
  const rows = (await loadData(db, await siteWorkspace(db, ws))).shifts;
  assert.equal(rows.find((e) => e.id === made.drop.id).drop_in, true);
  assert.ok(rows.filter((e) => e.id !== made.drop.id).every((e) => !('drop_in' in e)), 'only a drop-in row carries the mark');
  const volunteer = (await hit('/site/volunteer')).text;
  assert.match(volunteer, /drop in 5:00[^<]*9:00/, 'after the date, in lower case');
  assert.doesNotMatch(volunteer, /[Dd]rop in (6:30|7:00|11:00)/, 'no other shift says it');
});
