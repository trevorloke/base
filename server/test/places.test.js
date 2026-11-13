// Google's address suggestions (lib/places.js, ext/addresses /address/suggest
// and /address/place): off unless ADDRESS_SUGGEST=google; Google and the
// B.C. service asked together within one 4 s budget; a pick resolved to
// words and placed by B.C.; refusals paused; every call bounded. Google and
// the B.C. service are stand-ins (fetch is replaced); no test reaches the
// network.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDb, Client } from './helpers.js';
import { placesSuggest, placeDetails, probePlaces, placesHealth, addressSuggester, _setPlacesLogoForTest, _resetPlacesForTest } from '../lib/places.js';
import { today, _resetForTest as resetUsage } from '../lib/gusage.js';

const env = { ...process.env };
const realFetch = globalThis.fetch;
const KEYS = ['GOOGLE_MAPS_SERVER_KEY', 'ADDRESS_SUGGEST', 'GEOCODER', 'STARBASE_GEO_BOUNDS', 'GOOGLE_PLACES_DAILY_MAX', 'GOOGLE_PLACES_PER_PERSON'];
const asked = []; // { host, path, method, headers, body, search }
let mgr, vol, db;

// The stand-ins' answers, set per test.
let autocomplete = null; // { status, body } | null (the street rows below)
let details = null;
let bc = null; // B.C.'s features, or null: none
let googleMs = 0; // Google's delay (Infinity: never answers)
let bcMs = 0;
const ROWS = { suggestions: [
  { placePrediction: { placeId: 'ChIJstreet1', types: ['street_address', 'geocode'], structuredFormat: { mainText: { text: '13450 104 Ave' }, secondaryText: { text: 'Surrey, BC, Canada' } } } },
  { placePrediction: { placeId: 'ChIJroute', types: ['route', 'geocode'], structuredFormat: { mainText: { text: '104 Ave' }, secondaryText: { text: 'Surrey, BC, Canada' } } } },
  { placePrediction: { placeId: 'ChIJnumber', types: ['geocode'], structuredFormat: { mainText: { text: '13460 104 Ave' }, secondaryText: { text: 'Surrey, BC, Canada' } } } },
  { queryPrediction: { text: { text: '13450 104 Ave pizza' } } },
] };
const DETAILS = {
  formattedAddress: '1203-13450 104 Ave, Surrey, BC V3T 1V3, Canada',
  addressComponents: [
    { longText: '1203', shortText: '1203', types: ['subpremise'] },
    { longText: '13450', shortText: '13450', types: ['street_number'] },
    { longText: '104 Avenue', shortText: '104 Ave', types: ['route'] },
    { longText: 'Surrey', shortText: 'Surrey', types: ['locality', 'political'] },
    { longText: 'V3T 1V3', shortText: 'V3T 1V3', types: ['postal_code'] },
  ],
};
const BC_DOOR = [{ geometry: { coordinates: [-122.8466, 49.1906] }, properties: { civicNumber: 13450, civicNumberSuffix: '', streetName: '104', streetType: 'Ave', streetDirection: '',
  localityName: 'Surrey', fullAddress: '13450 104 Ave, Surrey, BC', matchPrecision: 'CIVIC_NUMBER', score: 98 } }];
