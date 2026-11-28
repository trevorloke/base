// What a phone's service worker kept under its older names (web/public/sw.js):
// the app, its files, the map's tiles and the note of which provider draws
// them. A worker update carries all of it over to the new names, so a turf
// looked at before the update still draws with no signal; an older cache goes
// only once its copy is done; another client's older caches are never
// touched; and the page's older tiles message still names the provider. Run
// in a stand-in for a browser's worker (no browser needed). This file may
// write the older names out: it proves they still work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { OLD_STORAGE } from '@base-win/shared/old-names';

const SOURCE = readFileSync(new URL('../../web/public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://app.example';
const OLD_AT = 'x-starbase-cached-at';
const NEW_AT = 'x-base-win-cached-at';
const DAY = 24 * 3600 * 1000;

// A worker as a browser starts it, over caches that already hold what an
// older worker kept. failPut(name): every put into that cache throws.
const worker = ({ base = '', kept = {}, failPut = () => false } = {}) => {
  const stores = new Map();
  const keyOf = (k) => new URL(typeof k === 'string' ? k : k.url, `${ORIGIN}/`).href;
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const cache = (name, m) => ({
    match: async (k) => { await turn(); return m.get(keyOf(k))?.clone(); },
    put: async (k, res) => { await turn(); if (failPut(name)) throw new Error('QuotaExceededError'); m.set(keyOf(k), res); },
    delete: async (k) => { await turn(); return m.delete(keyOf(k)); },
    keys: async () => { await turn(); return [...m.keys()].map((url) => ({ url })); },
  });
  for (const [name, entries] of Object.entries(kept)) stores.set(name, new Map(entries.map(([k, res]) => [keyOf(k), res])));
  const caches = {
    open: async (name) => { await turn(); if (!stores.has(name)) stores.set(name, new Map()); return cache(name, stores.get(name)); },
    keys: async () => { await turn(); return [...stores.keys()]; },
    delete: async (name) => { await turn(); return stores.delete(name); },
  };
  const fetched = [];
  let online = true;
  const fetch = async (req, init = {}) => {
    const url = typeof req === 'string' ? req : req.url;
    fetched.push(url);
    await turn();
    if (!online) throw new TypeError('offline');
    if (/index\.html$/.test(url)) return new Response('<!doctype html><div id="root"></div>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } });
  };
  const on = {};
  const self = {
    registration: { scope: `${ORIGIN}${base}/` },
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => { on[type] = fn; },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
  };
  vm.runInContext(SOURCE, vm.createContext({ self, caches, fetch, Response, Headers, URL, setTimeout, clearTimeout, console }));
  const settle = async (n = 400) => { for (let i = 0; i < n; i += 1) await turn(); };
  const activate = async () => {
    const waits = [];
    on.activate({ waitUntil: (p) => { waits.push(p); } });
    for (let i = 0; i < waits.length; i += 1) await waits[i];
    await settle(); // the copy runs after the worker has taken over: let it finish
  };
  const ask = async (url) => {
    const waits = [];
    let answer = null;
    on.fetch({ request: { method: 'GET', url, destination: 'image', mode: 'cors', cache: 'default' }, respondWith: (p) => { answer = Promise.resolve(p); }, waitUntil: (p) => { waits.push(p); } });
    const res = await answer;
    for (let i = 0; i < waits.length; i += 1) await waits[i];
    return res;
  };
  const tell = async (type, url) => {
    const waits = [];
    on.message({ data: { type, url }, waitUntil: (p) => { waits.push(p); } });
    await Promise.all(waits);
  };
  return { stores, activate, ask, tell, fetched, offline: () => { online = false; }, settle };
};

const tileRes = (at) => new Response('<svg xmlns="http://www.w3.org/2000/svg"><!--kept--></svg>', { status: 200, headers: { 'content-type': 'image/svg+xml', [OLD_AT]: String(at) } });
const json = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
const T = Date.now() - 2 * DAY;
const TILE = (n) => `https://tile.openstreetmap.org/15/5202/${11226 + n}.png`;
const older = (name = 'starbase') => ({
  [`${name}-tiles-v2`]: [[TILE(0), tileRes(T)], [TILE(1), tileRes(T + 1)], [TILE(2), tileRes(T + 2)]],
  [`${name}-meta-v2`]: [['/__starbase/tiles', json({ url: 'https://tiles.example/{z}/{x}/{y}.png' })], ['/__starbase/old-files', json({ '/assets/Old-a1.js': T })]],
  [`${name}-assets-v2`]: [['/assets/index-a1.js', new Response('a')], ['/fonts/fonts.css', new Response('b')]],
  [`${name}-shell-v2`]: [['/index.html', new Response('<div id="root"></div>', { headers: { 'content-type': 'text/html' } })]],
});
const urls = (w, name) => [...(w.stores.get(name)?.keys() || [])].sort();

test('after an update, everything the older worker kept is under the new names — tiles keep their time — and the older caches are gone', async () => {
  const w = worker({ kept: older() });
  await w.activate();
  assert.deepEqual([...w.stores.keys()].filter((n) => n.startsWith('starbase')), [], 'no older cache left');
  assert.deepEqual(urls(w, 'base-win-tiles-v2'), [TILE(0), TILE(1), TILE(2)].sort());
  for (let n = 0; n < 3; n += 1) {
    const r = w.stores.get('base-win-tiles-v2').get(TILE(n));
    assert.equal(r.headers.get(NEW_AT), String(T + n), 'the time it was kept, under the new header');
    assert.equal(r.headers.get(OLD_AT), null);
    assert.match(await r.clone().text(), /kept/);
  }
  assert.deepEqual(urls(w, 'base-win-meta-v2'), [`${ORIGIN}/__base-win/old-files`, `${ORIGIN}/__base-win/tiles`]);
  assert.deepEqual(await w.stores.get('base-win-meta-v2').get(`${ORIGIN}/__base-win/tiles`).clone().json(), { url: 'https://tiles.example/{z}/{x}/{y}.png' });
  assert.deepEqual(urls(w, 'base-win-assets-v2'), [`${ORIGIN}/assets/index-a1.js`, `${ORIGIN}/fonts/fonts.css`]);
  assert.deepEqual(urls(w, 'base-win-shell-v2'), [`${ORIGIN}/index.html`]);
  // With no signal, the turf seen before the update still draws.
  w.offline();
  const res = await w.ask(TILE(1));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /kept/);
  // And the provider the older worker was told about is still known.
  const custom = await w.ask('https://tiles.example/15/1/1.png');
  assert.ok(custom, 'the worker answers the configured provider’s tile');
});

test('a copy that fails leaves the older caches in place, and the older tiles still draw from there', async () => {
  const w = worker({ kept: older(), failPut: (name) => name === 'base-win-tiles-v2' });
  await w.activate();
  assert.equal(urls(w, 'starbase-tiles-v2').length, 3, 'the older tiles stay until a copy works');
  assert.equal(w.stores.has('starbase-meta-v2') || w.stores.has('base-win-meta-v2'), true);
  w.offline();
  const res = await w.ask(TILE(2));
  assert.equal(res.status, 200, 'a tile the older worker kept draws with no signal');
  assert.match(await res.text(), /kept/);
});

test('a tile with only the older header counts as fresh: no network asked', async () => {
  const fresh = Date.now() - 3600e3;
  const w = worker({ kept: { 'starbase-tiles-v2': [[TILE(5), tileRes(fresh)]] }, failPut: () => true });
  await w.activate();
  const before = w.fetched.length;
  const res = await w.ask(TILE(5));
  assert.equal(res.status, 200);
  assert.equal(w.fetched.length, before, 'served as kept');
});

test('the page’s older tiles message names the provider (the new one too), noted only under the new key', async () => {
  for (const type of [OLD_STORAGE.tilesMessage, 'base-win:tiles']) {
    const w = worker();
    await w.activate();
    await w.tell(type, 'https://{s}.tiles.example/streets/{z}/{x}/{y}.png');
    const res = await w.ask('https://a.tiles.example/streets/15/1/1.png');
    assert.ok(res && res.status === 200, `${type}: answered`);
    assert.ok(urls(w, 'base-win-tiles-v2').includes('https://a.tiles.example/streets/15/1/1.png'), `${type}: kept`);
    assert.deepEqual(urls(w, 'base-win-meta-v2'), [`${ORIGIN}/__base-win/tiles`]);
  }
});

test('another client’s older caches are never touched (at the root, and under a client’s path)', async () => {
  const root = worker({ kept: { ...older('starbase-other'), 'starbase-other-x': [] } });
  await root.activate();
  for (const n of ['starbase-other-tiles-v2', 'starbase-other-meta-v2', 'starbase-other-assets-v2', 'starbase-other-shell-v2', 'starbase-other-x']) assert.ok(root.stores.has(n), n);
  assert.equal(urls(root, 'base-win-tiles-v2').length, 0);
  const path = worker({ base: '/acme', kept: { ...older('starbase'), ...older('starbase-acme') } });
  await path.activate();
  assert.equal(urls(path, 'base-win-acme-tiles-v2').length, 3, 'this client’s are carried');
  assert.ok(!path.stores.has('starbase-acme-tiles-v2'));
  for (const n of ['starbase-tiles-v2', 'starbase-meta-v2', 'starbase-assets-v2', 'starbase-shell-v2']) assert.ok(path.stores.has(n), `the root’s ${n} stays`);
});

test('tiles no worker may keep are not copied over: Google’s through the server, and CARTO’s asked with no key', async () => {
  const google = `${ORIGIN}/tiles/15/5202/11226.png`;
  const keyless = 'https://a.basemaps.cartocdn.com/light_all/15/5202/11226.png';
  const keyed = 'https://a.basemaps.cartocdn.com/light_all/15/5202/11226.png?key=k';
  const w = worker({ kept: { 'starbase-tiles-v2': [[google, tileRes(T)], [keyless, tileRes(T)], [keyed, tileRes(T)], [TILE(0), tileRes(T)]] } });
  await w.activate();
  assert.deepEqual(urls(w, 'base-win-tiles-v2'), [keyed, TILE(0)].sort());
  assert.ok(!w.stores.has('starbase-tiles-v2'));
});
