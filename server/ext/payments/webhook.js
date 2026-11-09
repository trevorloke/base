// POST /stripe/webhook — Stripe telling base.win what happened. Public (no
// sign-in): every delivery must carry Stripe's signature over its exact
// bytes (stripe.js, constant-time, five minutes' tolerance), or it is
// refused with 400 and nothing is read. Answered on the app's own address
// and on the campaign's website hosts (SITE.md).
//
// Each event is done once: its id goes into stripe_events in the same
// transaction as what it did, so a delivery Stripe repeats — or two at once
// — changes nothing the second time, and a failure rolls both back for
// Stripe's retry (a 500 makes Stripe try again, for days).
//
// Three steps, so no transaction ever waits on Stripe:
//   1. prepare  find the campaign and the checkout or payment it's about
//               (our ids ride on the session, subscription and payment
//               intent as metadata), and read from Stripe what the event
//               left out (an older API version's invoice, its payment)
//   2. apply    one runAction on the campaign (apply.js): the gift, the
//               pledge, the membership, a refund or a dispute — on the
//               event log as the system
//   3. after    a refund it decided on starts now (refunds.js)
// Anything that isn't ours (another app on the same Stripe account) is
// answered 200 and left alone.
//
// Stripe sends events in no set order (a payment's event can still be being
// retried when its refund comes). A refund or dispute that names no payment
// of ours is looked up in Stripe: if it's ours, it is kept and done in the
// same write that records the payment (apply.js beforeItsPayment).
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { runAction } from '../../lib/events.js';
import { runJobsSoon } from '../../lib/jobs.js';
import {
  verifySignature, webhookSecrets, secretKey, stripeRequest, StripeError,
  idOf, eventTime, invoiceSubscription, invoicePaymentIntent, chargeRefs,
} from './stripe.js';
import { paidOnce, subscribed, invoicePaid, stopped, closed, refunded, disputed, beforeItsPayment, loadWorkspace } from './apply.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENDED = new Set(['canceled', 'unpaid', 'incomplete_expired']);

// Read an object (or a list) from Stripe; null when Stripe doesn't have it.
const retrieve = async (path, query) => {
  try {
    return await stripeRequest('GET', path, query ? { query } : {});
  } catch (e) {
    if (e instanceof StripeError && e.httpStatus === 404) return null;
    throw e;
  }
};

// Our checkout, by the id on the metadata, the session, or the subscription.
const CHECKOUT = 'select id, workspace_id, session_id, subscription_id, cadence from stripe_checkouts';
const checkoutBy = async (db, { id, sessionId, subscriptionId }) => {
  if (id && UUID.test(id)) {
    const r = (await db.query(`${CHECKOUT} where id = $1`, [id])).rows[0];
    if (r) return r;
  }
  if (sessionId) {
    const r = (await db.query(`${CHECKOUT} where session_id = $1`, [sessionId])).rows[0];
    if (r) return r;
  }
  if (subscriptionId) {
    const r = (await db.query(`${CHECKOUT} where subscription_id = $1 order by created_at limit 1`, [subscriptionId])).rows[0];
    if (r) return r;
  }
  return null;
};

// Our checkout for an invoice (invoiceSubscription's reading of it): by the
// subscription's metadata copied onto it, or by the subscription itself.
const checkoutOfInvoice = async (db, ref) => {
  let co = await checkoutBy(db, { id: ref.metadata?.base_checkout, subscriptionId: ref.subscriptionId });
  if (!co && ref.subscriptionId && !ref.metadata?.base_checkout) {
    // No metadata on this shape: the subscription itself carries ours.
    const sub = await retrieve(`/subscriptions/${encodeURIComponent(ref.subscriptionId)}`);
    co = await checkoutBy(db, { id: sub?.metadata?.base_checkout });
  }
  return co;
};

// Our payment, by its payment intent or charge.
const paymentBy = async (db, { paymentIntent, charge }) => {
  if (paymentIntent) {
    const r = (await db.query('select id, workspace_id from stripe_payments where payment_intent = $1 order by created_at limit 1', [paymentIntent])).rows[0];
    if (r) return r;
  }
  if (charge) {
    const r = (await db.query('select id, workspace_id from stripe_payments where charge_id = $1 order by created_at limit 1', [charge])).rows[0];
    if (r) return r;
  }
  return null;
};

