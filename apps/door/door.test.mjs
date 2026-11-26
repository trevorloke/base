// The front door: <client>.base.win goes to that client's server, the path
// as it came; base.win/<client>/… (the address from before) only sends
// people on to <client>.base.win; an unknown name and a server that isn't
// answering each get a plain page; cookies, bodies and redirects pass
// through untouched; the visitor's address goes up with the door's key
// (BASE_DOOR_KEY), so the server can tell visitors apart.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request } from 'node:http';
import { handler, readClients, hostClient, moved, named, clientOrigin, RESERVED } from './door.mjs';

const seen = [];
const upstream = (name) => createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    seen.push({
      name, method: req.method, url: req.url, body, fwdHost: req.headers['x-forwarded-host'], cookie: req.headers.cookie || '',
      clientIp: req.headers['x-base-client-ip'], doorKey: req.headers['x-base-door'],
    });
    if (req.url.endsWith('/login-now')) {
      res.writeHead(302, { location: '/admin/', 'set-cookie': ['sid=abc; Path=/; HttpOnly', 'pref=1; Path=/'] });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name, url: req.url }));
  });
});
let server, door, base, clients;
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

before(async () => {
  server = upstream('server');
  const s = await listen(server);
  clients = readClients(JSON.stringify({
    imaginesurrey: { name: 'Imagine Surrey', server: s },
    gone: { name: 'Gone Campaign', server: 'http://127.0.0.1:9' },
    older: { name: 'Older Config', ground: s, web: { redirect: 'https://site.example.org/admin' } },
  }));
  door = createServer(handler(clients, { doorKey: '' }));
  base = await listen(door);
});
after(() => { for (const s of [server, door]) s.close(); });

// A request to the door as the browser sends it: the Host says whose it is.
const withHost = (host, path, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const u = new URL(base);
  const req = request({ host: u.hostname, port: u.port, path, method, headers: { host, ...headers } }, (res) => {
    let text = '';
    res.on('data', (d) => { text += d; });
    res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, cache: res.headers['cache-control'], cookies: res.headers['set-cookie'], text, json: () => JSON.parse(text) }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});
const IS = 'imaginesurrey.base.win';

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

test('whose address: <client>.base.win is the client’s; base.win, www and the door’s own are nobody’s', () => {
  const c = readClients('{"x": {"server": "https://g.example"}}');
  assert.deepEqual(hostClient(c, 'x.base.win'), { client: { name: 'x', origin: 'https://g.example' }, key: 'x' });
  for (const host of ['X.Base.Win:443', 'x.base.win.']) assert.equal(hostClient(c, host)?.key, 'x', host);
  for (const host of ['base.win', 'www.base.win', 'base-door.onrender.com', '127.0.0.1:8080', '']) assert.equal(hostClient(c, host), null, host);
  // Another name under base.win is nobody's — never a client's server.
  for (const host of ['nobody.base.win', 'ops.base.win', 'staging.base.win', 'y.x.base.win']) assert.deepEqual(hostClient(c, host), { unknown: true }, host);
  // Somebody else's domain, or one merely ending in base.win, names no client.
  for (const host of ['x.evil.example', 'x.notbase.win', 'x.base.win.evil.example']) assert.equal(hostClient(c, host), null, host);
  // Another domain when BASE_APEX says so (a staging door, say; this machine).
  assert.equal(hostClient(c, 'x.door.example', 'door.example')?.key, 'x');
  assert.equal(hostClient(c, 'x.base.win', 'door.example'), null);
  assert.equal(clientOrigin('x', 'base.win', ''), 'https://x.base.win');
  assert.equal(clientOrigin('x', 'localhost', '8080'), 'http://x.localhost:8080');
});

test('<client>.base.win goes to the client’s server with its path as it came', async () => {
  const r = await withHost(IS, '/map?turf=1');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json(), { name: 'server', url: '/map?turf=1' });
  assert.equal(seen.at(-1).fwdHost, IS, 'the server is told the address people used');
  for (const p of ['/', '/admin/people', '/site/news/hello', '/api/health', '/field-report', '/webinar']) {
    assert.deepEqual((await withHost(IS, p)).json(), { name: 'server', url: p }, p);
  }
  assert.deepEqual((await withHost('ImagineSurrey.Base.Win:443', '/admin/')).json(), { name: 'server', url: '/admin/' });
  assert.deepEqual((await withHost('older.base.win', '/admin/')).json(), { name: 'server', url: '/admin/' });
});

