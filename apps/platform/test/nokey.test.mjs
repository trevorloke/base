// With no Render key the control centre is exactly what it was before it
// could hold one: Campaigns, New campaign, a campaign's page, its set-up
// page and base.win’s key are the same bytes (the copies in golden/ were
// made from the code before the feature), the menu has no Render, and every
// /render route is Not found. A key that can't be a key (a space in it, too
// short, too long) counts as none, and so do the other Render settings
// without a key.
//
// When one of these pages is changed on purpose, make the copies again:
//   NOKEY_GOLDEN=write node --test apps/platform/test/nokey.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { freshApp, setUp, baseEnv } from './helpers.mjs';

const RENDER_SETTINGS = ['RENDER_API_KEY', 'RENDER_SERVICE_ID', 'OPS_RENDER_API', 'RENDER'];
const noKey = () => { baseEnv(); for (const k of RENDER_SETTINGS) delete process.env[k]; };
noKey();

const GOLDEN = new URL('./golden/', import.meta.url);
const PAGES = { '/': 'campaigns', '/new': 'new', '/c/x': 'campaign', '/c/x/setup': 'setup', '/key': 'key' };
// The only thing on these pages that moves by itself: the time on a log line.
const steady = (body) => body.replace(/<span class="oc-when">[^<]*<\/span>/g, '<span class="oc-when">WHEN</span>');

const { app, db } = await freshApp();
const op = await setUp(app, db);
const made = await op.b.post('/new', { name: 'x', display: 'Example X', city: 'Exampleton', province: 'BC', rules: 'bc-municipal', tz: 'America/Vancouver', races: 'council', sw: '50.6, -120.5', ne: '50.8, -120.2' });
assert.equal(made.status, 303);

const read = async (path) => {
  const res = await op.b.get(path);
  assert.equal(res.status, 200, path);
  return steady(await res.text());
};

test('with no key, each page is byte for byte what it was before', async () => {
  for (const [path, slug] of Object.entries(PAGES)) {
    const body = await read(path);
    const file = new URL(`nokey-${slug}.html`, GOLDEN);
    if (process.env.NOKEY_GOLDEN === 'write') { mkdirSync(GOLDEN, { recursive: true }); writeFileSync(file, body); continue; }
    const want = readFileSync(file, 'utf8');
    if (body !== want) {
      const a = body.split('\n');
      const b = want.split('\n');
      const at = a.findIndex((line, i) => line !== b[i]);
      assert.fail(`${path} changed at line ${at + 1}:\n  now:    ${a[at]}\n  before: ${b[at]}`);
    }
  }
});

test('the other Render settings without a key, and a key that can’t be one, change nothing', async () => {
  const plain = {};
  for (const path of Object.keys(PAGES)) plain[path] = await read(path);
  const cases = [
    { RENDER_SERVICE_ID: 'srv-abcdefghij0123456789', OPS_RENDER_API: 'http://127.0.0.1:5608/v1', OPS_ALLOW_LOCAL: '1' },
    { RENDER_API_KEY: 'rnd_has a space in it 0123456789', RENDER_SERVICE_ID: 'srv-abcdefghij0123456789' },
    { RENDER_API_KEY: 'rnd_tooshort', RENDER_SERVICE_ID: 'srv-abcdefghij0123456789' },
    { RENDER_API_KEY: `rnd_${'x'.repeat(200)}`, RENDER_SERVICE_ID: 'srv-abcdefghij0123456789' },
  ];
  for (const settings of cases) {
    noKey();
    Object.assign(process.env, settings);
    for (const path of Object.keys(PAGES)) {
      // OPS_ALLOW_LOCAL alone widens form-action in a header, never the page.
      assert.equal(await read(path), plain[path], `${path} with ${Object.keys(settings).join(', ')}`);
    }
    assert.equal((await op.b.get('/render')).status, 404, 'no /render');
  }
  noKey();
});

test('with no key, every /render route is Not found and the menu has no Render', async () => {
  for (const path of ['/render', '/c/x/render', '/c/sample/render', '/c/nobody/render']) {
    assert.equal((await op.b.get(path)).status, 404, `GET ${path}`);
  }
  for (const path of ['/render/check', '/c/x/render/link', '/c/x/render/deploy', '/c/x/render/restart', '/c/x/render/key', '/c/x/render/domain', '/c/x/render/close-db', '/c/sample/render/link']) {
    assert.equal((await op.b.post(path, {})).status, 404, `POST ${path}`);
    assert.equal((await op.b.post(path, { job: 'a'.repeat(32), code: '123456' })).status, 404, `POST ${path} with a job`);
  }
  for (const path of [...Object.keys(PAGES), '/log']) {
    const body = await (await op.b.get(path)).text();
    assert.doesNotMatch(body, /href="\/render"/, `${path}: no Render in the menu`);
    assert.doesNotMatch(body, /\/render\b/, `${path}: no link to a Render page`);
  }
  assert.deepEqual(await (await op.b.get('/healthz')).json(), { ok: true, db: 'ok' }, '/healthz says nothing about Render');
});
