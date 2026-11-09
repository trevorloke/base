// What faces the open internet, hardened (lib/guard.js and friends): body
// size, the address a request is from, sign-in guessing, cross-site writes,
// open-checkout caps, odd ids, and the headers every answer carries.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { clientIp, makeLimiter } from '../lib/guard.js';
import { handler as doorHandler } from '../../apps/door/door.mjs';

let mgr, slug, wsId;
const env = { ...process.env };

before(async () => {
  await freshDb();
  delete process.env.STARBASE_TRUSTED_PROXIES;
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: 'Imagine Surrey', email: 'hard.manager@example.org', password: 'hardening-2026', jurisdiction: 'bc-municipal' });
  slug = r.json.workspace.slug;
  wsId = r.json.workspace.id;
});
after(() => {
  for (const k of ['STARBASE_TRUSTED_PROXIES', 'STRIPE_SECRET_KEY', 'BASE_DOOR_KEY']) {
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }
});

const req = (path, { method = 'GET', body, headers = {}, cookie } = {}) => app.request(path, {
  method,
  headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
  body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
});

test('clientIp: the proxy’s own entry wins; what the sender wrote further left is ignored', () => {
  const c = (xff, real) => ({ req: { header: (h) => (h === 'x-forwarded-for' ? xff : h === 'x-real-ip' ? real : undefined) } });
  assert.equal(clientIp(c('1.2.3.4, 203.0.113.9')), '203.0.113.9', 'the attacker wrote 1.2.3.4; the proxy appended the real one');
  assert.equal(clientIp(c('203.0.113.9')), '203.0.113.9');
  assert.equal(clientIp(c(undefined, '198.51.100.1')), '198.51.100.1');
  assert.equal(clientIp(c(undefined, undefined)), 'local');
  process.env.STARBASE_TRUSTED_PROXIES = '2';
  assert.equal(clientIp(c('1.2.3.4, 203.0.113.9, 10.0.0.1')), '203.0.113.9', 'two proxies: the entry two from the right');
  delete process.env.STARBASE_TRUSTED_PROXIES;
});

// The base.win door (apps/door) in front: every request reaches this server
// from the door's own address, so the door says whose it is, with a key
// only the door and this server hold (BASE_DOOR_KEY).
const DOOR_KEY = 'a-long-random-door-key-0123456789abcdef';
const DOOR_OUT = '216.24.57.253'; // the door's address, as this server's own proxy sees it

test('clientIp: the door’s word for whose request it is — believed only with the door’s key', () => {
  const c = (h) => ({ req: { header: (k) => h[k] } });
  const fromDoor = { 'x-forwarded-for': `198.51.100.9, ${DOOR_OUT}`, 'x-base-client-ip': '198.51.100.9', 'x-base-door': DOOR_KEY };
  delete process.env.BASE_DOOR_KEY;
  assert.equal(clientIp(c(fromDoor)), DOOR_OUT, 'no key set here: the proxy’s entry, as before');
  process.env.BASE_DOOR_KEY = DOOR_KEY;
  assert.equal(clientIp(c(fromDoor)), '198.51.100.9');
  assert.equal(clientIp(c({ ...fromDoor, 'x-base-client-ip': '2001:db8::7' })), '2001:db8::7');
  assert.equal(clientIp(c({ ...fromDoor, 'x-base-door': 'a-guess' })), DOOR_OUT, 'a wrong key: not believed');
  assert.equal(clientIp(c({ ...fromDoor, 'x-base-door': undefined })), DOOR_OUT, 'no key: not believed');
  assert.equal(clientIp(c({ ...fromDoor, 'x-base-client-ip': '198.51.100.9, 1.2.3.4' })), DOOR_OUT, 'not one address: not believed');
  // Moving to a new key: the server takes either while the door changes.
  process.env.BASE_DOOR_KEY = `the-next-long-random-door-key-0123456789, ${DOOR_KEY}`;
  assert.equal(clientIp(c(fromDoor)), '198.51.100.9');
  // Too short to be a key: never believed, whatever is sent.
  process.env.BASE_DOOR_KEY = 'short';
  assert.equal(clientIp(c({ ...fromDoor, 'x-base-door': 'short' })), DOOR_OUT);
  delete process.env.BASE_DOOR_KEY;
});

