// Donations' online side (signed in; under /api). Money roles only, and
// volunteers are refused before a handler runs (deskOnlyReads).
//
//   GET /payments  {
//     stripe:  { ready, mode: 'live' | 'test' | null },
//     needs:   [what a treasurer must see: refunding or refunded over the
//               limit, a refund that didn't go through, a dispute (lost for
//               part of it: what's still to log, or to return by hand), a
//               refund made in Stripe — each with a plain line, and can_ack
//               when "Got it" is all it needs],
//     recent:  [the latest online payments and how each stands],
//     gifts:   { [gift_id]: { status, word } }  — the ledger's chips,
//     monthly: [every monthly gift running — online or pledged on a form —
//               the donor, the amount, since when, the last month in],
//     monthly_cents }
import { Hono } from 'hono';
import { DEFAULT_SLATE } from '@starbase/shared/canvass';
import { paymentsReady, stripeMode } from './stripe.js';
import { money, tzOf } from './limits.js';

export const MONEY_ROLES = ['manager', 'treasurer', 'staff'];
const RECENT = 100;

export const api = new Hono();

const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : d ? String(d).slice(0, 10) : null);
const shortDay = (d) => {
  const day = iso(d);
  return day ? new Date(`${day}T00:00:00Z`).toLocaleDateString('en-CA', { timeZone: 'UTC', month: 'short', day: 'numeric' }) : '';
};

const WORD = {
  paid: 'Paid',
  over_limit: 'Refunding',
  refunded: 'Refunded',
  partly_refunded: 'Partly refunded',
  refund_failed: 'Refund failed',
  disputed: 'Disputed',
  dispute_lost: 'Dispute lost',
  no_donor: 'No donor',
};
export const wordOf = (r) => (r.status === 'refunded' && r.over_limit ? 'Returned — over the limit' : r.status === 'over_limit' ? 'Over the limit — refunding' : WORD[r.status] || r.status);

// What the treasurer is told, and whether "Got it" is all it needs. Never
// the donor's own giving: the payment's amount and what happened to it —
// and never "the gift" of a payment that has none (over the limit, or its
// donor's record deleted).
const NO_DONOR_GIFT = 'No gift was logged online for it (the donor’s record was deleted).';

// A lost dispute: what the bank took back (all of it on a row from before
// dispute_cents was kept), what was refunded, and what the campaign kept.
const afterLoss = (r) => {
  const amount = Number(r.amount_cents);
  const back = r.dispute_cents == null ? amount : Number(r.dispute_cents);
  const refunded = Number(r.refunded_cents || 0);
  return { amount, back, refunded, kept: amount - refunded - back };
};

// Over the limit, a dispute lost for only part of it: the rest is still with
// the campaign, in front of the treasurer until they say Got it — however
// long that takes.
const STILL_HELD = `(sp.status = 'dispute_lost' and sp.over_limit and sp.acknowledged_at is null
  and sp.amount_cents - sp.refunded_cents - coalesce(sp.dispute_cents, sp.amount_cents) > 0)`;

