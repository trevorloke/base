// What a person may still give this year on a slate — the contribution limit
// as the desk's gift logging counts it (lib/cap.js: every gift that isn't
// void, dated this calendar year, on that slate), plus what their monthly
// gifts already running will still take this year. Asked before a checkout
// opens (a gift that would go over is refused there), and again when the
// payment lands (lib/cap.js alone: money that arrived is what counts).
//
// A new monthly gift counts each payment left this year (this month's
// included) and must also fit, beside the monthly gifts already running, in
// a whole year on its own — so January's renewals don't go over either.
// Open checkouts nobody paid aren't counted: a second tab, or a stranger
// typing someone's email, can't lock a donor out (the webhook refunds
// anything that turns out over).
//
// Money lands only on the same email's record or someone new's, so one
// donor can be two records (another email, or a cheque at the desk on
// their voter record). Whenever a gift is logged under the limit — a
// payment landing, or a cheque at the desk after it — the records that may
// be the same donor are added in (overTogether): over together, the gift
// is flagged for the treasurer, never refunded — the other record may be
// someone else, and the desk can say so (Not the same).
import { capFor, donorYearTotal } from '../../lib/cap.js';
import { campaignDay } from '../../lib/gifts.js';
import { DEFAULT_TZ } from '../../lib/org.js';
import { DEFAULT_SLATE, slateLabel } from '@starbase/shared/canvass';
import { sameText, samePhone, samePostal, sharesOf, listed, sharedWords } from '../duplicates/same.js';

