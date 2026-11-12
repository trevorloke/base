// Stripe over plain fetch — no SDK, no new dependency. Everything here is a
// leaf: settings, one request helper, the webhook signature, and readers for
// the objects Stripe sends (whose shape moved between API versions).
//
//   STRIPE_SECRET_KEY      sk_live_… / sk_test_… (or a restricted rk_…) —
//                          the host's environment only, never the repo
//   STRIPE_WEBHOOK_SECRET  whsec_… from Stripe → Developers → Webhooks → the
//                          endpoint (a comma list while one is being rolled)
//   STRIPE_API_BASE        tests only: a stand-in for api.stripe.com
//
// A test key is test mode: Stripe moves no real money, and the desk says so.
import { TOLERANCE_S, signPayload, verifySignature as verifyTimed } from '../../lib/signature.js';

const env = (k) => String(process.env[k] || '').trim();
export const secretKey = () => env('STRIPE_SECRET_KEY');
export const webhookSecrets = () => env('STRIPE_WEBHOOK_SECRET').split(',').map((s) => s.trim()).filter(Boolean);
export const apiBase = () => (env('STRIPE_API_BASE') || 'https://api.stripe.com').replace(/\/+$/, '');

// 'live' | 'test' | null (no key). A key of another shape is treated as live:
// the desk never calls real money a test.
export const stripeMode = () => {
  const k = secretKey();
  if (!k) return null;
  return /^(sk|rk)_test_/.test(k) ? 'test' : 'live';
};

// Both keys: a checkout we could never hear back from is not offered.
export const paymentsReady = () => Boolean(secretKey() && webhookSecrets().length);

// The events the webhook acts on — what to tick in Stripe (Settings → Services
// and INTEGRATIONS.md list them).
export const STRIPE_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'invoice.paid',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
];

// Stripe's form encoding: { a: { b: [{ c: 1 }] } } → a[b][0][c]=1.
export const formEncode = (obj, prefix = '', out = new URLSearchParams()) => {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (item !== null && typeof item === 'object' ? formEncode(item, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
};

// param: the request field Stripe says no to (customer_email, …), when it says.
export class StripeError extends Error {
  constructor(message, { status = 0, code = null, type = null, param = null } = {}) {
    super(message);
    this.name = 'StripeError';
    this.httpStatus = status;
    this.code = code;
    this.type = type;
    this.param = param;
  }
}

// One call to Stripe. `params` go in the body (POST); `query` in the URL.
// A retry of a write with the same idempotency key is answered, not repeated.
// Never a key in an error message.
export const stripeRequest = async (method, path, { params, query, idempotencyKey, timeoutMs = 10_000 } = {}) => {
  const qs = query ? formEncode(query).toString() : '';
  const url = `${apiBase()}/v1${path}${qs ? `?${qs}` : ''}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${secretKey()}`,
        ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 255) } : {}),
      },
      body: params ? formEncode(params).toString() : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new StripeError(timedOut ? `Stripe didn’t answer in ${Math.round(timeoutMs / 1000)} s` : `Stripe couldn’t be reached (${String(e?.message || e).slice(0, 120)})`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body?.error || {};
    throw new StripeError(String(err.message || `Stripe answered ${res.status}`).slice(0, 300), { status: res.status, code: err.code || null, type: err.type || null, param: err.param || null });
  }
  return body;
};

// ── The webhook's signature ──
// Stripe-Signature: t=<seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">[,v1=…].
// The check itself is lib/signature.js (a ladder's "Send to a web address"
// signs the same way); here it is asked with Stripe's secrets.
export { TOLERANCE_S, signPayload };
export const verifySignature = (raw, header, secrets = webhookSecrets(), opts) => verifyTimed(raw, header, secrets, opts);

// ── Reading what Stripe sends, in either API-version shape ──
export const idOf = (v) => (typeof v === 'string' ? v : (v && typeof v === 'object' && typeof v.id === 'string' ? v.id : null));

// When Stripe says it happened (seconds), not when we got round to it.
export const eventTime = (event) => (Number(event?.created) > 0 ? new Date(Number(event.created) * 1000) : new Date());

// Which subscription an invoice belongs to and the metadata copied onto it:
// invoice.parent.subscription_details (API versions from 2025-03-31), or
// invoice.subscription + invoice.subscription_details before that. known:
// false when the object shows neither (re-read it from Stripe).
export const invoiceSubscription = (invoice) => {
  const modern = invoice?.parent?.subscription_details;
  if (modern) return { subscriptionId: idOf(modern.subscription), metadata: modern.metadata || null, known: true };
  if (invoice && (invoice.subscription !== undefined || invoice.subscription_details !== undefined)) {
    return { subscriptionId: idOf(invoice.subscription), metadata: invoice.subscription_details?.metadata || null, known: true };
  }
  return { subscriptionId: null, metadata: null, known: invoice?.parent !== undefined };
};

// The payment intent an invoice was paid with, when the object carries it
// (older versions: invoice.payment_intent; newer: an expanded payments list).
export const invoicePaymentIntent = (invoice) => {
  const legacy = idOf(invoice?.payment_intent);
  if (legacy) return legacy;
  const list = invoice?.payments?.data || [];
  const paid = list.find((p) => p?.status === 'paid') || list[0];
  return idOf(paid?.payment?.payment_intent);
};

// The payment intent and charge a refund or a dispute is about.
export const chargeRefs = (obj) => ({
  paymentIntent: idOf(obj?.payment_intent),
  charge: obj?.object === 'charge' ? obj.id : idOf(obj?.charge),
});
