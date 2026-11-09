// Over the limit when it landed: give the money back, then tell the donor.
//
// The webhook decides (apply.js: no gift, the payment kept as over_limit)
// and queues this job in the same transaction; it runs after the commit
// (and again with backoff if Stripe doesn't answer). Each step is its own
// write through runAction, and each is safe to repeat:
//   1. refund   first ask Stripe what has already gone back on the payment
//               (a refund of ours that went through unrecorded, or one made
//               from the dashboard) — then refund only what's left, with an
//               idempotency key naming the payment and the amount, so a
//               retry is never a second refund
//   2. record   status refunded (or refund_failed, when Stripe says no for
//               good or the tries run out: the treasurer sees it)
//   3. email    the donor, plainly, once (an idempotency key again) — no
//               amounts about their own giving, only this payment's
import { runAction } from '../../lib/events.js';
import { emailConfigured, sendEmail } from '../../lib/notify.js';
import { stripeRequest, StripeError, idOf } from './stripe.js';
import { money } from './limits.js';

const MAX_TRIES = 5; // lib/jobs.js gives a job five attempts

const act = (db, wsId, action, fn) => runAction(db, { workspaceId: wsId, actorId: null, action }, fn);
const load = async (q, wsId, id) => (await q.query('select * from stripe_payments where id = $1 and workspace_id = $2', [id, wsId])).rows[0] || null;
const lock = async (tx, wsId, id) => (await tx.query('select * from stripe_payments where id = $1 and workspace_id = $2 for update', [id, wsId])).rows[0] || null;

// The payment intent of a monthly payment recorded before it was known.
const intentOf = async (p) => {
  if (p.payment_intent) return p.payment_intent;
  if (!p.invoice_id) return null;
  try {
    const list = await stripeRequest('GET', '/invoice_payments', { query: { invoice: p.invoice_id, limit: 10 } });
    const paid = (list?.data || []).find((x) => x?.status === 'paid') || list?.data?.[0];
    const pi = idOf(paid?.payment?.payment_intent);
    if (pi) return pi;
  } catch (e) {
    if (!(e instanceof StripeError && e.httpStatus === 404)) throw e;
  }
  const inv = await stripeRequest('GET', `/invoices/${encodeURIComponent(p.invoice_id)}`).catch(() => null);
  return idOf(inv?.payment_intent);
};

// Give back whatever of the payment hasn't gone back yet. → { id, total, pi }
export const refundWhole = async (p) => {
  const pi = await intentOf(p);
  if (!pi && !p.charge_id) throw new StripeError('Stripe gave no payment to refund against', { status: 400 });
  const on = pi ? { payment_intent: pi } : { charge: p.charge_id };
  const listed = await stripeRequest('GET', '/refunds', { query: { ...on, limit: 100 } });
  const counted = (listed?.data || []).filter((r) => r && r.status !== 'failed' && r.status !== 'canceled');
  const already = counted.reduce((n, r) => n + Number(r.amount || 0), 0);
  const amount = Number(p.amount_cents) - already;
  if (amount <= 0) return { id: counted[0]?.id || null, total: already, pi };
  const refund = await stripeRequest('POST', '/refunds', {
    idempotencyKey: `base-over-limit-${p.id}-${amount}`,
    params: { ...on, amount, reason: 'requested_by_customer', metadata: { base_payment: p.id, why: 'over_contribution_limit' } },
  });
  return { id: refund?.id || null, total: already + Number(refund?.amount ?? amount), pi };
};

const longDay = (d) => {
  const day = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-CA', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
};

// The email, in plain words.
export const overLimitEmail = ({ campaign, firstName, amountCents, paidOn, kind, cadence }) => {
  const hi = firstName ? `Hi ${firstName},` : 'Hello,';
  const amount = money(amountCents);
  if (kind === 'membership') {
    return {
      subject: `About your ${campaign} membership`,
      text: [
        hi, '',
        `Thank you for joining ${campaign}.`, '',
        `Membership dues count as political contributions under BC law, and this year’s contribution limit means we can’t accept them from you this calendar year. We’ve refunded the full ${amount} to your card, so your membership hasn’t started. The refund can take 5 to 10 business days to show up.`, '',
        'Reply to this email and we’ll sort out your membership.', '',
        `— ${campaign}`,
      ].join('\n'),
    };
  }
  const what = cadence === 'monthly' ? `This month’s ${amount} from your monthly gift` : `Your gift of ${amount} on ${longDay(paidOn)}`;
  return {
    subject: `Your gift to ${campaign} was refunded`,
    text: [
      hi, '',
      `Thank you for giving to ${campaign}.`, '',
      `BC law limits how much one person can give in a year. ${what} would have taken you over this year’s limit, so we couldn’t accept it, and we’ve refunded the full ${amount} to your card. The refund can take 5 to 10 business days to show up.`, '',
      ...(cadence === 'monthly' ? ['If you’d like to change or stop your monthly gift, reply to this email.', ''] : ['If you have any questions, reply to this email.', '']),
      `— ${campaign}`,
    ].join('\n'),
  };
};

