// BASE_PATH (lib/basepath.js, lib/htmlhead.js — SUITE.md): Base Ground under
// a prefix (/imaginesurrey/…) when a deployment puts it under one, the two
// faces at /field and /ground, the old addresses sent on, and the session
// cookie host-only, on the prefix's path. On base.win each client has its
// own subdomain and Base Ground runs at the root (no BASE_PATH): everything
// is where it always was.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { publicUrlMismatch, clientSlug } from '../lib/basepath.js';
import { baseTags, headTags, injectHead } from '../lib/htmlhead.js';
import { cleanBase } from '@base-ground/shared/paths';
import { renderMarkdown } from '@base-ground/shared/markdown';

const KEYS = ['BASE_PATH', 'BASE_PUBLIC_URL', 'BASE_CLIENT', 'BASE_TRUSTED_PROXIES', 'BASE_WEB_URL'];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const tag = Math.random().toString(36).slice(2, 8);
const BUILT = existsSync(new URL('../../web/dist/index.html', import.meta.url));
let mgr;

before(async () => {
  for (const k of KEYS) delete process.env[k];
  await freshDb();
  mgr = new Client();
  await mgr.signup({ workspaceName: `Base path ${tag}`, email: `bp+${tag}@example.org` });
});
after(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const req = (path, opts = {}) => app.request(path, { redirect: 'manual', ...opts });
const where = (res) => res.headers.get('location');

test('cleanBase: a plain path or nothing', () => {
  assert.equal(cleanBase(''), '');
  assert.equal(cleanBase('/'), '');
  assert.equal(cleanBase(' imaginesurrey/ '), '/imaginesurrey');
  assert.equal(cleanBase('/a/b'), '/a/b');
  for (const bad of ['/a b', '/a"><script>', '/../x', '/a/./b', 'https://x', '/a?b', '/a#b', '/a\\b']) assert.equal(cleanBase(bad), null, bad);
});

test('under a prefix: handled as if at the root; outside it, 308 to the same address under it', async () => {
  process.env.BASE_PATH = '/imaginesurrey';
  try {
    const me = await req('/imaginesurrey/api/auth/me', { headers: { cookie: mgr.cookie } });
    assert.equal(me.status, 200);
    // A POST with a body keeps it through the prefix.
    const made = await req('/imaginesurrey/api/actions/person.create', {
      method: 'POST', headers: { cookie: mgr.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Pat Prefix' }),
    });
    assert.equal(made.status, 200);
    assert.equal((await made.json()).person.name, 'Pat Prefix');

    const off = await req('/api/auth/me?x=1');
    assert.equal(off.status, 308);
    assert.equal(where(off), '/imaginesurrey/api/auth/me?x=1');
    assert.equal(where(await req('/field/map')), '/imaginesurrey/field/map');
    assert.equal(where(await req('/imaginesurreyx/field')), '/imaginesurrey/imaginesurreyx/field', 'a longer name is not the prefix');
    // The health check answers without the prefix (Render calls /api/health) and with it.
    // Neither says whose it is: the unprefixed one answers whatever the
    // prefix, so it must not name the client.
    process.env.BASE_ORG_NAME = 'Imagine Surrey';
    for (const p of ['/api/health', '/imaginesurrey/api/health']) {
      const h = await req(p);
      assert.equal(h.status, 200, p);
      const j = await h.json();
      assert.equal(j.ok, true);
      assert.deepEqual(Object.keys(j).sort(), ['commit', 'env', 'ok', 'service', 'tzdataCurrent'], p);
      assert.equal(j.service, 'base-ground');
      assert.ok(!JSON.stringify(j).includes('Imagine Surrey'), p);
    }
  } finally { delete process.env.BASE_PATH; delete process.env.BASE_ORG_NAME; }
});

test('the two faces: / → /field/, /admin… → /ground/…, /join → the field app', async () => {
  for (const base of ['', '/imaginesurrey']) {
    if (base) process.env.BASE_PATH = base; else delete process.env.BASE_PATH;
    try {
      const home = await req(`${base}/`);
      assert.equal(home.status, 302);
      assert.equal(where(home), `${base}/field/`);
      if (base) assert.equal(where(await req(base)), `${base}/field/`, 'the bare prefix too');
      const desk = await req(`${base}/admin`);
      assert.equal(desk.status, 308);
      assert.equal(where(desk), `${base}/ground/`);
      assert.equal(where(await req(`${base}/admin/people/import?tab=2`)), `${base}/ground/people/import?tab=2`);
      assert.equal(where(await req(`${base}/join/abc123`)), `${base}/field/join/abc123`);
      // A field screen at its old address (a home-screen icon from before).
      const old = await req(`${base}/map?turf=1`);
      assert.equal(old.status, 308);
      assert.equal(where(old), `${base}/field/map?turf=1`);
      // A missing file is a 404, never the app under a .js name.
      assert.equal((await req(`${base}/assets/gone-123.js`)).status, 404);
      assert.equal((await req(`${base}/nothing.png`)).status, 404);
      // Both faces get the app.
      for (const face of ['/field/', '/field/map', '/ground', '/ground/people/x', '/index.html']) {
        const res = await req(`${base}${face}`);
        if (!BUILT) { assert.equal(res.status, 503, face); continue; }
        assert.equal(res.status, 200, face);
        assert.equal(res.headers.get('cache-control'), 'no-cache');
        const html = await res.text();
        assert.ok(html.includes(`<base href="${base}/">`), face);
        assert.ok(html.includes(`window.__BASE_PATH__=${JSON.stringify(base)}`), face);
      }
    } finally { delete process.env.BASE_PATH; }
  }
});

test('/web: Base Web’s admin, through its sign-in from Base Ground', async () => {
  assert.equal((await req('/web')).status, 404);
  process.env.BASE_WEB_URL = 'https://imaginesurrey.ca/';
  assert.equal(where(await req('/web')), 'https://imaginesurrey.ca/auth/base');
  delete process.env.BASE_WEB_URL;
});

test('the head tags: <base href> and window.__BASE_PATH__, escaped; one place to add more', async () => {
  assert.equal(baseTags(''), '<base href="/"><script>window.__BASE_PATH__=""</script>');
  assert.equal(baseTags('/imaginesurrey'), '<base href="/imaginesurrey/"><script>window.__BASE_PATH__="/imaginesurrey"</script>');
  assert.ok(!baseTags('/x</script><script>').includes('</script><script>alert'), 'no way out of the script');
  process.env.BASE_PATH = '/c1';
  assert.ok((await headTags()).startsWith('<base href="/c1/">'));
  delete process.env.BASE_PATH;
  const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="manifest" href="manifest.webmanifest"></head></html>';
  const out = injectHead(html, '<base href="/c1/">');
  assert.ok(out.indexOf('<base') < out.indexOf('<link'), 'before anything that loads a file');
});

test('the session cookie: host-only (never a Domain), on the prefix’s path', async () => {
  const c = async () => (await req('/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'C', email: `bp-c${Math.random().toString(36).slice(2, 7)}@example.org`, password: 'cookie-pass-1', workspaceName: 'Cookie' }),
  })).headers.get('set-cookie');
  assert.match(await c(), /Path=\/(;|$)/);
  assert.doesNotMatch(await c(), /Domain=/i, 'host-only: never a Domain, so another client’s subdomain never gets it');
  process.env.BASE_PATH = '/imaginesurrey';
  try {
    const res = await req('/imaginesurrey/api/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'C', email: `bp-d${tag}@example.org`, password: 'cookie-pass-1', workspaceName: 'Cookie 2' }),
    });
    assert.match(res.headers.get('set-cookie'), /Path=\/imaginesurrey(;|$)/);
    assert.doesNotMatch(res.headers.get('set-cookie'), /Domain=/i);
    const out = await req('/imaginesurrey/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json', cookie: res.headers.get('set-cookie').split(';')[0] } });
    assert.match(out.headers.get('set-cookie'), /Path=\/imaginesurrey(;|$)/);
  } finally { delete process.env.BASE_PATH; }
});

