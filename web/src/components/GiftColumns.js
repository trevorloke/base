// Donations → Import a file (pages/ImportGifts.jsx): which column of a gift
// file is what, one row of it as the server takes it, and what the check
// adds up to. No tool's export is assumed: a column is matched by what its
// heading means ("Donor", "Contributor name", "Date received", "Payment
// method", "Designation", "Transaction ID"), then by what its values look
// like — and the person corrects it on screen. Plain JS (no JSX) so the
// server's tests can check it.
import { readAmount, readGiftDate, readMethod, flipName, keyRows } from '@starbase/shared/giftfile';

export const GIFT_FIELDS = [
  { key: 'name', label: 'Donor’s full name' },
  { key: 'first', label: 'First name' },
  { key: 'last', label: 'Last name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'address', label: 'Street address' },
  { key: 'unit', label: 'Unit / apt' },
  { key: 'city', label: 'City' },
  { key: 'postal', label: 'Postal code' },
  { key: 'amount', label: 'Amount' },
  { key: 'date', label: 'Date of the gift' },
  { key: 'method', label: 'Paid by' },
  { key: 'slate', label: 'Slate' },
  { key: 'source_id', label: 'Their number for the gift' },
  { key: 'receipt', label: 'Their receipt number' },
];
export const SKIP = '';

const normHeader = (h) => String(h || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POSTAL_RE = /^[a-z]\d[a-z][ -]?\d[a-z]\d$/i;
const PHONE_RE = /^\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(\s*(x|ext\.?)\s*\d+)?$/i;
const NAME_RE = /^\p{L}[\p{L}'’.,-]*(?:\s+\p{L}[\p{L}'’.,-]*){1,3}$/u;
// A number Excel cut short ("1.6047E+10"): its last digits are gone.
export const SCI_RE = /^\d(\.\d+)?e\+?\d+$/i;

// A heading that says it outright, strongest first: when two columns could
// be the date ("Donation date", "Created at"), the one named for the gift
// is taken.
const EXACT = [
  ['amount', /^(amount|amt|donationamount|giftamount|contributionamount)$/],
  ['amount', /^(totalamount|total|donation|contribution|gift|gross|grossamount|amountcad|amountpaid|value)$/],
  ['date', /^(date|donationdate|giftdate|contributiondate|datereceived|receiveddate|received|receivedon|dateofgift|dateofdonation)$/],
  ['date', /^(paymentdate|paiddate|datepaid|paidon|transactiondate|donatedat|donatedon|completedat|completedon)$/],
  ['date', /^(created|createdat|createdon|datecreated|timestamp|datetime)$/],
  ['email', /^(e?mail|emailaddress|donoremail|contributoremail|primaryemail|billingemail|email\d|courriel)$/],
  ['first', /^(first|firstname|fname|givenname|forename|donorfirstname|donorfirst|contributorfirstname|billingfirstname)$/],
  ['last', /^(last|lastname|lname|surname|familyname|donorlastname|donorlast|contributorlastname|billinglastname)$/],
  ['name', /^(name|fullname|donor|donorname|donorfullname|contributor|contributorname|supporter|supportername|billingname|payer|payername)$/],
  ['phone', /^(phone|phonenumber|tel|telephone|mobile|mobilephone|cell|cellphone|donorphone|billingphone|primaryphone)$/],
  ['unit', /^(unit|unitnumber|apt|apartment|suite|address2|addressline2|street2|billingaddress2)$/],
  ['address', /^(address|streetaddress|address1|addressline1|street|street1|homeaddress|residentialaddress|mailingaddress|billingaddress|billingaddress1|billingstreet|donoraddress)$/],
  ['city', /^(city|town|municipality|billingcity|donorcity)$/],
  ['postal', /^(postal|postalcode|postcode|zip|zipcode|billingpostalcode|billingpostal|billingzip|donorpostalcode|pc)$/],
  ['method', /^(method|paymentmethod|paymenttype|paidby|paymentmode|tender|howpaid|paidvia|methodofpayment)$/],
  ['method', /^(gateway|paymentgateway|processor)$/],
  ['slate', /^(slate|designation|designations|donationdesignation|designationname|designatedto|directedto|fund|fundname|allocation)$/],
  ['receipt', /^(receipt|receiptnumber|receiptno|receiptnum|receiptid|taxreceipt|taxreceiptnumber|officialreceipt|officialreceiptnumber)$/],
  ['source_id', /^(donationid|giftid|contributionid|transactionid|txnid|donationnumber|giftnumber)$/],
  ['source_id', /^(id|transaction|paymentid|orderid|ordernumber|reference|referencenumber|referenceid|confirmation|confirmationnumber|confirmationcode|chargeid|stripeid|paymentintent|paymentintentid|entryid|recordid|uniqueid|uuid)$/],
];
// A heading that only hints: taken when the column's values agree.
const CONTAINS = [
  ['amount', /amount/],
  ['date', /date|receivedon|donatedon|createdat/],
  ['email', /e?mail/],
  ['first', /firstname|givenname/],
  ['last', /lastname|surname|familyname/],
  ['phone', /phone|mobile|^cell|^tel/],
  ['postal', /postal|postcode|zip/],
  ['unit', /^(unit|apt|suite)|address2|addressline2/],
  ['address', /address|street/],
  ['city', /city$|^town/],
  ['method', /paymentmethod|paymenttype|paidby/],
  ['slate', /designation|slate/],
  ['receipt', /receipt/],
  ['source_id', /(donation|gift|contribution|transaction|payment|order|charge|reference|confirmation|entry|record)(id|number|no|ref|code)$/],
  ['name', /donor|contributor|supporter|fullname/],
];

export const columnValues = (records, i, limit = 200) => {
  const out = [];
  for (const r of records) {
    const v = String(r.cells[i] ?? '').trim();
    if (v) out.push(v);
    if (out.length >= limit) break;
  }
  return out;
};
const share = (values, test) => (values.length ? values.filter(test).length / values.length : 0);
const isDate = (v) => readGiftDate(v) !== null || readGiftDate(v, { order: 'dmy' }) !== null;
// What a column's values must look like to be taken for a field.
const LOOKS = {
  email: (vals) => share(vals, (v) => EMAIL_RE.test(v)) >= 0.6,
  phone: (vals) => share(vals, (v) => PHONE_RE.test(v) || SCI_RE.test(v)) >= 0.6,
  postal: (vals) => share(vals, (v) => POSTAL_RE.test(v)) >= 0.6,
  amount: (vals) => share(vals, (v) => readAmount(v) !== null) >= 0.6,
  date: (vals) => share(vals, isDate) >= 0.6,
  name: (vals) => share(vals, (v) => NAME_RE.test(v)) >= 0.6 && share(vals, (v) => EMAIL_RE.test(v)) < 0.2,
};
// Money written as money ("$50.00", "49.99"): a column of bare whole numbers
// could as well be an id or a count.
const moneyish = (v) => readAmount(v) !== null && /[$.,]/.test(v);

// headers: the file's column names; records: [{ cells }]. slates: the
// campaign's slates — with only one there is no Slate to match.
// → one field key (or SKIP) per column.
export const guessGiftMapping = (headers, records, { slates = [], noHeader = false } = {}) => {
  const out = headers.map(() => SKIP);
  const taken = new Set();
  const values = headers.map((_, i) => columnValues(records, i));
  const norm = headers.map(normHeader);
  const claim = (i, key, loose) => {
    if (out[i] !== SKIP || taken.has(key)) return;
    if (key === 'slate' && slates.length < 2) return;
    // A gift's own number is different on every row: a column whose values
    // repeat (the donor's number, a batch) is not it — and taking it for
    // one would leave every repeat out as "that gift again".
    if (key === 'source_id' && new Set(values[i]).size < values[i].length) return;
    // A whole name beside first and last names is someone else's: a campaign's, a form's.
    if (key === 'name' && loose && (taken.has('first') || taken.has('last'))) return;
    const looks = LOOKS[key];
    // Amounts and dates must read as such even under the plainest heading;
    // the rest only when the heading merely hints.
    if (looks && values[i].length && (loose || key === 'amount' || key === 'date') && !looks(values[i])) return;
    out[i] = key;
    taken.add(key);
  };
  if (!noHeader) {
    for (const [key, re] of EXACT) norm.forEach((n, i) => { if (n && re.test(n)) claim(i, key, false); });
    for (const [key, re] of CONTAINS) norm.forEach((n, i) => { if (n && re.test(n)) claim(i, key, true); });
  }
  // What no heading named, from the values alone.
  headers.forEach((_, i) => {
    if (out[i] !== SKIP || !values[i].length) return;
    if (LOOKS.email(values[i])) claim(i, 'email', true);
    else if (LOOKS.postal(values[i])) claim(i, 'postal', true);
    else if (share(values[i], (v) => PHONE_RE.test(v)) >= 0.6) claim(i, 'phone', true);
    else if (share(values[i], moneyish) >= 0.8) claim(i, 'amount', true);
    else if (LOOKS.date(values[i]) && share(values[i], (v) => /[-/.,\s]/.test(v)) >= 0.8) claim(i, 'date', true);
    else if (noHeader && !taken.has('first') && !taken.has('last') && LOOKS.name(values[i])) claim(i, 'name', true);
  });
  return out;
};

// A column's values, most common first: [{ value, n }] (the list for "what
// each value means").
export const valuesIn = (records, col, limit = 40) => {
  const seen = new Map();
  if (col < 0) return [];
  for (const r of records) {
    const v = String(r.cells[col] ?? '').trim();
    if (!v) continue;
    const k = v.toLowerCase();
    const cur = seen.get(k) || { value: v, n: 0 };
    cur.n += 1;
    seen.set(k, cur);
  }
  return [...seen.values()].sort((a, b) => b.n - a.n || a.value.localeCompare(b.value)).slice(0, limit);
};

// How a value in the Paid by column is read: what the person picked for it
// (methodMap: the value, lower-cased → a method, or '' for not recorded),
// else its own words.
export const methodOf = (methodMap, value) => {
  const k = String(value).toLowerCase();
  if (methodMap && Object.hasOwn(methodMap, k)) return methodMap[k] || null;
  return readMethod(value);
};
// Which slate a value in the Slate column names: the person's pick, else a
// slate whose name or code it is, else the one slate a word of whose name
// it holds ("School board trustees"). A value that fits two slates ("City
// of Surrey School Board"), or none, names no slate here — the screen asks,
// and one left unsaid goes to the first slate, as a gift typed with none.
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const slateWords = (s) => `${s.label} ${s.code}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
export const slateOf = (slateMap, slates, value) => {
  const k = String(value).toLowerCase();
  if (slateMap && Object.hasOwn(slateMap, k)) return slateMap[k] || null;
  const v = squash(value);
  if (!v) return null;
  const named = slates.find((s) => squash(s.code) === v || squash(s.label) === v);
  if (named) return named.code;
  const fits = slates.filter((s) => slateWords(s).some((w) => v.includes(w)));
  return fits.length === 1 ? fits[0].code : null;
};

// One record of the file → { row } as the server takes it, or { error }:
// why this row can't be read, in plain words. badEmail: its email cell
// isn't an address ("n/a", "none") and was left out — the gift still comes
// in, matched by the donor's name.
//   order: which number of 03/04/2026 is the month ('mdy' | 'dmy')
export const giftRow = (cells, mapping, { order = 'mdy', timeZone, methodMap = null, slateMap = null, slates = [] } = {}) => {
  const cell = (key) => { const i = mapping.indexOf(key); return i < 0 ? '' : String(cells[i] ?? '').trim(); };
  const row = {};
  for (const k of ['first', 'last', 'address', 'unit', 'city', 'postal', 'receipt']) { const v = cell(k); if (v) row[k] = v; }
  const email = cell('email');
  const badEmail = Boolean(email) && !EMAIL_RE.test(email);
  if (email && !badEmail) row.email = email;
  const name = cell('name');
  if (name) row.name = flipName(name);
  const phone = cell('phone');
  if (phone && !SCI_RE.test(phone)) row.phone = phone; // digits lost in Excel: not a number to keep
  const id = cell('source_id');
  // Two gifts whose numbers Excel cut to the same "1.6047E+10" would read as one gift.
  if (SCI_RE.test(id)) return { error: `Their number for the gift lost its last digits in Excel (${id}).` };
  if (id) row.source_id = id;
  const amount = cell('amount');
  const cents = readAmount(amount);
  if (cents === null) return { error: amount ? `“${amount}” isn’t an amount above $0.` : 'No amount.' };
  row.amount_cents = cents;
  const when = cell('date');
  const date = readGiftDate(when, { order, ...(timeZone ? { timeZone } : {}) });
  if (!date) return { error: when ? `“${when}” isn’t a date we can read.` : 'No date.' };
  row.date = date;
  const paid = cell('method');
  const method = paid ? methodOf(methodMap, paid) : null;
  if (method) row.method = method;
  // The file's own word goes too: it — not what it was read as this time —
  // is part of what makes the gift the same gift when the file comes again.
  if (paid) row.paid_as = paid.slice(0, 80);
  const to = cell('slate');
  const slate = to ? slateOf(slateMap, slates, to) : null;
  if (slate) row.slate = slate;
  return badEmail ? { row, badEmail } : { row };
};

// The whole file as rows to send: each with its spreadsheet row number and
// which of the rows that read alike it is (shared/giftfile.js keyRows) — in
// the order the gifts were given, oldest first (a file may list the newest
// first), so the gift flagged for a limit is the one that crossed it.
// → { rows, unread: [{ row, text }], repeats, alike, badEmails }
//   unread     rows this screen can't read (no amount, no date…)
//   repeats    rows whose gift number an earlier row has: that gift again,
//              left out
//   alike      rows that read like an earlier one with no gift number to
//              tell them apart: each comes in as its own gift
//   badEmails  rows whose email cell isn't an address: it is left out
export const fileRows = (records, mapping, opts) => {
  const read = [];
  const unread = [];
  let badEmails = 0;
  for (const r of records) {
    const g = giftRow(r.cells, mapping, opts);
    if (g.error) { unread.push({ row: r.row, text: g.error }); continue; }
    if (g.badEmail) badEmails += 1;
    read.push({ ...g.row, row: r.row });
  }
  const keyed = keyRows(read);
  const rows = keyed.filter((r) => !r.repeat).map(({ key: _k, repeat: _r, alike: _a, nth, ...r }) => (nth > 1 ? { ...r, nth } : r))
    .sort((a, b) => a.date.localeCompare(b.date)); // stable: rows of one day stay as the file has them
  return { rows, unread, repeats: keyed.filter((r) => r.repeat).length, alike: keyed.filter((r) => r.alike).length, badEmails };
};

// Rows a call at a time: small enough for one request (the server takes
// 256 KB), and few enough that a call is short — each gift goes through the
// one gift path, a handful of reads and writes, and nobody else's write to
// the campaign (a door knock) gets in until the call is done.
export const callsOf = (rows, { maxRows = 100, maxBytes = 150_000 } = {}) => {
  const out = [];
  let part = [];
  let bytes = 0;
  for (const r of rows) {
    const size = JSON.stringify(r).length * 2; // any script: two bytes a character is plenty for most
    if (part.length && (part.length >= maxRows || bytes + size > maxBytes)) { out.push(part); part = []; bytes = 0; }
    part.push(r);
    bytes += size;
  }
  if (part.length) out.push(part);
  return out;
};

// ── What the check adds up to ──
// A tally over every call's answer (gift.import with dry_run): how many
// gifts would come in, on how many donors, how many wait for a donor, how
// many are here already, what can't come in — and who the file would take
// over the limit: what each matched donor has on file for a year on a
// slate, plus this file's gifts for it.
export const newTally = () => ({
  fresh: 0, waiting: 0, already: 0, cents: 0, invalid: [], matches: [], differs: 0,
  people: new Set(), years: new Map(),
});
const MATCHES_KEPT = 60;
export const addToTally = (t, res, part) => {
  (res.results || []).forEach((r, i) => {
    const sent = part[i] || {};
    if (r.state === 'invalid') t.invalid.push({ row: sent.row ?? null, text: r.error });
    else if (r.state === 'already' || r.state === 'resent') t.already += 1;
    else if (r.state === 'waiting') { t.waiting += 1; t.cents += Number(sent.amount_cents) || 0; }
    else if (r.state === 'new') {
      t.fresh += 1;
      t.cents += Number(r.amount_cents) || 0;
      t.people.add(r.person_id);
      if (r.name_differs) t.differs += 1;
      const k = `${r.person_id}|${r.year}|${r.slate}`;
      const y = t.years.get(k) || { person_id: r.person_id, name: r.person_name, year: r.year, slate: r.slate, file_cents: 0, on_file_cents: 0, cap_cents: null };
      y.file_cents += Number(r.amount_cents) || 0;
      t.years.set(k, y);
      const m = { row: sent.row ?? null, donor: sent.name || [sent.first, sent.last].filter(Boolean).join(' ') || sent.email || '', person: r.person_name, by: r.by, differs: !!r.name_differs };
      // Those under another name first: they are the ones to look at.
      if (m.differs) t.matches.unshift(m); else if (t.matches.length < MATCHES_KEPT) t.matches.push(m);
      if (t.matches.length > MATCHES_KEPT) t.matches.length = MATCHES_KEPT;
    }
  });
  for (const d of res.donors || []) {
    const y = t.years.get(`${d.person_id}|${d.year}|${d.slate}`);
    if (y) { y.on_file_cents = Number(d.on_file_cents) || 0; y.cap_cents = d.cap_cents == null ? null : Number(d.cap_cents); }
  }
  return t;
};
// The donors this file would take over a year's limit (or further over):
// [{ name, year, slate, total_cents, cap_cents }], the furthest over first.
export const overLimit = (t) => [...t.years.values()]
  .filter((y) => y.cap_cents != null && y.on_file_cents + y.file_cents > y.cap_cents)
  .map((y) => ({ person_id: y.person_id, name: y.name, year: y.year, slate: y.slate, total_cents: y.on_file_cents + y.file_cents, cap_cents: y.cap_cents }))
  .sort((a, b) => (b.total_cents - b.cap_cents) - (a.total_cents - a.cap_cents) || String(a.name).localeCompare(String(b.name)));
