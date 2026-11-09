// What a Stripe event does to the books — database only, inside the
// webhook's runAction (under the campaign's lock, on the event log). Stripe
// is never called from here: the webhook gathers what it needs first, and a
// refund is a job run after the commit (refunds.js).
//
//   paidOnce        a checkout's one payment: the gift through the normal
//                   gift path (lib/gifts.js logGift: method card, the limit
//                   checked, the receipt issued by ext/receipts), or for
//                   membership dues the gift and the membership
//   subscribed      a monthly checkout started: the pledge it keeps
//   invoicePaid     one month of it: that month's gift
//   stopped         the subscription ended: the pledge stops
//   closed          a checkout expired, or its bank payment failed
//   refunded        a refund in Stripe (ours, or the dashboard's)
//   disputed        a dispute opened or closed
//
// When a payment lands, the desk's own rule decides first: if logging it
// would take the donor over this year's limit on its slate (gifts logged
// since the checkout opened), no gift is logged — the payment is kept as
// over_limit, its refund is queued, and the treasurer sees it under
// Donations → Needs you until they say Got it.
import { newId } from '../../lib/events.js';
import { logGift, voidGift, campaignDay } from '../../lib/gifts.js';
import { enqueueJob } from '../../lib/jobs.js';
import { DEFAULT_SLATE } from '@starbase/shared/canvass';
import { overWhenLanding, tzOf } from './limits.js';

export const REFUND_JOB = 'payments.refund';

const parseJson = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));
const iso = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const addYears = (day, n) => {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y + n, m - 1, d));
  if (t.getUTCMonth() !== m - 1) t.setUTCDate(0); // Feb 29 → Feb 28
  return t.toISOString().slice(0, 10);
};
const ageOn = (birth, day) => {
  const [by, bm, bd] = birth.split('-').map(Number);
  const [y, m, d] = day.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
};

export const loadWorkspace = async (tx, id) => {
  const ws = (await tx.query('select id, name, jurisdiction, settings from workspaces where id = $1', [id])).rows[0];
  return ws ? { ...ws, settings: parseJson(ws.settings, {}) } : null;
};

// The donor as they are now: a record merged into another (ext/duplicates)
// is followed to the one that was kept.
export const donorOf = async (tx, wsId, personId) => {
  let id = personId;
  for (let hops = 0; id && hops < 5; hops += 1) {
    const p = (await tx.query('select id, name, first_name, email, deleted_at, attrs from persons where id = $1 and workspace_id = $2', [id, wsId])).rows[0];
    if (!p) return null;
    if (!p.deleted_at) return p;
    id = parseJson(p.attrs, {})?.merged_into || null;
  }
  return null;
};

const lockCheckout = async (tx, wsId, id) => (await tx.query(
  'select * from stripe_checkouts where id = $1 and workspace_id = $2 for update', [id, wsId],
)).rows[0] || null;

const lockPayment = async (tx, wsId, id) => (await tx.query(
  'select * from stripe_payments where id = $1 and workspace_id = $2 for update', [id, wsId],
)).rows[0] || null;

