// checkoutFor — open a Stripe Checkout for a gift (once or monthly) or for
// membership dues, for someone already recorded (the website's join and
// donate forms record the person first; SITE.md). Answers { url }: Stripe's
// own page, where the card (or Apple Pay / Google Pay) is taken — never here.
//
//   checkoutFor(tx, ctx, {
//     personId, kind: 'donation' | 'membership', amountCents,
//     cadence: 'once' | 'monthly', slate, declaration,
//     successUrl, cancelUrl, metadata,
//     term: 1 | 4, birthDate: 'YYYY-MM-DD', citizenship: 'citizen' | 'pr',   // membership
//   }, emit?)
//
// Before Stripe is asked: online payments are set up; the eligibility
// declaration was made (true, or the words the visitor ticked); the amount
// fits what this person may still give this year on that slate (limits.js —
// the desk's own rule, plus the monthly gifts they already have running);
// membership dues are at least the minimum. Each refusal is an Error with
// .status (400, or 503 when payments aren't set up or Stripe didn't answer)
// and .field (the form field to point at), in words a visitor reads — never
// what the person has given before.
//
// Everything needed to finish later is kept in stripe_checkouts (who, what,
// the declaration as made, the site's own metadata) and rides on the session
// as metadata (our checkout's id and the campaign's): the webhook needs
// nothing else. Run it inside the form's runAction (pass its emit, and the
// checkout is on the event log too): a refusal or a Stripe failure then
// leaves nothing behind. It calls Stripe once, 10 s at most.
import { newId } from '../../lib/events.js';
import { capFor } from '../../lib/cap.js';
import { SLATE_CODES, DEFAULT_SLATE } from '@starbase/shared/canvass';
import { stripeRequest, stripeMode, paymentsReady, StripeError } from './stripe.js';
import { roomFor, fits, campaignNow, monthlyMax, money } from './limits.js';

// The declaration a contributor makes (BC's Local Elections Campaign
// Financing Act), in the website's own words (apps/web DonateForm).
export const DECLARATION = 'I’m a Canadian citizen or permanent resident. I live in British Columbia. This contribution is my own money, and no one will pay me back for it.';
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

// The campaign as it is now (name, jurisdiction, settings), whatever the
// caller's ctx carries.
export const workspaceOf = async (q, ctx) => {
  const id = ctx?.workspaceId || ctx?.workspace?.id;
  const ws = id ? (await q.query('select id, name, jurisdiction, settings from workspaces where id = $1', [id])).rows[0] : null;
  if (!ws) throw payError(400, 'campaign not found');
  return { ...ws, settings: parseJson(ws.settings, {}) };
};

// The declaration as it was made: the words ticked (the form may send its
// own), when, and that it came from the website.
const declarationOf = (d) => {
  if (d === true || d === 'true' || d === 'on' || d === '1') return { text: DECLARATION };
  if (typeof d === 'string' && d.trim().length >= 10) return { text: d.trim().slice(0, 1000) };
  if (d && typeof d === 'object' && d.agreed !== false) {
    const text = typeof d.text === 'string' && d.text.trim().length >= 10 ? d.text.trim().slice(0, 1000) : DECLARATION;
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

export const checkoutFor = async (tx, ctx, opts = {}, emit = null) => {
  if (!paymentsReady()) throw payError(503, 'Online payments aren’t set up yet.');
  const say = typeof emit === 'function' ? emit : (typeof ctx?.emit === 'function' ? ctx.emit : null);
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
  const declaration = declarationOf(opts.declaration);
  if (!declaration) throw payError(400, 'Please confirm you can give: tick the declaration.', 'declaration');
  if (!absolute(opts.successUrl) || !absolute(opts.cancelUrl)) throw payError(400, 'successUrl and cancelUrl: full https addresses');
  const metadata = metadataOf(opts.metadata);

  // Membership: the term, the minimum (youth rate from the birth date), the age.
  const { day } = campaignNow(ws);
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
    ? (await tx.query('select id, name, email from persons where id = $1 and workspace_id = $2 and deleted_at is null', [opts.personId, ws.id])).rows[0]
    : null;
  if (!person) throw payError(400, 'person not found — record them first', 'person');

  // ── The limit: what they may still give this year on that slate ──
  const room = await roomFor(tx, ws, person.id, slate);
  if (cadence === 'monthly' && room.capCents != null && amountCents > monthlyMax(room.capCents)) {
    throw payError(400, `The most a monthly gift can be this year is ${money(monthlyMax(room.capCents))}.`, 'amount_cents');
  }
  const fit = fits(room, { cadence, amountCents });
  if (!fit.ok) throw payError(400, fit.message, 'amount_cents');

  // ── Kept, then Stripe ──
  const id = newId();
  const mode = stripeMode();
  const made = { ...declaration, at: new Date().toISOString(), source: 'website', ...(citizenship ? { citizenship } : {}) };
  await tx.query(
    `insert into stripe_checkouts (id, workspace_id, person_id, kind, cadence, amount_cents, slate, term_years, birth_date, citizenship,
                                   declaration, metadata, mode)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [id, ws.id, person.id, kind, cadence, amountCents, slate, term, birthDate, citizenship,
     JSON.stringify(made), JSON.stringify(metadata), mode],
  );

  const monthly = cadence === 'monthly';
  const name = kind === 'membership'
    ? `${ws.name} membership (${term} year${term > 1 ? 's' : ''})`
    : `${monthly ? 'Monthly contribution' : 'Contribution'} to ${ws.name}`;
  const meta = { base_checkout: id, base_workspace: ws.id, base_kind: kind };
  const email = String(person.email || '').trim().toLowerCase();
  let session;
  try {
    session = await stripeRequest('POST', '/checkout/sessions', {
      idempotencyKey: `base-checkout-${id}`,
      params: {
        mode: monthly ? 'subscription' : 'payment',
        client_reference_id: id,
        success_url: opts.successUrl,
        cancel_url: opts.cancelUrl,
        locale: 'auto',
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_MINUTES * 60,
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
      },
    });
  } catch (e) {
    // Outside a transaction this row would stay; inside one it rolls back.
    await tx.query(`update stripe_checkouts set status = 'failed', updated_at = now() where id = $1`, [id]).catch(() => {});
    if (e instanceof StripeError) {
      console.error(`payments: Stripe refused a checkout (${e.httpStatus || 'no answer'}${e.code ? ` ${e.code}` : ''}): ${e.message}`);
      throw payError(503, 'The payment service didn’t answer. Please try again in a minute.');
    }
    throw e;
  }
  if (!session?.id || !session?.url) throw payError(503, 'The payment service didn’t answer. Please try again in a minute.');
  await tx.query('update stripe_checkouts set session_id = $2, updated_at = now() where id = $1', [id, session.id]);
  say?.('payment_checkout', id, 'create', {
    person_id: person.id, kind, cadence, amount_cents: amountCents, slate, mode,
    ...(term ? { term_years: term } : {}), declaration: made, session_id: session.id,
  });
  return { url: session.url, id, session_id: session.id, mode };
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
