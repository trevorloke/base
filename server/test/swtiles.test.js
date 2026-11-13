// The service worker's street-map tiles (web/public/sw.js, run here in a
// stand-in for a browser's worker — no browser needed). A turf looked at with
// signal still draws with none only if the worker kept its tiles: the Clean
// look's (CARTO, what the map opens on) as well as OpenStreetMap's, from the
// first tile on — a worker just installed hears which provider the map draws
// a moment after its first tiles are asked for, and what it was told must
// not be lost to its own slower read of what it was told before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../../web/public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://app.example';
const TILES = 'starbase-tiles-v2';

// A worker as a browser starts it: its own caches (every read and write takes
// a turn, as a real one does), and a network that answers every tile.
const worker = () => {
  const stores = new Map();
  const keyOf = (k) => new URL(typeof k === 'string' ? k : k.url, `${ORIGIN}/`).href;
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const cache = (m) => ({
    match: async (k) => { await turn(); return m.get(keyOf(k))?.clone(); },
    put: async (k, res) => { await turn(); m.set(keyOf(k), res); },
    delete: async (k) => { await turn(); return m.delete(keyOf(k)); },
    keys: async () => { await turn(); return [...m.keys()].map((url) => ({ url })); },
  });
  const caches = {
    open: async (name) => { await turn(); if (!stores.has(name)) stores.set(name, new Map()); return cache(stores.get(name)); },
    keys: async () => [...stores.keys()],
  };
  const fetched = [];
  const fetch = async (req, init = {}) => {
    const url = typeof req === 'string' ? req : req.url;
    fetched.push({ url, cache: init.cache || req.cache || 'default' });
    await turn();
    return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } });
  };
  const on = {};
  const self = {
    registration: { scope: `${ORIGIN}/` },
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => { on[type] = fn; },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
  };
  vm.runInContext(SOURCE, vm.createContext({ self, caches, fetch, Response, Headers, URL, setTimeout, clearTimeout, console }));
  // One request from the page — a picture (a map tile), or from a script
  // (destination '') — and what the worker answered with (null: it let the
  // browser fetch it, untouched), once everything it set going is done.
  const ask = (url, { cache: mode = 'default', destination = 'image' } = {}) => {
    const waits = [];
    let answer = null;
    on.fetch({
      request: { method: 'GET', url, destination, mode: 'cors', cache: mode },
      respondWith: (p) => { answer = Promise.resolve(p); },
      waitUntil: (p) => { waits.push(p); },
    });
    return {
      answered: () => answer !== null,
      done: async () => {
        const res = await answer;
        for (let i = 0; i < waits.length; i += 1) await waits[i];
        return res;
      },
    };
  };
  const tell = (url) => {
    const waits = [];
    on.message({ data: { type: 'starbase:tiles', url }, waitUntil: (p) => { waits.push(p); } });
    return Promise.all(waits);
  };
  const kept = () => [...(stores.get(TILES)?.keys() || [])];
  const activate = async () => {
    const waits = [];
    on.activate({ waitUntil: (p) => { waits.push(p); } });
    for (let i = 0; i < waits.length; i += 1) await waits[i];
  };
  return { ask, tell, kept, fetched, stores, activate };
};

test('the Clean look’s tiles are kept from the first one — before the map has said which provider it draws', async () => {
  const w = worker();
  const tile = 'https://a.basemaps.cartocdn.com/light_all/15/5202/11226.png';
  const first = w.ask(tile);
  assert.equal(first.answered(), true, 'the worker answers it');
  const res = await first.done();
  assert.equal(res.status, 200);
  assert.deepEqual(w.kept(), [tile], 'kept, so the turf it is part of draws offline');
  // Later, with no signal: the kept copy.
  const again = w.ask(tile);
  assert.equal((await again.done()).status, 200);
  assert.equal(w.fetched.length, 1, 'answered from what it kept');
  // OpenStreetMap's (Standard, Muted, Dark) were always kept.
  const osm = 'https://tile.openstreetmap.org/15/5202/11226.png';
  await w.ask(osm).done();
  assert.deepEqual(w.kept().sort(), [tile, osm].sort());
});

test('a provider the map names while the worker is still reading what it was told before stays named', async () => {
  const w = worker();
  const template = 'https://tiles.example/streets/{z}/{x}/{y}.png';
  // A worker just installed: the first tile is asked for (the worker starts
  // reading its note of the provider — there is none yet)…
  const first = w.ask('https://tiles.example/streets/15/1/1.png');
  // …and the map's word of its provider arrives while that read is out.
  const told = w.tell(template);
  await first.done();
  await told;
  const next = w.ask('https://tiles.example/streets/15/1/2.png');
  assert.equal(next.answered(), true, 'the worker still knows the provider (its read of nothing must not undo what it was told)');
  await next.done();
  assert.deepEqual(w.kept().sort(), ['https://tiles.example/streets/15/1/1.png', 'https://tiles.example/streets/15/1/2.png']);
  // Any other picture from elsewhere goes straight through.
  assert.equal(w.ask('https://img.example/photo.png').answered(), false);
});

test('asked by the map itself (“does this provider answer now?”), a tile goes to the network — never a kept copy', async () => {
  const w = worker();
  for (const tile of ['https://a.basemaps.cartocdn.com/light_all/15/5202/11226.png', 'https://tile.openstreetmap.org/15/5202/11226.png']) {
    await w.ask(tile).done();
    const host = new URL(tile).hostname;
    assert.equal(w.ask(tile, { cache: 'no-store', destination: '' }).answered(), false, `${host}: left to the browser`);
    // A browser with its cache switched off (developer tools) hands the
    // worker 'reload' for every request: the script's ask still goes through.
    assert.equal(w.ask(tile, { cache: 'reload', destination: '' }).answered(), false, `${host}, cache off: left to the browser`);
    // The map's own tiles, the same: kept and answered.
    assert.equal(w.ask(tile, { cache: 'reload' }).answered(), true, `${host}: a tile on the map is answered`);
  }
});

test('Google’s tiles through the server are never kept (Google’s terms: no offline use); ones kept before go on activate', async () => {
  const w = worker();
  const own = `${ORIGIN}/tiles/15/5202/11226.png`;
  const a = w.ask(own);
  assert.equal(a.answered(), true);
  await a.done();
  assert.ok(w.fetched.some((f) => f.url === own), 'fetched from the network');
  assert.ok(!w.kept().some((u) => u.includes('/tiles/')), 'not kept');
  await w.ask(own).done();
  assert.equal(w.fetched.filter((f) => f.url === own).length, 2, 'asked again: the network again, never a kept copy');
  // An older worker kept some: activate throws them away, and keeps the free map's.
  const osm = 'https://tile.openstreetmap.org/15/5202/11226.png';
  w.stores.set(TILES, new Map([[own, new Response('x')], [`${ORIGIN}/tiles/15/5203/11226.png?t=satellite`, new Response('x')], [osm, new Response('x')]]));
  await w.activate();
  assert.deepEqual(w.kept(), [osm]);
});
