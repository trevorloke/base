// Online payments, through server/ext/payments when that feature is there
// (imported lazily: it may not be). SITE.md "Payments" is its contract, in
// two steps so no write waits on Stripe:
//   prepareCheckout(tx, ctx, { personId, kind: 'donation' | 'membership',
//     amountCents, cadence, slate, declaration, successUrl, cancelUrl,
//     metadata, email }, emit) → { id }         inside the form's write
//   openCheckout(db, ctx, id, { action, also }) → { url, result }
//                                               after it: Stripe, then a short write
//   retryCheckout(tx, ctx, id, emit) → { id } | null   a retry of the same form
// and, to say whether it's set up, paymentsReady() → boolean (the site also
// takes `ready` / `isReady` / `stripeReady`, as a function or a boolean;
// with none of them, the Stripe key in the environment decides).
let mod; // undefined: not looked for yet · null: not there
let forTest = null;

const load = async () => {
  if (forTest) return forTest;
  if (mod !== undefined) return mod;
  try {
    mod = await import('../payments/index.js');
  } catch (e) {
    if (!(e?.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes('payments'))) console.error('site: payments could not load:', e.message);
    mod = null;
  }
  return mod;
};

export const paymentsReady = async () => {
  const p = await load();
  if (!p || typeof p.prepareCheckout !== 'function') return false;
  for (const k of ['paymentsReady', 'ready', 'isReady', 'stripeReady']) {
    if (typeof p[k] === 'function') return Boolean(await p[k]());
    if (typeof p[k] === 'boolean') return p[k];
  }
  return Boolean(String(process.env.STRIPE_SECRET_KEY || '').trim());
};

const payments = async (fn) => {
  const p = await load();
  if (!p || typeof p[fn] !== 'function') throw Object.assign(new Error('online payments aren’t set up'), { status: 503 });
  return p[fn];
};

// emit: the form's, so the checkout is on the event log beside its action.
export const prepareCheckout = async (tx, ctx, args, emit) => (await payments('prepareCheckout'))(tx, ctx, args, emit);
export const retryCheckout = async (tx, ctx, id, emit) => (await payments('retryCheckout'))(tx, ctx, id, emit);
export const openCheckout = async (db, ctx, id, opts) => (await payments('openCheckout'))(db, ctx, id, opts);

// Tests: stand in for ext/payments (null: back to the real one).
export const _setPaymentsForTest = (fake) => { forTest = fake; };
