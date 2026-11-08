// The front door, end to end: two fake clients' apps behind it, real HTTP.
// Requests name their host the way a browser would (imaginesurrey.base.win).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createGateway, readClients, route } from '../server.js';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

// A fake app: echoes what it was asked (and every request it saw, in order),
// streams on /stream, upgrades only on /ws.
const fakeApp = (name) => {
  const seen = [];
  const s = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (req.url.endsWith('/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 50);
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=1; Path=/; HttpOnly' });
      res.end(JSON.stringify({ app: name, method: req.method, url: req.url, host: req.headers.host, xff: req.headers['x-forwarded-for'], xfh: req.headers['x-forwarded-host'], body }));
    });
  });
  s.on('upgrade', (req, socket) => {
    seen.push(`UPGRADE ${req.url}`);
    if (!req.url.endsWith('/ws')) { socket.end('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n'); return; }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(`${name}:${d}`));
  });
  s.seen = seen;
  return s;
};

let gw; let port; const apps = {};
before(async () => {
  for (const n of ['is-ground', 'is-air', 'rival-ground']) apps[n] = fakeApp(n);
  const ports = {};
  for (const [n, s] of Object.entries(apps)) ports[n] = await listen(s);
  ({ server: gw } = createGateway({
    BASE_HOST: 'base.win',
    BASE_CLIENT_IMAGINESURREY_GROUND: `127.0.0.1:${ports['is-ground']}`,
    BASE_CLIENT_IMAGINESURREY_AIR: `http://127.0.0.1:${ports['is-air']}`,
    BASE_CLIENT_IMAGINESURREY_WEB: 'https://imaginesurrey.ca',
    BASE_CLIENT_RIVAL_CAMPAIGN_GROUND: `127.0.0.1:${ports['rival-ground']}`,
  }));
  port = await listen(gw);
});
after(() => { gw.closeAllConnections(); gw.close(); for (const s of Object.values(apps)) { s.closeAllConnections(); s.close(); } });

// fetch() won't send a Host of our choosing, so requests go out by hand.
const ask = (host, path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host, ...headers }, agent: false }, (res) => {
    let text = '';
    res.on('data', (c) => { text += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }));
  });
  req.on('error', reject);
  if (body) req.write(body);
  req.end();
});
const IS = 'imaginesurrey.base.win';

// Raw bytes on one connection, for framing tricks a client library won't send.
const raw = (bytes, waitMs = 400) => new Promise((resolve, reject) => {
  const s = net.connect(port, '127.0.0.1', () => s.write(bytes));
  let out = '';
  s.on('data', (d) => { out += d; });
  s.on('error', reject);
  setTimeout(() => { s.destroy(); resolve(out); }, waitMs);
});

test('clients come from BASE_CLIENT_<SLUG>_<APP>; bad ones are reported, not served', () => {
  const { clients, problems } = readClients({
    BASE_CLIENT_NORTH_SHORE_GROUND: 'base-ground-north-shore:10000',
    BASE_CLIENT_NORTH_SHORE_WEB: 'http://northshore.example', // public site over http: refused
    BASE_CLIENT_WWW_GROUND: 'x:1', // Base's own subdomain
    BASE_CLIENT_LONELY_AIR: 'air:1', // no ground
    OTHER: 'ignored',
  });
  assert.deepEqual([...clients.keys()].sort(), ['lonely', 'north-shore']);
  assert.equal(clients.get('north-shore').ground.href, 'http://base-ground-north-shore:10000/');
  assert.equal(clients.get('north-shore').web, undefined);
  assert.equal(problems.length, 3);
  assert.equal(route(clients, 'base.win', 'lonely.base.win', '/air/').kind, 'unknown', 'a client without ground answers 404');
});

test('health on any host, and the landing page, which names no client', async () => {
  const h = (await ask('base-gateway:10000', '/healthz')).json();
  assert.equal(h.ok, true);
  assert.equal(h.clients, undefined, 'no count of clients');
  const land = await ask('base.win', '/');
  assert.equal(land.status, 200);
  assert.ok(!/imaginesurrey|rival/i.test(land.text));
  assert.equal((await ask('www.base.win', '/x?y=1')).headers.location, 'https://base.win/x?y=1');
  assert.equal((await ask('base.win', '/imaginesurrey/field/')).status, 404, 'no clients under the apex');
});

test('a client\'s root goes to the field app, keeping the query', async () => {
  const r = await ask(IS, '/?ref=door');
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/field/?ref=door');
  assert.equal((await ask('ImagineSurrey.Base.Win.:443', '/')).headers.location, '/field/', 'host matched without case, port or trailing dot');
});