const emailDonor = async (db, wsId, p, { last }) => {
  const who = (await db.query('select name, first_name, email from persons where id = $1 and workspace_id = $2', [p.person_id, wsId])).rows[0];
  const to = String(who?.email || p.email || '').trim();
  let res;
  if (!to) res = { status: 'none', detail: 'no email on file' };
  else if (!emailConfigured()) res = { status: 'none', detail: 'email isn’t connected' };
  else {
    const campaign = (await db.query('select name from workspaces where id = $1', [wsId])).rows[0]?.name || 'The campaign';
    const firstName = String(who?.first_name || '').trim() || String(who?.name || '').trim().split(/\s+/)[0] || '';
    res = await sendEmail({ to, ...overLimitEmail({ campaign, firstName, amountCents: p.amount_cents, paidOn: p.paid_on, kind: p.kind, cadence: p.cadence }), idempotencyKey: `base-over-limit-email-${p.id}` });
  }
  // A refusal the provider may get over: tried again with the job.
  if (res.status === 'failed' && !last) throw new Error(res.detail || 'email failed');
  await act(db, wsId, 'stripe.refund', async (tx, emit) => {
    const r = await lock(tx, wsId, p.id);
    if (!r || r.donor_emailed_at) return;
    const sent = res.status === 'sent';
    await tx.query(
      `update stripe_payments set donor_emailed_at = case when $3 then now() else donor_emailed_at end, donor_email_note = $4, updated_at = now()
       where id = $1 and workspace_id = $2`,
      [p.id, wsId, sent, sent ? null : String(res.detail || res.status).slice(0, 300)],
    );
    emit('payment', p.id, 'update', { donor_emailed: sent, ...(sent ? {} : { email_note: res.detail || res.status }) });
  });
};

export const settleOverLimit = async (db, wsId, paymentId, { last = false } = {}) => {
  let p = await load(db, wsId, paymentId);
  if (!p) return { skipped: 'gone' };
  if (p.status === 'over_limit') {
    let done;
    try {
      done = await refundWhole(p);
    } catch (e) {
      // 4xx (bar a rate limit): Stripe says no for good — a disputed charge,
      // say. Otherwise it's tried again until the tries run out.
      const final = last || (e instanceof StripeError && e.httpStatus >= 400 && e.httpStatus < 500 && e.httpStatus !== 429);
      const why = String(e.message || e).slice(0, 300);
      await act(db, wsId, 'stripe.refund', async (tx, emit) => {
        const r = await lock(tx, wsId, p.id);
        if (!r || r.status !== 'over_limit') return;
        await tx.query(
          `update stripe_payments set refund_error = $3, status = case when $4 then 'refund_failed' else status end, updated_at = now()
           where id = $1 and workspace_id = $2`,
          [p.id, wsId, why, final],
        );
        emit('payment', p.id, 'update', { refund_error: why, ...(final ? { status: 'refund_failed' } : {}) });
      });
      if (!final) throw e;
      return { failed: why };
    }
    await act(db, wsId, 'stripe.refund', async (tx, emit) => {
      const r = await lock(tx, wsId, p.id);
      if (!r || r.status !== 'over_limit') return;
      const total = Math.min(Number(done.total), Number(r.amount_cents));
      await tx.query(
        `update stripe_payments set status = 'refunded', refunded_cents = $3, refund_id = coalesce($4, refund_id), refund_error = null,
           payment_intent = coalesce(payment_intent, $5), updated_at = now()
         where id = $1 and workspace_id = $2`,
        [p.id, wsId, total, done.id, done.pi || null],
      );
      emit('payment', p.id, 'update', { status: 'refunded', refunded_cents: total, reason: 'over this year’s contribution limit' });
    });
    p = await load(db, wsId, paymentId);
  }
  if (p.over_limit && p.status === 'refunded' && !p.donor_emailed_at && !p.donor_email_note) await emailDonor(db, wsId, p, { last });
  return { status: p.status };
};

export const runRefundJob = async (db, job) => {
  const id = job.payload?.payment_id;
  if (!id) return;
  await settleOverLimit(db, job.workspace_id, id, { last: Number(job.attempts) >= MAX_TRIES });
};