test('the desk and the volunteers’ app by name: /desk opens /admin, /field opens /', async () => {
  assert.equal(named('/desk'), '/admin/');
  assert.equal(named('/desk/people/import'), '/admin/people/import');
  assert.equal(named('/field'), '/');
  assert.equal(named('/field/map'), '/map');
  for (const p of ['/', '/admin', '/field-report', '/fields', '/desktop', '/site/desk']) assert.equal(named(p), null, p);
  const before = seen.length;
  const d = await withHost(IS, '/desk/people?q=lee');
  assert.deepEqual([d.status, d.location, d.cache], [302, '/admin/people?q=lee', 'no-store']);
  const f = await withHost(IS, '/field/map');
  assert.deepEqual([f.status, f.location], [302, '/map']);
  assert.equal(seen.length, before, 'the door sends these on itself');
});

test('a sign-in: the body goes up, the cookies and the redirect come back untouched', async () => {
  const r = await withHost(IS, '/api/auth/login-now', { method: 'POST', headers: { 'content-type': 'application/json', cookie: 'old=1' }, body: '{"email":"a@example.org"}' });
  assert.equal(r.status, 302);
  assert.equal(r.location, '/admin/');
  assert.deepEqual(r.cookies, ['sid=abc; Path=/; HttpOnly', 'pref=1; Path=/']);
  const s = seen.at(-1);
  assert.deepEqual([s.method, s.body, s.cookie], ['POST', '{"email":"a@example.org"}', 'old=1']);
});

