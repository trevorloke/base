// The front door, end to end: two fake clients' apps behind it, real HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createGateway, readClients, route } from '../server.js';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

// A fake app: echoes what it was asked, streams on /stream, upgrades on /ws.
const fakeApp = (name) => {
  const s = http.createServer((req, res) => {
    if (req.url.endsWith('/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      setTimeout(() => { res.write('data: two\n\n'); res.end(); }, 50);
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=1; Path=/imaginesurrey; HttpOnly' });
      res.end(JSON.stringify({ app: name, method: req.method, url: req.url, host: req.headers.host, xff: req.headers['x-forwarded-for'], xfh: req.headers['x-forwarded-host'], body }));
    });
  });
  s.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(`${name}:${d}`));
  });
  return s;
};

let gw; let base; const apps = {};
before(async () => {
  for (const n of ['is-ground', 'is-air', 'rival-ground']) apps[n] = fakeApp(n);
  const ports = {};
  for (const [n, s] of Object.entries(apps)) ports[n] = await listen(s);
  ({ server: gw } = createGateway({
    BASE_CLIENT_IMAGINESURREY_GROUND: `127.0.0.1:${ports['is-ground']}`,
    BASE_CLIENT_IMAGINESURREY_AIR: `http://127.0.0.1:${ports['is-air']}`,
    BASE_CLIENT_IMAGINESURREY_WEB: 'https://imaginesurrey.ca',
    BASE_CLIENT_RIVAL_CAMPAIGN_GROUND: `127.0.0.1:${ports['rival-ground']}`,
  }));
  base = `http://127.0.0.1:${await listen(gw)}`;
});
after(() => { gw.closeAllConnections(); gw.close(); for (const s of Object.values(apps)) { s.closeAllConnections(); s.close(); } });

const get = (path, init) => fetch(base + path, { redirect: 'manual', ...init });

test('clients come from BASE_CLIENT_<SLUG>_<APP>; bad ones are reported, not served', () => {
  const { clients, problems } = readClients({
    BASE_CLIENT_NORTH_SHORE_GROUND: 'base-ground-north-shore:10000',
    BASE_CLIENT_NORTH_SHORE_WEB: 'http://northshore.example', // public site over http: refused
    BASE_CLIENT_HEALTHZ_GROUND: 'x:1', // reserved
    BASE_CLIENT_LONELY_AIR: 'air:1', // no ground
    OTHER: 'ignored',
  });
  assert.deepEqual([...clients.keys()].sort(), ['lonely', 'north-shore']);
  assert.equal(clients.get('north-shore').ground.href, 'http://base-ground-north-shore:10000/');
  assert.equal(clients.get('north-shore').web, undefined);
  assert.equal(problems.length, 3);
  assert.equal(route(clients, '/lonely/air/').kind, 'unknown', 'a client without ground answers 404');
});

test('health and the landing page, which names no client', async () => {
  const h = await (await get('/healthz')).json();
  assert.equal(h.ok, true);
  const land = await get('/');
  assert.equal(land.status, 200);
  const html = await land.text();
  assert.ok(!/imaginesurrey|rival/i.test(html));
});

test('a client root goes to the field app, keeping the query', async () => {
  const r = await get('/imaginesurrey?ref=door');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/imaginesurrey/field/?ref=door');
  assert.equal((await get('/imaginesurrey/')).headers.get('location'), '/imaginesurrey/field/');
});

test('field, desk, api and public pages reach that client\'s ground with the path unchanged', async () => {
  for (const path of ['/imaginesurrey/field/map', '/imaginesurrey/ground/people', '/imaginesurrey/api/me?x=1', '/imaginesurrey/u/abc']) {
    const j = await (await get(path, { headers: { 'x-forwarded-for': '203.0.113.9' } })).json();
    assert.equal(j.app, 'is-ground', path);
    assert.equal(j.url, path);
    assert.match(j.xff, /^203\.0\.113\.9, /, 'the visitor\'s address is kept for rate limits');
    assert.match(j.host, /^127\.0\.0\.1:/);
  }
  const rival = await (await get('/rival-campaign/field/')).json();
  assert.equal(rival.app, 'rival-ground');
});

test('air goes to air; web hands off to the site\'s admin, signed in', async () => {
  const j = await (await get('/imaginesurrey/air/api/health')).json();
  assert.equal(j.app, 'is-air');
  assert.equal(j.url, '/imaginesurrey/air/api/health');
  const w = await get('/imaginesurrey/web');
  assert.equal(w.status, 302);
  assert.equal(w.headers.get('location'), 'https://imaginesurrey.ca/auth/base?next=%2Fadmin');
  assert.equal((await get('/imaginesurrey/web/donate')).status, 404, 'the public site is only on its own domain');
  assert.equal((await get('/rival-campaign/web')).status, 404, 'no web set up');
  assert.equal((await get('/rival-campaign/air/')).status, 404, 'no air set up');
});

test('unknown clients and dot segments never cross to another client', async () => {
  assert.equal((await get('/nobody/field/')).status, 404);
  assert.equal((await get('/Imagine Surrey/field/')).status, 404);
  const j = await (await get('/rival-campaign/../imaginesurrey/api/me')).json();
  assert.equal(j.app, 'is-ground');
  assert.equal(j.url, '/imaginesurrey/api/me', 'resolved before routing, and passed on resolved');
  const k = await (await get('/imaginesurrey/%2e%2e/rival-campaign/field/')).json();
  assert.equal(k.app, 'rival-ground');
  assert.equal(k.url, '/rival-campaign/field/');
});

test('bodies, cookies and streams pass through', async () => {
  const r = await get('/imaginesurrey/api/actions/x', { method: 'POST', body: 'a'.repeat(200_000), headers: { 'content-type': 'text/plain' } });
  const j = await r.json();
  assert.equal(j.body.length, 200_000);
  assert.match(r.headers.get('set-cookie'), /Path=\/imaginesurrey/);
  const s = await get('/imaginesurrey/air/api/stream');
  assert.equal(await s.text(), 'data: one\n\ndata: two\n\n');
});

test('an app that is down gets a page that says so', async () => {
  const { server } = createGateway({ BASE_CLIENT_GONE_GROUND: '127.0.0.1:1' });
  const port = await listen(server);
  const r = await fetch(`http://127.0.0.1:${port}/gone/field/`);
  assert.equal(r.status, 502);
  assert.match(await r.text(), /isn't answering/);
  server.closeAllConnections();
  server.close();
});

test('WebSocket upgrades are piped to the right app', async () => {
  const port = Number(new URL(base).port);
  const reply = await new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('GET /imaginesurrey/air/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
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
});