// Whose is a charge that no payment of ours names yet? Ours when our ids
// ride on its payment intent (checkoutFor puts them there; the charge may
// carry a copy) or, for a month of a monthly gift, on the subscription its
// invoice belongs to. → { co, invoiceId } | null (not ours)
const chargeOwner = async (db, obj, { paymentIntent }) => {
  const mine = await checkoutBy(db, { id: obj.metadata?.base_checkout });
  if (mine) return { co: mine, invoiceId: null };
  let invoiceId = idOf(obj.invoice); // older API versions name it on the charge
  if (!invoiceId) {
    if (!paymentIntent) return null; // no payment intent: not from a Checkout
    const pi = await retrieve(`/payment_intents/${encodeURIComponent(paymentIntent)}`);
    if (!pi) return null;
    const co = await checkoutBy(db, { id: pi.metadata?.base_checkout });
    if (co) return { co, invoiceId: null };
    invoiceId = idOf(pi.invoice);
    if (!invoiceId) {
      // Newer API versions: the invoice this payment paid.
      const list = await retrieve('/invoice_payments', { payment: { type: 'payment_intent', payment_intent: paymentIntent }, limit: 1 });
      invoiceId = idOf(list?.data?.[0]?.invoice);
    }
    if (!invoiceId) return null;
  }
  const invoice = await retrieve(`/invoices/${encodeURIComponent(invoiceId)}`);
  const co = invoice ? await checkoutOfInvoice(db, invoiceSubscription(invoice)) : null;
  return co ? { co, invoiceId } : null;
};

const ignored = (why) => ({ ignored: why });

// ── 1. Prepare ──
export const prepare = async (db, event) => {
  const obj = event?.data?.object || {};
  const at = eventTime(event);
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const co = await checkoutBy(db, { id: obj.metadata?.base_checkout || obj.client_reference_id, sessionId: obj.id });
      if (!co) return ignored('not a base.win checkout');
      if (obj.mode === 'subscription') {
        return { action: 'stripe.subscription', workspaceId: co.workspace_id, run: subscribed,
          plan: { checkoutId: co.id, subscriptionId: idOf(obj.subscription), customerId: idOf(obj.customer), at } };
      }
      // A bank payment that hasn't cleared yet: its success event comes later.
      if (obj.payment_status === 'unpaid') return { action: 'stripe.checkout', workspaceId: co.workspace_id, run: async () => ({ result: 'waiting for the payment to clear' }) };
      return { action: 'stripe.payment', workspaceId: co.workspace_id, run: paidOnce,
        plan: { checkoutId: co.id, sessionId: obj.id, amount: obj.amount_total, paymentIntent: idOf(obj.payment_intent), email: obj.customer_details?.email || null, paidAt: at } };
    }
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed': {
      const co = await checkoutBy(db, { id: obj.metadata?.base_checkout || obj.client_reference_id, sessionId: obj.id });
      if (!co) return ignored('not a base.win checkout');
      return { action: 'stripe.checkout', workspaceId: co.workspace_id, run: closed,
        plan: { checkoutId: co.id, status: event.type.endsWith('expired') ? 'expired' : 'failed' } };
    }
    case 'invoice.paid': {
      let invoice = obj;
      let ref = invoiceSubscription(invoice);
      if (!ref.known && invoice.id) {
        invoice = (await retrieve(`/invoices/${encodeURIComponent(invoice.id)}`)) || invoice;
        ref = invoiceSubscription(invoice);
      }
      const co = await checkoutOfInvoice(db, ref);
      if (!co) return ignored('not a base.win subscription');
      let paymentIntent = invoicePaymentIntent(invoice);
      if (!paymentIntent && invoice.id) {
        // Newer API versions keep it on the invoice's payments.
        try {
          const list = await stripeRequest('GET', '/invoice_payments', { query: { invoice: invoice.id, limit: 10 } });
          const paid = (list?.data || []).find((p) => p?.status === 'paid') || list?.data?.[0];
          paymentIntent = idOf(paid?.payment?.payment_intent);
        } catch (e) {
          if (!(e instanceof StripeError && e.httpStatus === 404)) throw e;
        }
      }
      const paidAt = Number(invoice.status_transitions?.paid_at) > 0 ? new Date(Number(invoice.status_transitions.paid_at) * 1000) : at;
      return { action: 'stripe.payment', workspaceId: co.workspace_id, run: invoicePaid,
        plan: { checkoutId: co.id, invoiceId: invoice.id, subscriptionId: ref.subscriptionId, customerId: idOf(invoice.customer),
          amount: invoice.amount_paid, paymentIntent, charge: idOf(invoice.charge), email: invoice.customer_email || null, paidAt } };
    }
    case 'customer.subscription.deleted':
    case 'customer.subscription.updated': {
      if (event.type.endsWith('updated') && !ENDED.has(obj.status)) return ignored('still running');
      const co = await checkoutBy(db, { id: obj.metadata?.base_checkout, subscriptionId: obj.id });
      if (!co) return ignored('not a base.win subscription');
      return { action: 'stripe.subscription', workspaceId: co.workspace_id, run: stopped,
        plan: { checkoutId: co.id, at, why: event.type.endsWith('deleted') ? 'cancelled in Stripe' : `Stripe: ${obj.status}` } };
    }
    case 'charge.refunded':
    case 'charge.dispute.created':
    case 'charge.dispute.closed': {
      const due = Number(obj.evidence_details?.due_by);
      const step = event.type === 'charge.refunded'
        ? { action: 'stripe.refund', run: refunded, kind: 'refund',
            plan: { amountRefunded: obj.amount_refunded, refundId: idOf(obj.refunds?.data?.[0]) } }
        : { action: 'stripe.dispute', run: disputed, kind: 'dispute',
            plan: { closed: event.type.endsWith('closed'),
              dispute: { id: obj.id, status: obj.status, reason: obj.reason || null, dueBy: due > 0 ? new Date(due * 1000).toISOString() : null } } };
      const refs = chargeRefs(obj);
      const p = await paymentBy(db, refs);
      if (p) return { action: step.action, workspaceId: p.workspace_id, run: step.run, plan: { ...step.plan, paymentId: p.id } };
      // No payment of ours names it: not recorded yet, or not ours at all.
      const owner = await chargeOwner(db, obj, refs);
      if (!owner) return ignored('not a base.win payment');
      return { action: step.action, workspaceId: owner.co.workspace_id, run: beforeItsPayment,
        plan: { ...step.plan, kind: step.kind, checkoutId: owner.co.id, once: owner.co.cadence === 'once',
          refs: { ...refs, invoiceId: owner.invoiceId }, event: { id: event.id, type: event.type, at: at.toISOString() } } };
    }
    default:
      return ignored(`not an event base.win uses (${event.type})`);
  }
};

