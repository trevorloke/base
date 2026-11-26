// Real names staging must never show (not a test; used by the staging
// tests and scripts/staging-check.mjs). Staging is public, and the owner's
// rule is that everything on it is made up.
//
//   findReal(text) → [{ word, near }]: every listed name found in the text.
//   wrongIn(name, text, { json, own }) → lines: what in one answer is not
//     made up — a listed name; a phone outside 604-555-01xx (string values
//     of a JSON answer); an email outside example.org, example.com and
//     base.win; a link to a host other than the server's own (`own`),
//     base.win, example.org, example.com, schema.org or the free map's
//     tiles (*.openstreetmap.org). Each line says the kind and where, never
//     the phone, the email or the text around a name: the daily staging
//     check posts these lines to a public log and issue. (A listed name is
//     named: the list is in this repository already.)
//
// The list: every line of neutral-words/*.txt (Imagine Surrey's words and
// real-names.txt, the real names the product never held), less 604-555,
// the sample's own made-up range; the extras below; and the short
// all-capital names, matched with their case, so "cope" in a sentence or
// a random token is not one. Whole words only: "Locke" is not in "blocked".
//
// A deny-list only catches what is on it, so the sample's people are also
// checked against what is allowed (samplecampaign.test.js).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('./neutral-words/', import.meta.url));
const ALLOWED = new Set(['604-555']);

export const EXTRAS = [
  'Simon Fraser', 'Surrey City Hall', 'Newton Rec Centre', '13450 104', '13730 72',
  'Dev Patel', 'Ravi Shankar', 'Leah Goldberg', 'Ali Hassan', 'Mei Lin', 'Gurpreet Sandhu', 'Alex Morgan', 'samexample',
];
export const WITH_CASE = ['NPA', 'COPE', 'CBC', 'CTV', 'KPU', 'SFU', 'UBC', 'BCIT', 'HEU', 'CUPE', 'BCGEU', 'BCTF', 'UFCW', 'OMNI', 'The Province'];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const whole = (word, flags) => new RegExp(`(?<![A-Za-z0-9])${escape(word)}(?![A-Za-z0-9])`, flags);

export const listWords = () => {
  const fromFiles = readdirSync(DIR).filter((n) => n.endsWith('.txt')).sort()
    .flatMap((n) => readFileSync(join(DIR, n), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  return [...new Set([...fromFiles, ...EXTRAS])].filter((w) => !ALLOWED.has(w));
};

let compiled = null;
const patterns = () => {
  compiled ||= [
    ...listWords().map((word) => ({ word, re: whole(word, 'i') })),
    ...WITH_CASE.map((word) => ({ word, re: whole(word, '') })),
  ];
  return compiled;
};

export const findReal = (text) => {
  const t = String(text ?? '');
  const out = [];
  for (const { word, re } of patterns()) {
    const m = re.exec(t);
    if (m) out.push({ word, near: t.slice(Math.max(0, m.index - 40), m.index + word.length + 40).replace(/\s+/g, ' ') });
  }
  return out;
};

const PHONE = /(?<![\w.-])(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w-])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const HOST = /https:\/\/([A-Za-z0-9.-]+)/g;
const emailOk = (host) => /^(example\.org|example\.com|base\.win)$/i.test(host);
export const hostOk = (host, own = []) => own.map((h) => h.toLowerCase()).includes(host.toLowerCase())
  || /^(base\.win|www\.base\.win|staging\.base\.win|example\.org|example\.com|schema\.org)$/i.test(host)
  || /(^|\.)openstreetmap\.org$/i.test(host);
const strings = (v, out = []) => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
};

export const wrongIn = (name, text, { json = false, own = [] } = {}) => {
  const t = String(text ?? '');
  const out = [];
  for (const f of findReal(t)) out.push(`${name}: a listed real name, “${f.word}”`);
  let values = [];
  if (json) { try { values = strings(JSON.parse(t)); } catch { values = []; } }
  const phones = new Set();
  for (const v of values) for (const m of v.matchAll(PHONE)) if (!/^604-555-01\d\d$/.test(m[0])) phones.add(m[0]);
  const emails = new Set();
  for (const m of t.matchAll(EMAIL)) if (!emailOk(m[1])) emails.add(m[0].toLowerCase());
  const many = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;
  if (phones.size) out.push(`${name}: ${many(phones.size, 'phone number')} outside 604-555-01xx`);
  if (emails.size) out.push(`${name}: ${many(emails.size, 'email')} outside example.org, example.com and base.win`);
  for (const m of t.matchAll(HOST)) if (!hostOk(m[1], own)) out.push(`${name}: a link to ${m[1]}`);
  return [...new Set(out)];
};
