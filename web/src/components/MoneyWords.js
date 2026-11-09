// Donations (pages/Money.jsx): the words for a gift over the limit, and for
// Not the same person on a gift that may be the same donor as other
// records. Plain JS (no JSX) so the server's tests can check them against
// what the server sends.
import { fmtMoney, fmtDate } from '../api.js';

// "$3,325" for the big number; rows keep the cents.
export const fmtBig = (cents) => fmtMoney(cents).replace(/\.00$/, '');

// Over the contribution limit, in one line: "$150 over the $1,250 limit".
// The server's flag_reason reads "<donor> is at $1400.00 for 2026 — over the
// $1250.00 limit (<legal source>)"; a fresh gift.log also returns the numbers.
// The last such phrase: a name before it (the donor's, or another record's)
// can never stand in for the numbers.
export const parseOver = (reason) => {
  const m = [...String(reason || '').matchAll(/at \$([\d,]+(?:\.\d+)?) for (\d{4}) — over the \$([\d,]+(?:\.\d+)?) limit/g)].at(-1);
  if (!m) return null;
  const cents = (v) => Math.round(Number(v.replace(/,/g, '')) * 100);
  return { totalCents: cents(m[1]), capCents: cents(m[3]) };
};
// The brief's flagged rows carry the numbers (total_cents: the donor's total
// for that year as it stands; cap_cents: the limit); a ledger row, or a brief
// without them, falls back to reading flag_reason.
// A gift flagged as maybe one donor on two records reads "Possibly the same
// donor as <name> (same …): together they are at $2,000.00 for 2026 — over
// the $1,429.70 limit …" (server/ext/payments/limits.js): its own record is
// under, so until the two are made one, the line is the two together, as a
// maybe. The server adds it up again whenever a gift it counted leaves the
// books, so the reason is the two as they stand.
const centsOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const MAYBE_SAME = /^Possibly the same donor as /;
export const overOf = (g) => {
  const totalCents = centsOrNull(g?.total_cents);
  const capCents = centsOrNull(g?.cap_cents);
  const own = totalCents != null && capCents != null ? { totalCents, capCents } : null;
  const together = MAYBE_SAME.test(g?.flag_reason || '') && !(own && own.totalCents > own.capCents) ? parseOver(g.flag_reason) : null;
  if (together) return { ...together, maybe: true };
  return own || parseOver(g?.flag_reason);
};
export const overLine = (c) => (c && Number.isFinite(c.totalCents) && Number.isFinite(c.capCents) && c.totalCents > c.capCents
  ? `${c.maybe ? 'Maybe ' : ''}${fmtBig(c.totalCents - c.capCents)} over the ${fmtBig(c.capCents)} limit`
  : 'Over limit');

// A maybe (server lib/gifts.js): the ids of the other records it names — on
// the brief's row, or in a ledger row's attrs.
export const sameAsOf = (g) => {
  const ids = g?.maybe_same_donor ?? g?.attrs?.maybe_same_donor;
  return g?.flagged !== false && Array.isArray(ids) ? ids : [];
};

const ASK = 'The two records are kept apart, and the limit is checked again.';
const added = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
};

// Not the same person on a maybe: one choice for each record it names, each
// about that record alone (person.notDuplicate for that one pair), so ruling
// out someone else never rules out the record that may really be the donor.
// The brief and the ledger send each record's name and what it shares
// (maybe_same_as: "Not Aman Gill (same phone)"); two that would read the
// same also say what each gave that year, then when it was added. Two that
// still read the same get no choice: a tap would rule out one of them at
// random, so People → Duplicates shows them side by side (duplicates:
// true). With one record, one "Not the same person" that names it when it
// asks. A copy kept from before has the ids alone: one record is the one
// its reason names; more can't be told apart here, so People → Duplicates.
// → { choices: [{ id, label, ask }], duplicates }
export const apartChoices = (g) => {
  const ids = sameAsOf(g);
  const named = Array.isArray(g?.maybe_same_as) ? g.maybe_same_as : [];
  const known = ids.map((id) => named.find((n) => n.id === id));
  if (ids.length && known.every(Boolean)) {
    const year = fmtDate(g.date).slice(0, 4);
    const tells = [
      (n) => `${n.name}${n.shares ? ` (same ${n.shares})` : ''}`,
      (n) => (Number.isFinite(Number(n.given_cents)) ? ` · ${fmtBig(n.given_cents)}${/^\d{4}$/.test(year) ? ` in ${year}` : ''}` : ''),
      (n) => (added(n.created_at) ? ` · added ${added(n.created_at)}` : ''),
    ];
    let who = known.map(tells[0]);
    const twice = () => who.map((w) => who.filter((x) => x === w).length > 1);
    for (const tell of tells.slice(1)) {
      const again = twice();
      if (!again.some(Boolean)) break;
      who = who.map((w, i) => (again[i] ? w + tell(known[i]) : w));
    }
    const alike = twice();
    return {
      choices: known.map((n, i) => ({
        id: n.id, label: ids.length === 1 ? 'Not the same person' : `Not ${who[i]}`, ask: `Not the same person as ${who[i]}? ${ASK}`,
      })).filter((_, i) => !alike[i]),
      duplicates: alike.some(Boolean),
    };
  }
  if (ids.length === 1) {
    const who = /^Possibly the same donor as (.+?): together they are at /.exec(g?.flag_reason || '')?.[1] || 'the other record';
    return { choices: [{ id: ids[0], label: 'Not the same person', ask: `Not the same person as ${who}? ${ASK}` }], duplicates: false };
  }
  return { choices: [], duplicates: ids.length > 1 };
};

// What Not the same person did to the gift's flag (its entry in
// person.notDuplicate's rechecked, if it changed): cleared, or what is left.
export const apartSaid = (now) => {
  if (!now) return '✓ Kept apart';
  if (!now.flagged) return '✓ Kept apart. The flag is cleared.';
  const line = overLine(overOf(now));
  return line === 'Over limit' ? 'Kept apart. It’s still over the limit.' : `Kept apart. Still ${line[0].toLowerCase()}${line.slice(1)}.`;
};