// One sign-in try through the real door: the visitor's address as the
// proxy in front of the door wrote it; the door's own request, as this
// server's proxy passes it on. → the server's answer.
const doorClients = new Map([['imaginesurrey', { name: 'Imagine Surrey', origin: 'https://starbase-is.onrender.com' }]]);
const throughDoor = async (visitor, body, { doorKey = DOOR_KEY } = {}) => {
  let status = 0;
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const headers = new Headers(init.headers);
    headers.set('x-forwarded-for', `${headers.get('x-forwarded-for')}, ${DOOR_OUT}`);
    const res = await app.request(`${u.pathname.replace(/^\/imaginesurrey/, '')}${u.search}`, {
      method: init.method, headers, body: init.body, duplex: 'half',
    });
    status = res.status;
    return res;
  };
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    url: '/imaginesurrey/api/auth/login', method: 'POST', socket: { remoteAddress: '10.204.1.7' },
    headers: { host: 'base.win', 'content-type': 'application/json', 'x-forwarded-for': visitor, 'x-forwarded-proto': 'https' },
  });
  const res = Object.assign(new PassThrough(), { writeHead() {} });
  res.resume();
  await doorHandler(doorClients, { fetchImpl, doorKey })(req, res);
  return status;
};

test('behind the base.win door each visitor keeps their own address for the sign-in limit; nobody else can say whose a request is', async () => {
  process.env.BASE_DOOR_KEY = DOOR_KEY;
  // 31 people sign in through the door: each a try of their own.
  for (let i = 1; i <= 31; i++) {
    assert.equal(await throughDoor(`198.51.100.${i}`, { email: `door${i}@example.org`, password: 'not-it' }), 401, `visitor ${i}`);
  }
  // One of them, 31 times: their 31st waits — and only theirs.
  let last;
  for (let i = 0; i < 31; i++) last = await throughDoor('198.51.100.200', { email: `again${i}@example.org`, password: 'not-it' });
  assert.equal(last, 429);
  assert.equal(await throughDoor('198.51.100.201', { email: 'next@example.org', password: 'not-it' }), 401);
  // What a visitor writes in front of their address doesn't make them someone else.
  assert.equal(await throughDoor('6.6.6.6, 198.51.100.200', { email: 'spoof@example.org', password: 'not-it' }), 429);
  // Straight to this server, the door's header without its key is ignored:
  // the proxy's own entry counts, so 31 made-up addresses are one.
  for (let i = 0; i < 31; i++) {
    last = await req('/api/auth/login', { method: 'POST', body: { email: `direct${i}@example.org`, password: 'x' },
      headers: { 'x-forwarded-for': '203.0.113.88', 'x-base-client-ip': `192.0.2.${i}`, 'x-base-door': 'a-guess' } });
  }
  assert.equal(last.status, 429);
  delete process.env.BASE_DOOR_KEY;
});

test('a limiter sweeps old entries and never keeps more than its cap of keys', () => {
  const lim = makeLimiter({ windowMs: 1000, max: 2 });
  assert.equal(lim('a'), false); assert.equal(lim('a'), false); assert.equal(lim('a'), true);
  assert.equal(lim.count('a'), 3);
  for (let i = 0; i < 20_500; i++) lim(`k${i}`);
  assert.ok(lim._size() <= 20_501, 'a sweep ran');
  lim.clear('a');
  assert.equal(lim.count('a'), 0);
});

test('a spoofed X-Forwarded-For no longer dodges the sign-in rate limit', async () => {
  // 31 sign-in tries, each claiming a different address on the left — the
  // proxy's entry on the right is the same every time.
  let last;
  for (let i = 0; i < 31; i++) {
    last = await req('/api/auth/login', { method: 'POST', body: { email: `spoof${i}@example.org`, password: 'not-the-password' },
      headers: { 'x-forwarded-for': `1.2.3.${i}, 203.0.113.77` } });
  }
  assert.equal(last.status, 429);
});

test('request bodies are capped: 256 KB in general, more for an import or a picture', async () => {
  const login = await req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email: 'a'.repeat(300 * 1024), password: 'x' }) });
  assert.equal(login.status, 413);
  // An import of 1,000 rows (about 400 KB) is over 256 KB and goes through.
  const rows = Array.from({ length: 1000 }, (_, i) => ({ name: `Row Person ${i}`, address: `${10000 + i} 72 Ave`, note: 'x'.repeat(350) }));
  const imp = await req('/api/data/import', { method: 'POST', body: { rows, dryRun: true }, cookie: mgr.cookie });
  assert.equal(imp.status, 200, JSON.stringify(imp.json?.() ?? ''));
});

