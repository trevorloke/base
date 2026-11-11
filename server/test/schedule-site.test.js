// The website lists a public shift by what it is (ext/schedule kinds, read
// by ext/site/loaders.js): an Event with the events, every other kind with
// the volunteer openings — so a 6:30 am Burma Shave is no longer the home
// page's "Next event". A shift from before kinds is in both lists, as it
// always was. A place picked on the map gives its card a map link.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, dayOf, instantOf } from '@starbase/shared/dayparts';

const { hit, send, ok, campaign } = await import('./site-helpers.js');
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
    assert.deepEqual(Object.keys(row).sort(), ['ends_at', 'id', 'lat', 'lng', 'location', 'spots_left', 'starts_at', 'title']);
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
