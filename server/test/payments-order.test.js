// Stripe sends its events in no set order, and a delivery can come again
// (ext/payments/webhook.js). Whatever order they come in, the books end as
// if they had come in order:
//   - a refund or a dispute that comes before its payment is recorded is
//     kept, and done in the same write that records the payment — a gift
//     once, or one month of a monthly gift (whose it is, asked of Stripe:
//     our ids ride on the payment, or on the subscription its invoice
//     names), in either API version's shape — and one on a month recorded
//     before Stripe said which payment paid it is found through its
//     invoice; someone else's charge on the same Stripe account is still
//     left alone
//   - a dispute's close that comes before its opening leaves it closed (on
//     a payment over the limit, its refund still goes ahead); two refunds
//     whose events come the wrong way round leave the larger total
//   - a dispute that ends with the money kept puts the payment back as it
//     was: over the limit (its refund refused, or still waiting) is refunded
//     after all and stays in front of the treasurer until it is; refunded
//     in full stays refunded; a deleted donor's is still theirs to log —
//     and Needs you never says "the gift counts" when there is no gift
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { runAction } from '../lib/events.js';
import { runDueJobs } from '../lib/jobs.js';
import { campaignDay } from '../lib/gifts.js';
import { prepareCheckout, openCheckout } from '../ext/payments/index.js';
import { startFakeStripe } from './fake-stripe.js';

const SECRET = 'whsec_payments_order_secret';
const KEY = 'sk_test_payments_order_0123';
const ENV = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_API_BASE', 'RESEND_API_KEY', 'MAIL_FROM', 'STARBASE_PUBLIC_URL'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.order.${tag}@example.org`;
const today = campaignDay(new Date(), 'America/Vancouver');

let db, fake, older, mgr, wsId;

// The webhook, in-process: what Stripe would POST.
const deliver = async (raw, headers) => {
  const r = await app.request('/stripe/webhook', { method: 'POST', headers, body: raw });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };

// The site's donate form: the checkout is kept in the form's write, and
// Stripe is asked once that write is done (as the form handler does).
const open = async (personId, opts = {}) => {
  const ctx = { workspaceId: wsId };
  const { result: co } = await runAction(db, { workspaceId: wsId, actorId: null, action: 'site.form.donate' }, (tx, emit) => prepareCheckout(tx, ctx, {
    personId, kind: 'donation', amountCents: 5000, cadence: 'once', slate: null, declaration: true,
    successUrl: 'https://site.example.org/donate?sent=donate', cancelUrl: 'https://site.example.org/donate', ...opts,
  }, emit));
  return openCheckout(db, ctx, co.id, { action: 'site.form.donate' });
};
const donor = (first) => mgr.createPerson(`${first} Example`, { email: mail(first.toLowerCase()), address: '13450 104 Ave', city: 'Surrey', postal: 'V3T 1V8' });
const deskGift = async (person, cents) => ok(await mgr.action('gift.log', { person_id: person.id, amount_cents: cents, date: today, method: 'cheque' })).gift;
const payment = async (where, v) => (await db.query(`select * from stripe_payments where workspace_id = $1 and ${where} = $2`, [wsId, v])).rows[0];
const giftOf = async (id) => (await db.query('select * from gifts where id = $1', [id])).rows[0];
const receiptOf = async (giftId) => (await db.query('select * from receipts where gift_id = $1', [giftId])).rows[0];
const needOf = async (id) => ok(await mgr.get('/api/payments')).needs.find((x) => x.id === id);
const onToday = async (id) => ok(await mgr.get('/api/brief')).flagged.find((f) => f.payment_id === id);
const jobs = () => runDueJobs(db, { workspaceId: wsId });
const held = async () => (await db.query('select count(*)::int as n from stripe_held where workspace_id = $1', [wsId])).rows[0].n;
const intentOf = (r, f = fake) => f.sessions.get(r.session_id).payment_intent;
// An event kept back (send: false), delivered now.
const now = (kept, f = fake) => f.send(kept.type, kept.object);
const verified = async () => assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);

