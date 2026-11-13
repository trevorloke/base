// lib/geocode.js: the providers and the fallback chain, with fetch mocked.
// Google no longer places pins (its terms): GEOCODER=google places with the
// B.C. service and GEOCODER_FALLBACK=google is ignored. Every call stops at
// its time limit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { geocodeAddress, suggestAddresses, probeLookup, _resetLookupForTest } from '../lib/geocode.js';

const realFetch = globalThis.fetch;
const env = { ...process.env };
const calls = [];
let bcBody = null;
let nominatimBody = [];
let silent = false; // a stand-in that never answers

// No test reaches the network: an address not stood in for is an error.
const standIn = async (url, init) => {
  const u = new URL(String(url));
  calls.push(u);
  if (silent) return new Promise((_, reject) => { init?.signal?.addEventListener('abort', () => reject(init.signal.reason)); });
  if (u.hostname === 'geocoder.api.gov.bc.ca') return new Response(JSON.stringify(bcBody), { status: 200 });
  if (u.hostname === 'nominatim.openstreetmap.org') return new Response(JSON.stringify(nominatimBody), { status: 200 });
  throw new Error(`no stand-in for ${u.hostname}`);
};
before(() => { globalThis.fetch = standIn; });
after(() => {
  globalThis.fetch = realFetch;
  for (const k of ['GEOCODER', 'GEOCODER_FALLBACK', 'GOOGLE_MAPS_SERVER_KEY']) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
});

const DOOR = { features: [{ geometry: { coordinates: [-122.8466, 49.1906] }, properties: { score: 98, matchPrecision: 'CIVIC_NUMBER', fullAddress: '13450 104 Ave, Surrey, BC', civicNumber: 13450, streetName: '104', streetType: 'Ave' } }] };
const VAGUE = { features: [{ geometry: { coordinates: [-122.8, 49.1] }, properties: { score: 40, matchPrecision: 'LOCALITY', fullAddress: 'Surrey, BC' } }] };

test('GEOCODER=google places with the B.C. service, says so once, and never calls Google', async () => {
  process.env.GEOCODER = 'google';
  process.env.GOOGLE_MAPS_SERVER_KEY = 'server-key';
  delete process.env.GEOCODER_FALLBACK;
  _resetLookupForTest();
  bcBody = DOOR;
  calls.length = 0;
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    const r = await geocodeAddress({ address: '13450 104 Ave' });
    assert.deepEqual({ lat: r.lat, lng: r.lng }, { lat: 49.1906, lng: -122.8466 });
    assert.equal(calls[0].searchParams.get('addressString'), '13450 104 Ave, Surrey, BC');
    const s = await suggestAddresses('13450 104');
    assert.equal(s[0].house_number, '13450');
    await geocodeAddress({ address: '13450 104 Ave' });
  } finally { console.warn = realWarn; }
  assert.ok(calls.every((u) => u.hostname === 'geocoder.api.gov.bc.ca'), 'only the B.C. service');
  assert.equal(warns.filter((w) => /GEOCODER=google is no longer used/.test(w)).length, 1, 'said once');
  assert.ok(warns.every((w) => !/server-key/.test(w)));
});

test('GEOCODER_FALLBACK=google is ignored: a vague B.C. answer stands, Google is never asked', async () => {
  process.env.GEOCODER = 'bc';
  process.env.GEOCODER_FALLBACK = 'google';
  process.env.GOOGLE_MAPS_SERVER_KEY = 'server-key';
  bcBody = VAGUE;
  calls.length = 0;
  assert.equal((await geocodeAddress({ address: '9999 King George Blvd' })).weak, true);
  bcBody = { features: [] };
  assert.equal(await geocodeAddress({ address: '1 Nowhere St' }), null);
  assert.ok(calls.every((u) => u.hostname === 'geocoder.api.gov.bc.ca'));
  delete process.env.GEOCODER_FALLBACK;
});

test('a fallback that is a service still works: Nominatim for what B.C. can’t place; a B.C. error stays an error', async () => {
  process.env.GEOCODER = 'bc';
  process.env.GEOCODER_FALLBACK = 'nominatim';
  bcBody = VAGUE;
  nominatimBody = [{ lat: '49.17', lon: '-122.84', addresstype: 'house', display_name: '9999 King George Blvd, Surrey' }];
  calls.length = 0;
  assert.equal((await geocodeAddress({ address: '9999 King George Blvd' })).lat, 49.17);
  assert.ok(calls.some((u) => u.hostname === 'nominatim.openstreetmap.org'));
  globalThis.fetch = async (url) => { calls.push(new URL(String(url))); return new Response('busy', { status: 503 }); };
  calls.length = 0;
  try {
    assert.match((await geocodeAddress({ address: '3 Down St' })).error, /503/);
    assert.equal(calls.length, 1, 'the second is not asked when the first is down');
  } finally { globalThis.fetch = standIn; delete process.env.GEOCODER_FALLBACK; }
});

test('every call stops at its limit against a silent service: placing 8 s, suggesting 4 s', async () => {
  const awake = setInterval(() => {}, 1000);
  silent = true;
  try {
    const timed = async (fn) => { const t = Date.now(); const r = await fn(); return { r, ms: Date.now() - t }; };
    const cases = [
      ['bc', () => geocodeAddress({ address: '1 Slow St' }), 8000],
      ['nominatim', () => geocodeAddress({ address: '1 Slow St' }), 8000],
      ['bc', () => suggestAddresses('1 Slow'), 4000],
      ['nominatim', () => suggestAddresses('1 Slow'), 4000],
    ];
    const out = await Promise.all(cases.map(([geo, fn, limit]) => {
      process.env.GEOCODER = geo;
      return timed(fn).then((x) => ({ ...x, geo, limit }));
    }));
    for (const { r, ms, geo, limit } of out) {
      assert.ok(r?.error, `${geo}: an error, not a hang`);
      assert.ok(ms >= limit - 100 && ms < limit + 200, `${geo} stopped at ${ms} ms (limit ${limit})`);
    }
  } finally { silent = false; clearInterval(awake); process.env.GEOCODER = 'bc'; }
});

test('the B.C. service in plain words: busy, or not answering', async () => {
  process.env.GEOCODER = 'bc';
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('slow down', { status: 429 });
    _resetLookupForTest();
    assert.equal((await probeLookup()).plain, 'The B.C. address service is busy. It tries again by itself; a BC_GEOCODER_KEY raises the limit.');
    globalThis.fetch = async () => { throw new Error('fetch failed'); };
    _resetLookupForTest();
    assert.equal((await probeLookup()).plain, 'The B.C. address service isn’t answering.');
    globalThis.fetch = async () => new Response('down', { status: 503 });
    _resetLookupForTest();
    assert.equal((await probeLookup()).plain, 'The B.C. address service isn’t answering.');
  } finally { globalThis.fetch = real; _resetLookupForTest(); }
});
