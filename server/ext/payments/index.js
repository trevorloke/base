// Online payments with Stripe — gifts once or monthly and membership dues,
// taken on Stripe's own page from the campaign's website. SITE.md
// ("Payments") is the contract; INTEGRATIONS.md and GOING-LIVE.md say how
// to set it up.
//
//   stripe.js    settings, Stripe over plain fetch, the webhook signature,
//                readers for both API-version shapes
//   checkout.js  checkoutFor(tx, ctx, {...}, emit?) → { url } — the site's
//                join and donate forms call it; paymentsData() for its loaders
//   limits.js    what a person may still give this year on a slate
//   webhook.js   POST /stripe/webhook (public, signed, each event once)
//   apply.js     what an event does to the books: gifts through the normal
//                gift path (limit, flags, receipt), monthly pledges,
//                memberships, refunds and disputes
//   refunds.js   the refund of a payment that landed over the limit, and
//                the donor's email (a job: after the commit, with retries)
//   api.js       GET /api/payments — Donations' online side
//   actions.js   payment.ack — a treasurer's "Got it"
//   service.js   Stripe on Settings → Services (ext/connections)
//
// Keys only in the host's environment: STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET (STRIPE_API_BASE for tests).
import { REFUND_JOB } from './apply.js';
import { runRefundJob } from './refunds.js';

export { sql } from './sql.js';
export { publicRoutes } from './webhook.js';
export { api, deskOnlyReads } from './api.js';
export { actions } from './actions.js';
export { checkoutFor, paymentsData, DECLARATION, DUES } from './checkout.js';
export { paymentsReady, stripeMode, STRIPE_EVENTS } from './stripe.js';

export const jobs = { [REFUND_JOB]: runRefundJob };
// In the full export: every checkout (the declaration as made) and payment.
export const exportTables = ['stripe_checkouts', 'stripe_payments'];
