// Addresses that find their own place (ext/addresses): suggestions as you
// type — the campaign's own doors first, then the address service's — and a
// person saved with an address and no pin placed just after the save. The
// BC Address Geocoder is a stand-in here (fetch is replaced).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';

const tag = Math.random().toString(36).slice(2, 8);
const realFetch = globalThis.fetch;
const env = { ...process.env };
const asked = [];
let mgr, vol, other, db;
let down = false;

// The service: an autocomplete answer for suggestions, one match for a lookup.
const feature = (n, street, type, lng, lat, precision = 'CIVIC_NUMBER') => ({
  geometry: { coordinates: [lng, lat] },
  properties: { civicNumber: n, civicNumberSuffix: '', streetName: street, streetType: type, streetDirection: '',
    localityName: 'Surrey', fullAddress: `${n} ${street} ${type}, Surrey, BC`, matchPrecision: precision, score: 95 },
});
const BOOK = {
  '13450 104 Ave': feature(13450, '104', 'Ave', -122.8466, 49.1906),
  '13460 104 Ave': feature(13460, '104', 'Ave', -122.8461, 49.1907),
  '10355 King George Blvd': feature(10355, 'King George', 'Blvd', -122.8433, 49.1872),
};

before(async () => {
  db = await freshDb();
  delete process.env.GEOCODER;
  globalThis.fetch = async (url, opts) => {
    const u = new URL(String(url));
    if (u.hostname !== 'geocoder.api.gov.bc.ca') return realFetch(url, opts);
    const q = u.searchParams.get('addressString');
    asked.push({ q, auto: u.searchParams.get('autoComplete') === 'true', bbox: u.searchParams.get('bbox') });
    if (down) return new Response('busy', { status: 503 });
    if (u.searchParams.get('autoComplete') === 'true') {
      const hits = Object.entries(BOOK).filter(([k]) => k.toLowerCase().includes(q.toLowerCase().replace(/,.*$/, ''))).map(([, f]) => f);
      // A street-only match is never offered as a door.
      hits.push(feature('', '104', 'Ave', -122.85, 49.19, 'STREET'));
      return new Response(JSON.stringify({ features: hits }));
    }
    const key = Object.keys(BOOK).find((k) => q.toLowerCase().startsWith(k.toLowerCase()));
    return new Response(JSON.stringify({ features: key ? [BOOK[key]] : [] }));
  };
  mgr = new Client();
  await mgr.signup({ workspaceName: `Addresses ${tag}`, email: `ad-mgr+${tag}@example.org`, jurisdiction: 'bc-municipal' });
  const inv = await mgr.action('member.invite', { email: `ad-vol+${tag}@example.org`, role: 'volunteer' });
  vol = new Client();
  await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Ana Example', password: 'address-pass-1' });
  other = new Client();
  await other.signup({ workspaceName: `Elsewhere ${tag}`, email: `ad-other+${tag}@example.org` });
});
after(() => {
  globalThis.fetch = realFetch;
  for (const k of ['GEOCODER', 'GEOCODE_ON_SAVE']) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
});

const ok = (r, msg) => { assert.equal(r.status, 200, `${msg || ''} ${JSON.stringify(r.json)}`); return r.json; };
const suggest = async (c, q) => ok(await c.get(`/api/address/suggest?q=${encodeURIComponent(q)}`), q);
const until = async (fn, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end;) { const v = await fn(); if (v) return v; await new Promise((r) => { setTimeout(r, 40); }); }
  return fn();
};
const person = async (id) => (await db.query('select lat, lng, attrs from persons where id = $1', [id])).rows[0];

test('suggestions: the campaign’s own doors first, then the service’s — doors only, each with its pin', async () => {
  await mgr.createPerson('Harjit Example', { address: '13450 104 Ave', city: 'Surrey', lat: 49.1906, lng: -122.8466 });
  await other.createPerson('Theirs Example', { address: '13470 104 Ave', city: 'Surrey', lat: 49.19, lng: -122.84 });
  assert.deepEqual((await suggest(mgr, '13')).suggestions, [], 'too short: nothing, and nothing asked');
  asked.length = 0;
  const r = await suggest(mgr, '104 Ave');
  assert.equal(r.lookup, 'ok');
  assert.deepEqual(r.suggestions.map((s) => [s.address, s.source]), [
    ['13450 104 Ave', 'map'],
    ['13460 104 Ave', 'lookup'],
  ], 'the door on file once, the service’s other door after it; no street-only match; not another campaign’s door');
  const [mine, theirs] = r.suggestions;
  assert.deepEqual([mine.house_number, mine.street, mine.lat, mine.lng], ['13450', '104 Ave', 49.1906, -122.8466]);
  assert.deepEqual([theirs.house_number, theirs.street, theirs.city, theirs.lat, theirs.lng], ['13460', '104 Ave', 'Surrey', 49.1907, -122.8461]);
  assert.ok(asked[0].auto && /^-122\.92,49\.002,-122\.67,49\.222$/.test(asked[0].bbox), `asked in the campaign’s box: ${asked[0].bbox}`);
  assert.equal((await suggest(vol, 'King George')).suggestions[0].address, '10355 King George Blvd', 'a volunteer may ask too');
  assert.equal((await new Client().get('/api/address/suggest?q=104 Ave')).status, 401);
});

