// The front door: each client's paths go to that client's servers, as they
// came; the client's name alone opens the field app; an unknown client, an
// app a client doesn't have, and a server that isn't answering each get a
// plain page; cookies, bodies and redirects pass through untouched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { handler, readClients, route } from './door.mjs';

const seen = [];
const upstream = (name) => createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    seen.push({ name, method: req.method, url: req.url, body, fwdHost: req.headers['x-forwarded-host'], cookie: req.headers.cookie || '' });
    if (req.url.endsWith('/login-now')) {
      res.writeHead(302, { location: '/imaginesurrey/desk/', 'set-cookie': ['sid=abc; Path=/imaginesurrey; HttpOnly', 'pref=1; Path=/imaginesurrey'] });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name, url: req.url }));
  });
});
let ground, web, door, base;
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

before(async () => {
  ground = upstream('ground'); web = upstream('web');
  const g = await listen(ground); const w = await listen(web);
  const clients = readClients(JSON.stringify({
    imaginesurrey: { name: 'Imagine Surrey', ground: g, web: w },
    gone: { name: 'Gone Campaign', ground: 'http://127.0.0.1:9', air: { redirect: 'https://air.example.org' } },
  }));
  door = createServer(handler(clients));
  base = await listen(door);
});
after(() => { for (const s of [ground, web, door]) s.close(); });

const get = (path, init = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init });

test('the client list: names and origins checked, ground required', () => {
  assert.throws(() => readClients('{"Bad Name!": {"ground": "https://x.example"}}'), /usable name/);
  assert.throws(() => readClients('{"a": {"ground": "https://x.example/path"}}'), /origin/);
  assert.throws(() => readClients('{"a": {"web": "https://x.example"}}'), /needs a ground/);
  assert.throws(() => readClients('not json'), /not JSON/);
  const c = readClients('{"a": {"ground": "https://g.example/"}}');
  assert.deepEqual(c.get('a'), { name: 'a', ground: { origin: 'https://g.example' }, web: null, air: null });
  assert.throws(() => readClients('{"a": {"ground": "https://g.example", "web": {"redirect": "javascript:alert(1)"}}}'), /https address/);
});

test('routes: field, desk, api and the rest to Ground; /web and /air to theirs', () => {
  const c = readClients('{"x": {"ground": "https://g.example", "web": "https://w.example", "air": "https://a.example"}}');
  assert.equal(route(c, '/x/field/map').upstream, 'https://g.example');
  const r = readClients('{"x": {"ground": "https://g.example", "web": {"redirect": "https://site.example/admin"}}}');
  assert.deepEqual(route(r, '/x/web'), { redirect: 'https://site.example/admin', away: true });
  assert.deepEqual(route(r, '/x/web/people/1'), { redirect: 'https://site.example/admin/people/1', away: true });
  assert.equal(route(c, '/x/desk/people').upstream, 'https://g.example');
  assert.equal(route(c, '/x/api/health').upstream, 'https://g.example');
  assert.equal(route(c, '/x/web').upstream, 'https://w.example');
  assert.equal(route(c, '/x/web/admin').upstream, 'https://w.example');
  assert.equal(route(c, '/x/webinar').app, 'ground', 'only /web itself is Web');
  assert.equal(route(c, '/x/air/queue').upstream, 'https://a.example');
  assert.deepEqual(route(c, '/x'), { redirect: '/x/field/' });
  assert.deepEqual(route(c, '/X/desk'), { redirect: '/x/desk' });
  assert.equal(route(c, '/nobody/field'), null);
});

test('a request goes to the client’s Ground with its path as it came', async () => {
  const r = await get('/imaginesurrey/field/map?turf=1');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { name: 'ground', url: '/imaginesurrey/field/map?turf=1' });
  const w = await get('/imaginesurrey/web/admin');
  assert.deepEqual(await w.json(), { name: 'web', url: '/imaginesurrey/web/admin' });
  assert.equal(seen.at(-1).fwdHost, new URL(base).host, 'the app is told the address people used');
});

test('the client’s name alone opens the field app', async () => {
  const r = await get('/imaginesurrey?from=poster');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/imaginesurrey/field/?from=poster');
});

test('a sign-in: the body goes up, the cookies and the redirect come back untouched', async () => {
  const r = await get('/imaginesurrey/api/auth/login-now', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'old=1' }, body: '{"email":"a@example.org"}' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/imaginesurrey/desk/');
  assert.deepEqual(r.headers.getSetCookie(), ['sid=abc; Path=/imaginesurrey; HttpOnly', 'pref=1; Path=/imaginesurrey']);
  const s = seen.at(-1);
  assert.deepEqual([s.method, s.body, s.cookie], ['POST', '{"email":"a@example.org"}', 'old=1']);
});

test('nobody at that name, an app the client doesn’t have, a server not answering: a plain page each', async () => {
  const none = await get('/nobody/field/');
  assert.equal(none.status, 404);
  assert.match(await none.text(), /no Base at this address/);
  const air = await get('/imaginesurrey/air/');
  assert.equal(air.status, 404);
  assert.match(await air.text(), /Imagine Surrey doesn’t have Base Air yet/);
  const away = await get('/gone/air/queue?x=1');
  assert.equal(away.status, 302);
  assert.equal(away.headers.get('location'), 'https://air.example.org/queue?x=1', 'Air where it runs, the rest of the path after it');
  const down = await get('/gone/field/');
  assert.equal(down.status, 502);
  assert.match(await down.text(), /Gone Campaign’s Base isn’t answering/);
  const home = await get('/');
  assert.equal(home.status, 200);
  assert.doesNotMatch(await home.text(), /imaginesurrey/i, 'the home page lists no campaigns');
  assert.equal((await (await get('/healthz')).json()).ok, true);
});
