// Stripe sends its events in no set order, and a delivery can come again
// (ext/payments/webhook.js). Whatever order they come in, the books end as
// if they had come in order:
//   - a refund or a dispute that comes before its payment is recorded is
//     kept, and done in the same write that records the payment — a gift
//     once, or one month of a monthly gift (whose it is, asked of Stripe:
//     our ids ride on the payment, or on the subscription its invoice
//     names), in either API version's shape; someone else's charge on the
//     same Stripe account is still left alone
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { runAction } from '../lib/events.js';
import { runDueJobs } from '../lib/jobs.js';
import { campaignDay } from '../lib/gifts.js';
import { checkoutFor } from '../ext/payments/index.js';
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

// The site's donate form: the checkout opens inside the form's write.
const open = (personId, opts = {}) => runAction(db, { workspaceId: wsId, actorId: null, action: 'site.form.donate' }, (tx, emit) => checkoutFor(tx, { workspaceId: wsId }, {
  personId, kind: 'donation', amountCents: 5000, cadence: 'once', slate: null, declaration: true,
  successUrl: 'https://site.example.org/donate?sent=donate', cancelUrl: 'https://site.example.org/donate', ...opts,
}, emit)).then((r) => r.result);
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
  assert.equal(await held(), before, 'nothing kept for them');
});
