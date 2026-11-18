// The console's front: only its own host answers (but /healthz answers on
// any), every answer carries the headers, and a POST from anywhere but the
// console's own origin is refused, in both cookie modes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, browser, HOST, baseEnv } from './helpers.mjs';

const { app } = await freshApp();

test('/healthz answers on any host; everything else only on OPS_HOST', async () => {
  const b = browser(app);
  for (const host of [HOST, 'base-platform.onrender.com', 'base.win']) {
    const res = await b.get('/healthz', { host });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, db: 'ok' });
  }
  assert.equal((await b.get('/app.css', { host: 'base-platform.onrender.com' })).status, 404);
  assert.equal((await b.get('/ops.js', { host: 'base.win' })).status, 404);
  assert.equal((await b.get('/app.css', { host: `${HOST}:8443` })).status, 200, 'a port is ignored unless OPS_HOST names one');
  process.env.OPS_HOST = '127.0.0.1:5600';
  assert.equal((await b.get('/app.css', { host: '127.0.0.1:5601' })).status, 404);
  assert.equal((await b.get('/app.css', { host: '127.0.0.1:5600' })).status, 200);
  baseEnv();
});

test('every answer carries the CSP and the other headers; form-action allows 127.0.0.1 only with OPS_ALLOW_LOCAL', async () => {
  const b = browser(app);
  for (const path of ['/healthz', '/app.css', '/nope']) {
    const res = await b.get(path);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https:$/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
  }
  assert.equal((await b.get('/nope')).headers.get('cache-control'), 'no-store');
  process.env.OPS_ALLOW_LOCAL = '1';
  assert.match((await b.get('/healthz')).headers.get('content-security-policy'), /form-action 'self' https: http:\/\/127\.0\.0\.1:\*$/);
  baseEnv();
});

test('a POST without the console’s own Origin is refused, in both cookie modes', async () => {
  const b = browser(app);
  for (const insecure of ['1', '0']) {
    process.env.OPS_INSECURE_COOKIES = insecure;
    const right = `${insecure === '1' ? 'http' : 'https'}://${HOST}`;
    const wrong = `${insecure === '1' ? 'https' : 'http'}://${HOST}`;
    for (const origin of [null, 'https://evil.example', wrong]) {
      const res = await b.post('/signin', { email: 'x' }, { headers: { origin } });
      assert.equal(res.status, 403, `${insecure}: ${origin}`);
    }
    const ok = await b.post('/signin', { email: 'x' }, { headers: { origin: right } });
    assert.notEqual(ok.status, 403, `${insecure}: the right origin passes`);
    const json = await b.post('/signin', { email: 'x' }, { headers: { origin: right, 'content-type': 'application/json' } });
    assert.equal(json.status, 415);
  }
  baseEnv();
});