const needOf = (r, tz) => {
  const amt = money(r.amount_cents);
  const acked = !!r.acknowledged_at;
  switch (r.status) {
    case 'over_limit':
      return { line: `Over this year’s limit when it came in, so no gift was logged — ${amt} is being refunded to their card.`, can_ack: false };
    case 'refund_failed':
      return { line: `Over this year’s limit, and the refund didn’t go through${r.refund_error ? ` (${r.refund_error})` : ''}. Refund ${amt} in Stripe.`, can_ack: false };
    case 'disputed': {
      const due = r.dispute_due_by ? new Date(r.dispute_due_by).toLocaleDateString('en-CA', { timeZone: tz, month: 'long', day: 'numeric' }) : null;
      const ask = `The card holder disputed this payment with their bank. Answer in Stripe${due ? ` by ${due}` : ''}`;
      if (r.over_limit) return { line: `${ask}. It was over this year’s limit, so no gift was logged. If the dispute is won, it’s refunded to their card.`, can_ack: false };
      if (!r.gift_id) return { line: `${ask}. ${NO_DONOR_GIFT}`, can_ack: false };
      return { line: `${ask} — the gift counts until it’s settled.`, can_ack: false };
    }
    case 'refunded': {
      if (acked) return null;
      if (r.over_limit) {
        const told = r.donor_emailed_at ? 'They were emailed.' : r.donor_email_note ? `Not emailed (${r.donor_email_note}) — let them know.` : 'They’re being emailed.';
        return { line: `Over this year’s limit when it came in — refunded in full; no gift was logged. ${told}`, can_ack: true };
      }
      const voidNotice = r.receipt_emailed && !r.void_sent_at ? ` Receipt ${r.receipt_number} was already emailed — send a void notice from Receipts.` : '';
      return { line: `Refunded in Stripe — the gift is void.${voidNotice}`, can_ack: true };
    }
    case 'partly_refunded':
      if (acked) return null;
      return { line: `${money(r.refunded_cents)} of ${amt} was refunded in Stripe. The gift still says ${amt}: void it and log ${money(Number(r.amount_cents) - Number(r.refunded_cents))}.`, can_ack: true };
    case 'dispute_lost': {
      if (acked) return null;
      const { amount, back, refunded, kept } = afterLoss(r);
      const lost = back < amount
        ? `The bank gave ${money(back)} of ${amt} back to the card holder (dispute lost)${refunded > 0 ? `, and ${money(refunded)} was refunded in Stripe` : ''}`
        : 'The bank gave the money back to the card holder (dispute lost)';
      if (kept > 0) {
        if (r.over_limit) return { line: `${lost}. The other ${money(kept)} was over this year’s limit and is still with the campaign. Stripe won’t refund a payment with a lost dispute: return it to the donor by hand, then Got it.`, can_ack: true };
        if (!r.gift_id) return { line: `${lost}. ${NO_DONOR_GIFT} Only ${money(kept)} of it was kept: log that by hand.`, can_ack: true };
        return { line: `${lost}. The gift still says ${amt}: void it and log ${money(kept)}.`, can_ack: true };
      }
      if (r.over_limit) return { line: `${lost}. It was over this year’s limit, so no gift was logged.`, can_ack: true };
      if (!r.gift_id) return { line: `${lost}. ${NO_DONOR_GIFT}`, can_ack: true };
      return { line: `${lost} — the gift is void.`, can_ack: true };
    }
    case 'no_donor':
      if (acked) return null;
      return { line: `Paid online, but the donor’s record was deleted — log the gift by hand${r.email ? ` (${r.email})` : ''}.`, can_ack: true };
    default:
      return null;
  }
};

const shape = (r, tz) => ({
  id: r.id,
  gift_id: r.gift_id || null,
  person_id: r.person_id || null,
  name: r.name || 'Donor',
  amount_cents: Number(r.amount_cents),
  refunded_cents: Number(r.refunded_cents || 0),
  paid_on: iso(r.paid_on),
  paid_day: shortDay(r.paid_on),
  kind: r.kind,
  cadence: r.cadence,
  slate: r.slate || DEFAULT_SLATE,
  status: r.status,
  word: wordOf(r),
  over_limit: !!r.over_limit,
  emailed: !!r.donor_emailed_at,
  test: r.mode === 'test',
  ...(needOf(r, tz) || {}),
});

const ROW = `sp.*, pe.name, co.mode, rc.number as receipt_number, rc.void_sent_at,
  (coalesce(rc.sent_count, 0) > 0 or rc.email_status in ('sent', 'sending')) as receipt_emailed`;
const FROM = `from stripe_payments sp
  left join persons pe on pe.id = sp.person_id
  left join stripe_checkouts co on co.id = sp.checkout_id
  left join receipts rc on rc.workspace_id = sp.workspace_id and rc.gift_id = sp.gift_id`;

