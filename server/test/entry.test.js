// The signed entry (lib/entry.js): the vector shared byte for byte with the
// control centre (entry-vector.json, the spec's §4.6), each way a token is
// refused, the own-origin rule, and reading BASE_PLATFORM_PUBKEY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseKeys, kidOf, ownOrigin, originOf, verifyEntry, entryReadiness } from '../lib/entry.js';
import { signEntry } from './entry-sign.js';

const V = JSON.parse(readFileSync(new URL('./entry-vector.json', import.meta.url), 'utf8'));
const ctx = (over = {}) => ({ keys: parseKeys(V.publicKey), aud: V.audience, env: V.env, inst: V.instance, nowMs: V.nowMs, ...over });
const desk = V.cases.find((c) => c.name === 'desk');
const deskPayload = () => JSON.parse(desk.payloadJson);
const why = (token, over) => verifyEntry(token, ctx(over)).why;
const resigned = (change) => { const p = deskPayload(); change(p); return signEntry(V.signingKey, p); };
const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);

test('both vector tokens verify, with the payload as signed', () => {
  for (const c of V.cases) {
    const r = verifyEntry(c.token, ctx());
    assert.equal(r.ok, true, c.name);
    assert.deepEqual(r.payload, JSON.parse(c.payloadJson));
  }
});

test('the test signer makes the vector tokens exactly; the first of two keys signs', () => {
  for (const c of V.cases) {
    assert.equal(signEntry(V.signingKey, JSON.parse(c.payloadJson)), c.token);
    assert.equal(signEntry(`${V.signingKey},${V.otherSigningKey}`, JSON.parse(c.payloadJson)), c.token);
  }
});

test('kids, and a key change: either order of two keys still verifies', () => {
  assert.equal(kidOf(V.publicKey), V.kid);
  assert.equal(kidOf(V.otherPublicKey), V.otherKid);
  assert.equal(verifyEntry(desk.token, ctx({ keys: parseKeys(`${V.otherPublicKey},${V.publicKey}`) })).ok, true);
  assert.equal(verifyEntry(desk.token, ctx({ keys: parseKeys(`${V.publicKey}, ${V.otherPublicKey}`) })).ok, true);
});

test('each change to the desk token is refused, for its reason', () => {
  const [, P, S] = /^bw-entry\.v1\.([^.]+)\.([^.]+)$/.exec(desk.token);
  // A changed character that still reads as the 11 keys reaches the
  // signature check (one that breaks the JSON stops at 'payload').
  const i = [...P].findIndex((_, j) => { try { const o = JSON.parse(Buffer.from(flip(P, j), 'base64url')); return Object.keys(o).join() === Object.keys(deskPayload()).join() && o.v === 1 && o.kid === V.kid; } catch { return false; } });
  assert.ok(i >= 0);
  assert.equal(why(`bw-entry.v1.${flip(P, i)}.${S}`), 'sig');
  assert.equal(why(`bw-entry.v1.${P}.${flip(S, 10)}`), 'sig');
  // The right P, signed by another key, still naming this key's kid.
  const other = signEntry(V.otherSigningKey, deskPayload());
  assert.equal(other.split('.')[2], P);
  assert.equal(why(other), 'sig');
  assert.equal(why(desk.token, { keys: parseKeys(V.otherPublicKey) }), 'kid');
  assert.equal(why(desk.token, { aud: 'https://base-win-other.onrender.com' }), 'aud');
  assert.equal(why(desk.token, { env: 'staging' }), 'env');
  assert.equal(why(desk.token, { inst: 'AAAAAAAAAAAAAAAAAAAAAA' }), 'env');
  assert.equal(why(desk.token, { nowMs: 1795000091000 }), 'time');
  assert.equal(why(desk.token, { nowMs: 1794999969000 }), 'time');
  assert.equal(why(desk.token, { nowMs: 1795000090000 }), undefined, 'exp + 30 is still in');
  assert.equal(why(resigned((p) => { p.extra = 1; })), 'payload');
  assert.equal(why(resigned((p) => { delete p.inst; })), 'payload');
  assert.equal(why(resigned((p) => { p.v = 2; })), 'payload');
  assert.equal(why(resigned((p) => { p.exp = p.iat + 121; })), 'time');
  assert.equal(why(resigned((p) => { p.exp = p.iat; })), 'time');
  assert.equal(why(resigned((p) => { p.iat += 0.5; })), 'time');
  assert.equal(why(resigned((p) => { p.op.stepUpAt = p.iat - 631; })), 'op');
  assert.equal(why(resigned((p) => { p.op.stepUpAt = p.iat - 630; })), undefined);
  assert.equal(why(resigned((p) => { p.op.stepUpAt = p.iat + 1; })), 'op');
  assert.equal(why(resigned((p) => { p.op.id = 'not-a-uuid'; })), 'op');
  assert.equal(why(resigned((p) => { p.op.email = 'no at sign'; })), 'op');
  assert.equal(why(resigned((p) => { p.op.extra = true; })), 'op');
  assert.equal(why(resigned((p) => { p.nonce = 'short'; })), 'nonce');
  assert.equal(why(resigned((p) => { p.go = '/desk/data'; })), 'go');
  assert.equal(why(resigned((p) => { p.invite = { email: 'sam@example.org', role: 'manager' }; })), 'invite');
  assert.equal(why(resigned((p) => { p.invite = 'sam@example.org'; })), 'invite');
  assert.equal(why(desk.token + 'A'.repeat(4096)), 'shape');
  assert.equal(why(null), 'shape');
  assert.equal(why('bw-entry.v2.' + P + '.' + S), 'shape');
  // A payload that isn't JSON, or not an object.
  const junk = Buffer.from('not json').toString('base64url');
  assert.equal(why(`bw-entry.v1.${junk}.${S}`), 'payload');
  const arr = Buffer.from('[1]').toString('base64url');
  assert.equal(why(`bw-entry.v1.${arr}.${S}`), 'payload');
});

