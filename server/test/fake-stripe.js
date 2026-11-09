// A stand-in for Stripe, so the payment tests run with no account and no
// network (ported from apps/web/e2e/fake-stripe.mjs). Point base.win at it
// with STRIPE_API_BASE=http://127.0.0.1:<port>. It answers the API calls
// base.win makes, serves a hosted checkout page, and sends webhooks signed
// exactly as Stripe signs them.
//
//   In a test:   const fake = await startFakeStripe({ secret, deliver })
//                deliver(raw, headers) → { status, body } posts one event to
//                the webhook (in-process tests use app.request); without it
//                events go to webhookUrl with fetch.
//   On its own:  PORT=5390 WEBHOOK_URL=http://127.0.0.1:5380/stripe/webhook \
//                STRIPE_WEBHOOK_SECRET=whsec_… node server/test/fake-stripe.js
//
// The API (what base.win calls):
//   POST /v1/checkout/sessions            a session (one per idempotency key)
//   GET  /v1/checkout/sessions[/:id]      list one, or read one
//   GET  /v1/subscriptions/:id, /v1/invoices/:id
//   GET  /v1/invoice_payments?invoice=…   the invoice's payment intent
//   GET  /v1/refunds?payment_intent=…     refunds so far
//   POST /v1/refunds                      a refund (one per idempotency key)
//   GET  /v1/webhook_endpoints            what Settings → Services checks
// The hosted page (what a donor sees): GET /pay/:session → Pay, or Cancel;
// POST /pay/:session completes it, sends the webhooks, then redirects to the
// success address (a monthly gift: the checkout, then the first invoice).
// For tests, in code or over HTTP (POST /__name with JSON):
//   pay(sessionId)                        as if paid on the hosted page
//   invoice(subscriptionId, { amount })   next month's invoice, paid
//   cancel(subscriptionId)                the subscription deleted
//   refund(paymentIntent, amount?)        a refund made in the dashboard
//   dispute(paymentIntent, 'created' | 'won' | 'lost')
//   expire(sessionId)                     the checkout left to expire
//   send(type, object, { id })            any event (the same id twice = a repeat)
//   failRefunds(code | false)             POST /v1/refunds fails (503, or a 4xx code)
//   endpoints(list)                       what GET /v1/webhook_endpoints lists
//   calls · sessions · refunds · delivered   what happened
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { signPayload } from '../ext/payments/stripe.js';

const parseForm = (body) => {
  const out = {};
  for (const [k, v] of new URLSearchParams(body)) {
    const path = k.replace(/\]/g, '').split('[');
    let o = out;
    path.forEach((p, i) => {
      if (i === path.length - 1) o[p] = v;
      else o = o[p] ??= {};
    });
  }
  return out;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const now = () => Math.floor(Date.now() / 1000);