api.get('/payments', async (c) => {
  const ctx = c.get('ctx');
  if (!MONEY_ROLES.includes(ctx.role)) return c.json({ error: 'the desk only' }, 403);
  const db = c.get('db');
  const ws = ctx.workspaceId;
  const tz = tzOf(ctx.workspace);
  const recent = (await db.query(
    `select ${ROW} ${FROM} where sp.workspace_id = $1 order by sp.paid_at desc, sp.created_at desc limit ${RECENT}`, [ws],
  )).rows;
  const open = (await db.query(
    `select ${ROW} ${FROM} where sp.workspace_id = $1
       and (sp.status in ('over_limit', 'refund_failed', 'disputed') or ${STILL_HELD}
         or (sp.status in ('refunded', 'partly_refunded', 'dispute_lost', 'no_donor') and sp.acknowledged_at is null
             and sp.updated_at > now() - interval '90 days'))
     order by sp.updated_at desc limit 50`, [ws],
  )).rows;
  const monthly = (await db.query(
    `select gp.id, gp.person_id, gp.amount_cents, gp.slate, gp.method, gp.starts_on, pe.name,
            co.id as checkout_id, co.mode,
            (select max(g.date) from gifts g where g.workspace_id = gp.workspace_id and g.person_id = gp.person_id
               and g.deleted_at is null and g.cadence = 'monthly' and coalesce(g.slate, $2) = coalesce(gp.slate, $2)) as last_gift_on
       from gift_pledges gp
       join persons pe on pe.id = gp.person_id and pe.deleted_at is null
       left join stripe_checkouts co on co.workspace_id = gp.workspace_id and co.pledge_id = gp.id
      where gp.workspace_id = $1 and gp.stopped_at is null
      order by gp.amount_cents desc, pe.name limit 200`, [ws, DEFAULT_SLATE],
  )).rows.map((p) => ({
    id: p.id, person_id: p.person_id, name: p.name, amount_cents: Number(p.amount_cents), slate: p.slate || DEFAULT_SLATE,
    method: p.method || null, online: !!p.checkout_id, test: p.mode === 'test',
    since: iso(p.starts_on), last_gift_on: iso(p.last_gift_on),
  }));
  const gifts = {};
  for (const r of recent) if (r.gift_id) gifts[r.gift_id] = { status: r.status, word: wordOf(r) };
  return c.json({
    stripe: { ready: paymentsReady(), mode: stripeMode() },
    needs: open.map((r) => shape(r, tz)).filter((r) => r.line),
    recent: recent.map((r) => shape(r, tz)),
    gifts,
    monthly,
    monthly_cents: monthly.reduce((n, p) => n + p.amount_cents, 0),
  });
});

export const deskOnlyReads = ['/payments'];

// Today's Needs you (the brief hook): a payment that landed over the limit
// rides with the gifts over the limit — the same words, "Over limit", and a
// tap to Donations, where Needs you says what happened — until it's
// refunded (a dispute on it doesn't take it off; one lost for only part of
// it leaves the rest for the treasurer to return) and a treasurer has said
// Got it. Desk roles only.
export const briefOverLimit = async (db, ctx, body) => {
  if (!MONEY_ROLES.includes(ctx.role) || !Array.isArray(body.flagged) || body.money == null) return;
  const rows = (await db.query(
    `select sp.id, sp.person_id, sp.gift_id, sp.amount_cents, sp.refunded_cents, sp.paid_on, sp.status, sp.over_limit, sp.refund_error,
            sp.donor_emailed_at, sp.donor_email_note, sp.acknowledged_at, sp.dispute_due_by, sp.dispute_cents, pe.name
       from stripe_payments sp left join persons pe on pe.id = sp.person_id
      where sp.workspace_id = $1 and sp.over_limit
        and (sp.status in ('over_limit', 'refund_failed', 'disputed') or ${STILL_HELD}
          or (sp.status = 'refunded' and sp.acknowledged_at is null and sp.updated_at > now() - interval '90 days'))
      order by sp.paid_at desc limit 10`, [ctx.workspaceId],
  )).rows;
  for (const r of rows) {
    body.flagged.push({
      id: r.id, payment_id: r.id, online: true, person_id: r.person_id, donor: r.name || 'Donor',
      amount_cents: Number(r.amount_cents), date: iso(r.paid_on), flag_reason: needOf(r, tzOf(ctx.workspace))?.line || null,
      total_cents: null, cap_cents: null,
    });
  }
};
