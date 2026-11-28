// render.yaml after the rename (a Blueprint sync must never lose a client's
// saved setting): every setting is listed under its new name; every older
// name that was listed before stays listed, as sync: false with no value, so
// a sync can neither remove it nor write over what a service holds under it;
// a value the file fixed is fixed under the new name, unchanged; and a
// setting that was sync: false is sync: false under its new name too.
//
// The frozen list is render.yaml's settings as they stood before the rename.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseYaml, howSet } from './release-safety.js';
import { OLD_SETTINGS, newNameOf } from '../../shared/old-names.js';

const doc = parseYaml(readFileSync(new URL('../../render.yaml', import.meta.url), 'utf8'));
const vars = (name) => Object.fromEntries(doc.services.find((s) => s.name === name).envVars.map((v) => [v.key, v]));

// Before the rename: [old name, the fixed value, or 'sync' for sync: false].
const BEFORE = {
  'base-win-staging': [
    ['STARBASE_ENV', 'staging'],
    ['STARBASE_BRAND', 'base'],
    ['STARBASE_ORG_NAME', 'Sample Campaign'],
    ['STARBASE_JURISDICTION', 'bc-municipal'],
    ['STARBASE_TZ', 'America/Vancouver'],
    ['STARBASE_CITY', 'Vancouver'],
    ['STARBASE_GEO_BOUNDS', '49.198,-123.225|49.317,-123.023'],
    ['STARBASE_SLATES', 'council:City council,school_board:School board'],
    ['STARBASE_PUBLIC_URL', 'sync'],
    ['STARBASE_FRAME_HOSTS', 'https://base.win,https://www.base.win'],
    ['STARBASE_DEMO_EMAIL', 'demo@base.win'],
    ['STARBASE_SAMPLE', 'vancouver'],
    ['STARBASE_SAMPLE_RESET', 'sync'],
    ['STARBASE_CANDIDATES', '4A:Avendrel:Opposed — Lantern Quay Electors / Tamsin Avendrel;4B:Brindlemoor:Opposed — Juniper Bridge Alliance / Odell Brindlemoor;4C:Castramont:Opposed — Foghorn Civic League / Mireille Castramont'],
  ],
  'base-win': [
    ['STARBASE_ENV', 'production'],
    ['STARBASE_BRAND', 'sync'],
    ['STARBASE_ORG_NAME', 'sync'],
    ['STARBASE_JURISDICTION', 'sync'],
    ['STARBASE_TZ', 'sync'],
    ['STARBASE_CITY', 'sync'],
    ['STARBASE_SLATES', 'sync'],
    ['STARBASE_PUBLIC_URL', 'sync'],
  ],
  'base-platform': [],
};

test('the frozen list is every older name, each in the table', () => {
  for (const [, pairs] of Object.entries(BEFORE)) {
    for (const [old] of pairs) assert.ok(Object.values(OLD_SETTINGS).includes(old), old);
  }
});

test('every older name listed before is still listed, as sync: false with no value', () => {
  for (const [service, pairs] of Object.entries(BEFORE)) {
    const v = vars(service);
    for (const [old] of pairs) {
      assert.ok(v[old], `${service}: ${old} is still listed`);
      assert.equal(howSet(v[old]), 'sync', `${service}: ${old} is sync: false`);
      assert.deepEqual(Object.keys(v[old]).sort(), ['key', 'sync'], `${service}: ${old} has no value and nothing generated or linked`);
    }
  }
});

test('no older name is listed that was not before, and none anywhere with a value', () => {
  const olds = new Set(Object.values(OLD_SETTINGS));
  for (const s of doc.services) {
    const listed = (s.envVars || []).map((v) => v.key).filter((k) => olds.has(k));
    assert.deepEqual(listed, (BEFORE[s.name] || []).map(([k]) => k), s.name);
  }
});

test('each setting under its new name: a fixed value unchanged, a sync: false setting still sync: false', () => {
  for (const [service, pairs] of Object.entries(BEFORE)) {
    const v = vars(service);
    for (const [old, was] of pairs) {
      const now = newNameOf(old);
      assert.notEqual(now, old);
      assert.ok(v[now], `${service}: ${now} is listed`);
      if (was === 'sync') assert.equal(howSet(v[now]), 'sync', `${service}: ${now} stays sync: false, so the value in Render is never written over`);
      else {
        assert.equal(howSet(v[now]), 'fixed', `${service}: ${now}`);
        assert.equal(v[now].value, was, `${service}: ${now} keeps the value ${old} had`);
      }
    }
  }
});

test('every new name listed is one the server reads', () => {
  for (const s of doc.services) {
    for (const { key } of s.envVars || []) {
      if (/^BASE_/.test(key) && !['BASE_PLATFORM_PUBKEY', 'BASE_PATH', 'BASE_DOOR_KEY', 'BASE_CLIENTS', 'BASE_APEX'].includes(key)) {
        assert.ok(Object.hasOwn(OLD_SETTINGS, key), `${s.name}: ${key}`);
      }
    }
  }
});
