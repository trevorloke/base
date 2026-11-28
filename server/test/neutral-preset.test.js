// No other client gets anything of Imagine Surrey's: what is one client's
// own is a preset (server/presets/, read only through lib/preset.js), used
// only by the server whose BASE_BRAND names it. Here: which brand a
// server wears; that preset() follows the setting; that a campaign with no
// preset has no opponents, no city, no map area and no features, and its
// page is the page as built; that its lookups carry no city or box; and
// that Imagine Surrey's own server answers as it always did — its five
// opponents reach a phone with their labels, though the phone's own code
// holds none of them.
// Unique emails and campaign names (test:pg runs every file on one database).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb, Client } from './helpers.js';
import { preset, presetFor, brandHas, brandKey, brandNote, PRESET_KEYS } from '../lib/preset.js';
import { brandFor, brandHtml } from '../lib/brand.js';
import { city, geoBox, geoBounds, mapHome, orgOut } from '../lib/org.js';
import { geocodeAddress, suggestAddresses, _resetLookupForTest } from '../lib/geocode.js';
import { inFence } from '../ext/voteguide/api.js';
import { bootNotes } from '../index.js';
import { defaultCandidates } from '@base-win/shared/scale';
import { checkLines } from '../../web/src/pages/mapView.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const INDEX = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const tag = Math.random().toString(36).slice(2, 8);
const ok = (r, msg = '') => { assert.ok(r.status === 200 || r.status === 201, `${msg} ${r.status} ${JSON.stringify(r.json)}`); return r.json; };