test('sign-in guessing: 10 failures against one email, or 30 tries from one address, then 429', async () => {
  for (let i = 0; i < 10; i++) {
    const r = await req('/api/auth/login', { method: 'POST', body: { email: 'hard.manager@example.org', password: `wrong-${i}` },
      headers: { 'x-forwarded-for': `203.0.113.${100 + i}` } });
    assert.equal(r.status, 401);
  }
  const blocked = await req('/api/auth/login', { method: 'POST', body: { email: 'Hard.Manager@example.org', password: 'hardening-2026' },
    headers: { 'x-forwarded-for': '203.0.113.120' } });
  assert.equal(blocked.status, 429, 'even the right password waits now');
  // Someone else's account is not affected by that.
  const other = await req('/api/auth/login', { method: 'POST', body: { email: 'nobody@example.org', password: 'x' }, headers: { 'x-forwarded-for': '203.0.113.121' } });
  assert.equal(other.status, 401);
  // One address, many emails.
  let last;
  for (let i = 0; i < 31; i++) {
    last = await req('/api/auth/login', { method: 'POST', body: { email: `guess${i}@example.org`, password: 'x' }, headers: { 'x-forwarded-for': '203.0.113.150' } });
  }
  assert.equal(last.status, 429);
  const join = await req('/api/auth/join', { method: 'POST', body: { token: 'x', name: 'x', password: 'xxxxxxxx' }, headers: { 'x-forwarded-for': '203.0.113.150' } });
  assert.equal(join.status, 429, 'join shares the per-address limit');
});

test('a write with the cookie must be the app’s own: JSON, from the same origin', async () => {
  const form = await app.request('/api/actions/person.create', {
    method: 'POST', headers: { cookie: mgr.cookie, 'content-type': 'text/plain' }, body: '{"name":"CSRF Victim","x":"="}',
  });
  assert.equal(form.status, 415, 'a text/plain form post is refused');
  const urlenc = await app.request('/api/actions/person.create', {
    method: 'POST', headers: { cookie: mgr.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=CSRF',
  });
  assert.equal(urlenc.status, 415);
  const cross = await req('/api/actions/person.create', { method: 'POST', body: { name: 'CSRF Victim' }, cookie: mgr.cookie, headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.status, 403);
  const sibling = await req('/api/actions/person.create', { method: 'POST', body: { name: 'CSRF Victim' }, cookie: mgr.cookie, headers: { 'sec-fetch-site': 'same-site' } });
  assert.equal(sibling.status, 403, 'another host under the domain is not the app');
  const own = await req('/api/actions/person.create', { method: 'POST', body: { name: 'Real Person' }, cookie: mgr.cookie, headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(own.status, 200);
  assert.equal((await req('/api/auth/logout', { method: 'POST', cookie: mgr.cookie, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const list = await (await req('/api/persons?q=CSRF%20Victim', { cookie: mgr.cookie })).json();
  assert.equal(list.persons.length, 0, 'nothing was created');
  // Reads are untouched; the session cookie is Strict.
  const me = await req('/api/auth/me', { cookie: mgr.cookie });
  assert.equal(me.status, 200);
  const inv = await mgr.action('member.invite', { email: 'hard.staff@example.org', role: 'staff' });
  const join = await req('/api/auth/join', { method: 'POST', headers: { 'x-forwarded-for': '203.0.113.200' },
    body: { token: inv.json.joinUrl.split('/join/')[1], name: 'Hard Staff', password: 'hardening-2026' } });
  assert.equal(join.status, 200);
  assert.match(join.headers.get('set-cookie') || '', /SameSite=Strict/i);
});

test('odd ids and names are a 400 or 404, never a 500', async () => {
  assert.equal((await req('/media/constructor')).status, 404);
  assert.equal((await req('/media/__proto__')).status, 404);
  assert.equal((await req('/api/actions/constructor', { method: 'POST', body: {}, cookie: mgr.cookie })).status, 404);
  assert.equal((await req('/u/constructor')).status, 404);
});

test('every answer says: not framed, no sniffing, referrer trimmed — a route’s own choice stands', async () => {
  for (const path of ['/login', '/api/health', '/u/nope', '/learn/nope']) {
    const r = await req(path);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
    assert.ok(r.headers.get('referrer-policy'), path);
  }
});