// One event, once. → { result } | { duplicate } | { ignored }
export const handleEvent = async (db, event) => {
  if ((await db.query('select 1 from stripe_events where id = $1', [event.id])).rows.length) return { duplicate: true };
  const step = await prepare(db, event);
  if (step.ignored) return step;
  const { result } = await runAction(db, { workspaceId: step.workspaceId, actorId: null, action: step.action }, async (tx, emit) => {
    const claimed = (await tx.query(
      'insert into stripe_events (id, workspace_id, type) values ($1, $2, $3) on conflict (id) do nothing returning id',
      [event.id, step.workspaceId, String(event.type).slice(0, 100)],
    )).rows[0];
    if (!claimed) return { duplicate: true };
    const ws = await loadWorkspace(tx, step.workspaceId);
    return step.run(tx, emit, ws, step.plan || {});
  });
  // A refund decided above goes to Stripe now, outside any transaction.
  if (result?.refund) runJobsSoon();
  return result;
};

export const publicRoutes = new Hono();

publicRoutes.post('/stripe/webhook', async (c) => {
  if (!secretKey() || !webhookSecrets().length) return c.json({ error: 'online payments aren’t set up here' }, 503);
  const raw = Buffer.from(await c.req.arrayBuffer());
  const check = verifySignature(raw, c.req.header('stripe-signature'));
  if (!check.ok) return c.json({ error: `signature refused: ${check.why}` }, 400);
  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { return c.json({ error: 'not JSON' }, 400); }
  if (!event || typeof event.id !== 'string' || typeof event.type !== 'string') return c.json({ error: 'not a Stripe event' }, 400);
  try {
    const r = await handleEvent(await getDb(), event);
    // What Stripe's dashboard shows for the delivery: words, never a person.
    return c.json({
      received: true,
      ...(r.duplicate ? { duplicate: true } : {}),
      ...(r.ignored ? { ignored: r.ignored } : {}),
      ...(r.result ? { result: r.result } : {}),
    });
  } catch (e) {
    console.error(`payments: Stripe event ${event.type} ${event.id} failed — Stripe will send it again:`, e.message);
    return c.json({ error: 'not done — send it again' }, 500);
  }
});