export const money = (cents) => `$${(Number(cents || 0) / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const tzOf = (ws) => ws?.settings?.tz || DEFAULT_TZ;

// The campaign's day, year and month (0 = January) at `now`.
export const campaignNow = (ws, now = new Date()) => {
  const day = campaignDay(now, tzOf(ws));
  return { day, year: Number(day.slice(0, 4)), monthIndex: Number(day.slice(5, 7)) - 1 };
};

// The most a monthly gift can be: a twelfth of the year's limit in whole
// dollars, so a year of it stays under ($1,429.70 → $119), as the
// membership form's Star Club works it out.
export const monthlyMax = (capCents) => (capCents == null ? null : Math.floor(capCents / 12 / 100) * 100);

export const roomFor = async (q, ws, personId, slate = DEFAULT_SLATE, { now = new Date() } = {}) => {
  const { day, year, monthIndex } = campaignNow(ws, now);
  const rule = await capFor(q, ws.jurisdiction, year, ws.settings || {});
  const givenCents = await donorYearTotal(q, ws.id, personId, year, slate);
  // Monthly gifts running on this slate (pledged on a form, or online).
  const pledges = (await q.query(
    `select amount_cents, starts_on from gift_pledges
      where workspace_id = $1 and person_id = $2 and stopped_at is null and coalesce(slate, $3) = $4`,
    [ws.id, personId, DEFAULT_SLATE, slate || DEFAULT_SLATE],
  )).rows;
  let committedCents = 0;
  let monthlyActiveCents = 0;
  if (pledges.length) {
    // This month's payment counts until it has come in.
    const month = day.slice(0, 7);
    const paidThisMonth = (await q.query(
      `select 1 from gifts where workspace_id = $1 and person_id = $2 and deleted_at is null and cadence = 'monthly'
         and coalesce(slate, $3) = $4 and to_char(date, 'YYYY-MM') = $5 limit 1`,
      [ws.id, personId, DEFAULT_SLATE, slate || DEFAULT_SLATE, month],
    )).rows.length > 0;
    for (const p of pledges) {
      const start = p.starts_on instanceof Date ? p.starts_on.toISOString().slice(0, 7) : String(p.starts_on).slice(0, 7);
      const firstMonth = start > month ? Number(start.slice(5, 7)) - 1 : monthIndex;
      const left = start.slice(0, 4) > String(year) ? 0 : Math.max(0, 12 - firstMonth - (start <= month && paidThisMonth ? 1 : 0));
      committedCents += Number(p.amount_cents) * left;
      monthlyActiveCents += Number(p.amount_cents);
    }
  }
  const capCents = rule ? Number(rule.capCents) : null;
  return {
    year, monthIndex, slate: slate || DEFAULT_SLATE,
    capCents, source: rule?.source || null,
    givenCents, committedCents, monthlyActiveCents,
    roomCents: capCents == null ? null : Math.max(0, capCents - givenCents - committedCents),
  };
};

// Would this gift fit? { ok } — and, when it wouldn't, the words a public
// form shows: the limit (public), never what this person has given.
export const fits = (room, { cadence, amountCents }) => {
  if (room.capCents == null) return { ok: true, unchecked: true };
  const left = 12 - room.monthIndex;
  const thisYear = cadence === 'monthly' ? amountCents * left : amountCents;
  const fullYear = cadence === 'monthly' ? (amountCents + room.monthlyActiveCents) * 12 : 0;
  if (thisYear <= room.roomCents && fullYear <= room.capCents) return { ok: true };
  const where = `the ${slateLabel(room.slate).toLowerCase()} slate`;
  return {
    ok: false,
    message: cadence === 'monthly'
      ? `A monthly gift of ${money(amountCents)} would take you over this year’s ${money(room.capCents)} limit for contributions to ${where}. Try a smaller monthly amount, or give once.`
      : `That would take you over this year’s ${money(room.capCents)} limit for contributions to ${where}. Try a smaller amount.`,
  };
};

// When a payment lands: would logging it take the donor over? The desk's
// own rule (lib/gifts.js flagIfOver: the year's total with this gift in it,
// over the limit), asked before the gift is written.
export const overWhenLanding = async (q, ws, personId, { date, slate, amountCents }) => {
  const year = Number(String(date).slice(0, 4));
  const rule = await capFor(q, ws.jurisdiction, year, ws.settings || {});
  if (!rule) return { over: false, checked: false };
  const totalCents = (await donorYearTotal(q, ws.id, personId, year, slate || DEFAULT_SLATE)) + Number(amountCents);
  return { over: totalCents > Number(rule.capCents), checked: true, year, totalCents, capCents: Number(rule.capCents), source: rule.source };
};

// The other live records that may be this donor: the same first and last
// name, and the same whole postal code, phone or street address — compared
// as ext/duplicates compares records — never a pair the desk has said are
// two people (Duplicates: Not the same). Each with what it gave this year
// on the slate (given_cents; only those that gave) and what it shares
// (by_phone, by_address, by_postal). Read through persons_same_donor_idx
// (sql.js), so a city's whole voter file answers at once.
export const likelySameDonors = async (q, ws, personId, { year, slate }) => (await q.query(
  `with d as (
     select ${sameText('first_name')} as fn, ${sameText('last_name')} as ln, ${samePostal('postal')} as pc,
            ${samePhone('phone')} as ph, ${sameText('address')} as ad
       from persons where id = $2 and workspace_id = $1
   ), p as (
     select p.id, p.name, p.created_at,
            length(d.ph) >= 7 and ${samePhone('p.phone')} = d.ph as by_phone,
            d.ad <> '' and ${sameText('p.address')} = d.ad as by_address,
            length(d.pc) >= 6 and ${samePostal('p.postal')} = d.pc as by_postal
       from d join persons p
         on p.workspace_id = $1 and p.deleted_at is null and p.id <> $2 and p.kind = 'person'
        and ${sameText('p.last_name')} = d.ln and ${sameText('p.first_name')} = d.fn
      where d.fn <> '' and d.ln <> ''
        and not exists (select 1 from person_not_dupes n
                         where n.workspace_id = $1 and n.a = least(p.id, $2::uuid) and n.b = greatest(p.id, $2::uuid))
   )
   select * from (
     select p.id, p.name, p.by_phone, p.by_address, p.by_postal,
            (select coalesce(sum(g.amount_cents), 0) from gifts g
              where g.workspace_id = $1 and g.person_id = p.id and g.deleted_at is null and coalesce(g.slate, $4) = $5
                and g.date >= make_date($3, 1, 1) and g.date < make_date($3 + 1, 1, 1))::bigint as given_cents
       from p where p.by_phone or p.by_address or p.by_postal
      order by p.created_at
   ) x where given_cents > 0`,
  [ws.id, personId, year, DEFAULT_SLATE, slate || DEFAULT_SLATE],
)).rows;

// The pairs among these records the desk said are two people (Duplicates:
// Not the same), each both ways round: "a|b" and "b|a".
const ruledApart = async (q, wsId, ids) => {
  const pairs = new Set();
  if (ids.length < 2) return pairs;
  const rows = (await q.query(
    'select a, b from person_not_dupes where workspace_id = $1 and a = any($2::uuid[]) and b = any($2::uuid[])',
    [wsId, ids],
  )).rows;
  for (const { a, b } of rows) pairs.add(`${a}|${b}`).add(`${b}|${a}`);
  return pairs;
};

// Past this many records ruled apart from another, the sets aren't all
// tried (2^12 = 4,096 is plenty: few records share a donor's name and
// phone, address or postal code, and fewer still were ruled apart).
const MOST_TRIED = 12;

// The records the donor may be all at once, out of those that may be them
// ([{ id, given_cents }], in order): never two the desk ruled apart (apart:
// ruledApart's pairs) — the donor is at most one of each such pair — and,
// of the sets that are left, the one that gave the most. A ruling says
// nothing about a third record (X ≠ Y and Y ≠ Z leave X and Z), so the
// sets are tried, not grouped. Past MOST_TRIED, the largest givers first,
// each beside none it was ruled apart from: still never two of a pair.
export const mostTogether = (others, apart) => {
  if (!apart.size) return others;
  const clash = (a, b) => apart.has(`${a.id}|${b.id}`);
  const ruled = others.filter((o) => others.some((x) => clash(o, x)));
  const cents = (set) => set.reduce((n, o) => n + Number(o.given_cents), 0);
  const fits = (set, o) => !set.some((x) => clash(o, x));
  let best = [];
  if (ruled.length <= MOST_TRIED) {
    for (let mask = 1; mask < 2 ** ruled.length; mask += 1) {
      const set = ruled.filter((_, i) => Math.floor(mask / 2 ** i) % 2 === 1);
      if (set.every((o, i) => fits(set.slice(i + 1), o)) && cents(set) > cents(best)) best = set;
    }
  } else {
    for (const o of [...ruled].sort((a, b) => Number(b.given_cents) - Number(a.given_cents))) if (fits(best, o)) best.push(o);
  }
  return others.filter((o) => !ruled.includes(o) || best.includes(o));
};

// A gift under the limit for its own donor (check: lib/cap.js checkCap's,
// this gift in it), with what the records that may be the same donor gave
// (the most they can be together: mostTogether): over together? →
// { reason, ids } — the reason its gift is flagged and the records it
// names — or null. It says the two together in the words of lib/gifts.js
// flagIfOver, so the desk reads the numbers out of it the same way (Money:
// parseOver).
export const overTogether = async (q, ws, personId, check, slate) => {
  const found = await likelySameDonors(q, ws, personId, { year: check.year, slate });
  const others = mostTogether(found, await ruledApart(q, ws.id, found.map((o) => o.id)));
  const totalCents = others.reduce((n, o) => n + Number(o.given_cents), Number(check.totalCents));
  if (!others.length || totalCents <= Number(check.capCents)) return null;
  const who = listed(others.map((o) => `${o.name} (same ${sharedWords(o)})`));
  return {
    reason: `Possibly the same donor as ${who}: together they are at ${money(totalCents)} for ${check.year} — over the ${money(check.capCents)} limit on the ${slateLabel(slate).toLowerCase()} slate (${check.source})`,
    ids: others.map((o) => o.id),
  };
};

// The records each maybe names (the gift keeps their ids, attrs.
// maybe_same_donor), as the desk needs them to rule one out (Donations:
// Not the same person): each one's name, what it shares with the gift's
// donor ("phone", "address and postal code"), what it gave that year on
// that slate, and when it was added — read with the gift, as things stand,
// so a maybe flagged before has them too. → Map: gift id → [{ id, name,
// shares, given_cents, created_at }], in the order the flag names them.
export const maybesNamed = async (q, wsId, giftIds) => {
  const named = new Map();
  if (!giftIds.length) return named;
  const rows = (await q.query(
    `select g.id as gift_id, o.id, o.name, o.created_at, ${sharesOf('d', 'o')},
            (select coalesce(sum(x.amount_cents), 0) from gifts x
              where x.workspace_id = g.workspace_id and x.person_id = o.id and x.deleted_at is null
                and coalesce(x.slate, $3) = coalesce(g.slate, $3)
                and x.date >= make_date(extract(year from g.date)::int, 1, 1)
                and x.date < make_date(extract(year from g.date)::int + 1, 1, 1))::bigint as given_cents
       from gifts g
       join persons d on d.id = g.person_id and d.workspace_id = g.workspace_id
       cross join lateral jsonb_array_elements_text(g.attrs->'maybe_same_donor') with ordinality m(other, n)
       join persons o on o.id = m.other::uuid and o.workspace_id = g.workspace_id
      where g.workspace_id = $1 and g.id = any($2::uuid[]) and jsonb_typeof(g.attrs->'maybe_same_donor') = 'array'
      order by g.id, m.n`,
    [wsId, giftIds, DEFAULT_SLATE],
  )).rows;
  for (const r of rows) {
    if (!named.has(r.gift_id)) named.set(r.gift_id, []);
    named.get(r.gift_id).push({ id: r.id, name: r.name, shares: sharedWords(r), given_cents: Number(r.given_cents), created_at: r.created_at });
  }
  return named;
};

// lib/hooks.js underLimit: every gift whose donor is under the limit on
// their own record — logged at the desk (a gift, or dues on the membership
// form), a payment landing, a restore — is added up with the records that
// may be the same donor. Over together, it is flagged naming them: never
// refused or refunded.
export const underLimit = async (tx, ws, { personId, slate, cap }, out) => {
  const r = await overTogether(tx, ws, personId, cap, slate);
  if (r) Object.assign(out, { flagReason: r.reason, sameAs: r.ids });
};
