// A file of gifts made in another tool (Donations → Import a file): how its
// cells are read. Shared, so what the browser shows before the check, the
// key the server keeps on each gift and the tests all read a cell one way.
// Nothing here knows any tool's column names — the person matches columns.

// "$1,250.00" · "1250" · "49.99" · "50,00" · "CA$ 50" → cents. null when it
// isn't dollars and cents, is zero or less (a refund is not a gift), or is
// over $1,000,000 (the wrong column).
const MAX_CENTS = 100_000_000;
export const readAmount = (raw) => {
  let n = null;
  if (typeof raw === 'number') n = raw;
  else {
    const s = String(raw ?? '').trim()
      .replace(/^(?:CAD|CA|C)?\s*\$/i, '').replace(/^CAD\b/i, '').replace(/(?:\$|CAD)$/i, '')
      .replace(/[\s ]/g, '');
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) n = Number(s.replace(/,/g, '')); // 1,250.00
    else if (/^\d+(\.\d+)?$/.test(s)) n = Number(s); // 1250 · 49.99
    else if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) n = Number(s.replace(/\./g, '').replace(',', '.')); // 1.250,00 · 50,00
  }
  if (n === null || !Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  // A spreadsheet's 49.990000000000002 is 49.99; 33.3333 is not an amount.
  if (Math.abs(n * 100 - cents) > 1e-6) return null;
  return cents > 0 && cents <= MAX_CENTS ? cents : null;
};

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, '0');
const day = (y, m, d) => {
  const [yy, mm, dd] = [Number(y), Number(m), Number(d)];
  if (!Number.isInteger(yy) || !Number.isInteger(mm) || !Number.isInteger(dd) || yy < 1990 || yy > 2100) return null;
  const t = new Date(Date.UTC(yy, mm - 1, dd));
  return t.getUTCFullYear() === yy && t.getUTCMonth() === mm - 1 && t.getUTCDate() === dd ? `${yy}-${pad(mm)}-${pad(dd)}` : null;
};
// The calendar day an instant falls on in the campaign's time zone.
const dayIn = (instant, timeZone) => {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(instant).map((x) => [x.type, x.value]));
    return day(p.year, p.month, p.day);
  } catch { return null; }
};
// Two numbers and a year: 03/04/2026, 3-4-2026, 03.04.26.
const NUMERIC = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?:[ ,T].*)?$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

// A date as files write it → 'YYYY-MM-DD', or null.
//   2026-03-01 (a time after it is dropped) · 2026/03/01 · Mar 1, 2026 ·
//   March 1st 2026 · 1 Mar 2026 · 01-Mar-2026
//   03/04/2026: which number is the month is the file's habit — order says
//   ('mdy', the default, or 'dmy'; see dateOrderOf)
//   2026-03-01T03:22:10Z (an instant): the day it was in timeZone
export const readGiftDate = (raw, { order = 'mdy', timeZone = 'America/Vancouver' } = {}) => {
  const s = String(raw ?? '').trim();
  let x;
  if (INSTANT.test(s)) {
    const t = new Date(s);
    return Number.isNaN(t.getTime()) ? null : dayIn(t, timeZone);
  }
  if ((x = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ ,T].*)?$/.exec(s))) return day(x[1], x[2], x[3]);
  if ((x = NUMERIC.exec(s))) {
    const y = x[3].length === 2 ? `20${x[3]}` : x[3];
    return order === 'dmy' ? day(y, x[2], x[1]) : day(y, x[1], x[2]);
  }
  const month = (w) => MONTHS[w.slice(0, 3).toLowerCase()];
  if ((x = /^(\d{1,2})(?:st|nd|rd|th)?[ -]([a-z]{3,9})\.?,?[ -](\d{4})(?:[ ,T].*)?$/i.exec(s))) return day(x[3], month(x[2]), x[1]);
  if ((x = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?:[ ,T].*)?$/i.exec(s))) return day(x[3], month(x[1]), x[2]);
  return null;
};