test('field, desk, api and public pages reach that client\'s ground with the path unchanged', async () => {
  for (const path of ['/field/map', '/ground/people', '/api/me?x=1', '/u/abc']) {
    const j = (await ask(IS, path, { headers: { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-host': 'evil.example' } })).json();
    assert.equal(j.app, 'is-ground', path);
    assert.equal(j.url, path);
    assert.match(j.xff, /^203\.0\.113\.9, /, 'the visitor\'s address is kept for rate limits');
    assert.equal(j.xfh, IS, 'X-Forwarded-Host is the front door\'s to say');
    assert.match(j.host, /^127\.0\.0\.1:/);
  }
  assert.equal((await ask('rival-campaign.base.win', '/field/')).json().app, 'rival-ground');
});

test('air goes to air; web hands off to the site\'s admin, signed in', async () => {
  const j = (await ask(IS, '/air/api/health')).json();
  assert.equal(j.app, 'is-air');
  assert.equal(j.url, '/air/api/health');
  const w = await ask(IS, '/web');
  assert.equal(w.status, 302);
  assert.equal(w.headers.location, 'https://imaginesurrey.ca/auth/base?next=%2Fadmin');
  assert.equal((await ask(IS, '/web/donate')).status, 404, 'the public site is only on its own domain');
  assert.equal((await ask('rival-campaign.base.win', '/web')).status, 404, 'no web set up');
  assert.equal((await ask('rival-campaign.base.win', '/air/')).status, 404, 'no air set up');
});

test('unknown, nested and foreign hosts reach nobody; dot segments stay on the same client', async () => {
  for (const host of ['nobody.base.win', 'a.imaginesurrey.base.win', 'imaginesurrey.base.win.evil.example', 'imaginesurrey.evil.example', '']) {
    assert.equal((await ask(host, '/field/')).status, 404, host);
  }
  const j = (await ask(IS, '/air/../api/me')).json();
  assert.equal(j.app, 'is-ground', 'resolved before routing');
  assert.equal(j.url, '/api/me', 'and passed on resolved');
  assert.equal((await ask(IS, '/field/%2e%2e/air/api/x')).json().app, 'is-air');
});

test('bodies, cookies and streams pass through', async () => {
  const r = await ask(IS, '/api/actions/x', { method: 'POST', body: 'a'.repeat(200_000), headers: { 'content-type': 'text/plain', 'content-length': '200000' } });
  assert.equal(r.json().body.length, 200_000);
  assert.match(r.headers['set-cookie'][0], /Path=\//);
  assert.equal((await ask(IS, '/air/api/stream')).text, 'data: one\n\ndata: two\n\n');
});

test('a chunked body is passed on chunked, never as a second request', async () => {
  const before = apps['is-ground'].seen.length;
  const smuggled = 'POST /api/attacker-capture HTTP/1.1\r\nHost: x\r\nContent-Length: 120\r\n\r\n';
  const out = await raw(`GET /api/y HTTP/1.1\r\nHost: ${IS}\r\nTransfer-Encoding: chunked\r\n\r\n${smuggled.length.toString(16)}\r\n${smuggled}\r\n0\r\n\r\n`);
  assert.match(out, /^HTTP\/1\.1 200/);
  const seen = apps['is-ground'].seen.slice(before);
  assert.deepEqual(seen, ['GET /api/y'], `the app saw only the one request: ${seen.join(' | ')}`);
  const both = await raw(`POST /api/z HTTP/1.1\r\nHost: ${IS}\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`);
  assert.match(both, /^HTTP\/1\.1 400/, 'both framings at once are refused');
});

test('WebSocket upgrades are spliced only after the app says 101', async () => {
  const s = net.connect(port, '127.0.0.1');
  const reply = await new Promise((resolve, reject) => {
    s.on('connect', () => s.write(`GET /air/ws HTTP/1.1\r\nHost: ${IS}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`));
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      if (buf.includes('101') && !buf.includes('ping')) s.write('ping');
      if (buf.includes('is-air:ping')) { s.destroy(); resolve(buf); }
    });
    s.on('error', reject);
    setTimeout(() => reject(new Error(`timeout: ${buf}`)), 3000);
  });
  assert.match(reply, /101 Switching Protocols/);

  // A path that doesn't upgrade: its answer comes back and the line closes,
  // so nothing written after it reaches the app.
  const before = apps['is-ground'].seen.length;
  const out = await raw(`GET /api/not-a-socket HTTP/1.1\r\nHost: ${IS}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nGET /secret HTTP/1.1\r\nHost: evil.example\r\n\r\n`, 500);
  assert.match(out, /^HTTP\/1\.1 404/);
  assert.deepEqual(apps['is-ground'].seen.slice(before), ['UPGRADE /api/not-a-socket']);
});

test('an app that is down gets a page that says so', async () => {
  const { server } = createGateway({ BASE_HOST: 'base.win', BASE_CLIENT_GONE_GROUND: '127.0.0.1:1' });
  const p = await listen(server);
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: p, path: '/field/', headers: { host: 'gone.base.win' } }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(status, 502);
  server.closeAllConnections();
  server.close();
});

test('staging serves <client>.staging.base.win', () => {
  const { clients } = readClients({ BASE_CLIENT_IMAGINESURREY_GROUND: 'g:1' });
  assert.equal(route(clients, 'staging.base.win', 'imaginesurrey.staging.base.win', '/field/').kind, 'proxy');
  assert.equal(route(clients, 'staging.base.win', 'imaginesurrey.base.win', '/field/').kind, 'unknown', 'staging never answers for production');
  assert.equal(route(clients, 'base.win', 'imaginesurrey.staging.base.win', '/field/').kind, 'unknown', 'production never answers for staging');
});