const dollars = (c) => `$${(Number(c) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

export const startFakeStripe = async ({ port = 0, secret = process.env.STRIPE_WEBHOOK_SECRET, webhookUrl = process.env.WEBHOOK_URL, deliver = null, legacy = false, apiKey = null } = {}) => {
  let n = 0;
  const next = (p) => `${p}_test_${(++n).toString().padStart(4, '0')}${Math.random().toString(36).slice(2, 6)}`;
  const calls = [];
  const sessions = new Map();
  const subscriptions = new Map();
  const invoices = new Map();
  const refunds = [];
  const delivered = [];
  const idem = new Map();
  let refundsFail = false;
  let webhookEndpoints = [];
  let base = '';

  const post = deliver || (async (raw, headers) => {
    const r = await fetch(webhookUrl, { method: 'POST', headers, body: raw });
    return { status: r.status, body: await r.json().catch(() => null) };
  });

  // One event, signed as Stripe signs it, to the webhook.
  const send = async (type, object, { id = next('evt'), created = now(), sign = true, signWith = secret, t } = {}) => {
    const event = { id, object: 'event', type, created, livemode: false, api_version: legacy ? '2024-06-20' : '2025-03-31.basil', data: { object } };
    const raw = JSON.stringify(event);
    const headers = { 'content-type': 'application/json', ...(sign ? { 'stripe-signature': signPayload(raw, signWith, t) } : {}) };
    const res = await post(raw, headers);
    delivered.push({ id, type, status: res.status, body: res.body });
    return { event, ...res };
  };

  const invoiceFor = (sub, amount) => {
    const id = next('in');
    const pi = next('pi');
    const paidAt = now();
    const inv = legacy
      ? { id, object: 'invoice', subscription: sub.id, subscription_details: { metadata: sub.metadata }, payment_intent: pi, charge: next('ch'),
          amount_paid: amount, currency: 'cad', customer: sub.customer, customer_email: sub.email, status: 'paid', status_transitions: { paid_at: paidAt } }
      : { id, object: 'invoice', parent: { type: 'subscription_details', subscription_details: { subscription: sub.id, metadata: sub.metadata } },
          amount_paid: amount, currency: 'cad', customer: sub.customer, customer_email: sub.email, status: 'paid', status_transitions: { paid_at: paidAt } };
    invoices.set(id, { ...inv, _pi: pi });
    return { inv, pi };
  };

  const complete = (s) => {
    s.status = 'complete';
    s.payment_status = 'paid';
    s.customer_details = { email: s.customer_email || 'donor@example.org' };
    if (s.mode === 'subscription') {
      const sub = { id: next('sub'), object: 'subscription', status: 'active', customer: next('cus'), metadata: s.params.subscription_data?.metadata || {},
        amount: s.amount_total, email: s.customer_details.email };
      subscriptions.set(sub.id, sub);
      s.subscription = sub.id;
      s.customer = sub.customer;
    } else {
      s.payment_intent = next('pi');
    }
    return s;
  };

  const sessionOut = (s) => {
    const { params, ...rest } = s;
    return rest;
  };

  const api = {
    calls, sessions, refunds, delivered, subscriptions, invoices,
    get url() { return base; },
    send,
    // Paid, but nothing sent yet (to deliver events out of order).
    complete: (sessionId) => sessionOut(complete(sessions.get(sessionId))),
    // As if the donor paid on the hosted page.
    pay: async (sessionId) => {
      const s = sessions.get(sessionId);
      if (!s) throw new Error(`no such session ${sessionId}`);
      if (s.status !== 'complete') complete(s);
      const out = [await send('checkout.session.completed', sessionOut(s))];
      if (s.mode === 'subscription') {
        const sub = subscriptions.get(s.subscription);
        const { inv } = invoiceFor(sub, s.amount_total);
        sub.firstInvoice = inv.id;
        out.push(await send('invoice.paid', inv));
      }
      return out;
    },
    invoice: async (subscriptionId, { amount } = {}) => {
      const sub = subscriptions.get(subscriptionId);
      if (!sub) throw new Error(`no such subscription ${subscriptionId}`);
      const { inv, pi } = invoiceFor(sub, amount ?? sub.amount);
      const r = await send('invoice.paid', inv);
      return { ...r, invoice: inv, paymentIntent: pi };
    },
    cancel: async (subscriptionId) => {
      const sub = subscriptions.get(subscriptionId);
      sub.status = 'canceled';
      return send('customer.subscription.deleted', { ...sub, object: 'subscription' });
    },
    expire: async (sessionId) => {
      const s = sessions.get(sessionId);
      s.status = 'expired';
      return send('checkout.session.expired', sessionOut(s));
    },
    // A refund made in Stripe's dashboard (the whole payment unless an amount).
    refund: async (paymentIntent, amount = null) => {
      const total = api.amountOf(paymentIntent);
      const already = refunds.filter((r) => r.payment_intent === paymentIntent).reduce((x, r) => x + r.amount, 0);
      const amt = amount ?? total - already;
      refunds.push({ id: next('re'), object: 'refund', status: 'succeeded', amount: amt, payment_intent: paymentIntent, metadata: {} });
      const refunded = already + amt;
      return send('charge.refunded', { id: next('ch'), object: 'charge', payment_intent: paymentIntent, amount: total, amount_refunded: refunded, refunded: refunded >= total, refunds: { data: [refunds.at(-1)] } });
    },
    dispute: async (paymentIntent, status = 'created', { id } = {}) => {
      const d = { id: id || next('dp'), object: 'dispute', charge: next('ch'), payment_intent: paymentIntent, amount: api.amountOf(paymentIntent), reason: 'fraudulent',
        status: status === 'created' ? 'needs_response' : status, evidence_details: { due_by: now() + 7 * 86400 } };
      return send(status === 'created' ? 'charge.dispute.created' : 'charge.dispute.closed', d);
    },
    // How much a payment intent was for (a session's total, or an invoice's).
    amountOf: (pi) => {
      for (const s of sessions.values()) if (s.payment_intent === pi) return s.amount_total;
      for (const i of invoices.values()) if (i._pi === pi || i.payment_intent === pi) return i.amount_paid;
      return 0;
    },
    failRefunds: (v) => { refundsFail = v; },
    endpoints: (list) => { webhookEndpoints = list; },
    reset: () => { calls.length = 0; delivered.length = 0; },
  };

  const page = (s) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Test checkout</title><style>
body{margin:0;font:17px/1.5 system-ui,sans-serif;background:#f6f8fa;color:#1a1f36}main{max-width:480px;margin:0 auto;padding:28px 16px}
.card{background:#fff;border:1px solid #e3e8ee;border-radius:12px;padding:20px}h1{font-size:22px;margin:0 0 4px}.amt{font-size:32px;font-weight:700;margin:8px 0 16px}
.note{color:#4f566b;font-size:15px}button{width:100%;min-height:52px;border:0;border-radius:8px;background:#635bff;color:#fff;font:600 18px system-ui,sans-serif;cursor:pointer}
a{display:inline-block;margin-top:16px;min-height:48px;line-height:48px;color:#635bff}
</style></head><body><main><p class="note">Stripe test mode — a stand-in page</p><div class="card">
<h1>${esc(s.params.line_items?.['0']?.price_data?.product_data?.name || 'Payment')}</h1>
<div class="amt">${esc(dollars(s.amount_total))}${s.mode === 'subscription' ? ' a month' : ''}</div>
<p class="note">${esc(s.customer_email || '')}</p>
<form method="post" action="/pay/${esc(s.id)}"><button type="submit">${s.mode === 'subscription' ? 'Subscribe' : 'Pay'}</button></form>
<a href="${esc(s.cancel_url)}">Back</a></div></main></body></html>`;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const isJson = (req.headers['content-type'] || '').includes('application/json');
      const params = isJson ? (body ? JSON.parse(body) : {}) : parseForm(body);
      const key = req.headers['idempotency-key'] || null;
      calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), params, idem: key, auth: req.headers.authorization || null });
      const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      const notFound = (what) => json({ error: { type: 'invalid_request_error', code: 'resource_missing', message: `No such ${what}` } }, 404);
      try {
        // ── Test controls ──
        if (url.pathname === '/__log') return json(calls);
        if (url.pathname === '/__sessions') return json([...sessions.values()].map(sessionOut));
        if (url.pathname === '/__delivered') return json(delivered);
        if (req.method === 'POST' && url.pathname.startsWith('/__')) {
          const name = url.pathname.slice(3);
          const fn = { pay: () => api.pay(params.session), invoice: () => api.invoice(params.subscription, params), cancel: () => api.cancel(params.subscription),
            refund: () => api.refund(params.payment_intent, params.amount ?? null), dispute: () => api.dispute(params.payment_intent, params.status),
            expire: () => api.expire(params.session), send: () => send(params.type, params.object, params), failRefunds: () => api.failRefunds(params.fail ?? false),
            endpoints: () => api.endpoints(params.list || []) }[name];
          if (!fn) return notFound('control');
          return json({ ok: true, result: await fn() ?? null });
        }
        // The API wants a secret key (the one it was given, when given one).
        const auth = req.headers.authorization || '';
        if (url.pathname.startsWith('/v1/') && (!/^Bearer (sk|rk)_(test|live)_/.test(auth) || (apiKey && auth !== `Bearer ${apiKey}`))) {
          return json({ error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } }, 401);
        }

        // ── The hosted checkout page ──
        let m = url.pathname.match(/^\/pay\/([^/]+)$/);
        if (m) {
          const s = sessions.get(m[1]);
          if (!s) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<h1>No such checkout</h1>'); }
          if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(page(s)); }
          if (s.status !== 'complete') await api.pay(s.id);
          res.writeHead(303, { location: s.success_url.replace('{CHECKOUT_SESSION_ID}', s.id) });
          return res.end();
        }

        // ── The API ──
        if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
          if (key && idem.has(key)) return json(sessionOut(idem.get(key)));
          const id = next('cs');
          const items = Object.values(params.line_items ?? {});
          const amount_total = items.reduce((t, li) => t + Number(li.price_data.unit_amount) * Number(li.quantity), 0);
          const s = {
            id, object: 'checkout.session', url: `${base}/pay/${id}`, mode: params.mode, metadata: params.metadata ?? {},
            client_reference_id: params.client_reference_id ?? null, customer_email: params.customer_email ?? null,
            amount_total, currency: 'cad', status: 'open', payment_status: 'unpaid', success_url: params.success_url, cancel_url: params.cancel_url,
            expires_at: Number(params.expires_at) || now() + 86400, params,
          };
          sessions.set(id, s);
          if (key) idem.set(key, s);
          return json(sessionOut(s));
        }
        if (req.method === 'GET' && url.pathname === '/v1/checkout/sessions') return json({ object: 'list', has_more: false, data: [...sessions.values()].slice(-1).map(sessionOut) });
        m = url.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
        if (m) return sessions.has(m[1]) ? json(sessionOut(sessions.get(m[1]))) : notFound('checkout.session');
        m = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/);
        if (m) return subscriptions.has(m[1]) ? json(subscriptions.get(m[1])) : notFound('subscription');
        m = url.pathname.match(/^\/v1\/invoices\/([^/]+)$/);
        if (m) {
          const inv = invoices.get(m[1]);
          if (!inv) return notFound('invoice');
          const { _pi, ...out } = inv;
          return json(out);
        }
        if (req.method === 'GET' && url.pathname === '/v1/invoice_payments') {
          const inv = invoices.get(url.searchParams.get('invoice'));
          return json({ object: 'list', has_more: false, data: inv ? [{ id: next('inpay'), object: 'invoice_payment', status: 'paid', payment: { type: 'payment_intent', payment_intent: inv._pi } }] : [] });
        }
        if (req.method === 'GET' && url.pathname === '/v1/refunds') {
          const pi = url.searchParams.get('payment_intent');
          return json({ object: 'list', has_more: false, data: refunds.filter((r) => !pi || r.payment_intent === pi) });
        }
        if (req.method === 'POST' && url.pathname === '/v1/refunds') {
          if (refundsFail) {
            if (typeof refundsFail === 'string') return json({ error: { type: 'invalid_request_error', code: refundsFail, message: `Simulated: ${refundsFail}` } }, 400);
            return json({ error: { type: 'api_error', message: 'Simulated outage' } }, 503);
          }
          if (key && idem.has(key)) return json(idem.get(key));
          const refund = { id: next('re'), object: 'refund', status: 'succeeded', amount: Number(params.amount), payment_intent: params.payment_intent, metadata: params.metadata ?? {} };
          refunds.push(refund);
          if (key) idem.set(key, refund);
          return json(refund);
        }
        if (req.method === 'GET' && url.pathname === '/v1/webhook_endpoints') return json({ object: 'list', has_more: false, data: webhookEndpoints });
        return json({ error: { message: `unhandled ${req.method} ${url.pathname}` } }, 404);
      } catch (e) {
        return json({ error: { type: 'api_error', message: String(e.message) } }, 500);
      }
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  api.close = () => new Promise((r) => server.close(r));
  api.port = server.address().port;
  return api;
};

// On its own: the e2e suite runs it next to a server.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const fake = await startFakeStripe({ port: Number(process.env.PORT) || 12111 });
  console.log(`fake stripe on ${fake.url}`);
}