const API_BLOCKED = { error: { code: 403, message: 'Requests to this API places.googleapis.com method google.maps.places.v1.Places.AutocompletePlaces are blocked.', status: 'PERMISSION_DENIED',
  details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_SERVICE_BLOCKED', domain: 'googleapis.com' }] } };
const API_OFF = { error: { code: 403, message: 'Places API (New) has not been used in project 1 before or it is disabled.', status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED' }] } };
const QUOTA = { error: { code: 429, message: 'Quota exceeded for quota metric.', status: 'RESOURCE_EXHAUSTED' } };

const later = (ms, signal, make) => new Promise((resolve, reject) => {
  signal?.addEventListener('abort', () => reject(signal.reason));
  if (ms !== Infinity) setTimeout(() => resolve(make()), ms);
});
const standIn = async (url, init = {}) => {
  const u = new URL(String(url));
  const entry = { host: u.hostname, path: u.pathname, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null, search: u.searchParams };
  if (u.hostname === 'places.googleapis.com') {
    asked.push(entry);
    const a = u.pathname === '/v1/places:autocomplete' ? autocomplete : details;
    const out = a || { status: 200, body: u.pathname === '/v1/places:autocomplete' ? ROWS : DETAILS };
    return later(googleMs, init.signal, () => new Response(JSON.stringify(out.body), { status: out.status }));
  }
  if (u.hostname === 'geocoder.api.gov.bc.ca') {
    asked.push(entry);
    return later(bcMs, init.signal, () => new Response(JSON.stringify({ features: bc || [] })));
  }
  throw new Error(`no stand-in for ${u.hostname}`);
};
const toGoogle = (path) => asked.filter((a) => a.host === 'places.googleapis.com' && (!path || a.path === path)).length;
const toBc = () => asked.filter((a) => a.host === 'geocoder.api.gov.bc.ca').length;

before(async () => {
  for (const k of KEYS) delete process.env[k];
  db = await freshDb();
  globalThis.fetch = standIn;
  mgr = new Client();
  await mgr.signup({ workspaceName: 'Places Example', email: 'pl-mgr@example.org', jurisdiction: 'bc-municipal' });
  const inv = await mgr.action('member.invite', { email: 'pl-vol@example.org', role: 'volunteer' });
  vol = new Client();
  await vol.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Vic Example', password: 'places-pass-1' });
});
after(() => {
  globalThis.fetch = realFetch;
  _setPlacesLogoForTest(null);
  for (const k of KEYS) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
});
beforeEach(async () => {
  await db.query('delete from google_usage');
  process.env.GOOGLE_MAPS_SERVER_KEY = 'places-key';
  process.env.ADDRESS_SUGGEST = 'google';
  for (const k of ['GEOCODER', 'STARBASE_GEO_BOUNDS', 'GOOGLE_PLACES_DAILY_MAX', 'GOOGLE_PLACES_PER_PERSON']) delete process.env[k];
  _setPlacesLogoForTest(true);
  _resetPlacesForTest();
  resetUsage();
  autocomplete = null; details = null; bc = BC_DOOR; googleMs = 0; bcMs = 0;
  asked.length = 0;
});

const suggest = (c, q, extra = '') => c.get(`/api/address/suggest?q=${encodeURIComponent(q)}${extra}`);
const place = (c, id, session) => c.get(`/api/address/place?id=${encodeURIComponent(id)}&session=${encodeURIComponent(session)}`);
const timed = async (fn) => { const t = Date.now(); const r = await fn(); return { r, ms: Date.now() - t }; };
const awake = () => setInterval(() => {}, 1000); // (abort timers don't hold a test process open)

// ── The library ──
test('autocomplete: the key in a header, Canada and the campaign’s box, the session; only doors kept, with no pin', async () => {
  process.env.STARBASE_GEO_BOUNDS = '49.002,-122.92|49.222,-122.67';
  const session = randomUUID();
  const rows = await placesSuggest('13450 104', { session });
  assert.equal(toGoogle(), 1);
  const a = asked[0];
  assert.deepEqual([a.method, a.path], ['POST', '/v1/places:autocomplete']);
  assert.equal(a.headers['X-Goog-Api-Key'], 'places-key');
  assert.equal(a.headers['Content-Type'], 'application/json');
  assert.equal(a.search.get('key'), null, 'never in the address');
  assert.deepEqual(a.body, {
    input: '13450 104', sessionToken: session, includedRegionCodes: ['ca'], languageCode: 'en-CA', regionCode: 'ca',
    locationRestriction: { rectangle: { low: { latitude: 49.002, longitude: -122.92 }, high: { latitude: 49.222, longitude: -122.67 } } },
  });
  assert.deepEqual(rows, [
    { place_id: 'ChIJstreet1', label: '13450 104 Ave', sub: 'Surrey, BC, Canada', source: 'google' },
    { place_id: 'ChIJnumber', label: '13460 104 Ave', sub: 'Surrey, BC, Canada', source: 'google' },
  ], 'a street address, or words that start with a number; never a route or a query');
  for (const bad of [undefined, 'abc', '123e4567-e89b-12d3-a456-426614174000' /* v1 */]) {
    assert.equal((await placesSuggest('13450 104', { session: bad })).error, 'That address box needs to start again — type the address once more');
  }
  assert.equal(toGoogle(), 1, 'a bad session asks nobody');
});

test('details: only the address asked for (never location); a unit from subpremise; words, no pin', async () => {
  const session = randomUUID();
  const d = await placeDetails('ChIJstreet1', { session });
  const a = asked[0];
  assert.equal(a.path, '/v1/places/ChIJstreet1');
  assert.equal(a.headers['X-Goog-FieldMask'], 'addressComponents,formattedAddress');
  assert.doesNotMatch(a.headers['X-Goog-FieldMask'], /location/);
  assert.deepEqual([a.search.get('sessionToken'), a.search.get('languageCode'), a.search.get('regionCode')], [session, 'en-CA', 'ca']);
  assert.deepEqual(d, { address: '13450 104 Ave', house_number: '13450', street: '104 Ave', unit: '1203', city: 'Surrey', postal: 'V3T 1V3', label: '1203-13450 104 Ave, Surrey, BC V3T 1V3, Canada' });
  assert.equal((await placeDetails('bad id!', { session })).error, 'That address box needs to start again — type the address once more');
});

test('a key limited to other services: api-blocked, with Places API (New) in the words; no key in them', async () => {
  autocomplete = { status: 403, body: API_BLOCKED };
  const r = await placesSuggest('13450 104', { session: randomUUID() });
  assert.equal(r.trouble.code, 'api-blocked');
  assert.match(r.trouble.plain, /Places API \(New\)/);
  assert.equal(r.trouble.step, 'Recipe B step 4');
  assert.deepEqual([placesHealth().paused.code, placesHealth().last.code], ['api-blocked', 'api-blocked']);
  assert.doesNotMatch(JSON.stringify(placesHealth()), /places-key/);
});

test('the pause: 10 minutes after Places is off for the key, 60 s after quota', async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    autocomplete = { status: 403, body: API_OFF };
    await placesSuggest('13450 104', { session: randomUUID() });
    assert.equal(placesHealth().paused.code, 'api-off');
    autocomplete = null;
    now += 599_000;
    assert.equal((await placesSuggest('13450 104', { session: randomUUID() })).paused, true, 'still paused at 9 min 59 s');
    now += 2000;
    assert.ok(Array.isArray(await placesSuggest('13450 104', { session: randomUUID() })), 'asked again after 10 min');
    autocomplete = { status: 429, body: QUOTA };
    await placesSuggest('13450 104', { session: randomUUID() });
    assert.equal(placesHealth().paused.code, 'quota');
    autocomplete = null;
    now += 59_000;
    assert.equal((await placesSuggest('13450 104', { session: randomUUID() })).paused, true);
    now += 2000;
    assert.ok(Array.isArray(await placesSuggest('13450 104', { session: randomUUID() })), 'asked again after 60 s');
    assert.equal(toGoogle(), 4);
  } finally { Date.now = realNow; }
});

test('the probe: ignores the pause, clears it, cached 30 s, counted as a probe and never against the ceiling', async () => {
  autocomplete = { status: 403, body: API_OFF };
  await placesSuggest('13450 104', { session: randomUUID() });
  assert.ok(placesHealth().paused);
  autocomplete = null;
  const p = await probePlaces();
  assert.deepEqual([p.ok, p.example], [true, '13450 104 Ave']);
  assert.equal(placesHealth().paused, null, 'a good probe lifts the pause');
  assert.equal(asked.at(-1).body.input, '100');
  await probePlaces();
  assert.equal(toGoogle(), 2, 'the second probe within 30 s is the first’s answer');
  const u = today();
  assert.deepEqual([u.probe, u.autocomplete], [1, 1], 'the probe under probe; only the real ask counts');
  // Works with suggestions off: the owner can test the key first.
  delete process.env.ADDRESS_SUGGEST;
  _resetPlacesForTest();
  assert.equal((await probePlaces()).ok, true);
});

test('every call stops at its limit: autocomplete 3 s, details 2.5 s, the probe 8 s', async () => {
  const keep = awake();
  googleMs = Infinity;
  try {
    const [a, d, p] = await Promise.all([
      timed(() => placesSuggest('13450 104', { session: randomUUID() })),
      timed(() => placeDetails('ChIJstreet1', { session: randomUUID() })),
      timed(() => probePlaces()),
    ]);
    for (const [x, limit] of [[a, 3000], [d, 2500], [p, 8000]]) {
      assert.ok(x.r.error || x.r.ok === false, JSON.stringify(x.r));
      assert.ok(x.ms >= limit - 100 && x.ms < limit + 200, `stopped at ${x.ms} ms (limit ${limit})`);
    }
    assert.equal(p.r.code, 'timeout');
    assert.equal(placesHealth().paused, null, 'a slow answer is not a refusal');
  } finally { clearInterval(keep); }
});

// ── Who suggests ──
test('the setting: unset is GEOCODER’s suggester and never Google, with or without a key', () => {
  delete process.env.ADDRESS_SUGGEST;
  assert.equal(addressSuggester(), 'bc');
  process.env.GEOCODER = 'off';
  assert.equal(addressSuggester(), 'off');
  process.env.GEOCODER = 'google';
  assert.equal(addressSuggester(), 'bc', 'GEOCODER=google is retired');
  for (const v of ['google', 'bc', 'nominatim', 'off']) { process.env.ADDRESS_SUGGEST = v; assert.equal(addressSuggester(), v); }
});

test('the route: only the key set (no ADDRESS_SUGGEST) or ADDRESS_SUGGEST=bc never asks Google; with it, Google’s rows and by: google', async () => {
  const session = `&session=${randomUUID()}`;
  for (const v of [undefined, 'bc']) {
    if (v) process.env.ADDRESS_SUGGEST = v; else delete process.env.ADDRESS_SUGGEST;
    const r = (await suggest(mgr, '13450 104', session)).json;
    assert.deepEqual([r.lookup, r.by, r.suggestions.map((s) => s.source)], ['ok', 'bc', ['lookup']], String(v));
  }
  assert.equal(toGoogle(), 0, 'no Places call');
  process.env.ADDRESS_SUGGEST = 'google';
  const g = (await suggest(mgr, '13450 104', session)).json;
  assert.equal(g.by, 'google');
  assert.deepEqual(g.suggestions.map((s) => [s.source, s.place_id, s.label, s.sub, s.lat]), [
    ['google', 'ChIJstreet1', '13450 104 Ave', 'Surrey, BC, Canada', undefined],
    ['google', 'ChIJnumber', '13460 104 Ave', 'Surrey, BC, Canada', undefined],
  ]);
  assert.equal(toBc(), 3, 'B.C. asked as often as before: whenever fewer than 5 doors on file');
  // Rows that carry a pin (nogoogle=1), or a box with no session: B.C.'s.
  const before = toGoogle();
  assert.equal((await suggest(mgr, '13450 104', `${session}&nogoogle=1`)).json.by, 'bc');
  assert.equal((await suggest(mgr, '13450 104')).json.by, 'bc');
  assert.equal(toGoogle(), before);
  // Google's logo not in the build: no Google rows.
  _setPlacesLogoForTest(false);
  assert.equal((await suggest(mgr, '13450 104', session)).json.by, 'bc');
  assert.equal(toGoogle(), before, 'no logo, no Places call');
});

test('GEOCODER=off with a key and ADDRESS_SUGGEST unset: no Places call and lookup off; with ADDRESS_SUGGEST=google, Places only', async () => {
  process.env.GEOCODER = 'off';
  delete process.env.ADDRESS_SUGGEST;
  const r = (await suggest(mgr, '13450 104', `&session=${randomUUID()}`)).json;
  assert.deepEqual([r.lookup, r.by], ['off', null]);
  assert.equal(asked.length, 0);
  process.env.ADDRESS_SUGGEST = 'google';
  const g = (await suggest(mgr, '13450 104', `&session=${randomUUID()}`)).json;
  assert.deepEqual([g.lookup, g.by], ['ok', 'google']);
  assert.equal(toBc(), 0, 'nothing falls back to B.C.');
  const p = (await place(mgr, 'ChIJstreet1', randomUUID())).json;
  assert.deepEqual([p.address, p.lat, p.placed], ['13450 104 Ave', null, null], 'no B.C. pin asked');
  assert.equal(toBc(), 0);
});

test('Google offering no door, or refusing: B.C.’s rows from the same budget; 50 asks against a refusal make one Places call', async () => {
  autocomplete = { status: 200, body: { suggestions: [ROWS.suggestions[1], ROWS.suggestions[3]] } };
  const none = (await suggest(mgr, '104 Ave', `&session=${randomUUID()}`)).json;
  assert.deepEqual([none.by, none.lookup, none.suggestions.map((s) => s.source)], ['bc', 'ok', ['lookup']]);
  autocomplete = { status: 403, body: API_BLOCKED };
  asked.length = 0;
  for (let i = 0; i < 50; i += 1) {
    const r = await suggest(vol, `13450 10${i % 10}`, `&session=${randomUUID()}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.by, 'bc', `ask ${i + 1}: B.C.’s rows`);
    assert.ok(!r.json.suggestions.some((s) => s.source === 'google'));
  }
  assert.equal(toGoogle(), 1, 'exactly one call to Google');
  assert.doesNotMatch(JSON.stringify(placesHealth()), /places-key/);
});

test('the suggest budget: Places refusing at once and B.C. answering in 3.9 s → B.C.’s rows within 4.2 s', async () => {
  const keep = awake();
  try {
    autocomplete = { status: 403, body: API_OFF };
    bcMs = 3900;
    const { r, ms } = await timed(() => suggest(mgr, '13450 104', `&session=${randomUUID()}`));
    assert.equal(r.json.by, 'bc');
    assert.equal(r.json.lookup, 'ok');
    assert.ok(ms < 4200, `answered in ${ms} ms`);
    // Neither in 4 s: unavailable, as before.
    _resetPlacesForTest();
    autocomplete = null; googleMs = Infinity; bcMs = Infinity;
    const slow = await timed(() => suggest(mgr, '13470 104', `&session=${randomUUID()}`));
    assert.deepEqual([slow.r.json.lookup, slow.r.json.by], ['unavailable', null]);
    assert.ok(slow.ms < 4200, `answered in ${slow.ms} ms`);
  } finally { clearInterval(keep); }
});

// ── A pick ──
test('a pick: Google’s words placed by B.C. in what is left of 4 s; never 502 once Google answered', async () => {
  const keep = awake();
  try {
    bcMs = 3900;
    const good = await timed(() => place(vol, 'ChIJstreet1', randomUUID()));
    assert.equal(good.r.status, 200, 'a volunteer may pick');
    assert.deepEqual(good.r.json, { address: '13450 104 Ave', house_number: '13450', street: '104 Ave', unit: '1203', city: 'Surrey', postal: 'V3T 1V3',
      label: '1203-13450 104 Ave, Surrey, BC V3T 1V3, Canada', lat: 49.1906, lng: -122.8466, placed: 'bc', source: 'google' });
    assert.ok(good.ms < 4200, `answered in ${good.ms} ms`);
    const bcAsk = asked.find((a) => a.host === 'geocoder.api.gov.bc.ca');
    assert.equal(bcAsk.search.get('addressString'), '1203 - 13450 104 Ave, Surrey, BC, V3T 1V3');
    // B.C. never answers: 200 with no pin, still within 4.2 s.
    bcMs = Infinity;
    const slow = await timed(() => place(mgr, 'ChIJstreet1', randomUUID()));
    assert.equal(slow.r.status, 200);
    assert.deepEqual([slow.r.json.address, slow.r.json.lat, slow.r.json.lng, slow.r.json.placed], ['13450 104 Ave', null, null, null]);
    assert.ok(slow.ms < 4200, `answered in ${slow.ms} ms`);
    // B.C. finds nothing: no pin.
    bcMs = 0; bc = [];
    assert.equal((await place(mgr, 'ChIJstreet1', randomUUID())).json.lat, null);
  } finally { clearInterval(keep); }
});

test('a pick refused: 400 for bad input, 502 with the words when Google refuses, times out or is paused', async () => {
  const words = 'That address box needs to start again — type the address once more';
  assert.deepEqual([(await place(mgr, 'ChIJ street', randomUUID())).status, (await place(mgr, 'ChIJ street', randomUUID())).json.error], [400, words]);
  assert.equal((await place(mgr, 'ChIJstreet1', 'not-a-uuid')).status, 400);
  assert.equal((await new Client().get(`/api/address/place?id=x&session=${randomUUID()}`)).status, 401);
  details = { status: 403, body: API_BLOCKED };
  const r = await place(mgr, 'ChIJstreet1', randomUUID());
  assert.deepEqual([r.status, r.json.error], [502, 'Couldn’t get that address — type it in full']);
  const n = toGoogle();
  details = null;
  assert.equal((await place(mgr, 'ChIJstreet1', randomUUID())).status, 502, 'paused: at once');
  assert.equal(toGoogle(), n);
  _resetPlacesForTest();
  const keep = awake();
  googleMs = Infinity;
  try {
    const slow = await timed(() => place(mgr, 'ChIJstreet1', randomUUID()));
    assert.equal(slow.r.status, 502);
    assert.ok(slow.ms < 2700, `gave up at ${slow.ms} ms`);
  } finally { clearInterval(keep); }
  // Suggestions off: no Google call at all.
  googleMs = 0;
  delete process.env.ADDRESS_SUGGEST;
  const before = toGoogle();
  assert.equal((await place(mgr, 'ChIJstreet1', randomUUID())).status, 502);
  assert.equal(toGoogle(), before);
});

test('the per-person limit (60 a minute) counts Google asks too; then the doors on file only', async () => {
  const c = new Client();
  const inv = await mgr.action('member.invite', { email: 'pl-fast@example.org', role: 'volunteer' });
  await c.post('/api/auth/join', { token: inv.json.joinUrl.split('/join/')[1], name: 'Fay Example', password: 'places-pass-2' });
  process.env.GOOGLE_PLACES_PER_PERSON = '1000';
  for (let i = 0; i < 60; i += 1) assert.equal((await suggest(c, '13450 104', `&session=${randomUUID()}`)).json.by, 'google');
  assert.equal(toGoogle(), 60);
  const r = (await suggest(c, '13450 104', `&session=${randomUUID()}`)).json;
  assert.deepEqual([r.lookup, r.by], ['unavailable', null]);
  assert.equal(toGoogle(), 60, 'the 61st asks nobody');
  assert.equal((await place(c, 'ChIJstreet1', randomUUID())).status, 429);
});