before(async () => {
  db = await freshDb();
  for (const k of ENV) delete process.env[k];
  fake = await startFakeStripe({ secret: SECRET, deliver, apiKey: KEY });
  older = await startFakeStripe({ secret: SECRET, deliver, apiKey: KEY, legacy: true });
  Object.assign(process.env, { STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_API_BASE: fake.url });
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Out of order ${tag}`, email: mail('mgr'), jurisdiction: 'bc-municipal' });
  wsId = r.json.workspace.id;
});

after(async () => {
  await fake?.close();
  await older?.close();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

test('a refund made in Stripe before its payment is recorded: kept, then done in the write that records it — the gift and its receipt void', async () => {
  const p = await donor('Remy');
  const r = await open(p.id, { amountCents: 2500 });
  const s = fake.complete(r.session_id); // paid on Stripe's page; its event hasn't come yet
  const early = await now(await fake.refund(s.payment_intent, null, { send: false }));
  assert.equal(early.status, 200, JSON.stringify(early.body));
  assert.equal(early.body.ignored, undefined, 'not dropped as someone else’s');
  assert.equal(early.body.result, 'refund kept until its payment is recorded');
  assert.ok(fake.calls.some((c) => c.method === 'GET' && c.path === `/v1/payment_intents/${s.payment_intent}`), 'whose it is, asked of Stripe');
  assert.equal(await held(), 1);
  assert.equal((await fake.send(early.event.type, early.event.data.object, { id: early.event.id })).body.duplicate, true, 'each event once');
  assert.equal(await payment('session_id', r.session_id), undefined, 'no payment yet');

  const landed = await fake.send('checkout.session.completed', s);
  assert.equal(landed.status, 200, JSON.stringify(landed.body));
  assert.equal(landed.body.result, 'gift recorded — then refunded: the gift is void');
  const pay = await payment('session_id', r.session_id);
  assert.deepEqual([pay.status, pay.refunded_cents, pay.payment_intent], ['refunded', 2500, s.payment_intent]);
  assert.ok((await giftOf(pay.gift_id)).deleted_at, 'no live gift for money already given back');
  assert.ok((await receiptOf(pay.gift_id)).voided_at, 'nor a live receipt');
  assert.equal((await needOf(pay.id)).line, 'Refunded in Stripe — the gift is void.');
  assert.equal(await held(), 0, 'nothing left waiting');
  // The payment's event again, and Stripe's second try at the refund: nothing more.
  assert.equal((await fake.send('checkout.session.async_payment_succeeded', s)).body.result, 'already recorded');
  assert.equal((await fake.send(early.event.type, early.event.data.object, { id: early.event.id })).body.duplicate, true);
  await verified();
});

test('a month’s refund before that month is recorded: found through the invoice its payment paid, kept, then done — either API version', async () => {
  for (const f of [fake, older]) {
    process.env.STRIPE_API_BASE = f.url;
    try {
      const p = await donor(f === fake ? 'Mona' : 'Milo');
      const r = await open(p.id, { cadence: 'monthly', amountCents: 2000 });
      await f.pay(r.session_id); // the monthly gift starts; its first month lands
      const sub = f.sessions.get(r.session_id).subscription;
      const { invoice, paymentIntent } = await f.invoice(sub, { send: false }); // the next month, paid; its event not here yet
      const early = await now(await f.refund(paymentIntent, null, { send: false }), f);
      assert.equal(early.body.result, 'refund kept until its payment is recorded', JSON.stringify(early.body));
      const asked = f.calls.filter((c) => c.method === 'GET').map((c) => c.path);
      if (f === fake) {
        // Newer versions: the payment carries none of our ids; the invoice it paid, then its subscription's.
        assert.ok(f.calls.some((c) => c.path === '/v1/invoice_payments' && c.query['payment[payment_intent]'] === paymentIntent), 'the invoice its payment paid');
      } else {
        assert.ok(!asked.includes(`/v1/payment_intents/${paymentIntent}`), 'older versions: the charge names its invoice');
      }
      assert.ok(asked.includes(`/v1/invoices/${invoice.id}`));
      const month = await f.send('invoice.paid', invoice);
      assert.equal(month.body.result, 'month’s gift recorded — then refunded: the gift is void', JSON.stringify(month.body));
      const pay = await payment('invoice_id', invoice.id);
      assert.deepEqual([pay.status, pay.refunded_cents], ['refunded', 2000]);
      assert.ok((await giftOf(pay.gift_id)).deleted_at);
      const first = (await db.query(`select * from stripe_payments where workspace_id = $1 and subscription_id = $2 and invoice_id <> $3`, [wsId, sub, invoice.id])).rows;
      assert.deepEqual(first.map((x) => x.status), ['paid'], 'the first month is untouched');
      assert.equal(await held(), 0);
    } finally {
      process.env.STRIPE_API_BASE = fake.url;
    }
  }
  await verified();
});

test('a month recorded before Stripe said which payment paid it: a refund on it is still found, through its invoice', async () => {
  const p = await donor('Nell');
  const r = await open(p.id, { cadence: 'monthly', amountCents: 1800 });
  await fake.pay(r.session_id);
  const sub = fake.sessions.get(r.session_id).subscription;
  const { invoice, paymentIntent } = await fake.invoice(sub);
  // As when the invoice's payments couldn't be read as it landed.
  await db.query('update stripe_payments set payment_intent = null, charge_id = null where workspace_id = $1 and invoice_id = $2', [wsId, invoice.id]);
  const refund = await fake.refund(paymentIntent);
  assert.equal(refund.body.result, 'refunded: the gift is void', JSON.stringify(refund.body));
  const pay = await payment('invoice_id', invoice.id);
  assert.deepEqual([pay.status, pay.refunded_cents], ['refunded', 1800]);
  assert.ok((await giftOf(pay.gift_id)).deleted_at);
  assert.equal(await held(), 0, 'done at once, not kept');
});

test('a dispute that comes before its payment is recorded: kept, and done in order when it lands', async () => {
  // Opened and lost — the close delivered first — before the payment's event.
  const p = await donor('Dara');
  const r = await open(p.id, { amountCents: 3000 });
  const s = fake.complete(r.session_id);
  const opening = await fake.dispute(s.payment_intent, 'created', { send: false });
  const lost = await fake.dispute(s.payment_intent, 'lost', { id: opening.object.id, send: false });
  assert.equal((await now(lost)).body.result, 'dispute kept until its payment is recorded');
  assert.equal((await now(opening)).body.result, 'dispute kept until its payment is recorded');
  const landed = await fake.send('checkout.session.completed', s);
  assert.match(landed.body.result, /^gift recorded — then /, JSON.stringify(landed.body));
  const pay = await payment('session_id', r.session_id);
  assert.equal(pay.status, 'dispute_lost');
  assert.ok((await giftOf(pay.gift_id)).deleted_at, 'the bank gave it back: the gift is void');
  assert.equal((await needOf(pay.id)).word, 'Dispute lost');

  // Opened before the payment's event; won after it.
  const q = await donor('Dev');
  const r2 = await open(q.id, { amountCents: 3500 });
  const s2 = fake.complete(r2.session_id);
  const opened = await fake.dispute(s2.payment_intent, 'created');
  assert.equal(opened.body.result, 'dispute kept until its payment is recorded');
  assert.equal((await fake.send('checkout.session.completed', s2)).body.result, 'gift recorded — then disputed: flagged for the treasurer');
  let pay2 = await payment('session_id', r2.session_id);
  assert.equal(pay2.status, 'disputed');
  assert.equal((await giftOf(pay2.gift_id)).deleted_at, null, 'the gift counts until it’s settled');
  assert.match((await needOf(pay2.id)).line, /— the gift counts until it’s settled\.$/);
  assert.equal((await fake.dispute(s2.payment_intent, 'won', { id: opened.event.data.object.id })).body.result, 'dispute won');
  pay2 = await payment('id', pay2.id);
  assert.equal(pay2.status, 'paid');
  assert.equal(await held(), 0);
  await verified();
});

test('someone else’s charge on the same Stripe account is still left alone', async () => {
  const before = await held();
  const theirs = await fake.send('charge.refunded', { id: 'ch_elsewhere', object: 'charge', payment_intent: 'pi_elsewhere', amount: 999, amount_refunded: 999, refunded: true });
  assert.deepEqual([theirs.status, theirs.body.ignored], [200, 'not a base.win payment']);
  const dispute = await fake.send('charge.dispute.created', { id: 'dp_elsewhere', object: 'dispute', charge: 'ch_elsewhere', payment_intent: 'pi_elsewhere', status: 'needs_response' });
  assert.deepEqual([dispute.status, dispute.body.ignored], [200, 'not a base.win payment']);
  const old = await fake.send('charge.refunded', { id: 'ch_old_style', object: 'charge', payment_intent: null, amount: 500, amount_refunded: 500, refunded: true });
  assert.deepEqual([old.status, old.body.ignored], [200, 'not a base.win payment'], 'no payment intent: not from a checkout');
  // A payment of theirs that Stripe has — in either API version's shape
  // (the older can't list an invoice's payments by payment intent).
  for (const f of [fake, older]) {
    const pi = `pi_their_shop_${f === fake ? 'new' : 'old'}`;
    f.paymentIntents.set(pi, { id: pi, object: 'payment_intent', amount: 4200, currency: 'cad', status: 'succeeded', metadata: { order: 'A-17' } });
    process.env.STRIPE_API_BASE = f.url;
    try {
      const shop = await f.send('charge.refunded', { id: `ch_${pi}`, object: 'charge', payment_intent: pi, amount: 4200, amount_refunded: 4200, refunded: true, metadata: { order: 'A-17' } });
      assert.deepEqual([shop.status, shop.body?.ignored], [200, 'not a base.win payment'], JSON.stringify(shop.body));
    } finally {
      process.env.STRIPE_API_BASE = fake.url;
    }
  }
  assert.equal(await held(), before, 'nothing kept for them');
});

test('a dispute’s close that comes before its opening: it stays closed', async () => {
  const p = await donor('Wes');
  const r = await open(p.id, { amountCents: 3000 });
  await fake.pay(r.session_id);
  const pi = intentOf(r);
  const opening = await fake.dispute(pi, 'created', { send: false });
  const won = await fake.dispute(pi, 'won', { id: opening.object.id, send: false });
  assert.equal((await now(won)).body.result, 'dispute won');
  assert.equal((await now(opening)).body.result, 'already settled');
  const pay = await payment('session_id', r.session_id);
  assert.equal(pay.status, 'paid', 'not disputed again');
  assert.equal((await giftOf(pay.gift_id)).deleted_at, null);
  assert.equal(await needOf(pay.id), undefined, 'nothing for the treasurer');
  // Two refunds, the second's event first: the larger total stands.
  const second = await fake.refund(pi, 1000, { send: false });
  const third = await fake.refund(pi, 500, { send: false });
  assert.equal((await now(third)).body.result, 'partly refunded: flagged for the treasurer');
  assert.equal((await now(second)).body.result, 'already recorded');
  assert.equal((await payment('id', pay.id)).refunded_cents, 1500);
  await verified();
});

test('over the limit, an inquiry’s close before its opening: the refund still goes ahead', async () => {
  const p = await donor('Ivo');
  const r = await open(p.id, { amountCents: 40000 });
  await deskGift(p, 110000);
  await fake.pay(r.session_id); // over the limit; its refund is queued
  const pi = intentOf(r);
  const opening = await fake.dispute(pi, 'warning_needs_response', { send: false });
  const closed = await fake.dispute(pi, 'warning_closed', { id: opening.object.id, send: false });
  assert.equal((await now(closed)).body.result, 'dispute warning_closed');
  assert.equal((await now(opening)).body.result, 'already settled');
  let pay = await payment('session_id', r.session_id);
  assert.equal(pay.status, 'over_limit', 'not left disputed, where its refund would wait for ever');
  await jobs();
  pay = await payment('id', pay.id);
  assert.deepEqual([pay.status, pay.refunded_cents], ['refunded', 40000]);
  await verified();
});

test('a won dispute on a payment over the limit whose refund was refused: refunded after all, and in front of the treasurer until it is', async () => {
  const p = await donor('Olga');
  const r = await open(p.id, { amountCents: 40000 });
  await deskGift(p, 110000); // while she was on Stripe's page: $1,100 + $400 is over $1,429.70
  fake.failRefunds('charge_disputed');
  try {
    assert.equal((await fake.pay(r.session_id))[0].body.result, 'over_limit');
    await jobs();
  } finally {
    fake.failRefunds(false);
  }
  let pay = await payment('session_id', r.session_id);
  assert.deepEqual([pay.status, pay.gift_id], ['refund_failed', null]);
  const pi = intentOf(r);
  const opened = await fake.dispute(pi, 'created');
  assert.equal(opened.body.result, 'disputed: flagged for the treasurer');
  let need = await needOf(pay.id);
  assert.doesNotMatch(need.line, /the gift counts/, 'there is no gift');
  assert.match(need.line, /^The card holder disputed this payment with their bank\. Answer in Stripe by [A-Z][a-z]+ \d+\. It was over this year’s limit, so no gift was logged — if the bank doesn’t give the money back, it’s refunded once the dispute is settled\.$/);
  const today = await onToday(pay.id);
  assert.ok(today, 'still on Today: over-limit money not yet given back');
  assert.equal(today.flag_reason, need.line, 'in the same words, with the date to answer by');

  assert.equal((await fake.dispute(pi, 'won', { id: opened.event.data.object.id })).body.result, 'dispute won');
  pay = await payment('id', pay.id);
  assert.deepEqual([pay.status, pay.over_limit, pay.gift_id], ['over_limit', true, null], 'refunding again — not "paid"');
  assert.match((await needOf(pay.id)).line, /is being refunded to their card/);
  assert.ok(await onToday(pay.id));
  await jobs();
  pay = await payment('id', pay.id);
  assert.deepEqual([pay.status, pay.refunded_cents], ['refunded', 40000]);
  assert.equal(fake.refunds.filter((x) => x.payment_intent === pi).reduce((n, x) => n + x.amount, 0), 40000, 'the money went back, once');
  need = await needOf(pay.id);
  assert.match(need.line, /^Over this year’s limit when it came in — refunded in full; no gift was logged\./);
  await verified();
});

test('an inquiry opened before the over-limit refund ran: when it closes, the refund goes ahead', async () => {
  const p = await donor('Ines');
  const r = await open(p.id, { amountCents: 40000 });
  await deskGift(p, 110000);
  await fake.pay(r.session_id); // over the limit; its refund is queued
  const pi = intentOf(r);
  const inquiry = await fake.dispute(pi, 'warning_needs_response');
  assert.equal(inquiry.body.result, 'disputed: flagged for the treasurer');
  await jobs(); // the refund waits while the payment is disputed
  let pay = await payment('session_id', r.session_id);
  assert.equal(pay.status, 'disputed');
  assert.equal(fake.refunds.filter((x) => x.payment_intent === pi).length, 0);
  assert.equal((await fake.dispute(pi, 'warning_closed', { id: inquiry.event.data.object.id })).body.result, 'dispute warning_closed');
  pay = await payment('id', pay.id);
  assert.equal(pay.status, 'over_limit');
  await jobs();
  pay = await payment('id', pay.id);
  assert.deepEqual([pay.status, pay.refunded_cents], ['refunded', 40000]);
  await verified();
});

test('refunded in full during an inquiry, then the inquiry closes: refunded, not partly refunded', async () => {
  const p = await donor('Fay');
  const r = await open(p.id, { amountCents: 5000 });
  await fake.pay(r.session_id);
  const pi = intentOf(r);
  const inquiry = await fake.dispute(pi, 'warning_needs_response');
  assert.equal((await fake.refund(pi)).body.result, 'refunded: the gift is void');
  let pay = await payment('session_id', r.session_id);
  assert.deepEqual([pay.status, pay.refunded_cents], ['disputed', 5000]);
  await fake.dispute(pi, 'warning_closed', { id: inquiry.event.data.object.id });
  pay = await payment('id', pay.id);
  assert.deepEqual([pay.status, pay.refunded_cents], ['refunded', 5000]);
  const need = await needOf(pay.id);
  assert.deepEqual([need.word, need.line], ['Refunded', 'Refunded in Stripe — the gift is void.']);
  await verified();
});

test('a won dispute on a payment whose donor was deleted: still the treasurer’s to log', async () => {
  const p = await donor('Cyd');
  const r = await open(p.id, { amountCents: 2000 });
  await db.query('update persons set deleted_at = now() where id = $1', [p.id]);
  assert.equal((await fake.pay(r.session_id))[0].body.result, 'no_donor');
  const pi = intentOf(r);
  const opened = await fake.dispute(pi, 'created');
  let pay = await payment('session_id', r.session_id);
  const line = (await needOf(pay.id)).line;
  assert.doesNotMatch(line, /the gift counts/, 'there is no gift');
  assert.match(line, /\. No gift was logged online for it \(the donor’s record was deleted\)\.$/);
  await fake.dispute(pi, 'won', { id: opened.event.data.object.id });
  pay = await payment('id', pay.id);
  assert.equal(pay.status, 'no_donor', 'not "paid": no gift was ever logged');
  assert.match((await needOf(pay.id)).line, /^Paid online, but the donor’s record was deleted — log the gift by hand/);
  await verified();
});
