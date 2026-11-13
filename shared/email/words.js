// Campaign email's fill-ins and placeholders — newsletters, emails to a list
// and press releases, written at the desk and sent by base.win (actions/
// field.js blast.send, ext/abtests/send.js), started blank or from a
// template (ext/templates, email/starters.js).
//
//   EMAIL_FILLS        "[first name]" and "[campaign]": the words the compose
//                      shows, stored as {{first_name}} / {{campaign}}
//   toWords · toCodes · unfilled   fillwords.js, without its [… name] test:
//                      an email's brackets are its placeholders and link
//                      words, not mistyped fill-ins
//   firstOf(row)       the first name a greeting uses: "JOHN" → "John"; none → "friend"
//   fillText(text, v)  the codes in a subject or the text part → the raw values
//   fillHtml(html, v)  the codes in the finished HTML → the values, escaped,
//                      so a name typed as "[x](https://…)" or "**x**" is
//                      only ever words
//   placeholders(text) each "[…]" still to be filled in, and each link with
//                      no address ("a link with no address: Read more")
// Plain JS (no JSX): the server and the screens use the same words.
import { fillWords } from '../fillwords.js';
import { escapeHtml } from '../markdown.js';

export const EMAIL_FILLS = [
  { key: 'first_name', word: '[first name]', button: '+ First name', typed: /\[\s*first[\s_-]*name\s*\]/gi, hint: /name|first/i },
  { key: 'campaign', word: '[campaign]', button: '+ Campaign', typed: /\[\s*campaign\s*\]/gi, hint: /camp/i, rank: 1 },
];
export const { FILLS, toWords, toCodes, unfilled } = fillWords(EMAIL_FILLS, { near: false });

// The greeting's name: the person's first name, or the first word of the
// name a subscriber gave, cut to 40 characters. One typed all in capitals
// is greeted with only its first letter capital ("MARY-ANNE" → "Mary-anne");
// "Lee", "McKay" and "J" are left as they are. Nothing stored changes.
export const FRIEND = 'friend';
export const firstOf = (row) => {
  const n = (String(row?.first_name ?? '').trim() || String(row?.name ?? '').trim().split(/\s+/)[0] || '').slice(0, 40).trim();
  if (!n) return FRIEND;
  if (n.length > 1 && n === n.toUpperCase() && n !== n.toLowerCase()) return n[0] + n.slice(1).toLowerCase();
  return n;
};

// One pass over both codes, so a name that itself reads "{{campaign}}" is
// put in as typed, never filled again.
const CODES = /\{\{\s*(first_name|campaign)\s*\}\}/gi;
const valueOf = (vals, key) => String((key.toLowerCase() === 'first_name' ? vals?.first : vals?.campaign) ?? '');
export const fillText = (text, vals) => String(text ?? '').replace(CODES, (_, k) => valueOf(vals, k));
export const fillHtml = (html, vals) => String(html ?? '').replace(CODES, (_, k) => escapeHtml(valueOf(vals, k)));

// A placeholder is "[…]" on one line, up to PLACEHOLDER_MAX characters
// inside (one level of brackets within it allowed: "[volunteering on
// [day]]" — that and "[day]" are both placeholders), not a link's words
// ("[words](url)", "![alt](url)") and not a fill-in. A link whose address
// is empty ("[Read more](https://)", "[Read more]()") is reported too.
export const PLACEHOLDER_MAX = 120;
export const NO_ADDRESS = 'a link with no address: ';
const BRACKETS = /\[((?:[^[\]\n]|\[[^[\]\n]*\])+)\](\([^)\n]*\))?/g;
const INNER = /\[[^[\]\n]+\]/g;
const isFill = (s) => EMAIL_FILLS.some((f) => new RegExp(`^${f.typed.source}$`, 'i').test(s));
const EMPTY_ADDRESS = /^\(\s*(https?:\/\/)?\s*\)$/i;
export const placeholders = (text) => {
  const out = [];
  const add = (p) => { if (!out.includes(p)) out.push(p); };
  for (const m of String(text ?? '').matchAll(BRACKETS)) {
    const [whole, inside, link] = m;
    if (link) {
      if (EMPTY_ADDRESS.test(link)) add(`${NO_ADDRESS}${inside.trim()}`);
      continue;
    }
    if (inside.trim() && inside.length <= PLACEHOLDER_MAX && !isFill(whole)) add(whole);
    // The ones inside it: still to fill when the outer words are kept.
    for (const [inner] of inside.matchAll(INNER)) if (!isFill(inner)) add(inner);
  }
  return out;
};
