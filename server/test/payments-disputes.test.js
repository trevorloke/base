// A dispute the bank decides (ext/payments/apply.js disputed). Stripe's
// dispute can be for less than the payment (only part of it disputed), and
// a lost one takes back only that much:
//   - over the limit, the rest is still with the campaign, and Stripe won't
//     refund a payment with a lost dispute: Needs you and Today say how much
//     to return to the donor by hand until a treasurer says Got it (however
//     long that takes), and Stripe is never asked for a refund
//   - under the limit, the gift isn't voided whole: it's flagged, as a
//     partial refund is, with what was kept; a refund that gives back the
//     rest, its event before or after the dispute's, voids it
//   - while it's open, Needs you never promises a refund the code can't make
//   - lost in full, or won, it's as before
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, Client } from './helpers.js';
import { app } from '../index.js';
import { runAction } from '../lib/events.js';
import { runDueJobs } from '../lib/jobs.js';
import { campaignDay } from '../lib/gifts.js';
import { prepareCheckout, openCheckout } from '../ext/payments/index.js';
import { startFakeStripe } from './fake-stripe.js';

const SECRET = 'whsec_payments_disputes_secret';
const KEY = 'sk_test_payments_disputes_0123';
const ENV = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_API_BASE', 'RESEND_API_KEY', 'MAIL_FROM', 'STARBASE_PUBLIC_URL'];
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const tag = Math.random().toString(36).slice(2, 8);
const mail = (who) => `${who}.disputes.${tag}@example.org`;
const today = campaignDay(new Date(), 'America/Vancouver');

let db, fake, mgr, wsId;

// The webhook, in-process: what Stripe would POST.
const deliver = async (raw, headers) => {
  const r = await app.request('/stripe/webhook', { method: 'POST', headers, body: raw });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json; };

// The site's donate form: the checkout kept in the form's write, Stripe
// asked once that write is done.
const open = async (personId, amountCents) => {
  const ctx = { workspaceId: wsId };
  const { result: co } = await runAction(db, { workspaceId: wsId, actorId: null, action: 'site.form.donate' }, (tx, emit) => prepareCheckout(tx, ctx, {
    personId, kind: 'donation', amountCents, cadence: 'once', slate: null, declaration: true,
    successUrl: 'https://site.example.org/donate?sent=donate', cancelUrl: 'https://site.example.org/donate',
  }, emit));
  return openCheckout(db, ctx, co.id, { action: 'site.form.donate' });
};
const donor = (first) => mgr.createPerson(`${first} Example`, { email: mail(first.toLowerCase()), address: '13450 104 Ave', city: 'Surrey', postal: 'V3T 1V8' });
const deskGift = async (person, cents) => ok(await mgr.action('gift.log', { person_id: person.id, amount_cents: cents, date: today, method: 'cheque' })).gift;
const payment = async (where, v) => (await db.query(`select * from stripe_payments where workspace_id = $1 and ${where} = $2`, [wsId, v])).rows[0];
const giftOf = async (id) => (await db.query('select * from gifts where id = $1', [id])).rows[0];
const receiptOf = async (giftId) => (await db.query('select * from receipts where gift_id = $1', [giftId])).rows[0];
const desk = async () => ok(await mgr.get('/api/payments'));
const needOf = async (id) => (await desk()).needs.find((x) => x.id === id);
const onToday = async (id) => ok(await mgr.get('/api/brief')).flagged.find((f) => f.payment_id === id);
const jobs = () => runDueJobs(db, { workspaceId: wsId });
const intentOf = (r) => fake.sessions.get(r.session_id).payment_intent;
const refundAsks = (pi) => fake.calls.filter((c) => c.method === 'POST' && c.path === '/v1/refunds' && c.params.payment_intent === pi).length;
// An event kept back (send: false), delivered now.
const now = (kept) => fake.send(kept.type, kept.object);
const verified = async () => assert.equal(ok(await mgr.get('/api/audit/verify')).ok, true);

