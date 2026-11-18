// The key from PLATFORM_SIGNING_KEY: the shared vector's seed, public key and kid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seedOf, publicKeyOf, signingValues } from '../keys.mjs';

const V = JSON.parse(readFileSync(new URL('./entry-vector.json', import.meta.url), 'utf8'));

test('seed, public key and kid match the shared vector; the first of a list signs', () => {
  assert.equal(seedOf(V.signingKey).toString('hex'), V.seedHex);
  assert.deepEqual(publicKeyOf(V.signingKey), { publicKey: V.publicKey, kid: V.kid });
  assert.deepEqual(publicKeyOf(V.otherSigningKey), { publicKey: V.otherPublicKey, kid: V.otherKid });
  assert.deepEqual(publicKeyOf(`${V.signingKey},${V.otherSigningKey}`), { publicKey: V.publicKey, kid: V.kid });
  assert.deepEqual(signingValues(` ${V.signingKey} , short, ${V.otherSigningKey}`), [V.signingKey, V.otherSigningKey]);
  assert.deepEqual(signingValues(`short-new-value,${V.signingKey}`), [], 'a too-short first value is no key, not the next one');
});

test('shortValues counts set-but-too-short values after a usable first one', async () => {
  const { shortValues } = await import('../keys.mjs');
  assert.equal(shortValues(`${V.signingKey},short`), 1);
  assert.equal(shortValues(`${V.signingKey}, ${V.otherSigningKey}`), 0);
  assert.equal(shortValues(`${V.signingKey},,`), 0);
  assert.equal(shortValues('short,also'), 0);
});

test('base.win’s key says when a value after the first is too short', async () => {
  const { keyPage } = await import('../pages/desk.mjs');
  const { publicKeyOf } = await import('../keys.mjs');
  const keys = [{ ...publicKeyOf(V.signingKey), value: V.signingKey }];
  assert.match(String(keyPage({ keys, missing: [], short: 1 })), /a value after the first that is too short/);
  assert.doesNotMatch(String(keyPage({ keys, missing: [] })), /too short/);
});
