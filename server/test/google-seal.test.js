// Google's refresh tokens at rest (lib/google/seal.js): sealed with
// GOOGLE_TOKEN_KEY only — never a key kept in the database — and never
// interchangeable with two-step's sealing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.js';
import { NoTokenKey, openToken, sealToken, tokenKeyReady } from '../lib/google/seal.js';
import { openSecret, sealSecret } from '../lib/twostep.js';

const env = { ...process.env };
const K1 = 'first-google-token-key-0123456789abcdef';
const K2 = 'second-google-token-key-0123456789abcdef';
let db;

before(async () => { db = await freshDb(); });
after(() => { process.env = env; });

test('a round trip: the plain token never appears in what is stored', () => {
  process.env.GOOGLE_TOKEN_KEY = K1;
  const sealed = sealToken('1//refresh-token-plain');
  assert.match(sealed, /^v1\.g[0-9a-f]{10}\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(!sealed.includes('refresh-token-plain'));
  assert.deepEqual(openToken(sealed), { plain: '1//refresh-token-plain', current: true });
  assert.notEqual(sealToken('same'), sealToken('same'), 'a fresh iv each time');
});

test('rotation: the old key still opens (not current), the new key seals', () => {
  process.env.GOOGLE_TOKEN_KEY = K1;
  const old = sealToken('rotating');
  process.env.GOOGLE_TOKEN_KEY = `${K2},${K1}`;
  assert.deepEqual(openToken(old), { plain: 'rotating', current: false });
  const fresh = sealToken('rotating');
  assert.deepEqual(openToken(fresh), { plain: 'rotating', current: true });
  process.env.GOOGLE_TOKEN_KEY = K2;
  assert.equal(openToken(old), null, 'the old key gone: it can’t be opened');
});

test('a tampered tag or body opens to nothing', () => {
  process.env.GOOGLE_TOKEN_KEY = K1;
  const parts = sealToken('tamper me').split('.');
  const flip = (s) => (s[0] === 'A' ? `B${s.slice(1)}` : `A${s.slice(1)}`);
  assert.equal(openToken([...parts.slice(0, 3), flip(parts[3]), parts[4]].join('.')), null);
  assert.equal(openToken([...parts.slice(0, 4), flip(parts[4])].join('.')), null);
  assert.equal(openToken('nonsense'), null);
  assert.equal(openToken(null), null);
});

test('no key: NoTokenKey, and nothing is ever written to app_secrets', async () => {
  delete process.env.GOOGLE_TOKEN_KEY;
  const before = (await db.query('select count(*)::int as n from app_secrets')).rows[0].n;
  assert.equal(tokenKeyReady(), false);
  assert.throws(() => sealToken('x'), NoTokenKey);
  process.env.GOOGLE_TOKEN_KEY = 'too-short';
  assert.equal(tokenKeyReady(), false);
  assert.throws(() => sealToken('x'), NoTokenKey);
  const after = (await db.query('select count(*)::int as n from app_secrets')).rows[0].n;
  assert.equal(after, before);
});

test('two-step’s sealing and Google’s never open each other, even with the same key', async () => {
  process.env.GOOGLE_TOKEN_KEY = K1;
  process.env.STARBASE_TWO_STEP_KEY = K1;
  const twoStep = await sealSecret(db, 'authenticator-key');
  assert.equal(openToken(twoStep), null);
  const google = sealToken('refresh-token');
  assert.equal(await openSecret(db, google), null);
});