// $400 over the limit (a $1,100 cheque logged at the desk while the donor
// was on Stripe's page), its refund refused because the charge is disputed.
const overAndRefused = async (first) => {
  const p = await donor(first);
  const r = await open(p.id, 40000);
  await deskGift(p, 110000);
  fake.failRefunds('charge_disputed');
  try {
    assert.equal((await fake.pay(r.session_id))[0].body.result, 'over_limit');
    await jobs();
  } finally {
    fake.failRefunds(false);
  }
  const pay = await payment('session_id', r.session_id);
  assert.equal(pay.status, 'refund_failed');
  return { pay, pi: intentOf(r) };
};

const OPEN_OVER = /^The card holder disputed this payment with their bank\. Answer in Stripe by [A-Z][a-z]+ \d+\. It was over this year’s limit, so no gift was logged\. If the dispute is won, it’s refunded to their card\.$/;
const HELD_LINE = 'The bank gave $100.00 of $400.00 back to the card holder (dispute lost). The other $300.00 was over this year’s limit and is still with the campaign. Stripe won’t refund a payment with a lost dispute: return it to the donor by hand, then Got it.';

before(async () => {
  db = await freshDb();
  for (const k of ENV) delete process.env[k];
  fake = await startFakeStripe({ secret: SECRET, deliver, apiKey: KEY });
  Object.assign(process.env, { STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_API_BASE: fake.url });
  mgr = new Client();
  const r = await mgr.signup({ workspaceName: `Disputes ${tag}`, email: mail('mgr'), jurisdiction: 'bc-municipal' });
  wsId = r.json.workspace.id;
});