test('links: emailed ones from BASE_PUBLIC_URL, else this address with the prefix; pages under the prefix', async () => {
  process.env.BASE_PATH = '/imaginesurrey';
  try {
    const inv = await req('/imaginesurrey/api/actions/member.invite', {
      method: 'POST', headers: { cookie: mgr.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ email: `bp-inv+${tag}@example.org`, role: 'volunteer' }),
    });
    assert.match((await inv.json()).joinUrl, /^http:\/\/localhost\/imaginesurrey\/join\//);
    process.env.BASE_PUBLIC_URL = 'https://base.win/imaginesurrey';
    const inv2 = await req('/imaginesurrey/api/actions/member.invite', {
      method: 'POST', headers: { cookie: mgr.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ email: `bp-inv2+${tag}@example.org`, role: 'volunteer' }),
    });
    assert.match((await inv2.json()).joinUrl, /^https:\/\/base\.win\/imaginesurrey\/join\//);
    assert.equal(renderMarkdown('![x](/media/abc)', { base: '/imaginesurrey' }).includes('src="/imaginesurrey/media/abc"'), true);
    assert.equal(renderMarkdown('[x](https://e.org/a)', { base: '/imaginesurrey' }).includes('href="https://e.org/a"'), true);
  } finally { delete process.env.BASE_PATH; delete process.env.BASE_PUBLIC_URL; }
});