// The settings a server reads its brand and place from, set for one case
// and put back after the file.
const ENV = ['BASE_BRAND', 'BASE_ENV', 'BASE_ORG_NAME', 'BASE_CITY', 'BASE_GEO_BOUNDS', 'BASE_CANDIDATES', 'GEOCODER', 'ADDRESS_SUGGEST'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const setEnv = (v) => { for (const k of ENV) { if (v[k] === undefined) delete process.env[k]; else process.env[k] = v[k]; } };
after(() => setEnv(saved));

const IS = presetFor('imagine-surrey');
const FIVE = [
  ['4D', 'McCallum', 'Opposed — Doug McCallum supporter'],
  ['4B', 'Locke', 'Opposed — Surrey Connect / Brenda Locke'],
  ['4F', 'Annis', 'Opposed — Surrey First / Linda Annis'],
  ['4N', 'van Vliet', 'Opposed — SurreyNow / Troy van Vliet'],
  ['4C', 'Randhawa', 'Opposed — Surrey Conservatives / Honveer Randhawa'],
];

test('the brand: set and known, it is what it says; anything else is base.win’s — but a server named exactly Imagine Surrey keeps its own', () => {
  const key = (env) => brandKey(env);
  // Set and known.
  assert.equal(key({ BASE_BRAND: 'imagine-surrey' }), 'imagine-surrey');
  assert.equal(key({ BASE_BRAND: ' Imagine-Surrey ' }), 'imagine-surrey', 'any case, spaces around');
  assert.equal(key({ BASE_BRAND: 'base', BASE_ENV: 'production', BASE_ORG_NAME: 'Imagine Surrey' }), 'base', 'set to base, it is base whatever the name');
  // Unset or misspelled: nobody's.
  assert.equal(key({}), 'base', 'nothing set');
  assert.equal(key({ BASE_ENV: 'production' }), 'base', 'production, no name');
  assert.equal(key({ BASE_ENV: 'production', BASE_ORG_NAME: 'Kamloops Forward' }), 'base', 'another client');
  assert.equal(key({ BASE_BRAND: 'imagine-surey', BASE_ENV: 'production', BASE_ORG_NAME: 'Kamloops Forward' }), 'base', 'misspelled is never guessed at');
  assert.equal(key({ BASE_BRAND: 'purple' }), 'base');
  for (const name of ['imagine surrey', 'Imagine  Surrey', 'IMAGINE SURREY', 'Imagine Surrey 2026', 'Friends of Imagine Surrey']) {
    assert.equal(key({ BASE_ENV: 'production', BASE_ORG_NAME: name }), 'base', `“${name}” is not the name`);
  }
  // The one exception: production's own server, should its brand line be
  // missing or misspelled, does not change under its campaign.
  assert.equal(key({ BASE_ENV: 'production', BASE_ORG_NAME: 'Imagine Surrey' }), 'imagine-surrey');
  assert.equal(key({ BASE_ENV: 'production', BASE_ORG_NAME: ' Imagine Surrey ' }), 'imagine-surrey', 'spaces around a setting are not part of it');
  assert.equal(key({ BASE_BRAND: 'imagine-surey', BASE_ENV: 'production', BASE_ORG_NAME: 'Imagine Surrey' }), 'imagine-surrey', 'a misspelled brand on that server');
  assert.equal(key({ BASE_ORG_NAME: 'Imagine Surrey' }), 'imagine-surrey', 'a server whose BASE_ENV went missing too');
  // Staging is never worked out to a client's own.
  assert.equal(key({ BASE_ENV: 'staging', BASE_ORG_NAME: 'Imagine Surrey' }), 'base');
});

test('a server given a preset because of its name starts, and says loudly what to set', () => {
  // 1. Production named Imagine Surrey with no brand: it starts, with one line.
  const unset = { BASE_ENV: 'production', BASE_ORG_NAME: 'Imagine Surrey', BASE_PUBLIC_URL: 'https://example.base.win' };
  const note = brandNote(unset);
  assert.match(note, /^base.win: WARNING — BASE_BRAND is not set on a server named Imagine Surrey/);
  assert.match(note, /Set BASE_BRAND=imagine-surrey/);
  assert.deepEqual(bootNotes(unset), [note], 'printed with the other start-up warnings; nothing refuses to start');
  // 2. A misspelled brand there: the line names what was typed.
  assert.match(brandNote({ ...unset, BASE_BRAND: 'imagine-surey' }), /BASE_BRAND is “imagine-surey”, which is not a brand/);
  // 3. Set, either way: nothing to say.
  assert.equal(brandNote({ ...unset, BASE_BRAND: 'imagine-surrey' }), null);
  assert.equal(brandNote({ ...unset, BASE_BRAND: 'base' }), null);
  // 4. Any other server with no brand is base, quietly; staging too.
  assert.equal(brandNote({ BASE_ENV: 'production', BASE_ORG_NAME: 'Kamloops Forward' }), null);
  assert.equal(brandNote({ BASE_ENV: 'staging', BASE_ORG_NAME: 'Imagine Surrey' }), null);
  assert.equal(brandNote({}), null);
});

test('preset() follows the setting, read each time it is asked', () => {
  setEnv({ BASE_BRAND: 'imagine-surrey' });
  assert.equal(preset(), IS);
  assert.equal(preset().key, 'imagine-surrey');
  assert.deepEqual([brandHas('membership'), brandHas('sample'), brandHas('donorTiers')], [true, true, true]);
  assert.deepEqual(defaultCandidates().map((c) => [c.code, c.name, c.label]), FIVE);
  assert.equal(city(), 'Surrey');
  setEnv({ BASE_BRAND: 'base' });
  assert.notEqual(preset(), IS);
  assert.equal(preset().key, 'base');
  assert.deepEqual([brandHas('membership'), brandHas('sample'), brandHas('donorTiers')], [false, false, false]);
  assert.deepEqual(defaultCandidates(), []);
  assert.equal(city(), '');
  setEnv({ BASE_BRAND: 'imagine-surrey' });
  assert.equal(preset(), IS, 'and back');
  assert.deepEqual(PRESET_KEYS, ['imagine-surrey']);
  assert.equal(presetFor('base'), presetFor('nobody'), 'any other name is the neutral one');
  assert.ok(Object.isFrozen(IS) && Object.isFrozen(IS.fields.standard) && Object.isFrozen(presetFor('base')), 'nothing can write to a preset');
});

test('the neutral set-up has every key the preset has, each holding nothing', () => {
  const N = presetFor('base');
  const plain = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
  const missing = [];
  const walk = (a, b, path) => {
    for (const k of Object.keys(a)) {
      if (!(k in b)) { missing.push(`${path}${k}`); continue; }
      // A part the neutral set-up has none of (null) has no keys to compare.
      if (plain(a[k]) && plain(b[k]) && !['examples', 'words', 'wordsBefore', 'moduleDefaults', 'fieldLabels', 'appFiles', 'guesses'].includes(k)) walk(a[k], b[k], `${path}${k}.`);
    }
  };
  walk(IS, N, '');
  assert.deepEqual(missing, []);
  assert.deepEqual([N.candidates, N.donorTiers, N.orgNames], [[], [], []]);
  assert.deepEqual([N.map, N.membership, N.sample, N.brand, N.org.box, N.org.city], [null, null, null, null, null, '']);
  assert.deepEqual([N.site.skin, N.site.css, N.site.assets, N.site.seed, N.fields.standard], [null, null, null, null, null]);
  assert.deepEqual([N.examples, N.site.words, N.appFiles, N.training], [{}, {}, {}, { label: 'Training', oldPaths: [] }]);
  assert.deepEqual([N.site.wordsBefore, N.site.moduleDefaults, N.site.fieldLabels], [{}, {}, {}]);
  assert.doesNotMatch(JSON.stringify(N), /surrey|imagine/i);
});

test('only lib/preset.js imports server/presets/, and nothing but the brand’s own look-up asks for a preset by name', () => {
  const SKIP = new Set(['node_modules', 'dist', '.git', '.claude', 'data']);
  const files = [];
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      if (SKIP.has(n)) continue;
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|mjs|jsx|cjs)$/.test(n)) files.push(p);
    }
  };
  walk(ROOT);
  const importing = [];
  const naming = [];
  for (const f of files) {
    const rel = relative(ROOT, f);
    if (rel.startsWith('server/presets/')) continue;
    const src = readFileSync(f, 'utf8');
    if (/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"`][^'"`\n]*presets\//.test(src)) importing.push(rel);
    if (!rel.startsWith('server/test/') && !rel.startsWith('scripts/') && /\bpresetFor\s*\(/.test(src)) naming.push(rel);
  }
  assert.deepEqual(importing, ['server/lib/preset.js']);
  // …and for the read-only report of what another campaign still holds of
  // a preset's lists (server/neutral-report.mjs: no server loads it).
  assert.deepEqual(naming.sort(), ['server/lib/brand.js', 'server/lib/preset.js', 'server/neutral-report.mjs'], 'presetFor is for tests, and for a look asked for by its own name');
});

test('brand base never reaches the preset’s files: nothing to load, nothing to serve', () => {
  setEnv({ BASE_BRAND: 'base' });
  assert.equal(preset().site.seed, null);
  assert.equal(preset().sample, null);
  assert.equal(preset().site.assets, null);
  assert.deepEqual(preset().appFiles, {});
  // The preset names its large files and loads them only when asked.
  assert.equal(typeof IS.site.seed, 'function');
  assert.equal(typeof IS.sample.load, 'function');
});

test('brand base, nothing else set: no opponents, no city, no map area, no features — and the app’s page is the page as built', async () => {
  await freshDb();
  setEnv({ BASE_BRAND: 'base' });
  const c = new Client();
  ok(await c.signup({ workspaceName: `Neutral ${tag}`, email: `neutral+${tag}@example.org`, jurisdiction: 'bc-municipal' }));
  const me = ok(await c.get('/api/auth/me'));
  assert.equal(me.org.city, '');
  assert.equal(me.org.map, null);
  assert.deepEqual(me.org.features, []);
  assert.deepEqual(me.org.candidates, []);
  const scale = ok(await c.get('/api/scale')).scale;
  assert.deepEqual(scale.candidates, []);
  assert.deepEqual(scale.steps.map((s) => s.word), ['Strong yes', 'Lean yes', 'Undecided', 'Opposed']);
  for (const [code] of FIVE) {
    const r = await c.action('contact.log', { person_id: (await c.createPerson(`Nobody ${code} ${tag}`)).id, channel: 'door', outcome: 'contacted', rating: code });
    assert.equal(r.status, 400, `${code} is not on a neutral campaign’s scale`);
  }
  assert.equal(ok(await c.get('/api/health')).brand, 'base');
  // Signed out, the same: nothing about the place but that there is none.
  const setup = ok(await new Client().get('/api/auth/setup'));
  assert.deepEqual([setup.org.city, setup.org.map, setup.org.features, setup.org.candidates], ['', null, [], undefined]);
  // The page: marked, and otherwise exactly the file as built.
  const page = brandHtml(INDEX, brandFor({}));
  assert.equal(page.replace(' data-brand="base"', ''), INDEX);
  assert.doesNotMatch(page, /window\.__BRAND__|imagine|surrey|#003979|star\.png/i);
  // The map's own check says the area is not set, and who sets it.
  const check = ok(await c.get('/api/map/check'));
  assert.deepEqual(check.area, { box: null, inside: null, outside: null });
  const line = checkLines(check, { build: check.build, look: 'Standard', tilesFrom: 'tile.openstreetmap.org', tiles: { loaded: 0, failed: 0, down: false }, size: { x: 1158, y: 844 }, zoom: 3 })
    .find((l) => l.key === 'area');
  assert.deepEqual([line.label, line.value, line.note, line.warn], ['Map area', 'Not set', 'Ask base.win to set your map area.', true]);
  // Where the map opens on the list: no box to count people inside.
  await c.createPerson(`Pinned ${tag}`, { address: '1 Example St', lat: 50.67, lng: -120.33 });
  const doors = ok(await c.get('/api/map/doors'));
  assert.ok(!doors.opens || doors.opens.fit !== 'area', JSON.stringify(doors.opens));
});

test('brand base: an address is looked up with no city and no box; the voter guide has no fence', async () => {
  setEnv({ BASE_BRAND: 'base', GEOCODER: 'bc', ADDRESS_SUGGEST: 'bc' });
  _resetLookupForTest();
  assert.deepEqual([city(), geoBounds(), geoBox(), mapHome()], ['', null, null, null]);
  const asked = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { asked.push(String(url)); return new Response(JSON.stringify({ features: [] }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    await geocodeAddress({ address: '123 Main St' });
    await suggestAddresses('123 Main', { provider: 'bc' });
    await suggestAddresses('123 Main', { provider: 'nominatim' });
  } finally { globalThis.fetch = real; }
  assert.ok(asked.length >= 3, `the services were asked: ${asked.length}`);
  for (const url of asked) {
    assert.doesNotMatch(decodeURIComponent(url), /surrey/i, url);
    assert.doesNotMatch(url, /bbox=|viewbox=|49\.002|49\.222|122\.92|122\.67/, url);
  }
  assert.equal(new URL(asked[0]).searchParams.get('addressString'), '123 Main St, BC', 'the street and the province, no city');
  assert.equal(inFence(10, 10), true, 'no area: nowhere is outside it');
  assert.deepEqual(orgOut().features, []);
});

test('brand base with a map area typed: maps open on it, lookups lean to it — never to another campaign’s', async () => {
  // The control centre's New campaign block, for Kamloops.
  setEnv({ BASE_BRAND: 'base', BASE_CITY: 'Kamloops', BASE_GEO_BOUNDS: '50.6,-120.5|50.8,-120.2', BASE_CANDIDATES: 'none', GEOCODER: 'bc' });
  assert.deepEqual(geoBox(), [50.6, -120.5, 50.8, -120.2]);
  assert.deepEqual(mapHome(), { centre: [50.7, -120.35], zoom: 12, bounds: [[50.6, -120.5], [50.8, -120.2]] });
  assert.deepEqual(orgOut().map, mapHome());
  assert.equal(city(), 'Kamloops');
  assert.equal(inFence(50.7, -120.3), true);
  assert.equal(inFence(49.19, -122.85), false, 'Surrey is outside Kamloops');
  const asked = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { asked.push(String(url)); return new Response(JSON.stringify({ features: [] }), { status: 200 }); };
  try { await suggestAddresses('123 Main', { provider: 'bc' }); } finally { globalThis.fetch = real; }
  assert.match(decodeURIComponent(asked[0]), /bbox=-120\.5,50\.6,-120\.2,50\.8/);
  // Whichever corner was typed first.
  setEnv({ BASE_BRAND: 'base', BASE_GEO_BOUNDS: '50.8,-120.2|50.6,-120.5' });
  assert.deepEqual(geoBox(), [50.6, -120.5, 50.8, -120.2]);
  // A map area that can't be read is no area, not somebody else's.
  setEnv({ BASE_BRAND: 'base', BASE_GEO_BOUNDS: 'kamloops' });
  assert.deepEqual([geoBounds(), geoBox(), mapHome()], [null, null, null]);
});

test('brand imagine-surrey, nothing else set: its city, its map area, its five opponents — and a phone reads today’s five labels', async () => {
  setEnv({ BASE_BRAND: 'imagine-surrey' });
  assert.equal(city(), 'Surrey');
  assert.deepEqual(geoBox(), [49.002, -122.92, 49.222, -122.67]);
  assert.equal(geoBounds(), null, 'nothing is typed: the area is the preset’s');
  assert.deepEqual(mapHome(), { centre: [49.1913, -122.849], zoom: 12, bounds: [[49.0, -122.93], [49.22, -122.68]] });
  const c = new Client();
  ok(await c.signup({ workspaceName: `Imagine ${tag}`, email: `imagine+${tag}@example.org`, jurisdiction: 'bc-municipal' }));
  const me = ok(await c.get('/api/auth/me'));
  assert.equal(me.workspace.settings.scale, undefined, 'this campaign has saved no scale');
  assert.deepEqual(me.org.candidates.map((x) => [x.code, x.name, x.label]), FIVE);
  assert.deepEqual([me.org.city, me.org.features], ['Surrey', ['membership', 'sample']]);
  assert.deepEqual(me.org.map, mapHome());
  assert.equal(ok(await c.get('/api/health')).brand, 'imagine-surrey');
  const sent = ok(await c.get('/api/scale')).scale;
  assert.deepEqual(sent.candidates.map((x) => [x.code, x.name, x.label, x.off]), FIVE.map((x) => [...x, false]));

  // A phone's copy of shared/scale.js: read with no settings (the app's build
  // puts an empty object where they would be), so it is the browser's code.
  const proc = globalThis.process;
  globalThis.process = undefined;
  let phone;
  try { phone = await import(`${new URL('../../shared/scale.js', import.meta.url).href}?phone-${tag}`); } finally { globalThis.process = proc; }
  const wire = (x) => JSON.parse(JSON.stringify(x));
  assert.deepEqual(phone.defaultCandidates(), [], 'the phone’s own code holds nobody');
  assert.deepEqual(phone.DEFAULT_SCALE.candidates, []);
  // What web/src/components/scale.js does with the sign-in's list.
  phone.presetCandidates(() => wire(me).org.candidates);
  assert.deepEqual(phone.normalizeScale(wire(sent)).candidates.map((x) => [x.code, x.name, x.label, x.off]), FIVE.map((x) => [...x, false]),
    'GET /api/scale, read on the phone: today’s five labels, character for character');
  assert.deepEqual(phone.defaultScale().candidates.map((x) => x.label), FIVE.map((x) => x[2]), 'before it has read the scale: the sign-in’s list');
  // A saved scale as the sign-in carries it (no labels in it): the labels
  // are the starting list's for anyone still called what it calls them.
  const stored = { v: 2, words: {}, candidates: [{ code: '4B', name: 'Locke' }, { code: '4D', name: 'Doug M.' }] };
  assert.deepEqual(phone.normalizeScale(stored).candidates.map((x) => x.label), ['Opposed — Surrey Connect / Brenda Locke', 'Opposed — Doug M.']);
  // A sign-in kept from before the server sent labels: plain ones, until the scale is read.
  phone.presetCandidates(() => wire(me).org.candidates.map(({ code, name }) => ({ code, name })));
  assert.deepEqual(phone.normalizeScale(stored).candidates.map((x) => x.label), ['Opposed — Locke', 'Opposed — Doug M.']);
  assert.deepEqual(phone.normalizeScale(wire(sent)).candidates.map((x) => x.label), FIVE.map((x) => x[2]), 'the scale the server sent carries each label itself');
});
