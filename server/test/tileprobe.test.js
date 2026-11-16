// The page's notice probe (web/src/pages/tileProbe.js): two of a provider's
// tiles, far apart in zoom — the same bytes is a notice, not streets. It asks
// a provider the phone reaches itself only (never the server's own /tiles/,
// Google's), lets the browser's cache answer (no no-cache headers: tile
// servers' rules), and asks each address once per page life.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { askNotice, forgetNotice } from '../../web/src/pages/tileProbe.js';

const realFetch = globalThis.fetch;
const asked = [];
let answer = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
globalThis.fetch = async (url, init) => { asked.push({ url, init }); return answer(url); };
after(() => { globalThis.fetch = realFetch; });
beforeEach(() => { asked.length = 0; });

const at = { lat: 49.19, lng: -122.85 };
const CARTO = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png?key=one';

test('a third-party host: asked with cache default and no credentials, never no-store or reload; the same picture is a notice', async () => {
  assert.equal(await askNotice(CARTO, at, 20), true);
  assert.equal(asked.length, 2);
  for (const a of asked) {
    assert.equal(a.init.cache, 'default');
    assert.equal(a.init.credentials, 'omit');
    assert.equal(a.init.mode, 'cors');
  }
  assert.deepEqual(asked.map((a) => a.url.split('/')[4]), ['3', '15']);
});

test('once per address until forgotten; a different picture per tile is streets', async () => {
  const OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  let n = 0;
  answer = () => { n += 1; return new Response(new Uint8Array([n]), { status: 200 }); };
  assert.equal(await askNotice(OSM, at), false);
  assert.equal(await askNotice(OSM, at), false);
  assert.equal(asked.length, 2, 'asked once');
  forgetNotice(OSM);
  await askNotice(OSM, at);
  assert.equal(asked.length, 4, 'asked again after Check again');
});

test('never the server’s own tiles; a failure or refusal is no verdict', async () => {
  assert.equal(await askNotice('/tiles/{z}/{x}/{y}.png', at), null);
  assert.equal(await askNotice('/imaginesurrey/tiles/{z}/{x}/{y}.png?t=satellite', at), null);
  assert.equal(asked.length, 0);
  answer = () => new Response('no', { status: 403 });
  assert.equal(await askNotice('https://tiles.example/a/{z}/{x}/{y}.png', at), null);
  answer = () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await askNotice('https://tiles.example/b/{z}/{x}/{y}.png', at), null);
});