test('own origin: normalized, https only (http on this machine for tests)', () => {
  assert.equal(originOf('HTTPS://Base-Win-X.onrender.com:443/'), 'https://base-win-x.onrender.com');
  assert.equal(originOf('https://base-win-x.onrender.com/admin?x=1#y'), 'https://base-win-x.onrender.com');
  assert.equal(originOf('https://base-win-x.onrender.com:8443'), 'https://base-win-x.onrender.com:8443');
  assert.equal(originOf('http://example.org'), null);
  assert.equal(originOf('http://127.0.0.1:5620'), 'http://127.0.0.1:5620');
  assert.equal(originOf('http://localhost:5620/x'), 'http://localhost:5620');
  assert.equal(originOf('ftp://example.org'), null);
  assert.equal(originOf(''), null);
  assert.equal(originOf('nonsense'), null);
  const saved = { own: process.env.STARBASE_OWN_URL, render: process.env.RENDER_EXTERNAL_URL };
  try {
    delete process.env.STARBASE_OWN_URL;
    process.env.RENDER_EXTERNAL_URL = 'https://Base-Win-Y.onrender.com';
    assert.equal(ownOrigin(), 'https://base-win-y.onrender.com');
    process.env.STARBASE_OWN_URL = 'http://127.0.0.1:5620/';
    assert.equal(ownOrigin(), 'http://127.0.0.1:5620');
    delete process.env.STARBASE_OWN_URL; delete process.env.RENDER_EXTERNAL_URL;
    assert.equal(ownOrigin(), null);
  } finally {
    for (const [k, n] of [['own', 'STARBASE_OWN_URL'], ['render', 'RENDER_EXTERNAL_URL']]) {
      if (saved[k] === undefined) delete process.env[n]; else process.env[n] = saved[k];
    }
  }
});

test('BASE_PLATFORM_PUBKEY: blanks and junk skipped; readiness for health', () => {
  assert.deepEqual(parseKeys(` , junk, ${V.publicKey} ,${'A'.repeat(42)},`).map((k) => k.kid), [V.kid]);
  assert.deepEqual(parseKeys('').map((k) => k.kid), []);
  assert.deepEqual(parseKeys(undefined).map((k) => k.kid), []);
  const saved = { key: process.env.BASE_PLATFORM_PUBKEY, own: process.env.STARBASE_OWN_URL, render: process.env.RENDER_EXTERNAL_URL };
  try {
    delete process.env.RENDER_EXTERNAL_URL;
    process.env.STARBASE_OWN_URL = 'http://127.0.0.1:5620';
    delete process.env.BASE_PLATFORM_PUBKEY;
    assert.equal(entryReadiness(), 'no-key');
    process.env.BASE_PLATFORM_PUBKEY = 'junk, also-junk';
    assert.equal(entryReadiness(), 'bad-key');
    process.env.BASE_PLATFORM_PUBKEY = V.publicKey;
    assert.deepEqual(parseKeys().map((k) => k.kid), [V.kid]);
    assert.equal(entryReadiness(), 'ready');
    delete process.env.STARBASE_OWN_URL;
    assert.equal(entryReadiness(), 'no-origin');
  } finally {
    for (const [k, n] of [['key', 'BASE_PLATFORM_PUBKEY'], ['own', 'STARBASE_OWN_URL'], ['render', 'RENDER_EXTERNAL_URL']]) {
      if (saved[k] === undefined) delete process.env[n]; else process.env[n] = saved[k];
    }
  }
});
