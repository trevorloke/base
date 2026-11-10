// One row of a gift file, as the screen sends it — its cells already read
// by shared/giftfile.js (integer cents, a YYYY-MM-DD day, the ledger's word
// for how it was paid) — checked here again, since the server trusts no
// screen: → { row } the import works with, or { error } why it can't come
// in, in plain words (the screen shows them beside the row's number).
import { z } from 'zod';
import { SLATE_CODES } from '@starbase/shared/canvass';
import { GIFT_METHODS, giftKey } from '@starbase/shared/giftfile';

const text = (max) => z.string().max(max).nullish();
const rowSchema = z.object({
  row: z.number().int().min(1).max(100_000_000).nullish(), // its row in the spreadsheet
  name: text(300), first: text(150), last: text(150),
  email: text(320), phone: text(40),
  address: text(1000), unit: text(40), city: text(120), postal: text(20),
  amount_cents: z.number().nullish(),
  date: text(40),
  method: text(40), slate: text(40),
  // How it was paid as the file writes it ("Wire"): part of what makes the
  // gift the same gift the next time, whatever the person says it means.
  paid_as: text(80),
  source_id: text(200), receipt: text(200),
  // Which of the file's rows that read alike this is (shared/giftfile.js keyRows).
  nth: z.number().int().min(1).max(1_000_000).nullish(),
});

const WORDS = {
  name: 'The name', first: 'The first name', last: 'The last name', email: 'The email', phone: 'The phone number',
  address: 'The address', unit: 'The unit', city: 'The city', postal: 'The postal code', amount_cents: 'The amount',
  date: 'The date', method: 'How it was paid', paid_as: 'How it was paid', slate: 'The slate',
  source_id: 'Their gift number', receipt: 'Their receipt number',
};
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const clean = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
const realDay = (s) => {
  const m = DAY_RE.exec(String(s ?? ''));
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return y >= 1990 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
};

// latest: the last day a gift can be dated (tomorrow, as the campaign's
// calendar has it: a file kept in another time zone can be a day ahead).
export const readRow = (raw, { latest }) => {
  const p = rowSchema.safeParse(raw);
  if (!p.success) return { error: `${WORDS[p.error.issues[0].path[0]] || 'This row'} can’t be read.` };
  const v = p.data;
  const first = clean(v.first) || null;
  const last = clean(v.last) || null;
  const name = clean(v.name) || [first, last].filter(Boolean).join(' ') || null;
  const email = clean(v.email).toLowerCase() || null;
  if (email && !EMAIL_RE.test(email)) return { error: `“${clean(v.email)}” doesn’t look like an email address.` };
  if (!name && !email) return { error: 'No donor name or email.' };
  if (!Number.isInteger(v.amount_cents) || v.amount_cents <= 0 || v.amount_cents > 100_000_000) return { error: 'The amount isn’t dollars above $0.' };
  if (!realDay(v.date)) return { error: 'The date isn’t a day like 2026-03-01.' };
  if (v.date > latest) return { error: 'The date is in the future.' };
  const method = clean(v.method).toLowerCase() || null;
  if (method && !GIFT_METHODS.includes(method)) return { error: `“${clean(v.method)}” isn’t a way of paying on the list.` };
  const slate = clean(v.slate) || null;
  if (slate && !SLATE_CODES.includes(slate)) return { error: `“${slate}” isn’t one of the slates.` };
  const donor = {
    name, first, last, email, phone: clean(v.phone) || null, address: clean(v.address) || null,
    unit: clean(v.unit) || null, city: clean(v.city) || null, postal: clean(v.postal).toUpperCase() || null,
  };
  const ref = clean(v.source_id) || null;
  const row = {
    row_no: v.row ?? null, donor, amount_cents: v.amount_cents, date: v.date, method, slate,
    import_ref: ref, import_receipt: clean(v.receipt) || null,
  };
  row.key = giftKey({ source_id: ref, name, first, last, email, amount_cents: row.amount_cents, date: row.date, method, paid_as: v.paid_as, nth: v.nth || 1 });
  return { row };
};
