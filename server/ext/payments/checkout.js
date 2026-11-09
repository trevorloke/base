// Checkouts: a gift (once or monthly) or membership dues, paid on Stripe's
// own page — the card (or Apple Pay / Google Pay) is taken there, never
// here — for someone already recorded (the website's join and donate forms
// record the person first; SITE.md). Two steps, so no write ever waits on
// Stripe (a write holds the campaign's lock from start to commit: a slow
// Stripe inside one would stall every door knock and desk edit behind it):
//
//   prepareCheckout(tx, ctx, opts, emit?) → { id, mode }
//     inside the caller's write (the form's runAction): the checks, then the
//     checkout kept — stripe_checkouts, status open, no session yet, with
//     the request Stripe will be sent — and on the event log
//     (payment_checkout). Database only. A refusal leaves nothing behind.
//   openCheckout(db, ctx, id, { action, also }?) → { url, id, session_id, mode, result }
//     after that write has committed, outside any transaction: Stripe is
//     asked for its page (10 s at most) under the idempotency key
//     base-checkout-<id>, with the request as it was kept — so, asked again,
//     Stripe answers with the same page — then a short write keeps the
//     session id and runs also(tx, emit, { url, session_id }) in that same
//     write (the site keeps what the visitor is told there; its answer is
//     `result`). Stripe saying no marks the checkout failed; no or no
//     answer, a 503 — but a no to the email typed is a 400 on 'email'.
//   retryCheckout(tx, ctx, id, emit?) → { id } | null
//     a checkout kept but not opened, made ready to be asked again: as it
//     was while Stripe may still answer with its page; after Stripe said no,
//     or when it waited too long to be sent (Stripe wants the expiry at
//     least 30 minutes ahead), with a fresh expiry under a new key
//     (base-checkout-<id>-<try>). One checkout per form sent, however many
//     tries. null: nothing to ask again.
//
//   opts: { personId, kind: 'donation' | 'membership', amountCents,
//     cadence: 'once' | 'monthly', slate, declaration, successUrl, cancelUrl,
//     metadata, email,
//     term: 1 | 4, birthDate: 'YYYY-MM-DD', citizenship: 'citizen' | 'pr' }   // membership
//
// Before anything is kept: online payments are set up; the eligibility
// declaration was made (true — the website's own words for that kind,
// shared/site/wording.js — or the words the visitor ticked); membership dues
// are at least the minimum; the amount is one anyone may give this year (the
// year's limit at once, or a twelfth of it a month). What this person may
// still give (limits.js — the desk's own rule, with the monthly gifts they
// already have running) is checked only for someone signed in, who may see
// what a person gave: a website visitor is never refused for what someone
// gave before — the form would tell a stranger — so that is checked when
// the money lands, and refunded if over (apply.js). Each refusal is an Error
// with .status (400, or 503 when payments aren't set up or Stripe didn't
// answer) and .field (the form field to point at), in words a visitor reads.
//
// The email Stripe's page starts with is the one the visitor typed
// (opts.email), never the one on file: whoever a form matched, their email
// is not the visitor's to read.
//
// Everything needed to finish later is kept in stripe_checkouts (who, what,
// the declaration as made, the site's own metadata) and rides on the session
// as metadata (our checkout's id and the campaign's): the webhook needs
// nothing else, and finds a checkout by that id whether or not its session
// was kept yet.
import { newId, runAction } from '../../lib/events.js';
import { capFor } from '../../lib/cap.js';
import { SLATE_CODES, DEFAULT_SLATE, slateLabel } from '@starbase/shared/canvass';
import { DONATE_DECLARATION, JOIN_DECLARATION } from '../../../shared/site/wording.js';
import { stripeRequest, stripeMode, paymentsReady, StripeError } from './stripe.js';
import { roomFor, fits, campaignNow, monthlyMax, money } from './limits.js';

