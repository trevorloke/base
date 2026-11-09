// Online payments, through server/ext/payments when that feature is there
// (imported lazily: it may not be). SITE.md "Payments" is its contract:
//   checkoutFor(tx, ctx, { personId, kind: 'donation' | 'membership',
//     amountCents, cadence, slate, declaration, successUrl, cancelUrl,
//     metadata }) → { url }
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
  if (!p || typeof p.checkoutFor !== 'function') return false;
  for (const k of ['paymentsReady', 'ready', 'isReady', 'stripeReady']) {
    if (typeof p[k] === 'function') return Boolean(await p[k]());
    if (typeof p[k] === 'boolean') return p[k];
  }
  return Boolean(String(process.env.STRIPE_SECRET_KEY || '').trim());
};

export const checkout = async (tx, ctx, args) => {
  const p = await load();
  if (!p || typeof p.checkoutFor !== 'function') throw Object.assign(new Error('online payments aren’t set up'), { status: 503 });
  return p.checkoutFor(tx, ctx, args);
};

// Tests: stand in for ext/payments (null: back to the real one).
export const _setPaymentsForTest = (fake) => { forTest = fake; };
