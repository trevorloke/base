// Places, picked by tap (ext/schedule): saved once, offered again — this
// kind's most used first — and a point tapped on the map gets its name from
// the server: the nearest corner, else the nearest address, else the nearest
// door on file, else its coordinates. The BC Address Geocoder is a stand-in
// here (BC_GEOCODER_URL points at a host only this file answers); when it
// fails, is slow or answers nonsense the next rule names the place and the
// save still goes through.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { verifyChain } from '../lib/events.js';
import { _setNearestMsForTest } from '../lib/geocode.js';
import { pinName } from '@starbase/shared/shiftkinds';

const tag = Math.random().toString(36).slice(2, 8);
const realFetch = globalThis.fetch;
const env = { ...process.env };
const FAKE = 'http://bc-geocoder.test';
const asked = [];
// What the stand-in answers: per path, a function of the request's URL.
let service = {};
let mgr, vol, volId, other, db, ws;
const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.json)}`); return r.json; };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const corner = (name, degree = 4) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-122.8447, 49.163] }, properties: { intersectionName: name, degree, fullAddress: `${name}, Surrey, BC` } });
const site = (n, street, type) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-122.8447, 49.163] }, properties: { civicNumber: n, civicNumberSuffix: '', streetName: street, streetType: type, streetDirection: '', localityName: 'Surrey', fullAddress: `${n} ${street} ${type}, Surrey, BC` } });
const KG88 = { lat: 49.163, lng: -122.8447 };
const DAY = '2030-05-06';

before(async () => {
  db = await freshDb();
  for (const k of ['GEOCODER', 'BC_GEOCODER_KEY', 'STARBASE_PROVINCE']) delete process.env[k];
  process.env.BC_GEOCODER_URL = FAKE;
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (u.origin !== FAKE) return realFetch(url, opts);
    asked.push({ path: u.pathname, point: u.searchParams.get('point'), max: u.searchParams.get('maxDistance'), q: u.search });
    const answer = service[u.pathname];
    if (!answer) return json({}, 404);
    return answer(u, opts);
  };
  mgr = new Client();
  ws = (await mgr.signup({ workspaceName: `Places ${tag}`, email: `pl-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' })).json.workspace.id;
  const inv = ok(await mgr.action('member.invite', { email: `pl-vol+${tag}@example.org`, role: 'volunteer' }));
  vol = new Client();
  volId = ok(await vol.post('/api/auth/join', { token: inv.joinUrl.split('/join/')[1], name: 'Vik Example', password: 'places-pass-1' })).user.id;
  other = new Client();
  await other.signup({ workspaceName: `Elsewhere ${tag}`, email: `pl-other+${tag}@example.org` });
});
after(() => {
  globalThis.fetch = realFetch;
  for (const k of ['GEOCODER', 'BC_GEOCODER_URL', 'BC_GEOCODER_KEY', 'STARBASE_PROVINCE']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
});

const nameAt = async (pt = KG88) => ok(await mgr.get(`/api/places/name?lat=${pt.lat}&lng=${pt.lng}`));

test('a point on the map is named by its nearest corner', async () => {
  service = { '/intersections/nearest.json': () => json(corner('King George Blvd and 88 Ave')) };
  asked.length = 0;
  const r = await nameAt();
  assert.deepEqual(r, { name: 'King George Blvd & 88 Ave', source: 'corner' });
  assert.deepEqual(asked.map((a) => [a.path, a.point, a.max]), [['/intersections/nearest.json', '-122.8447,49.163', '150']], 'one call, lng first, within 150 m');
});

test('no corner in reach: the nearest address; neither: the nearest door on file; nothing: its coordinates', async () => {
  service = {
    '/intersections/nearest.json': () => json({}, 404),
    '/sites/nearest.json': () => json(site(8850, 'King George', 'Blvd')),
  };
  asked.length = 0;
  assert.deepEqual(await nameAt(), { name: 'near 8850 King George Blvd', address: '8850 King George Blvd, Surrey, BC', source: 'address' });
  assert.deepEqual(asked.map((a) => [a.path, a.max]), [['/intersections/nearest.json', '150'], ['/sites/nearest.json', '100']]);

  // The service has neither: the campaign's own nearest door, if one is near.
  service = {};
  await mgr.createPerson('Harjit Example', { address: '13450 104 Ave', city: 'Surrey', lat: 49.1906, lng: -122.8466 });
  await mgr.createPerson('Far Example', { address: '10355 King George Blvd', city: 'Surrey', lat: 49.1872, lng: -122.8433 });
  await other.createPerson('Theirs Example', { address: '13452 104 Ave', city: 'Surrey', lat: 49.19061, lng: -122.84661 });
  assert.deepEqual(await nameAt({ lat: 49.19065, lng: -122.84665 }), { name: 'near 13450 104 Ave', source: 'door' }, 'this campaign’s nearest door, never another’s');
  // Nothing anywhere near: a pin, with a real minus sign.
  assert.deepEqual(await nameAt(), { name: 'Pin at 49.1630, −122.8447', source: 'pin' });
});

test('a geocoder that fails, hangs or answers nonsense never blocks: the next rule names the place', async () => {
  const fallsThrough = async (why) => assert.deepEqual(await nameAt(), { name: 'Pin at 49.1630, −122.8447', source: 'pin' }, why);
  service = { '/intersections/nearest.json': () => json({ error: 'busy' }, 503), '/sites/nearest.json': () => json({ error: 'busy' }, 503) };
  await fallsThrough('503s');
  service = { '/intersections/nearest.json': () => { throw new TypeError('fetch failed'); }, '/sites/nearest.json': () => { throw new TypeError('fetch failed'); } };
  await fallsThrough('the network is down');
  service = { '/intersections/nearest.json': () => new Response('<html>hello</html>'), '/sites/nearest.json': () => new Response('not json') };
  await fallsThrough('not JSON');
  service = {
    '/intersections/nearest.json': () => json({ type: 'Feature', properties: { intersectionName: '', fullAddress: 'Surrey, BC' } }),
    '/sites/nearest.json': () => json({ type: 'Feature', properties: { fullAddress: 'Surrey, BC' } }),
  };
  await fallsThrough('an answer with no corner and no civic number in it');
  service = { '/intersections/nearest.json': () => json({ features: [] }), '/sites/nearest.json': () => json(null) };
  await fallsThrough('empty answers');
  // A corner that fails while the address answers: the address.
  service = { '/intersections/nearest.json': () => json({}, 500), '/sites/nearest.json': () => json({ features: [site(8850, 'King George', 'Blvd')] }) };
  assert.equal((await nameAt()).name, 'near 8850 King George Blvd', 'a list of one is read too');
  // A hang is given up on: the request carries a time limit. (The stand-in
  // would answer two seconds on, with a name that must never be used.)
  const hang = (u, opts) => new Promise((yes, no) => {
    const late = setTimeout(() => yes(json(corner('Too Late Rd and Never Ave'))), 2000);
    opts.signal.addEventListener('abort', () => { clearTimeout(late); no(new DOMException('timed out', 'TimeoutError')); });
  });
  service = { '/intersections/nearest.json': hang, '/sites/nearest.json': hang };
  _setNearestMsForTest(60);
  try { await fallsThrough('both hung'); } finally { _setNearestMsForTest(null); }
  // Lookups turned off: nothing is asked at all.
  service = { '/intersections/nearest.json': () => json(corner('King George Blvd and 88 Ave')) };
  process.env.GEOCODER = 'off';
  asked.length = 0;
  try { await fallsThrough('GEOCODER=off'); } finally { delete process.env.GEOCODER; }
  assert.equal(asked.length, 0);
  // Not a place on Earth: refused, nothing asked.
  for (const q of ['lat=91&lng=0', 'lat=49.1&lng=-181', 'lat=abc&lng=1', '']) assert.equal((await mgr.get(`/api/places/name?${q}`)).status, 400, q);
});

test('saving a place: by tap on the map (the server names it), by name, once per name', async () => {
  service = { '/intersections/nearest.json': () => json(corner('King George Blvd and 88 Ave')) };
  const made = ok(await mgr.action('place.save', { ...KG88, source: 'map' }));
  assert.deepEqual([made.place.name, made.place.lat, made.place.lng, made.place.source], ['King George Blvd & 88 Ave', 49.163, -122.8447, 'map']);
  // The same corner again is the same place — no second chip.
  const again = ok(await mgr.action('place.save', { ...KG88, source: 'map' }));
  assert.deepEqual([again.place.id, again.duplicate], [made.place.id, true]);
  // The geocoder down: the save still goes through, named by the next rule.
  service = {};
  const pin = ok(await mgr.action('place.save', { lat: 49.1045, lng: -122.801, source: 'map' }));
  assert.equal(pin.place.name, 'Pin at 49.1045, −122.8010');
  // A name of its own (renaming is the only typing); a pin is optional.
  const office = ok(await mgr.action('place.save', { name: '  Campaign office ', source: 'typed' }));
  assert.deepEqual([office.place.name, office.place.lat, office.place.lng], ['Campaign office', null, null]);
  // The same name with a pin later: the place gets its pin.
  const pinned = ok(await mgr.action('place.save', { name: 'campaign OFFICE', lat: 49.19, lng: -122.85 }));
  assert.deepEqual([pinned.place.id, pinned.place.name, pinned.place.lat, pinned.duplicate], [office.place.id, 'Campaign office', 49.19, true]);
  assert.equal((await mgr.action('place.save', {})).status, 400, 'a name or a point');
  assert.equal((await mgr.action('place.save', { lat: 49.1 })).status, 400, 'half a point');
  assert.equal((await mgr.action('place.save', { name: 'x'.repeat(201) })).status, 400);

  const list = ok(await mgr.get('/api/places')).places;
  assert.deepEqual(list.map((p) => p.name), ['Campaign office', 'King George Blvd & 88 Ave', 'Pin at 49.1045, −122.8010'], 'with no kind asked: by name');
  // On the log, like every write.
  const events = (await db.query(`select action, op, payload from events where workspace_id = $1 and entity_type = 'place' order by seq`, [ws])).rows;
  assert.deepEqual(events.map((e) => [e.action, e.op, e.payload.name ?? null]), [
    ['place.save', 'create', 'King George Blvd & 88 Ave'], ['place.save', 'create', 'Pin at 49.1045, −122.8010'],
    ['place.save', 'create', 'Campaign office'], ['place.save', 'update', null],
  ]);
  assert.equal((await verifyChain(db, ws)).ok, true);
});

test('who may: the desk and a volunteer granted Shifts; never another campaign', async () => {
  assert.equal((await vol.action('place.save', { name: 'Newton Exchange' })).status, 403);
  assert.equal((await vol.get('/api/places')).status, 403);
  assert.equal((await vol.get('/api/places/name?lat=49.1&lng=-122.8')).status, 403);
  ok(await mgr.action('permission.member.set', { user_id: volId, grant: ['shifts'], deny: [] }));
  const made = ok(await vol.action('place.save', { name: 'Newton Exchange' }), 'granted Shifts');
  assert.ok(ok(await vol.get('/api/places')).places.some((p) => p.id === made.place.id));
  // The nearest door on file is the desk's to know: a volunteer's point
  // (granted Shifts, their own doors scoped to their turfs) falls to its pin.
  const door = { lat: 49.19065, lng: -122.84665 };
  const q = `/api/places/name?lat=${door.lat}&lng=${door.lng}`;
  assert.deepEqual(ok(await mgr.get(q)), { name: 'near 13450 104 Ave', source: 'door' }, 'the desk');
  assert.deepEqual(ok(await vol.get(q)), { name: pinName(door.lat, door.lng), source: 'pin' }, 'never an address on file');
  const pinned = ok(await vol.action('place.save', { ...door, source: 'map' })).place;
  assert.equal(pinned.name, pinName(door.lat, door.lng), 'nor by saving the point');
  ok(await mgr.action('place.remove', { id: pinned.id }));
  ok(await mgr.action('permission.member.set', { user_id: volId, grant: [], deny: [] }));
  assert.deepEqual(ok(await other.get('/api/places')).places, [], 'another campaign has its own list');
  assert.equal((await other.action('place.rename', { id: made.place.id, name: 'Theirs now' })).status, 404);
  assert.equal((await other.action('place.remove', { id: made.place.id })).status, 404);
  assert.equal((await other.action('shift.create', { title: 'x', place_id: made.place.id, starts_at: `${DAY}T06:30:00-07:00` })).status, 400, 'nor book a shift at it');
});

test('a shift at a saved place carries its name and its pin; new words leave the place behind', async () => {
  const places = ok(await mgr.get('/api/places')).places;
  const kg = places.find((p) => p.name === 'King George Blvd & 88 Ave');
  const office = places.find((p) => p.name === 'Campaign office');
  const s = ok(await mgr.action('shift.create', {
    title: 'Morning wave', kind: 'burma_shave', place_id: kg.id, starts_at: `${DAY}T06:30:00-07:00`, ends_at: `${DAY}T08:30:00-07:00`,
  })).shift;
  assert.equal(s.location, 'King George Blvd & 88 Ave', 'the place’s name is the words shown');
  const read = async () => ok(await mgr.get(`/api/shifts/${s.id}`)).shift;
  assert.deepEqual([(await read()).place_id, (await read()).place_lat, (await read()).place_lng], [kg.id, 49.163, -122.8447]);
  const inList = ok(await vol.get('/api/shifts')).shifts.find((x) => x.id === s.id);
  assert.deepEqual([inList.location, inList.place_lat, inList.place_lng], ['King George Blvd & 88 Ave', 49.163, -122.8447], 'a volunteer’s list has the pin for a map link');

  // Moved to another saved place: its name and (made) title follow.
  ok(await mgr.action('shift.update', { id: s.id, title: null }));
  ok(await mgr.action('shift.update', { id: s.id, place_id: office.id }));
  let now = await read();
  assert.deepEqual([now.place_id, now.location, now.title], [office.id, 'Campaign office', 'Burma Shave — Campaign office']);
  // Words typed over it (the long form): the saved place no longer says where.
  ok(await mgr.action('shift.update', { id: s.id, location: 'Behind the rec centre' }));
  now = await read();
  assert.deepEqual([now.place_id, now.location, now.place_lat, now.title], [null, 'Behind the rec centre', null, 'Burma Shave — Behind the rec centre']);
  assert.equal((await mgr.action('shift.update', { id: s.id, place_id: '99999999-9999-4999-8999-999999999999' })).status, 400);
  ok(await mgr.action('shift.update', { id: s.id, place_id: kg.id }));
});

test('the chips for a kind: its own most-used places first, then the other saved places, then words already on shifts', async () => {
  const byName = Object.fromEntries(ok(await mgr.get('/api/places')).places.map((p) => [p.name, p]));
  const at = (h) => ({ starts_at: `2030-05-07T${h}:00:00-07:00` });
  // Burma Shave: twice at the pin, once at King George (the shift above). A phone bank at the office, twice.
  for (const h of ['06', '16']) ok(await mgr.action('shift.create', { title: 'BS', kind: 'burma_shave', place_id: byName['Pin at 49.1045, −122.8010'].id, ...at(h) }));
  for (const h of ['18', '19']) ok(await mgr.action('shift.create', { title: 'PB', kind: 'phone_bank', place_id: byName['Campaign office'].id, ...at(h) }));
  // Words on shifts made the old way: one used twice for burmashave (by role), one once elsewhere.
  for (const h of ['07', '08']) ok(await mgr.action('shift.create', { title: 'Old wave', role: 'burmashave', location: 'Scott Rd & 72 Ave', ...at(h) }));
  ok(await mgr.action('shift.create', { title: 'Old canvass', role: 'doorknocking', location: 'Newton Rec Centre', ...at('10') }));
  ok(await mgr.action('shift.create', { title: 'Same words as a saved place', location: 'campaign office', ...at('11') }));
  const called = ok(await mgr.action('shift.create', { title: 'Called off', location: 'Nowhere now', ...at('12') })).shift;
  ok(await mgr.action('shift.delete', { id: called.id }));

  const r = ok(await mgr.get('/api/places?kind=burma_shave'));
  assert.deepEqual(r.places.map((p) => [p.name, p.kind_uses, p.uses]), [
    ['Pin at 49.1045, −122.8010', 2, 2],
    ['King George Blvd & 88 Ave', 1, 1],
    ['Campaign office', 0, 2],
    ['Newton Exchange', 0, 0],
  ]);
  assert.deepEqual(r.words.map((w) => [w.name, w.kind_uses, w.uses]), [['Scott Rd & 72 Ave', 2, 2], ['Newton Rec Centre', 0, 1]],
    'not a saved place’s own name, not a called-off shift’s');
  const phones = ok(await mgr.get('/api/places?kind=phone_bank'));
  assert.equal(phones.places[0].name, 'Campaign office');
  assert.equal((await mgr.get('/api/places?kind=parade')).status, 400);
});

test('renaming a place renames it on the shifts still to come; removing it takes it off the list only', async () => {
  const kg = ok(await mgr.get('/api/places')).places.find((p) => p.name === 'King George Blvd & 88 Ave');
  // One shift to come with a made name, one with a typed name, one long over.
  const typed = ok(await mgr.action('shift.create', { title: 'Typed', kind: 'burma_shave', place_id: kg.id, starts_at: `${DAY}T16:00:00-07:00` })).shift;
  const past = ok(await mgr.action('shift.create', { title: 'Long ago', kind: 'burma_shave', place_id: kg.id, starts_at: '2020-05-04T06:30:00-07:00' })).shift;
  ok(await mgr.action('shift.update', { id: past.id, title: null }));
  const made = ok(await mgr.get('/api/shifts')).shifts.find((s) => s.title === 'Burma Shave — King George Blvd & 88 Ave');
  assert.ok(made, 'the made-name shift from before');

  assert.equal((await mgr.action('place.rename', { id: kg.id, name: 'campaign office' })).status, 409, 'another place has that name');
  assert.equal((await mgr.action('place.rename', { id: kg.id, name: '   ' })).status, 400);
  const r = ok(await mgr.action('place.rename', { id: kg.id, name: 'King George & 88 (north-east corner)' }));
  assert.equal(r.place.name, 'King George & 88 (north-east corner)');
  assert.equal(r.shifts, 2, 'the two still to come');
  const shift = async (id) => ok(await mgr.get(`/api/shifts/${id}`)).shift;
  assert.deepEqual([(await shift(made.id)).location, (await shift(made.id)).title], ['King George & 88 (north-east corner)', 'Burma Shave — King George & 88 (north-east corner)']);
  assert.deepEqual([(await shift(typed.id)).location, (await shift(typed.id)).title], ['King George & 88 (north-east corner)', 'Typed'], 'a typed name is kept');
  assert.deepEqual([(await shift(past.id)).location, (await shift(past.id)).title], ['King George Blvd & 88 Ave', 'Burma Shave — King George Blvd & 88 Ave'], 'what is over stays as it was');

  ok(await mgr.action('place.remove', { id: kg.id }));
  assert.ok(!ok(await mgr.get('/api/places')).places.some((p) => p.id === kg.id), 'off the list');
  assert.equal((await mgr.action('place.remove', { id: kg.id })).status, 404);
  assert.equal((await mgr.action('shift.update', { id: typed.id, place_id: kg.id })).status, 400, 'no longer offered');
  const kept = await shift(made.id);
  assert.deepEqual([kept.location, kept.place_lat, kept.place_lng], ['King George & 88 (north-east corner)', 49.163, -122.8447], 'the shift keeps its words and its pin');
  // The same name can be saved again.
  ok(await mgr.action('place.save', { name: 'King George & 88 (north-east corner)' }));
  assert.equal((await verifyChain(db, ws)).ok, true);
});

test('a point nothing could name: "Pinned place" in a made name, its coordinates kept as its details; named later, the shifts follow', async () => {
  const pin = ok(await mgr.get('/api/places')).places.find((p) => p.name === 'Pin at 49.1045, −122.8010');
  const made = ok(await mgr.action('shift.createMany', { kind: 'mainstreet', place_id: pin.id, days: [DAY], start: '07:00', end: '09:00' })).shifts[0];
  const shift = async () => ok(await mgr.get(`/api/shifts/${made.id}`)).shift;
  let s = await shift();
  assert.deepEqual([s.title, s.location, s.place_lat, s.place_lng, s.need], ['Mainstreet — Pinned place', 'Pin at 49.1045, −122.8010', 49.1045, -122.801, null],
    'the name says "Pinned place"; where it is stays in the words and the pin; and no number was asked for, so it has none');
  const moved = ok(await mgr.action('shift.createMany', { kind: 'burma_shave', location: 'Scott Rd & 72 Ave', days: [DAY], start: '06:30', end: '08:30' })).shifts[0];
  ok(await mgr.action('shift.update', { id: moved.id, place_id: pin.id }));
  assert.equal(ok(await mgr.get(`/api/shifts/${moved.id}`)).shift.title, 'Burma Shave — Pinned place', 'a made name that follows its place there says the same');
  // "Name it": the place gets a name, and the shifts to come say it.
  const r = ok(await mgr.action('place.rename', { id: pin.id, name: 'Scott Road Station' }));
  assert.ok(r.shifts >= 2);
  s = await shift();
  assert.deepEqual([s.title, s.location, s.place_lat], ['Mainstreet — Scott Road Station', 'Scott Road Station', 49.1045]);
});

test('the address service is asked at most 60 times a minute from here', async () => {
  service = { '/intersections/nearest.json': () => json(corner('King George Blvd and 88 Ave')) };
  let named = 0;
  for (let i = 0; i < 70; i += 1) if ((await nameAt()).source === 'corner') named += 1;
  assert.ok(named < 70, 'past the limit a place is named without the service');
  assert.equal((await nameAt()).source, 'pin', 'by the next rule that needs no one else');
});