// One payment row, as it landed.
const insertPayment = async (tx, ws, p) => {
  const id = newId();
  await tx.query(
    `insert into stripe_payments (id, workspace_id, checkout_id, person_id, gift_id, kind, cadence, slate, amount_cents, currency,
                                  paid_at, paid_on, session_id, invoice_id, subscription_id, payment_intent, charge_id, email, status, over_limit)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
    [id, ws.id, p.checkout_id, p.person_id, p.gift_id || null, p.kind, p.cadence, p.slate, p.amount_cents, p.currency || 'cad',
     p.paid_at, p.paid_on, p.session_id || null, p.invoice_id || null, p.subscription_id || null, p.payment_intent || null,
     p.charge_id || null, p.email || null, p.status, !!p.over_limit],
  );
  return id;
};

// The gift for a payment, through the one gift path. The declaration rides
// with it (the gift's event and its attrs), as does where it came from.
const giftFor = async (tx, emit, ws, { donor, co, paymentId, amount, date, cadence }) => {
  const declaration = parseJson(co.declaration, {});
  const note = co.kind === 'membership' ? 'Membership dues — paid online'
    : cadence === 'monthly' ? 'Paid online — monthly' : 'Paid online';
  const { gift } = await logGift(tx, ws, {
    person_id: donor.id, amount_cents: amount, date, method: 'card',
    cadence: cadence === 'monthly' ? 'monthly' : 'one-time', slate: co.slate || DEFAULT_SLATE, note,
    source: 'online', payment_id: paymentId, declaration,
  }, emit);
  await tx.query(
    `update gifts set attrs = coalesce(attrs, '{}'::jsonb) || $3::jsonb where id = $1 and workspace_id = $2`,
    [gift.id, ws.id, JSON.stringify({ source: 'online', payment_id: paymentId, declaration })],
  );
  return gift;
};

// Membership dues paid: the membership, as the membership form makes one —
// a renewal starts when the current term ends; youth when they were 14 to
// 30 the day they joined; citizen or permanent resident as declared — with
// source 'website', and the member tag.
const joinOnline = async (tx, emit, ws, { donor, co, day }) => {
  const current = (await tx.query(
    `select max(ends_on) as ends_on from member_terms where workspace_id = $1 and person_id = $2 and voided_at is null and ends_on >= $3`,
    [ws.id, donor.id, day],
  )).rows[0];
  const starts = current?.ends_on ? iso(current.ends_on) : day;
  const term = Number(co.term_years) === 4 ? 4 : 1;
  const birth = co.birth_date ? iso(co.birth_date) : null;
  const age = birth ? ageOn(birth, day) : null;
  const id = newId();
  const row = {
    id, person_id: donor.id, term_years: term, starts_on: starts, ends_on: addYears(starts, term),
    youth: age != null && age >= 14 && age <= 30, citizenship: co.citizenship || null, declaration_on: day, source: 'website',
  };
  await tx.query(
    `insert into member_terms (id, workspace_id, person_id, term_years, starts_on, ends_on, youth, citizenship, declaration_on, source)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'website')`,
    [id, ws.id, donor.id, term, row.starts_on, row.ends_on, row.youth, row.citizenship, day],
  );
  emit('membership', id, 'create', { ...row, ...(current?.ends_on ? { renewal: true } : {}) });
  const had = (await tx.query('select tags from persons where id = $1', [donor.id])).rows[0];
  const tags = parseJson(had?.tags, []);
  if (!tags.includes('member')) {
    const next = [...tags, 'member'];
    await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2', [donor.id, ws.id, JSON.stringify(next)]);
    emit('person', donor.id, 'update', { tags: next, source: 'membership dues paid online' });
  }
  await tx.query('update stripe_checkouts set membership_id = $2 where id = $1', [co.id, id]);
  return row;
};

// A payment landed for a checkout: decide, then write. Shared by a one-time
// payment and each month's invoice.
const land = async (tx, emit, ws, co, { amount, paidAt, cadence, refs }) => {
  const date = campaignDay(paidAt, tzOf(ws));
  const donor = await donorOf(tx, ws.id, co.person_id);
  const base = {
    checkout_id: co.id, person_id: donor?.id || co.person_id, kind: co.kind, cadence, slate: co.slate || DEFAULT_SLATE,
    amount_cents: amount, paid_at: paidAt.toISOString(), paid_on: date, ...refs,
  };
  const out = { paymentId: null, giftId: null, status: null, refund: false, membership: null };
  if (!donor) {
    out.paymentId = await insertPayment(tx, ws, { ...base, status: 'no_donor' });
    out.status = 'no_donor';
  } else {
    const check = await overWhenLanding(tx, ws, donor.id, { date, slate: base.slate, amountCents: amount });
    if (check.over) {
      out.paymentId = await insertPayment(tx, ws, { ...base, status: 'over_limit', over_limit: true });
      out.status = 'over_limit';
      out.refund = true;
      await enqueueJob(tx, { workspaceId: ws.id, kind: REFUND_JOB, payload: { payment_id: out.paymentId }, key: `${REFUND_JOB}:${out.paymentId}` });
    } else {
      out.paymentId = await insertPayment(tx, ws, { ...base, status: 'paid' });
      const gift = await giftFor(tx, emit, ws, { donor, co, paymentId: out.paymentId, amount, date, cadence });
      out.giftId = gift.id;
      await tx.query('update stripe_payments set gift_id = $2 where id = $1', [out.paymentId, gift.id]);
      if (co.kind === 'membership') out.membership = await joinOnline(tx, emit, ws, { donor, co, day: date });
      out.status = 'paid';
    }
  }
  emit('payment', out.paymentId, 'create', {
    checkout_id: co.id, person_id: base.person_id, gift_id: out.giftId, kind: co.kind, cadence, slate: base.slate,
    amount_cents: amount, paid_on: date, status: out.status,
    ...(out.status === 'over_limit' ? { reason: 'over this year’s contribution limit: refunding' } : {}),
    ...(out.membership ? { membership_id: out.membership.id } : {}),
    stripe: { session_id: refs.session_id || null, invoice_id: refs.invoice_id || null, payment_intent: refs.payment_intent || null },
  });
  return out;
};

// ── One-time: a gift once, or membership dues ──
export const paidOnce = async (tx, emit, ws, plan) => {
  const co = await lockCheckout(tx, ws.id, plan.checkoutId);
  if (!co) return { result: 'not a base.win checkout' };
  const had = (await tx.query('select id from stripe_payments where workspace_id = $1 and session_id = $2 and invoice_id is null', [ws.id, co.session_id || plan.sessionId])).rows[0];
  if (had || co.status === 'paid') return { result: 'already recorded' };
  // What Stripe collected (a coupon or a price change in Stripe can make it
  // differ from what was asked); only money received is recorded.
  const amount = plan.amount != null && Number.isFinite(Number(plan.amount)) ? Number(plan.amount) : Number(co.amount_cents);
  let out = { status: 'nothing collected' };
  if (amount > 0) {
    out = await land(tx, emit, ws, co, {
      amount, paidAt: plan.paidAt, cadence: 'once',
      refs: { session_id: co.session_id || plan.sessionId, payment_intent: plan.paymentIntent, email: plan.email },
    });
  }
  await tx.query(`update stripe_checkouts set status = 'paid', completed_at = now(), updated_at = now() where id = $1`, [co.id]);
  emit('payment_checkout', co.id, 'update', { status: 'paid' });
  return { result: out.status === 'paid' ? (co.kind === 'membership' ? 'membership and gift recorded' : 'gift recorded') : out.status, ...out };
};

// ── Monthly: the pledge it keeps (ext/membership's gift_pledges) ──
const ensurePledge = async (tx, emit, ws, co, { subscriptionId, customerId, day }) => {
  if (co.pledge_id) {
    if (subscriptionId && !co.subscription_id) {
      await tx.query('update stripe_checkouts set subscription_id = $2, updated_at = now() where id = $1', [co.id, subscriptionId]);
    }
    return co.pledge_id;
  }
  const donor = await donorOf(tx, ws.id, co.person_id);
  const pid = newId();
  if (donor) {
    await tx.query(
      `insert into gift_pledges (id, workspace_id, person_id, amount_cents, slate, method, starts_on)
       values ($1, $2, $3, $4, $5, 'card', $6)`,
      [pid, ws.id, donor.id, co.amount_cents, co.slate || DEFAULT_SLATE, day],
    );
    emit('gift_pledge', pid, 'create', {
      id: pid, person_id: donor.id, amount_cents: Number(co.amount_cents), slate: co.slate || DEFAULT_SLATE, method: 'card', starts_on: day, source: 'online',
    });
  }
  await tx.query(
    `update stripe_checkouts set pledge_id = $2, subscription_id = coalesce(subscription_id, $3), customer_id = coalesce(customer_id, $4),
       status = 'active', completed_at = coalesce(completed_at, now()), updated_at = now() where id = $1`,
    [co.id, donor ? pid : null, subscriptionId || null, customerId || null],
  );
  emit('payment_checkout', co.id, 'update', { status: 'active', subscription_id: subscriptionId || co.subscription_id || null, pledge_id: donor ? pid : null });
  return donor ? pid : null;
};

export const subscribed = async (tx, emit, ws, plan) => {
  const co = await lockCheckout(tx, ws.id, plan.checkoutId);
  if (!co) return { result: 'not a base.win checkout' };
  if (co.status === 'cancelled') return { result: 'already stopped' };
  const day = campaignDay(plan.at, tzOf(ws));
  const pledgeId = await ensurePledge(tx, emit, ws, co, { subscriptionId: plan.subscriptionId, customerId: plan.customerId, day });
  return { result: 'monthly gift started', pledgeId };
};

export const invoicePaid = async (tx, emit, ws, plan) => {
  const co = await lockCheckout(tx, ws.id, plan.checkoutId);
  if (!co) return { result: 'not a base.win checkout' };
  const had = (await tx.query('select id from stripe_payments where workspace_id = $1 and invoice_id = $2', [ws.id, plan.invoiceId])).rows[0];
  if (had) return { result: 'already recorded' };
  // The first invoice can come before the checkout's own event.
  if (co.status !== 'cancelled') {
    await ensurePledge(tx, emit, ws, co, { subscriptionId: plan.subscriptionId, customerId: plan.customerId, day: campaignDay(plan.paidAt, tzOf(ws)) });
  }
  const amount = Number(plan.amount);
  if (!(amount > 0)) return { result: 'nothing collected' };
  const out = await land(tx, emit, ws, co, {
    amount, paidAt: plan.paidAt, cadence: 'monthly',
    refs: { invoice_id: plan.invoiceId, subscription_id: plan.subscriptionId, payment_intent: plan.paymentIntent, charge_id: plan.charge, email: plan.email },
  });
  return { result: out.status === 'paid' ? 'month’s gift recorded' : out.status, ...out };
};

export const stopped = async (tx, emit, ws, plan) => {
  const co = await lockCheckout(tx, ws.id, plan.checkoutId);
  if (!co) return { result: 'not a base.win checkout' };
  if (co.pledge_id) {
    const r = (await tx.query(
      'update gift_pledges set stopped_at = $3 where id = $1 and workspace_id = $2 and stopped_at is null returning id',
      [co.pledge_id, ws.id, plan.at.toISOString()],
    )).rows[0];
    if (r) emit('gift_pledge', co.pledge_id, 'update', { stopped: true, source: 'stripe', why: plan.why });
  }
  if (co.status !== 'cancelled') {
    await tx.query(`update stripe_checkouts set status = 'cancelled', updated_at = now() where id = $1`, [co.id]);
    emit('payment_checkout', co.id, 'update', { status: 'cancelled', why: plan.why });
  }
  return { result: 'monthly gift stopped' };
};

export const closed = async (tx, emit, ws, plan) => {
  const r = (await tx.query(
    `update stripe_checkouts set status = $3, updated_at = now() where id = $1 and workspace_id = $2 and status = 'open' returning id`,
    [plan.checkoutId, ws.id, plan.status],
  )).rows[0];
  if (r) emit('payment_checkout', plan.checkoutId, 'update', { status: plan.status });
  return { result: r ? `checkout ${plan.status}` : 'nothing to change' };
};

// A refunded payment takes its gift — and membership — out of the books.
const unbook = async (tx, emit, ws, p) => {
  if (p.gift_id) {
    const live = (await tx.query('select 1 from gifts where id = $1 and workspace_id = $2 and deleted_at is null', [p.gift_id, ws.id])).rows[0];
    if (live) await voidGift(tx, ws.id, p.gift_id, emit);
  }
  const co = p.checkout_id ? (await tx.query('select membership_id from stripe_checkouts where id = $1', [p.checkout_id])).rows[0] : null;
  if (co?.membership_id && p.kind === 'membership') {
    const m = (await tx.query(
      'update member_terms set voided_at = now() where id = $1 and workspace_id = $2 and voided_at is null returning id',
      [co.membership_id, ws.id],
    )).rows[0];
    if (m) emit('membership', co.membership_id, 'void', { why: 'dues refunded' });
  }
};

// ── charge.refunded: what Stripe says has gone back on the payment ──
export const refunded = async (tx, emit, ws, plan) => {
  const p = await lockPayment(tx, ws.id, plan.paymentId);
  if (!p) return { result: 'not a base.win payment' };
  const total = Math.min(Number(plan.amountRefunded) || 0, Number(p.amount_cents));
  if (total <= Number(p.refunded_cents)) return { result: 'already recorded' };
  const full = total >= Number(p.amount_cents);
  let status = p.status;
  if (full) {
    if (p.status !== 'disputed') status = 'refunded';
    await unbook(tx, emit, ws, p);
  } else if (p.status === 'paid') {
    status = 'partly_refunded';
  }
  await tx.query(
    `update stripe_payments set refunded_cents = $3, status = $4, refund_id = coalesce(refund_id, $5),
       refund_error = case when $4 = 'refunded' then null else refund_error end, acknowledged_at = null, updated_at = now()
     where id = $1 and workspace_id = $2`,
    [p.id, ws.id, total, status, plan.refundId || null],
  );
  emit('payment', p.id, 'update', { status, refunded_cents: total, full, source: 'stripe' });
  // An over-limit refund: the donor still gets their email (refunds.js).
  if (full && p.over_limit && !p.donor_emailed_at) {
    await enqueueJob(tx, { workspaceId: ws.id, kind: REFUND_JOB, payload: { payment_id: p.id } });
  }
  return { result: full ? 'refunded: the gift is void' : 'partly refunded: flagged for the treasurer', refund: full && p.over_limit && !p.donor_emailed_at };
};

// ── charge.dispute.*: the card holder asked their bank for it back ──
export const disputed = async (tx, emit, ws, plan) => {
  const p = await lockPayment(tx, ws.id, plan.paymentId);
  if (!p) return { result: 'not a base.win payment' };
  const d = plan.dispute;
  if (plan.closed) {
    if (d.status === 'lost') {
      await unbook(tx, emit, ws, p);
      await tx.query(
        `update stripe_payments set status = 'dispute_lost', dispute_id = $3, acknowledged_at = null, updated_at = now() where id = $1 and workspace_id = $2`,
        [p.id, ws.id, d.id],
      );
      emit('payment', p.id, 'update', { status: 'dispute_lost', dispute: d.status });
      return { result: 'dispute lost: the gift is void' };
    }
    // Won (or a warning closed): the money stays and so does the gift.
    const back = Number(p.refunded_cents) > 0 ? 'partly_refunded' : 'paid';
    if (p.status === 'disputed') {
      await tx.query(`update stripe_payments set status = $3, updated_at = now() where id = $1 and workspace_id = $2`, [p.id, ws.id, back]);
      emit('payment', p.id, 'update', { status: back, dispute: d.status });
    }
    return { result: `dispute ${d.status}` };
  }
  if (['refunded', 'dispute_lost'].includes(p.status)) return { result: 'already settled' };
  await tx.query(
    `update stripe_payments set status = 'disputed', dispute_id = $3, dispute_reason = $4, dispute_due_by = $5, updated_at = now()
     where id = $1 and workspace_id = $2`,
    [p.id, ws.id, d.id, d.reason || null, d.dueBy ? d.dueBy.toISOString() : null],
  );
  emit('payment', p.id, 'update', { status: 'disputed', dispute_reason: d.reason || null });
  return { result: 'disputed: flagged for the treasurer' };
};