after(async () => {
  await fake?.close();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

test('over the limit, a dispute for $100 of $400 lost: the other $300 is the treasurer’s to return by hand, in front of them until Got it', async () => {
  const { pay, pi } = await overAndRefused('Pia');
  const opened = await fake.dispute(pi, 'created', { amount: 10000 });
  assert.equal(opened.body.result, 'disputed: flagged for the treasurer');
  const disputed = await needOf(pay.id);
  assert.match(disputed.line, OPEN_OVER, 'no promise of a refund the code can’t make');
  assert.equal(disputed.can_ack, false);

  const lost = await fake.dispute(pi, 'lost', { id: opened.event.data.object.id, amount: 10000 });
  assert.equal(lost.body.result, 'dispute lost in part: flagged for the treasurer');
  let row = await payment('id', pay.id);
  assert.deepEqual([row.status, row.dispute_cents, row.refunded_cents, row.gift_id], ['dispute_lost', 10000, 0, null]);
  await jobs();
  assert.equal(refundAsks(pi), 1, 'Stripe is never asked again (only the refusal before the dispute)');
  const need = await needOf(pay.id);
  assert.deepEqual([need.word, need.line, need.can_ack], ['Dispute lost', HELD_LINE, true]);
  assert.doesNotMatch(need.line, /gave the money back/);
  const flag = await onToday(pay.id);
  assert.ok(flag, 'on Today: over-limit money still with the campaign');
  assert.equal(flag.flag_reason, HELD_LINE);

  // Months on, still unanswered: still there.
  await db.query(`update stripe_payments set updated_at = now() - interval '100 days' where id = $1`, [pay.id]);
  assert.ok(await needOf(pay.id), 'never dropped from Needs you for its age');
  assert.ok(await onToday(pay.id), 'nor from Today');

  ok(await mgr.action('payment.ack', { id: pay.id }));
  assert.equal(await needOf(pay.id), undefined, 'Got it: off Needs you');
  assert.equal(await onToday(pay.id), undefined, 'and off Today');
  row = await payment('id', pay.id);
  assert.deepEqual([row.status, row.dispute_cents], ['dispute_lost', 10000], 'the record stays');
  await verified();
});

test('over the limit, a dispute for part of it that came before the payment was recorded, then lost: the same', async () => {
  const p = await donor('Quin');
  const r = await open(p.id, 40000);
  await deskGift(p, 110000);
  const s = fake.complete(r.session_id); // paid on Stripe's page; its event hasn't come yet
  const opened = await fake.dispute(s.payment_intent, 'created', { amount: 10000 });
  assert.equal(opened.body.result, 'dispute kept until its payment is recorded');
  const held = (await db.query('select plan from stripe_held where workspace_id = $1 and payment_intent = $2', [wsId, s.payment_intent])).rows[0];
  const plan = typeof held.plan === 'string' ? JSON.parse(held.plan) : held.plan;
  assert.deepEqual([plan.dispute.amount, plan.dispute.currency], [10000, 'cad'], 'kept with its amount');

  assert.equal((await fake.send('checkout.session.completed', s)).body.result, 'over_limit — then disputed: flagged for the treasurer');
  await jobs();
  const pay = await payment('session_id', r.session_id);
  assert.equal(pay.status, 'disputed');
  assert.match((await needOf(pay.id)).line, OPEN_OVER);
  assert.ok(await onToday(pay.id));

  assert.equal((await fake.dispute(s.payment_intent, 'lost', { id: opened.event.data.object.id, amount: 10000 })).body.result, 'dispute lost in part: flagged for the treasurer');
  await jobs();
  assert.equal(refundAsks(s.payment_intent), 0, 'no refund asked of Stripe, ever');
  const row = await payment('id', pay.id);
  assert.deepEqual([row.status, row.dispute_cents], ['dispute_lost', 10000]);
  const need = await needOf(pay.id);
  assert.deepEqual([need.line, need.can_ack], [HELD_LINE, true]);
  assert.equal((await onToday(pay.id))?.flag_reason, HELD_LINE);
  ok(await mgr.action('payment.ack', { id: pay.id }));
  assert.equal(await needOf(pay.id), undefined);
  assert.equal(await onToday(pay.id), undefined);
  await verified();
});

test('under the limit, a dispute for $100 of a $400 gift lost: the gift isn’t voided whole; the treasurer is told to log what was kept', async () => {
  const p = await donor('Rho');
  const r = await open(p.id, 40000);
  await fake.pay(r.session_id);
  const pi = intentOf(r);
  const pay = await payment('session_id', r.session_id);
  assert.equal(pay.status, 'paid');
  const opened = await fake.dispute(pi, 'created', { amount: 10000 });
  assert.equal((await fake.dispute(pi, 'lost', { id: opened.event.data.object.id, amount: 10000 })).body.result, 'dispute lost in part: flagged for the treasurer');
  const row = await payment('id', pay.id);
  assert.deepEqual([row.status, row.dispute_cents], ['dispute_lost', 10000]);
  assert.equal((await giftOf(pay.gift_id)).deleted_at, null, 'the gift stands until the treasurer logs what was kept');
  const receipt = await receiptOf(pay.gift_id);
  assert.ok(receipt?.number, 'it was receipted');
  assert.equal(receipt.voided_at, null, 'and its receipt with it');
  const d = await desk();
  const need = d.needs.find((x) => x.id === pay.id);
  assert.deepEqual([need.word, need.line, need.can_ack], ['Dispute lost', 'The bank gave $100.00 of $400.00 back to the card holder (dispute lost). The gift still says $400.00: void it and log $300.00.', true]);
  assert.equal(d.gifts[pay.gift_id].word, 'Dispute lost');
  assert.equal(await onToday(pay.id), undefined, 'not an over-limit payment');

  // A donor whose record was deleted: no gift to void; what was kept is logged by hand.
  const gone = await donor('Sol');
  const r2 = await open(gone.id, 40000);
  await db.query('update persons set deleted_at = now() where id = $1', [gone.id]);
  assert.equal((await fake.pay(r2.session_id))[0].body.result, 'no_donor');
  const pi2 = intentOf(r2);
  const opened2 = await fake.dispute(pi2, 'created', { amount: 10000 });
  await fake.dispute(pi2, 'lost', { id: opened2.event.data.object.id, amount: 10000 });
  const pay2 = await payment('session_id', r2.session_id);
  assert.deepEqual([pay2.status, pay2.dispute_cents], ['dispute_lost', 10000]);
  assert.equal((await needOf(pay2.id)).line, 'The bank gave $100.00 of $400.00 back to the card holder (dispute lost). No gift was logged online for it (the donor’s record was deleted). Only $300.00 of it was kept: log that by hand.');
  await verified();
});

test('the rest given back by a refund, its event before or after the lost dispute’s: the gift is void either way, in the same words', async () => {
  const BOTH = 'The bank gave $100.00 of $400.00 back to the card holder (dispute lost), and $300.00 was refunded in Stripe — the gift is void.';
  // The refund made before the dispute; its event comes after the dispute is lost.
  const p = await donor('Uma');
  const r = await open(p.id, 40000);
  await fake.pay(r.session_id);
  const pi = intentOf(r);
  const late = await fake.refund(pi, 30000, { send: false });
  const opened = await fake.dispute(pi, 'created', { amount: 10000 });
  assert.equal((await fake.dispute(pi, 'lost', { id: opened.event.data.object.id, amount: 10000 })).body.result, 'dispute lost in part: flagged for the treasurer');
  let pay = await payment('session_id', r.session_id);
  assert.equal((await giftOf(pay.gift_id)).deleted_at, null);
  ok(await mgr.action('payment.ack', { id: pay.id }));
  assert.equal((await now(late)).body.result, 'refunded: the gift is void');
  pay = await payment('id', pay.id);
  assert.deepEqual([pay.status, pay.refunded_cents, pay.dispute_cents], ['dispute_lost', 30000, 10000]);
  assert.ok((await giftOf(pay.gift_id)).deleted_at, 'nothing was kept: the gift is void');
  assert.ok((await receiptOf(pay.gift_id)).voided_at, 'and its receipt');
  assert.equal((await needOf(pay.id))?.line, BOTH, 'in front of the treasurer again');

  // The refund's event first.
  const q = await donor('Ugo');
  const r2 = await open(q.id, 40000);
  await fake.pay(r2.session_id);
  const pi2 = intentOf(r2);
  assert.equal((await fake.refund(pi2, 30000)).body.result, 'partly refunded: flagged for the treasurer');
  const opened2 = await fake.dispute(pi2, 'created', { amount: 10000 });
  assert.equal((await fake.dispute(pi2, 'lost', { id: opened2.event.data.object.id, amount: 10000 })).body.result, 'dispute lost: the gift is void');
  const pay2 = await payment('session_id', r2.session_id);
  assert.deepEqual([pay2.status, pay2.refunded_cents, pay2.dispute_cents], ['dispute_lost', 30000, 10000]);
  assert.ok((await giftOf(pay2.gift_id)).deleted_at);
  assert.equal((await needOf(pay2.id)).line, BOTH);
  await verified();
});

test('over the limit, the rest refunded in Stripe after the dispute was lost: it says so, and leaves Today', async () => {
  const { pay, pi } = await overAndRefused('Cai');
  const opened = await fake.dispute(pi, 'created', { amount: 10000 });
  await fake.dispute(pi, 'lost', { id: opened.event.data.object.id, amount: 10000 });
  assert.equal((await needOf(pay.id)).line, HELD_LINE);
  await fake.refund(pi, 30000);
  await jobs();
  const row = await payment('id', pay.id);
  assert.deepEqual([row.status, row.refunded_cents, row.dispute_cents], ['dispute_lost', 30000, 10000]);
  assert.equal(refundAsks(pi), 1, 'nothing more asked of Stripe');
  const need = await needOf(pay.id);
  assert.deepEqual([need.line, need.can_ack], ['The bank gave $100.00 of $400.00 back to the card holder (dispute lost), and $300.00 was refunded in Stripe. It was over this year’s limit, so no gift was logged.', true]);
  assert.equal(await onToday(pay.id), undefined, 'nothing still to give back');
  await verified();
});

test('a dispute lost in full is as before: the gift and its receipt void; over the limit the bank gave it all back, and it isn’t on Today', async () => {
  const p = await donor('Vik');
  const r = await open(p.id, 25000);
  await fake.pay(r.session_id);
  const pi = intentOf(r);
  const opened = await fake.dispute(pi, 'created');
  assert.equal((await fake.dispute(pi, 'lost', { id: opened.event.data.object.id })).body.result, 'dispute lost: the gift is void');
  const pay = await payment('session_id', r.session_id);
  assert.deepEqual([pay.status, pay.dispute_cents], ['dispute_lost', 25000], 'what the bank took back');
  assert.ok((await giftOf(pay.gift_id)).deleted_at);
  assert.ok((await receiptOf(pay.gift_id)).voided_at);
  assert.equal((await needOf(pay.id)).line, 'The bank gave the money back to the card holder (dispute lost) — the gift is void.');

  const { pay: over, pi: pi2 } = await overAndRefused('Wyn');
  const opened2 = await fake.dispute(pi2, 'created');
  await fake.dispute(pi2, 'lost', { id: opened2.event.data.object.id });
  await jobs();
  const row = await payment('id', over.id);
  assert.deepEqual([row.status, row.dispute_cents], ['dispute_lost', 40000]);
  assert.equal(refundAsks(pi2), 1);
  const need = await needOf(over.id);
  assert.deepEqual([need.line, need.can_ack], ['The bank gave the money back to the card holder (dispute lost). It was over this year’s limit, so no gift was logged.', true]);
  assert.equal(await onToday(over.id), undefined, 'nothing still to give back');

  // A dispute for more than the payment (the card holder's currency moved),
  // or in another currency, or with no amount: all of it, as before.
  for (const [first, change] of [['Xia', { amount: 45000 }], ['Yul', { amount: 10000, currency: 'usd' }], ['Zed', { amount: undefined }]]) {
    const who = await donor(first);
    const r3 = await open(who.id, 40000);
    await fake.pay(r3.session_id);
    const pi3 = intentOf(r3);
    const opened3 = await fake.dispute(pi3, 'created');
    const closed = await fake.dispute(pi3, 'lost', { id: opened3.event.data.object.id, send: false });
    Object.assign(closed.object, change);
    assert.equal((await now(closed)).body.result, 'dispute lost: the gift is void', first);
    const pay3 = await payment('session_id', r3.session_id);
    assert.deepEqual([pay3.status, pay3.dispute_cents], ['dispute_lost', 40000], first);
    assert.ok((await giftOf(pay3.gift_id)).deleted_at, first);
  }
  await verified();
});

test('a dispute for part of it won is as before: over the limit, all of it is refunded; under it, the gift stands', async () => {
  const { pay, pi } = await overAndRefused('Ada');
  const opened = await fake.dispute(pi, 'created', { amount: 10000 });
  assert.match((await needOf(pay.id)).line, OPEN_OVER);
  assert.equal((await fake.dispute(pi, 'won', { id: opened.event.data.object.id, amount: 10000 })).body.result, 'dispute won');
  let row = await payment('id', pay.id);
  assert.deepEqual([row.status, row.dispute_cents], ['over_limit', null]);
  await jobs();
  row = await payment('id', pay.id);
  assert.deepEqual([row.status, row.refunded_cents], ['refunded', 40000]);
  assert.equal(fake.refunds.filter((x) => x.payment_intent === pi).reduce((n, x) => n + x.amount, 0), 40000, 'the whole payment went back, once');
  assert.match((await needOf(pay.id)).line, /^Over this year’s limit when it came in — refunded in full; no gift was logged\./);

  const p = await donor('Bo');
  const r = await open(p.id, 40000);
  await fake.pay(r.session_id);
  const pi2 = intentOf(r);
  const opened2 = await fake.dispute(pi2, 'created', { amount: 10000 });
  assert.equal((await fake.dispute(pi2, 'won', { id: opened2.event.data.object.id, amount: 10000 })).body.result, 'dispute won');
  const pay2 = await payment('session_id', r.session_id);
  assert.deepEqual([pay2.status, pay2.dispute_cents], ['paid', null]);
  assert.equal((await giftOf(pay2.gift_id)).deleted_at, null);
  assert.equal(await needOf(pay2.id), undefined);
  await verified();
});
