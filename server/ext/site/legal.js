// The words the law or a person's consent depends on, per language (TR
// decision 14): the English templates are code (shared/site/wording.js
// LEGAL_ENGLISH); a manager approves the words in each language
// (site_legal_words, insert-only), and pages draw only approved words —
// a key whose English changed since its approval shows in English until
// approved again, and "Authorized by" missing or changed takes the
// language off the site (offeredLanguages).
import { createHash } from 'node:crypto';
import { LEGAL_ENGLISH, LEGAL_KEYS, consentName } from '../../../shared/site/wording.js';
import { keyCurrent, legalWords } from '../../../shared/site/legal-words.js';
import { parseJ } from './store.js';

// The first 12 hex characters of the sha256 of LEGAL_ENGLISH as JSON: a form
// carries it (legal_v), so a page drawn by another release is asked to
// reload rather than stored with words it didn't show.
export const LEGAL_ENGLISH_HASH = createHash('sha256').update(JSON.stringify(LEGAL_ENGLISH)).digest('hex').slice(0, 12);

// The newest approval per language: { lang → row }.
export const latestLegal = async (q, workspaceId) => {
  const rows = (await q.query(
    `select distinct on (lang) id, lang, english, words, approved_by, approved_at from site_legal_words
      where workspace_id = $1 order by lang, approved_at desc, id desc`, [workspaceId],
  )).rows;
  return Object.fromEntries(rows.map((r) => [r.lang, { ...r, english: parseJ(r.english, {}), words: parseJ(r.words, {}) }]));
};
export const legalRow = async (q, workspaceId, id) => {
  const r = (await q.query('select id, lang, english, words, approved_at from site_legal_words where workspace_id = $1 and id = $2', [workspaceId, id])).rows[0];
  return r ? { ...r, english: parseJ(r.english, {}), words: parseJ(r.words, {}) } : null;
};

// Is this key of an approval still the running code's English? And a
// key's words as a page draws them. Pure, shared with the renderer and the
// "Authorized by" rule (shared/site/legal-words.js).
export { keyCurrent, legalWords };
export const staleKeys = (row) => (row ? LEGAL_KEYS.filter((k) => !keyCurrent(row, k)) : [...LEGAL_KEYS]);

// The slots' values, as the page fills them.
export const legalSlots = (settings, extra = {}) => {
  const org = settings?.org || {};
  return {
    org: consentName(org, settings?.seo),
    agent: String(org.agentName || '').replace(/\s+/g, ' ').trim(),
    contact: String(org.agentContact || '').replace(/\s+/g, ' ').trim(),
    ...extra,
  };
};
