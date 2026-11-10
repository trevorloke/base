// A page from before a deploy. The server names its web build on every /api
// answer (X-Build: the page's entry file, from web/dist/index.html — it
// changes with every build) and at /api/health; a page compares that with
// its own and says "A new version is ready" (web/src/build.js). A file of an
// older build that is gone answers 404 — never the app's page under a .js
// name, which a browser refuses as a script and the screen went blank.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { buildOf, currentBuild, _setIndexForTest } from '../lib/build.js';

const page = (entry) => `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<link rel="stylesheet" href="/fonts/fonts.css" />
<script type="module" crossorigin src="/assets/${entry}"></script>
<link rel="stylesheet" crossorigin href="/assets/index-DaUc7oXG.css"></head><body><div id="root"></div></body></html>`;

let dir;
let index;
let tick = 0;
// A deploy: a new page on disk (its time moves on, as a build's does).
const deploy = (entry) => {
  writeFileSync(index, page(entry));
  tick += 1;
  const at = new Date(Date.UTC(2026, 10, 10, 12, 0, tick));
  utimesSync(index, at, at);
  _setIndexForTest(); // look again now, not in two seconds
};

before(async () => {
  await freshDb();
  dir = mkdtempSync(join(tmpdir(), 'basewin-build-'));
  index = join(dir, 'index.html');
  _setIndexForTest(index);
});
after(() => { rmSync(dir, { recursive: true, force: true }); });

test('the build is the page’s entry file', () => {
  assert.equal(buildOf(page('index-BviH2piN.js')), 'index-BviH2piN.js');
  // Under a client's path the page's links carry it (lib/mount.js): the file is the same.
  assert.equal(buildOf(page('index-BviH2piN.js').replace('/assets/', '/imaginesurrey/assets/')), 'index-BviH2piN.js');
  assert.equal(buildOf('<html><script src="/site-assets/site-islands.js"></script></html>'), null, 'not the app’s page');
  assert.equal(buildOf(''), null);
});

test('every /api answer names the build; a deploy changes it', async () => {
  assert.equal(currentBuild(), null, 'no web build: nothing claimed');
  assert.equal((await app.request('/api/health')).headers.get('x-build'), null);

  deploy('index-OLDbuild1.js');
  const health = await app.request('/api/health');
  assert.equal(health.headers.get('x-build'), 'index-OLDbuild1.js');
  assert.equal((await health.json()).build, 'index-OLDbuild1.js');
  // Signed in or refused, a read or a write: the same.
  assert.equal((await app.request('/api/map/doors')).headers.get('x-build'), 'index-OLDbuild1.js', 'a 401 names it too');
  const mgr = new Client();
  await mgr.signup({ workspaceName: 'Build check', jurisdiction: 'bc-municipal' });
  const doors = await app.request('/api/map/doors', { headers: { cookie: mgr.cookie } });
  assert.deepEqual([doors.status, doors.headers.get('x-build')], [200, 'index-OLDbuild1.js']);

  // The deploy: the page that tab still runs is index-OLDbuild1.js; the server now says otherwise.
  deploy('index-NEWbuild2.js');
  const after = await app.request('/api/map/doors', { headers: { cookie: mgr.cookie } });
  assert.equal(after.headers.get('x-build'), 'index-NEWbuild2.js');
  // Only the API says it (the website and the server's own pages have no build to compare).
  assert.equal((await app.request('/u/not-a-token')).headers.get('x-build'), null);
});

test('a file of a build that is gone answers 404, not the app’s page', async () => {
  for (const path of ['/assets/Map-GONE0000.js', '/assets/index-OLDbuild1.js', '/assets/People-GONE0000.css']) {
    const res = await app.request(path);
    assert.equal(res.status, 404, path);
    assert.ok(!(res.headers.get('content-type') || '').includes('text/html'), `${path} is not a page`);
    assert.match(res.headers.get('cache-control') || '', /no-store/, 'never kept as that file');
  }
});
