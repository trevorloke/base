// GET /gotv/find?q=&place_id=&written_at=&practice=  a scrutineer's look-up:
// one person by name, street or voter number, never a list to browse.
//
// The first name word rides PS's folded name indexes (person_fold(name) or
// person_fold(last_name) starts with it); each further word may match the
// name or the address, and a word of digits the house number's block
// ("14" → the 14000s, "14000" → 14000–14099) or the street's number ("72"
// in "72 Ave"). Commas, dashes, "x" placeholders and order don't matter.
// At most 8 rows of { id, name, where } and more: true when there are more —
// nothing else, so a look-up never says whether anyone voted.
//
// Limits that fit a runner's afternoon: 120 a minute and 5,000 a day per
// person (in memory, one instance); past the day limit the desk's
// Scrutineers tab shows a flag and a manager may allow 2,000 more.
import { foldTerm } from '@base-win/shared/names';
import { streetOf } from '../../lib/address.js';
import { voterNumber } from '../voternumber/index.js';
import { now } from '../../lib/clock.js';
import { localDay } from '../../lib/tzrule.js';

const PER_MINUTE = 120;
const PER_DAY = 5_000;
const ROWS = 8;
const LEAD_CAP = 2_000;
export const SLOW = 'Slow down — try again in a minute.';
export const DAY_LIMIT = 'Today’s look-up limit is reached — names are kept to match later. The office has been told.';
export const TOO_SHORT = 'Type at least 3 letters or a voter number.';

// `${ws}:${uid}` → { day, n, extra, minute: [timestamps] }
const counts = new Map();
const countOf = (ws, uid, day) => {
  const k = `${ws}:${uid}`;
  let c = counts.get(k);
  if (!c || c.day !== day) { c = { day, n: 0, extra: 0, minute: [] }; counts.set(k, c); }
  return c;
};
// → null, or the words of a 429.
export const takeLookup = (ws, uid, tz) => {
  const c = countOf(ws, uid, localDay(now(), tz));
  const t = Date.now();
  c.minute = c.minute.filter((x) => t - x < 60_000);
  if (c.n >= PER_DAY + c.extra) { c.flag = true; return DAY_LIMIT; }
  if (c.minute.length >= PER_MINUTE) return SLOW;
  c.minute.push(t);
  c.n += 1;
  return null;
};
export const allowMore = (ws, uid, n) => {
  for (const [k, c] of counts) if (k === `${ws}:${uid}`) { c.extra += n; c.flag = false; }
};
// For the Scrutineers tab: today's count and whether the limit was reached.
export const lookupsOf = (ws, uid, tz) => {
  const c = counts.get(`${ws}:${uid}`);
  if (!c || c.day !== localDay(now(), tz)) return { lookups: 0, limit_reached: false };
  return { lookups: c.n, limit_reached: Boolean(c.flag) };
};
export const _resetLookups = () => counts.clear();

const escLike = (s) => s.replace(/[%_\\]/g, (m) => `\\${m}`);
// The words of what was typed: folded, split on spaces, commas and dashes;
// "14xxx" is "14"; the order kept only to choose the leading name word.
export const wordsOf = (q) => foldTerm(String(q || '').replace(/[—–]/g, ' '))
  .split(/[\s,;/-]+/)
  .map((w) => (/^\d+x+$/i.test(w) ? w.replace(/x+$/i, '') : w.replace(/[.']/g, '')))
  .filter((w) => w && !/^x+$/i.test(w));

const whereOf = (r) => {
  const street = streetOf(r.house_number, r.address);
  if (!street) return 'No address';
  const n = /^\d+$/.test(String(r.house_number || '').trim()) ? Number(r.house_number) : null;
  return n !== null ? `${street} · ${Math.floor(n / 100) * 100} block` : street;
};

// → { status, body }
export const findPeople = async (db, ws, q) => {
  const raw = String(q || '').trim().slice(0, 120);
  const words = wordsOf(raw);
  const letters = words.filter((w) => /[a-z]/.test(w)).join('').replace(/[^a-z]/g, '').length;
  const single = raw.replace(/[\s-]/g, '');
  const vn = /\d/.test(single) && single.length >= 4 && /^[a-z0-9]+$/i.test(single) ? voterNumber(single) : null;
  if (vn) {
    const rows = (await db.query(
      `select id, name, address, house_number from persons where workspace_id = $1 and voter_number = $2 and deleted_at is null limit 2`,
      [ws, vn],
    )).rows;
    if (rows.length || letters < 3) return { status: 200, body: { people: rows.slice(0, ROWS).map((r) => ({ id: r.id, name: r.name, where: whereOf(r) })), more: false } };
  }
  if (letters < 3) return { status: 400, body: { error: TOO_SHORT } };
  // The leading name word: the one the name indexes narrow most ("harjit"
  // before "singh" in a city of Singhs), each counted up to 2,000 on
  // persons_ws_name_fold_idx / persons_ws_last_fold_idx in one query.
  const named = [...new Set(words.filter((w) => /^[a-z]/.test(w) && w.length >= 2))].slice(0, 4);
  if (!named.length) return { status: 400, body: { error: TOO_SHORT } };
  let lead = named[0];
  if (named.length > 1) {
    const counts = (await db.query(
      `select ${named.map((_, i) => `(select count(*)::int from (select 1 from persons p where p.workspace_id = $1 and p.deleted_at is null
          and (person_fold(p.name) like $${i + 2} or person_fold(p.last_name) like $${i + 2}) limit ${LEAD_CAP}) x) as c${i}`).join(', ')}`,
      [ws, ...named.map((w) => `${escLike(w)}%`)],
    )).rows[0];
    // A word no name starts with ("ave") is the address's, never the lead.
    const n = (w) => counts[`c${named.indexOf(w)}`] || Infinity;
    lead = named.reduce((best, w) => (n(w) < n(best) ? w : best), named[0]);
  }
  const rest = words.filter((w, i) => i !== words.indexOf(lead));
  const params = [ws, `${escLike(lead)}%`];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  const conds = [];
  for (const w of rest) {
    if (/^\d+$/.test(w)) {
      const n = Number(w);
      const block = w.length >= 3 && w.endsWith('00')
        ? `(p.house_number ~ '^[0-9]+$' and length(p.house_number) < 9 and p.house_number::int between ${add(n)} and ${add(n + 99)})`
        : `p.house_number like ${add(`${escLike(w)}%`)}`;
      conds.push(`(${block} or lower(coalesce(p.address, '')) ~ ${add(`(^|[^0-9])${w}([^0-9]|$)`)})`);
    } else {
      const like = add(`%${escLike(w)}%`);
      conds.push(`(person_fold(p.name) like ${like} or lower(coalesce(p.address, '')) like ${like})`);
    }
  }
  const full = add(words.filter((w) => /^[a-z]/.test(w)).join(' '));
  const rows = (await db.query(
    `select p.id, p.name, p.address, p.house_number from persons p
      where p.workspace_id = $1 and p.deleted_at is null
        and (person_fold(p.name) like $2 or person_fold(p.last_name) like $2)
        ${conds.map((c) => `and ${c}`).join(' ')}
      order by (person_fold(p.name) = ${full}) desc, person_fold(p.name), p.id
      limit ${ROWS + 1}`,
    params,
  )).rows;
  return { status: 200, body: { people: rows.slice(0, ROWS).map((r) => ({ id: r.id, name: r.name, where: whereOf(r) })), more: rows.length > ROWS } };
};
