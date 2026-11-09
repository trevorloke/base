// The front door: each client's paths go to that client's server, as they
// came; the client's name alone opens their public website; an old /web
// link opens the desk's Website area; an unknown client and a server that
// isn't answering each get a plain page; cookies, bodies and redirects pass
// through untouched.
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
let server, door, base;
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

before(async () => {
  server = upstream('server');
  const s = await listen(server);
  const clients = readClients(JSON.stringify({
    imaginesurrey: { name: 'Imagine Surrey', server: s },
    gone: { name: 'Gone Campaign', server: 'http://127.0.0.1:9' },
    older: { name: 'Older Config', ground: s, web: { redirect: 'https://site.example.org/admin' } },
  }));
  door = createServer(handler(clients));
  base = await listen(door);
});
after(() => { for (const s of [server, door]) s.close(); });

const get = (path, init = {}) => fetch(`${base}${path}`, { redirect: 'manual', ...init });

test('the client list: names and origins checked, a server required; older entries still read', () => {
  assert.throws(() => readClients('{"Bad Name!": {"server": "https://x.example"}}'), /usable name/);
  assert.throws(() => readClients('{"a": {"server": "https://x.example/path"}}'), /origin/);
  assert.throws(() => readClients('{"a": {"name": "No Server"}}'), /needs a server/);
  assert.throws(() => readClients('not json'), /not JSON/);
  assert.deepEqual(readClients('{"a": {"server": "https://g.example/"}}').get('a'), { name: 'a', origin: 'https://g.example' });
  // A config from before: "ground" is the server; "web" and "air" are ignored.
  assert.deepEqual(readClients('{"a": {"ground": "https://g.example", "web": "https://w.example", "air": "https://a.example"}}').get('a'),
    { name: 'a', origin: 'https://g.example' });
});

test('routes: the name alone is the website; site, field, desk, api and the rest go to the server', () => {
  const c = readClients('{"x": {"server": "https://g.example"}}');
  assert.deepEqual(route(c, '/x'), { redirect: '/x/site/' });
  assert.deepEqual(route(c, '/x/'), { redirect: '/x/site/' });
  assert.deepEqual(route(c, '/X'), { redirect: '/x/site/' });
  for (const p of ['/x/site/', '/x/site/news/hello', '/x/field/map', '/x/desk/people', '/x/api/health', '/x/webinar']) {
    assert.equal(route(c, p).upstream, 'https://g.example', p);
  }
  assert.deepEqual(route(c, '/X/desk'), { redirect: '/x/desk' });
  // No more Web: its back office is the desk's Website area.
  assert.deepEqual(route(c, '/x/web'), { redirect: '/x/desk/website' });
  assert.deepEqual(route(c, '/x/web/admin/pages'), { redirect: '/x/desk/website' });
  assert.equal(route(c, '/x/air/queue').upstream, 'https://g.example', 'an old /air link is the server’s (it opens the app)');
  assert.equal(route(c, '/nobody/field'), null);
});

test('a request goes to the client’s server with its path as it came', async () => {
  const r = await get('/imaginesurrey/field/map?turf=1');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { name: 'server', url: '/imaginesurrey/field/map?turf=1' });
  const site = await get('/imaginesurrey/site/news');
  assert.deepEqual(await site.json(), { name: 'server', url: '/imaginesurrey/site/news' });
  assert.equal(seen.at(-1).fwdHost, new URL(base).host, 'the server is told the address people used');
  const older = await get('/older/desk/');
  assert.deepEqual(await older.json(), { name: 'server', url: '/older/desk/' });
});

test('the client’s name alone opens their public website', async () => {
  const r = await get('/imaginesurrey?from=poster');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/imaginesurrey/site/?from=poster');
  const w = await get('/older/web/people?x=1');
  assert.equal(w.status, 302);
  assert.equal(w.headers.get('location'), '/older/desk/website?x=1', 'an old Web link: the desk’s Website area');
});

test('a sign-in: the body goes up, the cookies and the redirect come back untouched', async () => {
  const r = await get('/imaginesurrey/api/auth/login-now', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'old=1' }, body: '{"email":"a@example.org"}' });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/imaginesurrey/desk/');
  assert.deepEqual(r.headers.getSetCookie(), ['sid=abc; Path=/imaginesurrey; HttpOnly', 'pref=1; Path=/imaginesurrey']);
  const s = seen.at(-1);
  assert.deepEqual([s.method, s.body, s.cookie], ['POST', '{"email":"a@example.org"}', 'old=1']);
});

test('nobody at that name, a server not answering: a plain page each, saying base.win', async () => {
  const none = await get('/nobody/field/');
  assert.equal(none.status, 404);
  const noneText = await none.text();
  assert.match(noneText, /no campaign at this address on base\.win/);
  const down = await get('/gone/field/');
  assert.equal(down.status, 502);
  assert.match(await down.text(), /Gone Campaign isn’t answering on base\.win/);
  const home = await get('/');
  assert.equal(home.status, 200);
  const homeText = await home.text();
  assert.match(homeText, /<title>base\.win<\/title>/);
  assert.doesNotMatch(homeText, /imaginesurrey/i, 'the home page lists no campaigns');
  for (const t of [noneText, homeText]) assert.doesNotMatch(t, /\bGround\b|\bAir\b|Base Web/, 'one name: base.win');
  assert.equal((await (await get('/healthz')).json()).ok, true);
});
