// The service worker's routing (web/public/sw.js): on base.win Base Ground
// runs at the root of the client's subdomain, so its worker's scope is the
// whole host, Base Air's /air included (SUITE.md). Base Air's requests must
// go straight to the network: never Base Ground's app shell, and never
// adopted as Base Ground's offline copy. Run in a sandbox with a stand-in
// `self`; only which requests the worker answers is checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const SOURCE = await readFile(new URL('../../web/public/sw.js', import.meta.url), 'utf8');

// A worker registered with `scope` on `origin`; → answered(url, init): true
// when the worker calls respondWith for that request.
const worker = (origin, scope) => {
  const handlers = {};
  const self = {
    registration: { scope: `${origin}${scope}` },
    location: { origin },
    addEventListener: (type, fn) => { handlers[type] = fn; },
  };
  // Nothing is ever really fetched or cached: a handler that gets as far as
  // either just fails quietly.
  const nope = () => Promise.reject(new Error('not in this test'));
  vm.runInNewContext(SOURCE, { self, URL, RegExp, Promise, Response, setTimeout, clearTimeout, caches: { open: nope, keys: nope, delete: nope }, fetch: nope, console });
  return (url, { mode = 'no-cors', destination = '' } = {}) => {
    let answered = false;
    handlers.fetch({
      request: { method: 'GET', url, mode, destination, headers: new Map() },
      respondWith: (p) => { answered = true; Promise.resolve(p).catch(() => {}); },
      waitUntil: (p) => { Promise.resolve(p).catch(() => {}); },
    });
    return answered;
  };
};

const HOST = 'https://imaginesurrey.base.win';
const nav = { mode: 'navigate', destination: 'document' };

test('at the root of a client’s subdomain: Base Air’s /air is never this worker’s', () => {
  const answered = worker(HOST, '/');
  for (const path of ['/air', '/air/', '/air/listen', '/air/auth/base/callback?code=x&state=y']) {
    assert.equal(answered(`${HOST}${path}`, nav), false, `navigation ${path}`);
  }
  assert.equal(answered(`${HOST}/air/assets/index-x1.js`, { destination: 'script' }), false, 'Base Air’s own build files');
  assert.equal(answered(`${HOST}/air/manifest.webmanifest`), false);
  // Base Ground's own screens and files are still answered (offline field mode).
  for (const path of ['/', '/field/', '/field/map', '/ground/people', '/map']) {
    assert.equal(answered(`${HOST}${path}`, nav), true, `navigation ${path}`);
  }
  assert.equal(answered(`${HOST}/assets/index-x1.js`, { destination: 'script' }), true);
  // A name that only starts with "air" is Base Ground's (an old field address).
  assert.equal(answered(`${HOST}/airport`, nav), true);
  // The server's own pages stay on the network, as before.
  for (const path of ['/api/auth/me', '/web', '/u/abc', '/join/abc']) assert.equal(answered(`${HOST}${path}`, nav), false, path);
});

test('under a prefix: only its own faces, nothing outside it', () => {
  const answered = worker('https://example.org', '/ground-app/');
  assert.equal(answered('https://example.org/ground-app/field/map', nav), true);
  assert.equal(answered('https://example.org/ground-app/air/', nav), false);
  assert.equal(answered('https://example.org/elsewhere/', nav), false);
  assert.equal(answered('https://example.org/air/', nav), false);
});
