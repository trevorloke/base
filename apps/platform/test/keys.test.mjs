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
});
