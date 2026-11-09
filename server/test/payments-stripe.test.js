// Online payments, the parts that need no database: Stripe's signature (and
// what is refused), its form encoding, the two API-version shapes of an
// invoice, and the limit rule a checkout is asked against.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  verifySignature, signPayload, formEncode, invoiceSubscription, invoicePaymentIntent, chargeRefs, stripeMode, paymentsReady, eventTime,
} from '../ext/payments/stripe.js';
import { fits, monthlyMax } from '../ext/payments/limits.js';
import { overLimitEmail } from '../ext/payments/refunds.js';

const SECRET = 'whsec_unit_secret';
const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });

test('a signature Stripe would send is accepted; a wrong secret, a changed body, an old or future timestamp, or none is refused', () => {
  const t = Math.floor(Date.now() / 1000);
  assert.equal(verifySignature(body, signPayload(body, SECRET, t), [SECRET]).ok, true);
  assert.equal(verifySignature(Buffer.from(body), signPayload(body, SECRET, t), [SECRET]).ok, true, 'the raw bytes');
  assert.equal(verifySignature(body, signPayload(body, 'whsec_other', t), [SECRET]).why, 'signature doesn’t match');
  assert.equal(verifySignature(`${body} `, signPayload(body, SECRET, t), [SECRET]).ok, false, 'one byte more');
  assert.equal(verifySignature(body, signPayload(body, SECRET, t - 301), [SECRET]).why, 'too old (or the server clock is wrong)');
  assert.equal(verifySignature(body, signPayload(body, SECRET, t + 301), [SECRET]).ok, false, 'from the future');
  assert.equal(verifySignature(body, signPayload(body, SECRET, t - 299), [SECRET]).ok, true, 'inside five minutes');
  assert.equal(verifySignature(body, '', [SECRET]).why, 'no signature');
  assert.equal(verifySignature(body, `t=${t}`, [SECRET]).why, 'no v1 signature');
  assert.equal(verifySignature(body, `v1=${'a'.repeat(64)}`, [SECRET]).why, 'no timestamp');
  assert.equal(verifySignature(body, `t=${t},v1=zz`, [SECRET]).ok, false, 'not hex');
  assert.equal(verifySignature(body, signPayload(body, SECRET, t), []).why, 'no webhook secret is set');
  // Stripe sends one v1 per secret while a secret is being rolled; either matches.
  const two = `${signPayload(body, 'whsec_old', t)},v1=${signPayload(body, SECRET, t).split('v1=')[1]}`;
  assert.equal(verifySignature(body, two, [SECRET]).ok, true);
  assert.equal(verifySignature(body, signPayload(body, 'whsec_old', t), ['whsec_new', 'whsec_old']).ok, true, 'a comma list of secrets');
});

test('Stripe’s form encoding: nested objects and lists', () => {
  const f = formEncode({ mode: 'payment', line_items: [{ quantity: 1, price_data: { currency: 'cad', unit_amount: 5000 } }], metadata: { a: 'b' }, skip: null });
  assert.equal(decodeURIComponent(f.toString()),
    'mode=payment&line_items[0][quantity]=1&line_items[0][price_data][currency]=cad&line_items[0][price_data][unit_amount]=5000&metadata[a]=b');
});

