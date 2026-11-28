// Two-step sign-in's key under both names (server/lib/twostep.js): every
// authenticator key sealed while the setting had its older name still
// opens, whichever names are set now. Both values are used together, the
// new one first, so the new one seals.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { hkdfSync } from 'node:crypto';
import { freshDb } from './helpers.js';
import { sealSecret, openSecret, keyStatus, KEY_MIN } from '../lib/twostep.js';
import { OLD_SETTINGS } from '../../shared/old-names.js';

const NEW = 'BASE_TWO_STEP_KEY';
const OLD = OLD_SETTINGS[NEW];
const K1 = `riverbend-two-step-key-one-${'a'.repeat(16)}`;
const K2 = `riverbend-two-step-key-two-${'b'.repeat(16)}`;
// A key's id, worked out as twostep.js does (never the key itself).
const kidOf = (raw) => `e${Buffer.from(hkdfSync('sha256', raw, Buffer.alloc(0), 'base.win/two-step-kid/v1', 32)).toString('hex').slice(0, 10)}`;
const kidIn = (sealed) => sealed.split('.')[1];

const saved = { [NEW]: process.env[NEW], [OLD]: process.env[OLD] };
const only = (values) => {
  delete process.env[NEW];
  delete process.env[OLD];
  Object.assign(process.env, values);
};
let db;
before(async () => { db = await freshDb(); });
after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

test('sealed under the older name alone; then both names: the old secret opens, the new key seals, the key counts as set', async () => {
  only({ [OLD]: K1 });
  const sealed = await sealSecret(db, 'JBSWY3DPEHPK3PXP');
  assert.equal(kidIn(sealed), kidOf(K1), 'sealed with the older name’s key');
  assert.deepEqual(keyStatus(), { source: 'env' });

  only({ [NEW]: K2, [OLD]: K1 });
  const opened = await openSecret(db, sealed);
  assert.equal(opened?.plain, 'JBSWY3DPEHPK3PXP', 'the older secret still opens');
  assert.equal(opened.current, false, 'and is moved to the new key the next time it is used');
  const fresh = await sealSecret(db, 'KRSXG5CTMVRXEZLU');
  assert.equal(kidIn(fresh), kidOf(K2), 'a new seal carries the new key’s id');
  assert.equal((await openSecret(db, fresh)).current, true);
  assert.deepEqual(keyStatus(), { source: 'env' });
});

test('the same key moved to the new name: the old secret opens', async () => {
  only({ [OLD]: K1 });
  const sealed = await sealSecret(db, 'GEZDGNBVGY3TQOJQ');
  only({ [NEW]: K1 });
  const opened = await openSecret(db, sealed);
  assert.equal(opened?.plain, 'GEZDGNBVGY3TQOJQ');
  assert.equal(opened.current, true);
  assert.deepEqual(keyStatus(), { source: 'env' });
});

test('the same value under both names is one key, not two', async () => {
  only({ [NEW]: K1, [OLD]: K1 });
  const sealed = await sealSecret(db, 'MFRGGZDFMZTWQ2LK');
  assert.equal(kidIn(sealed), kidOf(K1));
  assert.equal((await openSecret(db, sealed)).current, true);
});

test('a blank new name hides nothing: the older value still seals and opens', async () => {
  only({ [OLD]: K1 });
  const sealed = await sealSecret(db, 'NBSWY3DPO5XXE3DE');
  only({ [NEW]: '  ', [OLD]: K1 });
  assert.equal((await openSecret(db, sealed))?.plain, 'NBSWY3DPO5XXE3DE');
  assert.deepEqual(keyStatus(), { source: 'env' });
});

test('a value under either name that is too short to use is reported, even while the other name holds a good one', async () => {
  // The copy is missing its last character: the older name still seals, so it works for now.
  only({ [NEW]: K1.slice(0, K1.length - 13), [OLD]: K1 });
  assert.ok(K1.slice(0, K1.length - 13).length < 32);
  assert.deepEqual(keyStatus(), { source: 'env', problem: 'short', short: [NEW] });
  only({ [NEW]: K1, [OLD]: 'too-short' });
  assert.deepEqual(keyStatus(), { source: 'env', problem: 'short', short: [OLD] });
  only({ [NEW]: `${K2}, too-short`, [OLD]: K1 });
  assert.deepEqual(keyStatus(), { source: 'env', problem: 'short', short: [NEW] });
  only({ [NEW]: K1, [OLD]: K1 });
  assert.deepEqual(keyStatus(), { source: 'env' });
  assert.equal(KEY_MIN, 32, 'the same length shared/old-names.js counts as usable');
  // Neither long enough: the database's key, as before.
  only({ [NEW]: 'too-short' });
  assert.deepEqual(keyStatus(), { source: 'database', problem: 'short' });
  only({});
  assert.deepEqual(keyStatus(), { source: 'database', problem: 'unset' });
});
