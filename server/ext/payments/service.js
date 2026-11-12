// Stripe on Settings → Services (ext/connections lists it): set up, not set
// up, or test mode; the webhook address to paste into Stripe and the events
// to tick; and Check — one real read from Stripe (the webhook endpoints),
// never a charge, never a write.
import { stripeMode, secretKey, webhookSecrets, stripeRequest, StripeError, STRIPE_EVENTS } from './stripe.js';

const NEEDS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
const has = (k) => Boolean(String(process.env[k] || '').trim());
export const webhookUrl = (base) => `${String(base || '').replace(/\/+$/, '')}/stripe/webhook`;

export const stripeService = (base) => {
  const missing = NEEDS.filter((k) => !has(k));
  const mode = stripeMode();
  return {
    key: 'stripe',
    name: 'Online payments (Stripe)',
    for: 'Gifts once or monthly and membership dues on the website — card, Apple Pay, Google Pay — with the limit checked and the receipt sent by itself',
    launch: false,
    missing,
    set: NEEDS.filter(has),
    state: missing.length ? 'missing' : mode === 'test' ? 'test' : 'ready',
    detail: missing.length
      ? 'Not set up: the website’s donate and join forms say online payments aren’t ready yet'
      : mode === 'test'
        ? 'Test mode — no real money moves; pay with Stripe’s test cards. Live keys take real gifts.'
        : 'Live — gifts are real money',
    checkable: true,
    webhook: { url: webhookUrl(base), events: STRIPE_EVENTS, where: 'Stripe: Developers → Webhooks → Add endpoint' },
  };
};

export const checkStripe = async (base) => {
  if (!secretKey()) return { ok: false, said: 'STRIPE_SECRET_KEY isn’t set' };
  const modeWord = stripeMode() === 'test' ? 'test mode' : 'live';
  const want = webhookUrl(base);
  try {
    const list = await stripeRequest('GET', '/webhook_endpoints', { query: { limit: 100 }, timeoutMs: 8000 });
    const ep = (list?.data || []).find((e) => String(e?.url || '').replace(/\/+$/, '') === want);
    if (!ep) return { ok: false, said: `The key works (${modeWord}), but no webhook in Stripe sends to ${want} — add it` };
    if (ep.status && ep.status !== 'enabled') return { ok: false, said: `The webhook to ${want} is ${ep.status} in Stripe — turn it back on` };
    const events = ep.enabled_events || [];
    const lacking = events.includes('*') ? [] : STRIPE_EVENTS.filter((e) => !events.includes(e));
    if (lacking.length) return { ok: false, said: `The webhook is there, but it doesn’t send ${lacking.join(', ')}` };
    if (!webhookSecrets().length) return { ok: false, said: 'The key and the webhook are right; set STRIPE_WEBHOOK_SECRET to the webhook’s signing secret' };
    return { ok: true, said: `The key works (${modeWord}) and the webhook sends every event base.win needs` };
  } catch (e) {
    if (e instanceof StripeError && e.httpStatus === 401) return { ok: false, said: 'Stripe refused the key' };
    if (e instanceof StripeError && e.httpStatus === 403) {
      // A restricted key that can't read webhook settings: can it open checkouts?
      try {
        await stripeRequest('GET', '/checkout/sessions', { query: { limit: 1 }, timeoutMs: 8000 });
        return { ok: true, said: `The key works (${modeWord}); it can’t read webhook settings, so check the webhook in Stripe` };
      } catch (e2) {
        return { ok: false, said: `Stripe refused: ${String(e2.message).slice(0, 160)}` };
      }
    }
    return { ok: false, said: `Stripe didn’t answer: ${String(e.message).slice(0, 160)}` };
  }
};
