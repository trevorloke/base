// Minting: the shared vector's tokens exactly (with one key or two, the
// first signing), the key order, the minute's life, a fresh nonce each time,
// and no audience but https (127.0.0.1 only when local is allowed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { mint, mintFor } from '../mint.mjs';
import { verifyEntry, parseKeys } from './verify-entry.mjs';
// Tests only: the campaign server's own check, so a change on one side
// alone fails here (the console's sources never import it).
import { verifyEntry as serverVerify, parseKeys as serverKeys } from '../../../server/lib/entry.js';

const V = JSON.parse(readFileSync(new URL('../../../server/test/entry-vector.json', import.meta.url), 'utf8'));
const decode = (token) => Buffer.from(token.split('.')[2], 'base64url').toString('utf8');

test('the shared vector: both tokens exactly, with one key and with two', () => {
  for (const c of V.cases) {
    assert.equal(mint(V.signingKey, JSON.parse(c.payloadJson)), c.token, c.name);
    assert.equal(mint(`${V.signingKey},${V.otherSigningKey}`, JSON.parse(c.payloadJson)), c.token, `${c.name}, two keys`);
    // The other side's check passes it.
    const r = verifyEntry(c.token, { keys: parseKeys(V.publicKey), aud: V.audience, env: V.env, inst: V.instance, nowMs: V.nowMs });
    assert.deepEqual(r, { ok: true, payload: JSON.parse(c.payloadJson) });
  }
});

test('the keys in their one order, no whitespace, whatever order they came in', () => {
  const p = JSON.parse(V.cases[1].payloadJson);
  const shuffled = { invite: p.invite, go: p.go, op: { stepUpAt: p.op.stepUpAt, email: p.op.email, id: p.op.id }, nonce: p.nonce, exp: p.exp, iat: p.iat, inst: p.inst, env: p.env, aud: p.aud, kid: p.kid, v: p.v };
  const token = mint(V.signingKey, shuffled);
  assert.equal(token, V.cases[1].token);
  assert.equal(decode(token), V.cases[1].payloadJson);
  assert.doesNotMatch(decode(token), /\s/);
});

test('a fresh token: 11 keys, a minute to live, the signing kid, a new 22-character nonce every time', () => {
  const nonces = new Set();
  const op = { id: '7b1f3c2e-0000-4000-8000-000000000001', email: 'Owner@Example.org', stepUpAt: 1795000000 - 100.6 };
  for (let i = 0; i < 1000; i++) {
    const { payload } = mintFor({ aud: V.audience, env: 'production', inst: V.instance, op, nowMs: 1795000000500, signingKey: V.signingKey });
    assert.match(payload.nonce, /^[A-Za-z0-9_-]{22}$/);
    nonces.add(payload.nonce);
  }
  assert.equal(nonces.size, 1000);
  const { token, payload } = mintFor({ aud: V.audience, env: 'production', inst: V.instance, op, go: '/desk/settings/members', invite: { email: 'Sam@Example.org' }, nowMs: 1795000000500, signingKey: V.signingKey });
  assert.deepEqual(Object.keys(payload), ['v', 'kid', 'aud', 'env', 'inst', 'iat', 'exp', 'nonce', 'op', 'go', 'invite']);
  assert.equal(payload.iat, 1795000000);
  assert.equal(payload.exp, payload.iat + 60);
  assert.equal(payload.kid, V.kid);
  assert.deepEqual(payload.op, { id: op.id, email: 'owner@example.org', stepUpAt: 1794999899 });
  assert.deepEqual(payload.invite, { email: 'sam@example.org' });
  assert.equal(verifyEntry(token, { keys: parseKeys(V.publicKey), aud: V.audience, env: 'production', inst: V.instance, nowMs: 1795000001000 }).ok, true);
});

test('an audience that isn’t https is refused, unless local is allowed (and then only 127.0.0.1)', () => {
  const p = JSON.parse(V.cases[0].payloadJson);
  for (const aud of ['http://base-win-example.onrender.com', 'http://127.0.0.1:5601', 'https://base-win-example.onrender.com/admin', 'javascript:alert(1)', '']) {
    assert.throws(() => mint(V.signingKey, { ...p, aud }, { allowLocal: false }), /audience/, aud);
  }
  assert.ok(mint(V.signingKey, { ...p, aud: 'http://127.0.0.1:5601' }, { allowLocal: true }));
  assert.throws(() => mint(V.signingKey, { ...p, aud: 'http://localhost:5601' }, { allowLocal: true }), /audience/);
  assert.throws(() => mintFor({ aud: V.audience, env: 'production', inst: V.instance, op: p.op, signingKey: 'short' }), /PLATFORM_SIGNING_KEY/);
});

test('one shared vector, the campaign server’s: no copy here; the server’s own check passes the console’s tokens', () => {
  assert.equal(existsSync(new URL('./entry-vector.json', import.meta.url)), false, 'no second copy to drift');
  const keys = serverKeys(`${V.publicKey},${V.otherPublicKey}`);
  for (const c of V.cases) {
    const token = mint(V.signingKey, JSON.parse(c.payloadJson));
    assert.deepEqual(serverVerify(token, { keys, aud: V.audience, env: V.env, inst: V.instance, nowMs: V.nowMs }), { ok: true, payload: JSON.parse(c.payloadJson) }, c.name);
  }
  // A fresh token from mintFor, too.
  const nowMs = Date.now();
  const op = { id: '7b1f3c2e-0000-4000-8000-000000000001', email: 'owner@example.org', stepUpAt: nowMs / 1000 - 30 };
  const { token } = mintFor({ aud: V.audience, env: 'production', inst: V.instance, op, nowMs, signingKey: V.signingKey });
  assert.equal(serverVerify(token, { keys, aud: V.audience, env: 'production', inst: V.instance, nowMs }).ok, true);
});