test('suggestions with the service down or off: the doors on file still come, and the page is told', async () => {
  down = true;
  const r = await suggest(mgr, '13450');
  assert.equal(r.lookup, 'unavailable');
  assert.deepEqual(r.suggestions.map((s) => s.address), ['13450 104 Ave']);
  down = false;
  process.env.GEOCODER = 'off';
  asked.length = 0;
  const off = await suggest(mgr, '104 Ave');
  assert.equal(off.lookup, 'off');
  assert.equal(asked.length, 0);
  delete process.env.GEOCODER;
});

test('saved with an address and no pin: placed just after the save; at a door on file, its pin is copied without asking', async () => {
  process.env.GEOCODE_ON_SAVE = 'on';
  const kg = await mgr.createPerson('Kim Example', { address: '10355 King George Blvd', city: 'Surrey' });
  const placed = await until(async () => (await person(kg.id)).lat != null);
  assert.ok(placed, 'placed');
  const p = await person(kg.id);
  assert.deepEqual([Number(p.lat), Number(p.lng), p.attrs.geocode.status], [49.1872, -122.8433, 'ok']);
  asked.length = 0;
  const mate = await mgr.createPerson('Mo Example', { address: '13450 104 Ave', city: 'Surrey' });
  assert.ok(await until(async () => (await person(mate.id)).lat != null), 'Harjit’s pin copied');
  assert.equal(asked.length, 0, 'no lookup for a door already on the map');
  assert.equal((await person(mate.id)).attrs.geocode.copied, true);
  // A pin that came with the save is never looked up again.
  asked.length = 0;
  await mgr.createPerson('Pinned Example', { address: '13460 104 Ave', city: 'Surrey', lat: 49.19, lng: -122.84 });
  await new Promise((r) => { setTimeout(r, 300); });
  assert.equal(asked.length, 0);
  process.env.GEOCODE_ON_SAVE = 'off';
});

test('an address it can’t place is marked for a pin by hand; fixed, it is looked up again', async () => {
  process.env.GEOCODE_ON_SAVE = 'on';
  const typo = await mgr.createPerson('Typo Example', { address: '99999 Nowhere Rd', city: 'Surrey' });
  assert.ok(await until(async () => (await person(typo.id)).attrs.geocode?.status === 'nomatch'), 'nomatch');
  ok(await mgr.action('person.update', { id: typo.id, address: '13460 104 Ave' }), 'the address fixed');
  assert.ok(await until(async () => (await person(typo.id)).lat != null), 'placed after the fix');
  assert.equal((await person(typo.id)).attrs.geocode.status, 'ok');
  // With the service down the person waits, unmarked, for the desk's run.
  down = true;
  const later = await mgr.createPerson('Later Example', { address: '13450 104 Ave', city: 'Delta' });
  await new Promise((r) => { setTimeout(r, 400); });
  const w = await person(later.id);
  assert.equal(w.lat, null);
  assert.equal(w.attrs.geocode, undefined, 'not set aside: the background run will try it');
  down = false;
  process.env.GEOCODE_ON_SAVE = 'off';
});

test('a fixed address goes back into the background run’s queue even with lookups on save off', async () => {
  const p = await mgr.createPerson('Queue Example', { address: '1 Gone Rd', city: 'Surrey' });
  await db.query(`update persons set attrs = jsonb_set(attrs, '{geocode}', '{"status":"nomatch"}') where id = $1`, [p.id]);
  ok(await mgr.action('person.update', { id: p.id, address: '13460 104 Ave' }));
  assert.equal((await person(p.id)).attrs.geocode, undefined);
  assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);
});

test('a sign at a different address than the supporter’s home never takes their home’s pin', async () => {
  const p = await mgr.createPerson('Sign Example', { address: '13450 104 Ave', city: 'Surrey', lat: 49.1906, lng: -122.8466 });
  const home = ok(await mgr.action('sign.place', { kind: 'lawn', person_id: p.id })).sign;
  const shop = ok(await mgr.action('sign.place', { kind: 'large', person_id: p.id, address: '10355 King George Blvd' })).sign;
  const pinned = ok(await mgr.action('sign.place', { kind: 'billboard', person_id: p.id, address: '10355 King George Blvd', lat: 49.1872, lng: -122.8433 })).sign;
  const row = async (id) => (await db.query('select address, lat, lng from signs where id = $1', [id])).rows[0];
  assert.equal(Number((await row(home.id)).lat), 49.1906, 'at home: the home pin');
  assert.deepEqual(await row(shop.id), { address: '10355 King George Blvd', lat: null, lng: null }, 'elsewhere: no wrong pin');
  assert.equal(Number((await row(pinned.id)).lat), 49.1872, 'elsewhere with its own pin (a picked address)');
});
