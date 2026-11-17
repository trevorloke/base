// The English of the words the law needs (shared/site/wording.js
// LEGAL_ENGLISH) is held here by its hash. A release that changes it makes
// those lines "English changed" on every translated website until a manager
// approves new words, so it must never be a surprise: change the hash below
// only together with a line in docs/RELEASE-CHECKLIST.md naming the keys
// that changed ("Legal English changed: donate. Managers re-approve it in
// each language.").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LEGAL_ENGLISH, LEGAL_KEYS } from '../../shared/site/wording.js';
import { LEGAL_ENGLISH_HASH } from '../ext/site/legal.js';

const HELD = '11ca8dfa0e94';
// The keys as they were when HELD was taken.
const KEYS_AT_HELD = ['authorizedBy', 'email', 'sms', 'newsletter', 'privacy', 'donate', 'join', 'donateSmall', 'donateSmallNoLimit', 'payPageNote', 'translatedNote', 'readInEnglish', 'policyInEnglish'];

test('the legal English is the one the release checklist names', () => {
  const checklist = readFileSync(new URL('../../docs/RELEASE-CHECKLIST.md', import.meta.url), 'utf8');
  if (LEGAL_ENGLISH_HASH !== HELD) {
    assert.match(checklist, /Legal English changed: [a-zA-Z, ]+\./,
      `LEGAL_ENGLISH changed (now ${LEGAL_ENGLISH_HASH}): add "Legal English changed: <keys>. Managers re-approve it in each language." to docs/RELEASE-CHECKLIST.md, then hold the new hash here`);
  }
  assert.equal(LEGAL_ENGLISH_HASH, HELD, 'hold the new hash here once the checklist names the change');
  assert.deepEqual(LEGAL_KEYS, KEYS_AT_HELD);
  for (const k of LEGAL_KEYS) assert.ok(LEGAL_ENGLISH[k].trim(), k);
});