test('BASE_PUBLIC_URL and BASE_PATH must agree (said, never a crash); the client’s slug', () => {
  assert.equal(publicUrlMismatch({ BASE_PATH: '/imaginesurrey', BASE_PUBLIC_URL: 'https://base.win/imaginesurrey' }), null);
  assert.equal(publicUrlMismatch({ BASE_PATH: '/imaginesurrey', BASE_PUBLIC_URL: 'https://base.win/imaginesurrey/' }), null);
  assert.equal(publicUrlMismatch({ BASE_PATH: '', BASE_PUBLIC_URL: 'https://base.imaginesurrey.ca' }), null);
  // base.win: the client's own subdomain, Base Ground at its root.
  assert.equal(publicUrlMismatch({ BASE_PUBLIC_URL: 'https://imaginesurrey.base.win' }), null);
  assert.equal(publicUrlMismatch({ BASE_PUBLIC_URL: 'https://imaginesurrey.staging.base.win/' }), null);
  assert.equal(publicUrlMismatch({ BASE_PATH: '/imaginesurrey' }), null);
  assert.match(publicUrlMismatch({ BASE_PATH: '/imaginesurrey', BASE_PUBLIC_URL: 'https://base.win' }), /BASE_PATH is "\/imaginesurrey"/);
  assert.match(publicUrlMismatch({ BASE_PATH: '', BASE_PUBLIC_URL: 'https://base.win/other' }), /ends in "\/other"/);
  process.env.BASE_PATH = '/clients/imaginesurrey';
  assert.equal(clientSlug(), 'imaginesurrey');
  process.env.BASE_CLIENT = 'Bad Slug!';
  assert.equal(clientSlug(), 'imaginesurrey', 'a BASE_CLIENT that isn’t a slug is ignored');
  delete process.env.BASE_PATH; delete process.env.BASE_CLIENT;
  assert.equal(clientSlug(), null);
});

test('behind the front door (two proxies): sign-in limits count the visitor, not the door', async () => {
  process.env.BASE_TRUSTED_PROXIES = '2';
  process.env.BASE_PATH = '/imaginesurrey';
  try {
    // Render appends the front door's address; the front door appended the
    // visitor's. Whatever the visitor wrote further left is ignored.
    const login = (visitor, spoof) => req('/imaginesurrey/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `${spoof}, ${visitor}, 10.0.0.9` },
      body: JSON.stringify({ email: `nobody-${Math.random()}@example.org`, password: 'x' }),
    });
    let last;
    for (let i = 0; i < 31; i++) last = await login('198.51.100.7', `1.1.1.${i}`);
    assert.equal(last.status, 429, 'one visitor, many spoofed addresses: still one visitor');
    assert.equal((await login('198.51.100.8', '1.1.1.1')).status, 401, 'another visitor behind the same door is not held up');
  } finally { delete process.env.BASE_TRUSTED_PROXIES; delete process.env.BASE_PATH; }
});