test('the visitor’s address goes up with the door’s key; what a visitor wrote in those headers never does', async () => {
  const KEY = 'a-long-random-door-key-0123456789abcdef';
  const keyed = createServer(handler(clients, { doorKey: KEY }));
  const kbase = await listen(keyed);
  try {
    // The edge in front of the door appended the visitor's address (the
    // last entry); what the visitor wrote further left, and their own
    // x-base-* headers, are not theirs to say.
    const ask = (path, headers = {}, method = 'GET', body) => new Promise((resolve, reject) => {
      const u = new URL(kbase);
      const req = request({ host: u.hostname, port: u.port, path, method, headers: { host: IS, ...headers } }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
    await ask('/api/auth/login', { 'content-type': 'application/json', 'x-forwarded-for': '6.6.6.6, 198.51.100.7', 'x-base-client-ip': '6.6.6.6', 'x-base-door': 'a-guess' }, 'POST', '{}');
    let s = seen.at(-1);
    assert.deepEqual([s.url, s.clientIp, s.doorKey], ['/api/auth/login', '198.51.100.7', KEY]);
    // Nothing in front of the door: whoever connected.
    await ask('/map');
    s = seen.at(-1);
    assert.deepEqual([s.clientIp, s.doorKey], ['127.0.0.1', KEY]);
  } finally {
    keyed.close();
  }
  // A door with no key says nothing — and passes on nothing a visitor wrote.
  await withHost(IS, '/map', { headers: { 'x-base-client-ip': '6.6.6.6', 'x-base-door': 'a-guess' } });
  const s = seen.at(-1);
  assert.deepEqual([s.url, s.clientIp, s.doorKey], ['/map', undefined, undefined]);
});

test('nobody at that name, a server not answering: a plain page each, saying base.win', async () => {
  const none = await withHost('nobody.base.win', '/admin');
  assert.equal(none.status, 404);
  assert.match(none.text, /no campaign at this address on base\.win/);
  const down = await withHost('gone.base.win', '/');
  assert.equal(down.status, 502);
  assert.match(down.text, /Gone Campaign isn’t answering on base\.win/);
  const home = await withHost('base.win', '/');
  assert.equal(home.status, 200);
  assert.match(home.text, /<title>base\.win<\/title>/);
  assert.match(home.text, /Coming soon/);
  assert.doesNotMatch(home.text, /imaginesurrey/i, 'the home page lists no campaigns');
  for (const t of [none.text, home.text]) assert.doesNotMatch(t, /\bGround\b|\bAir\b|Base Web/, 'one name: base.win');
  // The door's own health check answers on any address it is reached at.
  for (const host of ['base.win', IS, 'nobody.base.win']) assert.equal((await withHost(host, '/healthz')).json().service, 'base-door', host);
});

test('base.win/<client>/… (the address from before) sends people on to <client>.base.win, the same screen', async () => {
  const c = readClients('{"x": {"server": "https://g.example"}}');
  for (const [from, to] of [
    ['/x', 'https://x.base.win/site/'],
    ['/x/', 'https://x.base.win/site/'],
    ['/X', 'https://x.base.win/site/'],
    ['/x/site/news/hello', 'https://x.base.win/site/news/hello'],
    ['/x/field', 'https://x.base.win/'],
    ['/x/field/map', 'https://x.base.win/map'],
    ['/x/desk', 'https://x.base.win/admin/'],
    ['/x/desk/people', 'https://x.base.win/admin/people'],
    ['/x/admin/people', 'https://x.base.win/admin/people'],
    ['/x/web', 'https://x.base.win/admin/website'],
    ['/x/web/admin/pages', 'https://x.base.win/admin/website'],
    ['/x/api/health', 'https://x.base.win/api/health'],
    ['/x/join/abc', 'https://x.base.win/join/abc'],
  ]) assert.equal(moved(c, from, '', 'base.win', ''), to, from);
  assert.equal(moved(c, '/x/field/', '?turf=3', 'base.win', ''), 'https://x.base.win/?turf=3');
  assert.equal(moved(c, '/nobody/field', '', 'base.win', ''), null);
  assert.equal(moved(c, '/', '', 'base.win', ''), null);
  assert.equal(moved(c, '/x/desk', '', 'localhost', '8080'), 'http://x.localhost:8080/admin/');

  const before = seen.length;
  // On base.win, www and the door's own address alike.
  for (const host of ['base.win', 'www.base.win', 'base-door.onrender.com']) {
    const r = await withHost(host, '/imaginesurrey/desk/people?q=lee');
    assert.deepEqual([r.status, r.location, r.cache], [302, 'https://imaginesurrey.base.win/admin/people?q=lee', 'no-store'], host);
  }
  const site = await withHost('base.win', '/imaginesurrey?from=poster');
  assert.deepEqual([site.status, site.location], [302, 'https://imaginesurrey.base.win/site/?from=poster']);
  // A form sent to the old address keeps its method and body.
  const post = await withHost('base.win', '/imaginesurrey/api/auth/login', { method: 'POST', body: '{"a":1}' });
  assert.deepEqual([post.status, post.location], [307, 'https://imaginesurrey.base.win/api/auth/login']);
  // Nobody by that name: the plain page, never a redirect.
  assert.equal((await withHost('base.win', '/nobody/field/')).status, 404);
  // None of it reached a client's server: base.win only sends people on.
  assert.equal(seen.length, before);
});

test('only the door’s own domain names a client: a made-up Host reaches no server', async () => {
  const before = seen.length;
  for (const host of ['imaginesurrey.evil.example', 'imaginesurrey.notbase.win', 'imaginesurrey.base.win.evil.example', 'x.imaginesurrey.base.win']) {
    const r = await withHost(host, '/admin/people');
    assert.equal(r.status, 404, host);
  }
  assert.equal(seen.length, before);
});

test('names kept for base.win can’t be a client; ops.base.win is never anyone’s server', async () => {
  for (const name of RESERVED) {
    assert.throws(() => readClients(JSON.stringify({ [name]: { server: 'https://g.example' } })), /kept for base\.win/, name);
    assert.throws(() => readClients(JSON.stringify({ [name.toUpperCase()]: { server: 'https://g.example' } })), /kept for base\.win/, name);
  }
  for (const name of ['ops', 'staging', 'www']) assert.ok(RESERVED.includes(name), name);
  // Even a list made some other way: the control centre's address reaches no server.
  const forced = new Map([['ops', { name: 'x', origin: 'https://g.example' }]]);
  assert.deepEqual(hostClient(forced, 'ops.base.win'), { unknown: true });
  assert.equal(moved(forced, '/ops/desk', '', 'base.win', ''), null);
  const before = seen.length;
  const r = await withHost('ops.base.win', '/');
  assert.equal(r.status, 404);
  assert.equal(seen.length, before);
});
