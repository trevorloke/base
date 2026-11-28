// The approved legal words, as a page or a message draws them: pure, so the
// website's renderer (in the browser and on the server), the server's
// senders and the "Authorized by" rule (authorized.js) all read them the
// same way. No database and no hashing here (server/ext/site/legal.js
// reads the rows and hashes the English).
//
// A row is a site_legal_words row ({ english, words }); a digest is what a
// page is handed for its language ({ current: [keys], words: { key: text } }):
// only the keys whose approval is of the running code's English.
import { LEGAL_ENGLISH, LEGAL_KEYS, fillSlots } from './wording.js';

// Is this key of an approval still the running code's English?
export const keyCurrent = (row, key) => Boolean(row && String(row.words?.[key] ?? '').trim() && row.english?.[key] === LEGAL_ENGLISH[key]);
// "Authorized by Ada, " with no contact → "Authorized by Ada".
export const tidy = (s) => String(s ?? '').replace(/[\s,，、]+$/u, '').replace(/\s+/g, ' ').trim();
// A row → its digest.
export const digestOf = (row) => ({
  current: row ? LEGAL_KEYS.filter((k) => keyCurrent(row, k)) : [],
  words: (row && row.words && typeof row.words === 'object') ? row.words : {},
});
// A key's words as a page draws them, from a digest: the approval's,
// filled — or the English with lang 'en' when that key isn't current in it.
export const digestWords = (digest, lang, key, slots = {}) => {
  const d = digest && typeof digest === 'object' ? digest : {};
  const current = Array.isArray(d.current) ? d.current : [];
  const words = d.words && typeof d.words === 'object' ? d.words : {};
  if (lang !== 'en' && current.includes(key) && String(words[key] ?? '').trim()) return { text: tidy(fillSlots(words[key], slots)), lang };
  return { text: tidy(fillSlots(LEGAL_ENGLISH[key], slots)), lang: 'en' };
};
// The same from a row.
export const legalWords = (row, lang, key, slots) => digestWords(digestOf(row), lang, key, slots);