// What a column's dates say about which number comes first:
//   'mdy' | 'dmy'  a value settles it (a 13 or more can only be the day)
//   'either'       03/04/2026 and the like only — the person says
//   'mixed'        some say one, some the other
//   null           no two-numbers-and-a-year dates in the column
export const dateOrderOf = (values) => {
  let mdy = 0; let dmy = 0; let any = 0;
  for (const v of values) {
    const x = NUMERIC.exec(String(v ?? '').trim());
    if (!x) continue;
    any += 1;
    if (Number(x[1]) > 12) dmy += 1;
    if (Number(x[2]) > 12) mdy += 1;
  }
  if (!any) return null;
  if (mdy && dmy) return 'mixed';
  return mdy ? 'mdy' : dmy ? 'dmy' : 'either';
};

// How it was paid, in the ledger's words (shared/registry.js: card ·
// etransfer · cheque · cash · pad · in-kind), or null when the cell says
// nothing we know — the person can say what each value means.
const METHOD_WORDS = [
  [/card|credit|visa|master|amex|americanexpress|stripe|paypal|square|applepay|googlepay/, 'card'],
  [/etransfer|interac|emt|emailtransfer|emoneytransfer/, 'etransfer'],
  [/cheque|check|chq|draft|moneyorder/, 'cheque'],
  [/cash/, 'cash'],
  [/inkind|nonmonetary/, 'in-kind'],
  [/^pad$|preauthori|debit|^eft$|^ach$|withdrawal/, 'pad'],
];
export const GIFT_METHODS = ['card', 'etransfer', 'cheque', 'cash', 'pad', 'in-kind'];
export const readMethod = (raw) => {
  const w = String(raw ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return null;
  if (GIFT_METHODS.includes(String(raw).trim().toLowerCase())) return String(raw).trim().toLowerCase();
  return METHOD_WORDS.find(([re]) => re.test(w))?.[1] || null;
};

// "Example, Jane" → "Jane Example": a name written last name first (one
// comma). Anything else is left as written.
export const flipName = (raw) => {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  const x = /^([^,]+),\s*([^,]+)$/.exec(s);
  return x ? `${x[2].trim()} ${x[1].trim()}` : s;
};

const squash = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
// The donor as a row names them, for telling two rows apart.
const donorWords = ({ name, first, last, email }) => squash(name || [first, last].map((x) => String(x ?? '').trim()).filter(Boolean).join(' ')) || squash(email);

// What makes a gift the same gift when its file comes in again: the other
// tool's own id when the file has one; without one, donor + amount + date +
// how it was paid — and, for rows of one file that read alike (two $20 cash
// gifts on one day), which of them it is (nth: 1, 2, …), so neither is lost
// and the same file adds nothing the second time. How it was paid is the
// file's own word when the row carries one (paid_as: "Wire"): what a person
// says an unknown word means can differ from one import to the next, and
// must not make the same row a new gift.
export const giftKey = ({ source_id, amount_cents, date, method, paid_as, nth = 1, ...donor }) => {
  const id = String(source_id ?? '').trim();
  if (id) return `id:${id}`;
  return `row:${donorWords(donor)}|${amount_cents}|${date}|${squash(paid_as) || method || ''}${nth > 1 ? `#${nth}` : ''}`;
};
// A file's rows, each with its key: a row that reads like an earlier one
// gets nth (and a key of its own); a row whose id an earlier row has is
// that gift again (repeat: true — it is left out).
export const keyRows = (rows) => {
  const seen = new Map();
  return rows.map((r) => {
    const base = giftKey({ ...r, nth: 1 });
    const nth = (seen.get(base) || 0) + 1;
    seen.set(base, nth);
    const byId = base.startsWith('id:');
    return { ...r, nth: byId ? 1 : nth, key: byId ? base : giftKey({ ...r, nth }), repeat: byId && nth > 1, alike: !byId && nth > 1 };
  });
};