// The declaration a contributor makes, in the website's own words (the
// donate form's; membership dues: JOIN_DECLARATION).
export const DECLARATION = DONATE_DECLARATION;
// Membership dues, as on the paper form (ext/membership): at least $10 a
// year, $5 for members aged 14 to 30 on the day they join; members are 14
// or older.
export const DUES = { adult_cents: 1000, youth_cents: 500, youth_ages: [14, 30], min_age: 14 };
export const MIN_CENTS = 100;
export const MAX_CENTS = 10_000_000;
// Stripe's shortest Checkout life is 30 minutes; a little more so a slow
// request is never refused. A checkout left open frees nothing (open ones
// aren't counted against the limit) but expires soon.
const CHECKOUT_MINUTES = 35;
// Stripe wants the expiry at least 30 minutes after it makes the page.
const SEND_BY_S = 31 * 60;

export const payError = (status, message, field = null) => {
  const e = new Error(message);
  e.status = status;
  if (field) e.field = field;
  return e;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const absolute = (u) => typeof u === 'string' && u.length <= 2000 && /^https?:\/\/[^\s/]+/i.test(u);
const ageOn = (birth, day) => {
  const [by, bm, bd] = birth.split('-').map(Number);
  const [y, m, d] = day.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
};
const parseJson = (v, d) => (typeof v === 'string' ? JSON.parse(v) : (v ?? d));
const nowS = () => Math.floor(Date.now() / 1000);
const wsIdOf = (ctx) => ctx?.workspaceId || ctx?.workspace?.id || null;
const sayOf = (ctx, emit) => (typeof emit === 'function' ? emit : (typeof ctx?.emit === 'function' ? ctx.emit : null));

// The campaign as it is now (name, jurisdiction, settings), whatever the
// caller's ctx carries.
export const workspaceOf = async (q, ctx) => {
  const id = wsIdOf(ctx);
  const ws = id ? (await q.query('select id, name, jurisdiction, settings from workspaces where id = $1', [id])).rows[0] : null;
  if (!ws) throw payError(400, 'campaign not found');
  return { ...ws, settings: parseJson(ws.settings, {}) };
};

// The declaration as it was made: the words ticked (the form may send its
// own), when, and that it came from the website.
const declarationOf = (d, kind) => {
  const ours = kind === 'membership' ? JOIN_DECLARATION : DONATE_DECLARATION;
  if (d === true || d === 'true' || d === 'on' || d === '1') return { text: ours };
  if (typeof d === 'string' && d.trim().length >= 10) return { text: d.trim().slice(0, 1000) };
  if (d && typeof d === 'object' && d.agreed !== false) {
    const text = typeof d.text === 'string' && d.text.trim().length >= 10 ? d.text.trim().slice(0, 1000) : ours;
    return { text };
  }
  return null;
};

// The site's own context for the record (page, module, source, referrer…):
// small and flat, never anything that decides money.
const metadataOf = (m) => {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
  const out = {};
  for (const [k, v] of Object.entries(m).slice(0, 20)) {
    if (!/^[a-z0-9_]{1,40}$/i.test(k)) continue;
    if (['string', 'number', 'boolean'].includes(typeof v) || v === null) out[k] = typeof v === 'string' ? v.slice(0, 300) : v;
  }
  return out;
};

// What Stripe is asked for, made once and kept with the checkout: asked
// again under the same key, Stripe must be sent exactly the same.
const requestFor = ({ id, ws, kind, cadence, amountCents, term, email, successUrl, cancelUrl }) => {
  const monthly = cadence === 'monthly';
  const name = kind === 'membership'
    ? `${ws.name} membership (${term} year${term > 1 ? 's' : ''})`
    : `${monthly ? 'Monthly contribution' : 'Contribution'} to ${ws.name}`;
  const meta = { base_checkout: id, base_workspace: ws.id, base_kind: kind };
  return {
    mode: monthly ? 'subscription' : 'payment',
    client_reference_id: id,
    success_url: successUrl,
    cancel_url: cancelUrl,
    locale: 'auto',
    expires_at: nowS() + CHECKOUT_MINUTES * 60,
    line_items: [{
      quantity: 1,
      price_data: {
        currency: 'cad',
        unit_amount: amountCents,
        product_data: { name },
        ...(monthly ? { recurring: { interval: 'month' } } : {}),
      },
    }],
    metadata: meta,
    ...(EMAIL.test(email) ? { customer_email: email } : {}),
    ...(monthly
      ? { subscription_data: { metadata: meta, description: name } }
      : { submit_type: kind === 'donation' ? 'donate' : 'pay', payment_intent_data: { metadata: meta, description: name } }),
  };
};

export const prepareCheckout = async (tx, ctx, opts = {}, emit = null) => {
  if (!paymentsReady()) throw payError(503, 'Online payments aren’t set up yet.');
  const say = sayOf(ctx, emit);
  const ws = await workspaceOf(tx, ctx);

  // ── What is asked for ──
  const kind = opts.kind === 'membership' ? 'membership' : opts.kind === 'donation' || opts.kind == null ? 'donation' : null;
  if (!kind) throw payError(400, 'kind: donation or membership');
  const cadence = opts.cadence == null || opts.cadence === 'once' || opts.cadence === 'one-time' ? 'once' : opts.cadence === 'monthly' ? 'monthly' : null;
  if (!cadence) throw payError(400, 'Choose once or monthly.', 'cadence');
  if (kind === 'membership' && cadence !== 'once') throw payError(400, 'Membership dues are paid once.', 'cadence');
  const amountCents = Number(opts.amountCents);
  if (!Number.isInteger(amountCents) || amountCents < MIN_CENTS) throw payError(400, `The smallest amount we can take online is ${money(MIN_CENTS)}.`, 'amount_cents');
  if (amountCents > MAX_CENTS) throw payError(400, 'That amount is too large.', 'amount_cents');
  const slate = opts.slate == null || opts.slate === '' ? DEFAULT_SLATE : String(opts.slate);
  if (!SLATE_CODES.includes(slate)) throw payError(400, 'Choose who the gift is for.', 'slate');
  const declaration = declarationOf(opts.declaration, kind);
  if (!declaration) throw payError(400, 'Please confirm you can give: tick the declaration.', 'declaration');
  if (!absolute(opts.successUrl) || !absolute(opts.cancelUrl)) throw payError(400, 'successUrl and cancelUrl: full https addresses');
  const metadata = metadataOf(opts.metadata);
  const email = String(opts.email || '').trim().toLowerCase();

  // Membership: the term, the minimum (youth rate from the birth date), the age.
  const { day, year } = campaignNow(ws);
  let term = null;
  let birthDate = null;
  let citizenship = null;
  if (kind === 'membership') {
    term = Number(opts.term ?? metadata.term ?? 1);
    if (term !== 1 && term !== 4) throw payError(400, 'Choose 1 or 4 years.', 'term');
    const b = opts.birthDate ?? opts.birth_date ?? null;
    if (b != null && b !== '') {
      if (!DAY.test(String(b)) || Number.isNaN(Date.parse(`${b}T00:00:00Z`))) throw payError(400, 'Your birth date, as YYYY-MM-DD.', 'birth_date');
      birthDate = String(b);
      if (ageOn(birthDate, day) < DUES.min_age) throw payError(400, `Members are ${DUES.min_age} or older.`, 'birth_date');
    }
    const cz = opts.citizenship ?? null;
    if (cz != null && cz !== '' && cz !== 'citizen' && cz !== 'pr') throw payError(400, 'Canadian citizen or permanent resident.', 'citizenship');
    citizenship = cz || null;
    const age = birthDate ? ageOn(birthDate, day) : null;
    const youth = age != null && age >= DUES.youth_ages[0] && age <= DUES.youth_ages[1];
    const minimum = term * (youth ? DUES.youth_cents : DUES.adult_cents);
    if (amountCents < minimum) {
      throw payError(400, `The smallest membership is ${money(minimum)} for ${term} year${term > 1 ? 's' : ''}${youth ? ' (aged 14 to 30)' : ''}.`, 'amount_cents');
    }
  }

  // ── Who ──
  const person = opts.personId
    ? (await tx.query('select id from persons where id = $1 and workspace_id = $2 and deleted_at is null', [opts.personId, ws.id])).rows[0]
    : null;
  if (!person) throw payError(400, 'person not found — record them first', 'person');

  // ── The limit ──
  if (ctx?.user) {
    // Someone signed in (the desk may see what a person gave): what this
    // person may still give this year on that slate.
    const room = await roomFor(tx, ws, person.id, slate);
    if (cadence === 'monthly' && room.capCents != null && amountCents > monthlyMax(room.capCents)) {
      throw payError(400, `The most a monthly gift can be this year is ${money(monthlyMax(room.capCents))}.`, 'amount_cents');
    }
    const fit = fits(room, { cadence, amountCents });
    if (!fit.ok) throw payError(400, fit.message, 'amount_cents');
  } else {
    // A visitor: only what no one may give.
    const rule = await capFor(tx, ws.jurisdiction, year, ws.settings || {});
    const capCents = rule ? Number(rule.capCents) : null;
    if (capCents != null && cadence === 'monthly' && amountCents > monthlyMax(capCents)) {
      throw payError(400, `The most a monthly gift can be this year is ${money(monthlyMax(capCents))}.`, 'amount_cents');
    }
    if (capCents != null && cadence === 'once' && amountCents > capCents) {
      throw payError(400, `That’s more than this year’s ${money(capCents)} limit for contributions to the ${slateLabel(slate).toLowerCase()} slate. Try a smaller amount.`, 'amount_cents');
    }
  }

  // ── Kept; Stripe is asked once this write is done (openCheckout) ──
  const id = newId();
  const mode = stripeMode();
  const made = { ...declaration, at: new Date().toISOString(), source: 'website', ...(citizenship ? { citizenship } : {}) };
  const request = requestFor({ id, ws, kind, cadence, amountCents, term, email, successUrl: opts.successUrl, cancelUrl: opts.cancelUrl });
  await tx.query(
    `insert into stripe_checkouts (id, workspace_id, person_id, kind, cadence, amount_cents, slate, term_years, birth_date, citizenship,
                                   declaration, metadata, mode, request)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [id, ws.id, person.id, kind, cadence, amountCents, slate, term, birthDate, citizenship,
     JSON.stringify(made), JSON.stringify(metadata), mode, JSON.stringify(request)],
  );
  say?.('payment_checkout', id, 'create', {
    person_id: person.id, kind, cadence, amount_cents: amountCents, slate, mode,
    ...(term ? { term_years: term } : {}), declaration: made,
  });
  return { id, mode };
};

export const retryCheckout = async (tx, ctx, id, emit = null) => {
  const say = sayOf(ctx, emit);
  const wsId = wsIdOf(ctx);
  const co = (await tx.query(
    'select id, status, session_id, request, tries from stripe_checkouts where id = $1 and workspace_id = $2 for update', [id, wsId],
  )).rows[0];
  const request = co ? parseJson(co.request, null) : null;
  if (!request) return null;
  // Stripe made its page: asked again under the same key, it answers with it.
  if (co.session_id) return co.status === 'open' ? { id } : null;
  // No answer yet, and still in time: asked again as it was (had Stripe made
  // the page after all, the same key finds it).
  if (co.status === 'open' && Number(request.expires_at) - nowS() >= SEND_BY_S) return { id };
  // Never opened: Stripe said no, or no page came back in time (or one we
  // never heard of has expired since) — made afresh.
  if (!['open', 'failed', 'expired'].includes(co.status)) return null;
  const tries = Number(co.tries || 0) + 1;
  const next = { ...request, expires_at: nowS() + CHECKOUT_MINUTES * 60 };
  await tx.query(
    `update stripe_checkouts set request = $3, tries = $4, status = 'open', updated_at = now() where id = $1 and workspace_id = $2`,
    [id, wsId, JSON.stringify(next), tries],
  );
  say?.('payment_checkout', id, 'update', { status: 'open', tries });
  return { id };
};

export const openCheckout = async (db, ctx, id, { action = 'payment.checkout', also = null } = {}) => {
  const wsId = wsIdOf(ctx);
  const co = (await db.query('select id, status, request, tries, mode from stripe_checkouts where id = $1 and workspace_id = $2', [id, wsId])).rows[0];
  const request = co ? parseJson(co.request, null) : null;
  if (!request) throw payError(400, 'checkout not found');
  const unanswered = () => payError(503, 'The payment service didn’t answer. Please try again in a minute.');
  if (co.status !== 'open') throw unanswered();
  const tries = Number(co.tries) || 0;
  let session;
  try {
    session = await stripeRequest('POST', '/checkout/sessions', { idempotencyKey: tries ? `base-checkout-${id}-${tries}` : `base-checkout-${id}`, params: request });
    if (!session?.id || !session?.url) throw new StripeError('Stripe answered without a checkout page', { status: 502 });
  } catch (e) {
    if (!(e instanceof StripeError)) throw e;
    console.error(`payments: Stripe refused a checkout (${e.httpStatus || 'no answer'}${e.code ? ` ${e.code}` : ''}): ${e.message}`);
    // Stripe said no: this try is over (the next one goes under a new key).
    // No answer, or the same key still being answered (a double tap): the
    // page may be there, and the next try asks under the same key.
    if (e.httpStatus && e.httpStatus !== 409) {
      await runAction(db, { workspaceId: wsId, actorId: null, action }, async (tx, emit) => {
        const r = (await tx.query(
          `update stripe_checkouts set status = 'failed', updated_at = now()
            where id = $1 and workspace_id = $2 and status = 'open' and session_id is null and tries = $3 returning id`,
          [id, wsId, tries],
        )).rows[0];
        if (r) emit('payment_checkout', id, 'update', { status: 'failed', stripe: e.httpStatus });
      });
    }
    // The email they typed is one Stripe won't take: theirs to fix.
    if (e.httpStatus === 400 && e.param === 'customer_email') throw payError(400, 'That email address doesn’t look right. Check it and try again.', 'email');
    throw unanswered();
  }
  const { result } = await runAction(db, { workspaceId: wsId, actorId: null, action }, async (tx, emit) => {
    const kept = (await tx.query(
      `update stripe_checkouts set session_id = $3, status = case when status = 'failed' then 'open' else status end, updated_at = now()
        where id = $1 and workspace_id = $2 and session_id is null returning id`,
      [id, wsId, session.id],
    )).rows[0];
    if (kept) emit('payment_checkout', id, 'update', { session_id: session.id });
    else {
      // Kept already, by another try under the same key: the same page.
      const had = (await tx.query('select session_id from stripe_checkouts where id = $1 and workspace_id = $2', [id, wsId])).rows[0];
      if (had?.session_id !== session.id) throw unanswered();
    }
    return also ? also(tx, emit, { url: session.url, session_id: session.id }) : null;
  });
  return { url: session.url, id, session_id: session.id, mode: co.mode, result };
};

// What the site's loaders show beside the donate and join modules: whether
// online payments are on, this year's limit per slate (lib/cap.js) and the
// most a monthly gift can be. paymentsReady() alone (stripe.js) is the
// switch; this is the figures as well.
export const paymentsData = async (q, workspace, { now = new Date() } = {}) => {
  const ws = workspace?.jurisdiction !== undefined && workspace?.id ? { ...workspace, settings: parseJson(workspace.settings, {}) } : await workspaceOf(q, { workspaceId: workspace?.id || workspace });
  const { year } = campaignNow(ws, now);
  const rule = await capFor(q, ws.jurisdiction, year, ws.settings || {});
  const limit = rule ? Number(rule.capCents) : null;
  return { ready: paymentsReady(), mode: stripeMode(), year, limit_cents: limit, monthly_max_cents: monthlyMax(limit) };
};
