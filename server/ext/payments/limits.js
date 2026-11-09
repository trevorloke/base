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
import { capFor, donorYearTotal } from '../../lib/cap.js';
import { campaignDay } from '../../lib/gifts.js';
import { DEFAULT_TZ } from '../../lib/org.js';
import { DEFAULT_SLATE, slateLabel } from '@starbase/shared/canvass';

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
