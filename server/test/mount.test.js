// base.win under a client's path on a shared domain (lib/mount.js):
// base.win/imaginesurrey/… The path comes off on the way in and goes back on
// redirects, the sign-in cookie, and the pages and stylesheets the server
// sends; the client's path alone and an old /admin link go where they
// should; another path on the domain isn't answered; and at a site's root
// (no BASE_PATH) nothing changes.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { app } from '../index.js';
import { basePath, mountAt, rewriters, here } from '../lib/mount.js';

const B = '/imaginesurrey';
const door = mountAt(app, B);
const call = (path, init = {}) => door(new Request(`http://base.test${path}`, init));
let cookie = '';

before(async () => { await freshDb(); });

test('BASE_PATH: one segment, tidied; anything else is no path', () => {
  assert.equal(basePath('/imaginesurrey'), '/imaginesurrey');
  assert.equal(basePath('imaginesurrey/'), '/imaginesurrey');
  assert.equal(basePath(''), '');
  assert.equal(basePath('/a/b'), '');
  assert.equal(basePath('/../x'), '');
  assert.equal(here({ env: { base: B } }, '/tiles/1/2/3.png'), '/imaginesurrey/tiles/1/2/3.png');
  assert.equal(here({ env: {} }, '/tiles/1/2/3.png'), '/tiles/1/2/3.png');
});

test('the API answers under the client’s path — and at the server’s own address, as before', async () => {
  const h = await call(`${B}/api/health`);
  assert.equal(h.status, 200);
  assert.equal((await h.json()).ok, true);
  assert.equal((await call('/api/health')).status, 200, 'the host checks /api/health as it is');
  const old = await call('/api/auth/me');
  assert.equal(old.status, 401, 'the old address still answers, not redirected');
  const longer = await call('/imaginesurreyx/api/health');
  assert.notEqual(longer.headers.get('location') || '', `${B}x/api/health`, 'a longer name is not this client’s path');
});

test('the client’s path alone opens the field app; /admin goes to /desk; an old /login to the field app’s', async () => {
  const root = await call(B);
  assert.equal(root.status, 302);
  assert.equal(new URL(root.headers.get('location')).pathname, `${B}/field/`);
  const admin = await call(`${B}/admin/people?tag=vip`);
  assert.equal(admin.status, 302);
  const to = new URL(admin.headers.get('location'));
  assert.equal(`${to.pathname}${to.search}`, `${B}/desk/people?tag=vip`);
  const login = await call(`${B}/login?next=x`);
  assert.equal(login.status, 302);
  assert.equal(login.headers.get('location'), `${B}/field/login?next=x`);
});

test('signing in: the cookie is kept to the client’s path, and works there', async () => {
  const res = await call(`${B}/api/auth/signup`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Marco Manager', email: 'marco@example.org', password: 'surrey-forward-2026', workspaceName: 'Imagine Surrey', jurisdiction: 'bc-municipal' }),
  });
  assert.equal(res.status, 201, await res.clone().text());
  const set = res.headers.getSetCookie();
  assert.ok(set.length >= 1);
  assert.ok(set.every((c) => /;\s*Path=\/imaginesurrey(;|$)/i.test(c)), set.join(' | '));
  cookie = set.map((c) => c.split(';')[0]).join('; ');
  const old = await call('/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Old Address', email: 'old@example.org', password: 'surrey-forward-2026', workspaceName: 'Old', jurisdiction: 'bc-municipal' }),
  });
  if (old.status === 201) assert.ok(old.headers.getSetCookie().every((c) => /Path=\/(;|$)/i.test(c)), 'at the old address the cookie is the site’s, as before');
  const me = await call(`${B}/api/auth/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).workspace.name, 'Imagine Surrey');
  const out = await call(`${B}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  assert.ok(out.headers.getSetCookie().every((c) => /Path=\/imaginesurrey/i.test(c)), 'signing out clears the same cookie');
});

test('what the server sends a browser: links, forms, styles, the app’s page, the install manifest', () => {
  const rw = rewriters(B);
  assert.equal(rw.location('/field/'), `${B}/field/`);
  assert.equal(rw.location(`${B}/field/`), `${B}/field/`, 'never twice');
  assert.equal(rw.location('https://elsewhere.example/x'), 'https://elsewhere.example/x');
  assert.equal(rw.location('//cdn.example/x'), '//cdn.example/x');
  const html = rw.html('<html><head><title>x</title></head><body><div id="root"></div><a href="/u/1">u</a> <form action="/u/1"></form> <img src="/star.png"> <a href="https://x.example/">x</a> <a href="//cdn.example/a">c</a> <a href="/imaginesurrey/field/">f</a> <a href="/imaginesurreyx/">o</a></body></html>');
  assert.match(html, /<head><script>window\.__BASE__="\/imaginesurrey"<\/script>/);
  assert.match(html, /href="\/imaginesurrey\/u\/1"/);
  assert.match(html, /action="\/imaginesurrey\/u\/1"/);
  assert.match(html, /src="\/imaginesurrey\/star\.png"/);
  assert.match(html, /href="https:\/\/x\.example\/"/);
  assert.match(html, /href="\/\/cdn\.example\/a"/);
  assert.match(html, /href="\/imaginesurrey\/field\/"/);
  assert.doesNotMatch(html, /\/imaginesurrey\/imaginesurrey\//, "never twice");
  assert.match(html, /href="\/imaginesurrey\/imaginesurreyx\/"/, 'a longer name is a path like any other');
  assert.equal(rw.html('<html><head></head><body>no app here</body></html>').includes('__BASE__'), false, 'only the app’s page gets the script');
  assert.equal(rw.css(".a{background:url('/star.png')} .b{background:url(/x.png)} .c{background:url(data:x)}"),
    ".a{background:url('/imaginesurrey/star.png')} .b{background:url(/imaginesurrey/x.png)} .c{background:url(data:x)}");
  assert.equal(rw.cookie('sid=1; Path=/; HttpOnly'), 'sid=1; Path=/imaginesurrey; HttpOnly');
  assert.equal(rw.cookie('sid=1; Path=/imaginesurrey; HttpOnly'), 'sid=1; Path=/imaginesurrey; HttpOnly');
  const m = rw.manifest({ id: '/', start_url: '/map', scope: '/', icons: [{ src: '/icon-192.png' }] });
  assert.deepEqual([m.id, m.start_url, m.scope, m.icons[0].src], [`${B}/`, `${B}/field/map`, `${B}/`, `${B}/icon-192.png`]);
});

test('at a site’s root (no BASE_PATH) nothing changes', async () => {
  const plain = mountAt(app, '');
  const h = await plain(new Request('http://root.test/api/health'));
  assert.equal(h.status, 200);
  const res = await plain(new Request('http://root.test/api/auth/me'));
  assert.equal(res.status, 401);
});