test('an invoice, in either API version’s shape: its subscription, our metadata, its payment intent', () => {
  const modern = { id: 'in_1', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1', metadata: { base_checkout: 'c1' } } } };
  assert.deepEqual(invoiceSubscription(modern), { subscriptionId: 'sub_1', metadata: { base_checkout: 'c1' }, known: true });
  const legacy = { id: 'in_2', subscription: { id: 'sub_2' }, subscription_details: { metadata: { base_checkout: 'c2' } }, payment_intent: 'pi_2' };
  assert.deepEqual(invoiceSubscription(legacy), { subscriptionId: 'sub_2', metadata: { base_checkout: 'c2' }, known: true });
  assert.equal(invoiceSubscription({ id: 'in_3', object: 'invoice' }).known, false, 'neither: read it again from Stripe');
  assert.equal(invoiceSubscription({ id: 'in_4', parent: null }).subscriptionId, null, 'a one-off invoice');
  assert.equal(invoicePaymentIntent(legacy), 'pi_2');
  assert.equal(invoicePaymentIntent({ payments: { data: [{ status: 'open', payment: { payment_intent: 'pi_open' } }, { status: 'paid', payment: { payment_intent: { id: 'pi_paid' } } }] } }), 'pi_paid');
  assert.equal(invoicePaymentIntent(modern), null, 'not on the object: listed from Stripe');
  assert.deepEqual(chargeRefs({ object: 'charge', id: 'ch_1', payment_intent: 'pi_1' }), { paymentIntent: 'pi_1', charge: 'ch_1' });
  assert.deepEqual(chargeRefs({ object: 'dispute', id: 'dp_1', charge: 'ch_2', payment_intent: { id: 'pi_2' } }), { paymentIntent: 'pi_2', charge: 'ch_2' });
  assert.equal(eventTime({ created: 1_700_000_000 }).toISOString(), '2023-11-14T22:13:20.000Z');
});

test('the mode follows the key; ready needs both keys', () => {
  const saved = { k: process.env.STRIPE_SECRET_KEY, w: process.env.STRIPE_WEBHOOK_SECRET };
  try {
    delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET;
    assert.deepEqual([stripeMode(), paymentsReady()], [null, false]);
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
    assert.deepEqual([stripeMode(), paymentsReady()], ['test', false], 'no webhook secret: nothing would ever come back');
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    assert.deepEqual([stripeMode(), paymentsReady()], ['test', true]);
    process.env.STRIPE_SECRET_KEY = 'rk_live_abc';
    assert.equal(stripeMode(), 'live');
  } finally {
    if (saved.k === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = saved.k;
    if (saved.w === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = saved.w;
  }
});

test('the limit a checkout is asked against: once, monthly for the rest of the year, and a whole year beside the monthly gifts running', () => {
  const room = { capCents: 142970, monthIndex: 10, slate: 'council', givenCents: 0, committedCents: 0, monthlyActiveCents: 0, roomCents: 142970 };
  assert.equal(monthlyMax(142970), 11900, '$1,429.70 a year → $119 a month');
  assert.equal(fits(room, { cadence: 'once', amountCents: 142970 }).ok, true);
  assert.equal(fits(room, { cadence: 'once', amountCents: 142971 }).ok, false);
  assert.equal(fits(room, { cadence: 'monthly', amountCents: 11900 }).ok, true);
  const used = { ...room, givenCents: 130000, roomCents: 12970 };
  assert.equal(fits(used, { cadence: 'monthly', amountCents: 6500 }).ok, false, 'November and December: $130 is over the $129.70 left');
  assert.equal(fits(used, { cadence: 'monthly', amountCents: 6400 }).ok, true);
  const running = { ...room, monthlyActiveCents: 6000 };
  assert.equal(fits(running, { cadence: 'monthly', amountCents: 6000 }).ok, false, 'beside $60 a month already, $60 more is $1,440 a year');
  assert.equal(fits(running, { cadence: 'monthly', amountCents: 5900 }).ok, true);
  const said = fits(used, { cadence: 'once', amountCents: 20000 });
  assert.match(said.message, /over this year’s \$1,429\.70 limit for contributions to the city council slate/);
  assert.ok(!/1,300|130/.test(said.message), 'never what they have given');
  assert.equal(fits({ ...room, capCents: null }, { cadence: 'once', amountCents: 99999999 }).ok, true, 'no rule known: nothing to check against');
});

test('the refund email says it plainly, without the donor’s own giving', () => {
  const once = overLimitEmail({ campaign: 'North Shore 2026', firstName: 'Mina', amountCents: 50000, paidOn: '2026-11-09', kind: 'donation', cadence: 'once' });
  assert.equal(once.subject, 'Your gift to North Shore 2026 was refunded');
  assert.match(once.text, /^Hi Mina,/);
  assert.match(once.text, /Your gift of \$500\.00 on November 9, 2026 would have taken you over this year’s limit/);
  assert.match(once.text, /refunded the full \$500\.00 to your card/);
  const dues = overLimitEmail({ campaign: 'North Shore 2026', firstName: '', amountCents: 2500, paidOn: '2026-11-09', kind: 'membership', cadence: 'once' });
  assert.equal(dues.subject, 'About your North Shore 2026 membership');
  assert.match(dues.text, /^Hello,/);
  assert.match(dues.text, /your membership hasn’t started/);
});
