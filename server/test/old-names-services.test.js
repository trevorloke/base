// Settings → Services while a setting is under both names: the older-names
// row says, per setting, whether the new name is still to add, set and
// different (the new one is used, so check it before deleting the older),
// or, for the two-step key, whether it already holds every key the older
// name holds. The two-step row says when a value under either name is too
// short to use. Names only, never a value.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { OLD_SETTINGS } from '../../shared/old-names.js';
import { olderNames } from '../lib/adopt-old-names.js';
import { services } from '../ext/connections/index.js';

const TWO = 'BASE_TWO_STEP_KEY';
const OLD_TWO = OLD_SETTINGS[TWO];
const BRAND = 'BASE_BRAND';
const OLD_BRAND = OLD_SETTINGS[BRAND];
const K1 = `riverbend-two-step-key-one-${'a'.repeat(16)}`;
const K2 = `riverbend-two-step-key-two-${'b'.repeat(16)}`;
const TOUCHED = [TWO, OLD_TWO, BRAND, OLD_BRAND];
const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
const only = (values) => { for (const k of TOUCHED) delete process.env[k]; Object.assign(process.env, values); };
const rowOf = (key) => services().find((s) => s.key === key);
const lineFor = (row, old) => row.detail.split('\n').find((l) => l.includes(old));
const noValues = (row, ...values) => { for (const v of values) assert.ok(!JSON.stringify(row).includes(v), 'no value in the row'); };

test('set under both names with different values: the row says the new one is used and to check it first', () => {
  only({ [OLD_BRAND]: 'imagine-surrey', [BRAND]: 'imagine-surry' });
  assert.deepEqual(olderNames(), [{ old: OLD_BRAND, now: BRAND, differs: true }]);
  const row = rowOf('older-names');
  const line = lineFor(row, OLD_BRAND);
  assert.match(line, new RegExp(`${BRAND} is set and differs from ${OLD_BRAND}; ${BRAND} is used`));
  assert.match(line, new RegExp(`before deleting ${OLD_BRAND}`));
  noValues(row, 'imagine-surrey', 'imagine-surry');
  // The same value under both: the ordinary line.
  only({ [OLD_BRAND]: 'imagine-surrey', [BRAND]: 'imagine-surrey' });
  assert.deepEqual(olderNames(), [{ old: OLD_BRAND, now: BRAND }]);
  assert.match(lineFor(rowOf('older-names'), OLD_BRAND), new RegExp(`add ${BRAND}, copy the value exactly, then delete ${OLD_BRAND}`));
});

test('the two-step key: never “then delete” until the new name holds every key the older one holds', () => {
  only({ [OLD_TWO]: K1 });
  let line = lineFor(rowOf('older-names'), OLD_TWO);
  assert.match(line, new RegExp(`add ${TWO} with exactly the same value`));
  assert.match(line, /never press Generate/);
  assert.match(line, new RegExp(`keep ${OLD_TWO} until`));
  assert.doesNotMatch(line, /then delete/);

  // Generated, or one character short: both differ from the older value.
  for (const wrong of [K2, K1.slice(0, -1)]) {
    only({ [OLD_TWO]: K1, [TWO]: wrong });
    assert.deepEqual(olderNames(), [{ old: OLD_TWO, now: TWO, differs: true }]);
    const row = rowOf('older-names');
    line = lineFor(row, OLD_TWO);
    assert.match(line, new RegExp(`${TWO} does not hold the same key as ${OLD_TWO}`));
    assert.match(line, new RegExp(`do not delete ${OLD_TWO}`, 'i'));
    noValues(row, K1, K2);
  }

  // The same value, or both keys under the new name: now it may go.
  for (const right of [K1, `${K2},${K1}`]) {
    only({ [OLD_TWO]: K1, [TWO]: right });
    assert.deepEqual(olderNames(), [{ old: OLD_TWO, now: TWO, copied: true }]);
    line = lineFor(rowOf('older-names'), OLD_TWO);
    assert.match(line, new RegExp(`${TWO} holds every key ${OLD_TWO} holds: you can delete ${OLD_TWO} now`));
  }
});

test('the two-step row flags a value too short to use under either name', () => {
  only({ [OLD_TWO]: K1, [TWO]: K1.slice(0, 31) });
  let row = rowOf('twostep');
  assert.equal(row.flagged, true);
  assert.match(row.detail, new RegExp(`${TWO} is too short`));
  noValues(row, K1);
  only({ [OLD_TWO]: 'too-short', [TWO]: K1 });
  assert.deepEqual(olderNames(), [{ old: OLD_TWO, now: TWO, copied: true }], 'a key too short to use opens nothing: the older name may go');
  row = rowOf('twostep');
  assert.equal(row.flagged, true);
  assert.match(row.detail, new RegExp(`${OLD_TWO} is too short`));
  assert.match(row.detail, new RegExp(`${TWO} holds the key in use; ${OLD_TWO} can be deleted`), 'with the new name to use');
  only({ [TWO]: K1 });
  row = rowOf('twostep');
  assert.equal(row.state, 'ready');
  assert.ok(!row.flagged);
  assert.equal(row.detail, 'Set: authenticator keys are sealed with it');
});
