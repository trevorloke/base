// POST {site}/api/forms/:kind — every website form, the same way (SITE.md
// "Public forms"): JSON from the islands, or a plain form post (no
// JavaScript: a 303 back to the page). Each kind reads exactly the fields
// SITE.md lists; an email or a phone is required for every kind.
//
//   200 { ok: true }                     done (also for a retry with the same
//                                        client_key, and for the honeypot)
//   200 { ok: true, checkout_url }       join, donate: off to pay
//   400 { error, field }                 what to fix, in plain words (every
//                                        refusal, the payments' too)
//   403 { error }                        posted from another site
//   429 { error }                        too many from one address
//   503 { error }                        online payments aren't set up, or
//                                        Stripe didn't answer (a retry with
//                                        the same client_key finishes it)
// A plain post gets 303 to the page with ?sent=<kind>#m-<module_id>, or
// ?error=<field>#m-<module_id> (field 'busy' for too many, 'payments' when
// payments aren't set up), or to the checkout.
//
// One runAction('site.form.<kind>') records it all: the person (matched or
// added, people.js), a site_actions row (event site_action/create, the hook
// for the rest of base.win), the consent (consent.js), the tags ("Website:
// <kind>"; "Signed: <title>" for a petition or pledge — the money forms
// leave none: who gave or joined is the desk's to see, never a volunteer's),
// "Brought in by" for someone new who came through a referral link, and what
// the kind asks for:
//   petition, pledge   the signature (a person counts once)
//   volunteer          a "Wants to volunteer" request for the desk, with the
//                      roles, when they're free and their note
//   rsvp               a spot on the public shift, through the app's own
//                      booking (room is checked; someone who couldn't make it
//                      before is booked again)
//   contact            a request for the desk with what they wrote (the
//                      intake API's rule) — never their note: a visitor's
//                      words are not the person's own
//   join, donate       the checkout kept (server/ext/payments); join also
//                      keeps their birth date and citizenship on the profile
//                      where it has none
// For join and donate, Stripe is asked for its page only after that write
// has committed (no write ever waits on Stripe), and a second short write
// keeps the page and the answer; until then the action has no answer, so a
// retry with the same client_key asks again for the same checkout.
// Money only ever lands on the same email's record, or on someone new's.
// The answer never says whether someone was on file.
import { getCookie } from 'hono/cookie';
import { newId, runAction } from '../../lib/events.js';
import { clientIp, makeLimiter } from '../../lib/guard.js';
import { campaignDay } from '../../lib/gifts.js';
import { SLATE_CODES } from '@starbase/shared/canvass';
import { DONATE_DECLARATION, JOIN_DECLARATION } from '../../../shared/site/wording.js';
import { actions as fieldActions } from '../fields/actions.js';
import { KINDS, consentWording, tagOf } from './shape.js';
import { ensureSite, readSettings, parseJ } from './store.js';
import { takePerson, refCodeFor, personOfCode, broughtInBy, CODE_RE } from './people.js';
import { consentFromForm } from './consent.js';
import { paymentsReady, prepareCheckout, retryCheckout, openCheckout } from './payments.js';
import { limitsFor } from './loaders.js';

export class FormError extends Error {
  constructor(field, message, status = 400) { super(message); this.field = field; this.status = status; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const one = (v) => (Array.isArray(v) ? v[0] : v);
const bool = (v) => [true, 1, 'true', 'on', '1', 'yes'].includes(typeof v === 'string' ? v.trim().toLowerCase() : v);
const money = (c) => `$${(c / 100).toLocaleString('en-CA', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;

const str = (b, key, max, label) => {
  const raw = one(b[key]);
  if (raw == null || raw === '') return '';
  if (typeof raw !== 'string' && typeof raw !== 'number') throw new FormError(key, `${label}: words, please`);
  const s = String(raw).trim();
  if (s.length > max) throw new FormError(key, `${label} is too long — ${max.toLocaleString('en-CA')} characters at most`);
  return s;
};
const int = (b, key) => {
  const raw = one(b[key]);
  if (raw == null || raw === '') return null;
  const n = Number(String(raw).trim());
  return Number.isInteger(n) ? n : NaN;
};

// The fields every kind has.
const common = (b) => {
  const out = {
    first_name: str(b, 'first_name', 150, 'Your first name'),
    last_name: str(b, 'last_name', 150, 'Your last name'),
    email: str(b, 'email', 320, 'Your email').toLowerCase(),
    phone: str(b, 'phone', 40, 'Your phone number'),
    postal_code: str(b, 'postal_code', 12, 'Your postal code'),
    consent_email: bool(one(b.consent_email)),
    consent_sms: bool(one(b.consent_sms)),
  };
  if (out.email && !EMAIL_RE.test(out.email)) throw new FormError('email', 'That email address doesn’t look right — check it and try again');
  if (out.phone && out.phone.replace(/\D/g, '').length < 7) throw new FormError('phone', 'That phone number doesn’t look right — check it and try again');
  if (!out.email && !out.phone) throw new FormError('email', 'Add your email or your phone number');
  if (out.consent_sms && !out.phone) throw new FormError('phone', 'Add your mobile number to get texts');
  const key = str(b, 'client_key', 64, 'The form’s key');
  const ref = str(b, 'ref', 40, 'The link').toLowerCase();
  const pageId = str(b, 'page_id', 64, 'The page');
  const moduleId = str(b, 'module_id', 64, 'The section');
  const source = str(b, 'source', 60, 'The source').toLowerCase();
  out.client_key = key || null;
  out.ref = CODE_RE.test(ref) ? ref : null;
  out.page_id = UUID.test(pageId) ? pageId.toLowerCase() : null;
  out.module_id = /^[A-Za-z0-9_-]{1,64}$/.test(moduleId) ? moduleId : null;
  out.source = /^[a-z0-9][a-z0-9:_.-]{0,59}$/.test(source) ? source : null;
  return out;
};

// What each kind adds (SITE.md's table).
const ofKind = (kind, b, f, day) => {
  const k = {};
  if (kind === 'newsletter') {
    if (!f.email) throw new FormError('email', 'Add your email to get the newsletter');
    if (!f.consent_email) throw new FormError('consent_email', 'Tick the box to get the newsletter');
  }
  if (kind === 'petition' || kind === 'pledge') {
    const id = str(b, 'campaign', 64, 'The petition');
    if (!UUID.test(id)) throw new FormError('campaign', kind === 'pledge' ? 'Pick a pledge to sign' : 'Pick a petition to sign');
    k.campaign = id.toLowerCase();
    k.comment = str(b, 'comment', 1000, 'Your comment');
  }
  if (kind === 'volunteer') {
    const raw = b.roles ?? b['roles[]'];
    const list = (Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw]);
    if (list.length > 20) throw new FormError('roles', 'Pick at most 20 ways to help');
    k.roles = [...new Set(list.map((r) => {
      if (typeof r !== 'string') throw new FormError('roles', 'Pick from the list');
      const s = r.trim().replace(/\s+/g, ' ');
      if (s.length > 60) throw new FormError('roles', 'Each way to help is 60 characters at most');
      return s;
    }).filter(Boolean))];
    k.availability = str(b, 'availability', 300, 'When you’re free');
    k.note = str(b, 'note', 1000, 'Your note');
  }
  if (kind === 'rsvp') {
    const id = str(b, 'shift_id', 64, 'The event');
    if (!UUID.test(id)) throw new FormError('shift_id', 'Pick an event');
    k.shift_id = id.toLowerCase();
  }
  if (kind === 'contact') {
    k.topic = str(b, 'topic', 60, 'The topic');
    k.message = str(b, 'message', 4000, 'Your message');
    if (!k.message) throw new FormError('message', 'Write your message');
  }
  if (kind === 'join' || kind === 'donate') {
    k.address = str(b, 'address', 400, 'Your address');
    k.city = str(b, 'city', 120, 'Your city');
    if (!bool(one(b.declaration))) {
      throw new FormError('declaration', kind === 'join'
        ? 'Tick the declaration to join'
        : 'Tick the declaration: you’re a Canadian citizen or permanent resident living in BC, giving your own money');
    }
    k.declaration = true;
  }
  if (kind === 'join') {
    const birth = str(b, 'birth_date', 10, 'Your birth date');
    if (birth) {
      if (!DAY.test(birth) || Number.isNaN(Date.parse(`${birth}T00:00:00Z`)) || new Date(`${birth}T00:00:00Z`).toISOString().slice(0, 10) !== birth) {
        throw new FormError('birth_date', 'Your birth date, like 1990-04-21');
      }
      const age = ageOn(birth, day);
      if (age < 14) throw new FormError('birth_date', 'Members are 14 or older');
      if (age > 120) throw new FormError('birth_date', 'Your birth date, like 1990-04-21');
    }
    k.birth_date = birth || null;
    const cz = str(b, 'citizenship', 10, 'Citizenship');
    if (cz && !['citizen', 'pr'].includes(cz)) throw new FormError('citizenship', 'Canadian citizen or permanent resident');
    k.citizenship = cz || null;
    const term = int(b, 'term') ?? 1;
    if (term !== 1 && term !== 4) throw new FormError('term', 'One year or four');
    k.term = term;
    const youth = k.birth_date ? (() => { const a = ageOn(k.birth_date, day); return a >= 14 && a <= 30; })() : false;
    const minimum = term * (youth ? 500 : 1000);
    const amount = int(b, 'amount_cents');
    if (Number.isNaN(amount)) throw new FormError('amount_cents', 'Pick an amount');
    if (amount != null && amount < minimum) {
      throw new FormError('amount_cents', `The membership is at least ${money(minimum)} for ${term === 1 ? 'a year' : 'four years'}${youth ? ' (aged 14 to 30)' : ''}`);
    }
    if (amount != null && amount > 10_000_000) throw new FormError('amount_cents', 'Pick a smaller amount');
    k.amount_cents = amount ?? minimum;
    k.youth = youth;
  }
  if (kind === 'donate') {
    const amount = int(b, 'amount_cents');
    if (amount == null || Number.isNaN(amount) || amount <= 0) throw new FormError('amount_cents', 'Pick an amount');
    if (amount < 500) throw new FormError('amount_cents', 'The smallest gift online is $5');
    if (amount > 10_000_000) throw new FormError('amount_cents', 'Pick a smaller amount');
    k.amount_cents = amount;
    const cadence = str(b, 'cadence', 10, 'How often') || 'once';
    if (!['once', 'monthly'].includes(cadence)) throw new FormError('cadence', 'Once or monthly');
    k.cadence = cadence;
    const slate = str(b, 'slate', 40, 'The slate');
    if (slate && !SLATE_CODES.includes(slate)) throw new FormError('slate', 'Pick one of the slates');
    k.slate = slate || null;
  }
  return k;
};

const ageOn = (birth, day) => {
  const [by, bm, bd] = birth.split('-').map(Number);
  const [y, m, d] = day.split('-').map(Number);
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
};

// ── The body: JSON, or a plain form ──
const readBody = async (c) => {
  const type = (c.req.header('content-type') || '').toLowerCase();
  if (type.includes('application/json')) {
    const b = await c.req.json().catch(() => null);
    return { body: b && typeof b === 'object' && !Array.isArray(b) ? b : {}, plain: false };
  }
  if (type.includes('application/x-www-form-urlencoded') || type.includes('multipart/form-data')) {
    const f = await c.req.parseBody({ all: true }).catch(() => ({}));
    const body = {};
    for (const [k, v] of Object.entries(f)) {
      const vals = (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string');
      body[k.replace(/\[\]$/, '')] = k === 'roles' || k === 'roles[]' ? vals : vals[0];
    }
    // A form an island sends as FormData still wants JSON back.
    return { body, plain: !(c.req.header('accept') || '').includes('application/json') };
  }
  return { body: null };
};

// Per address: 20 a minute (SITE_FORMS_PER_MINUTE), so a crowd on one
// network (a rally's wifi, a phone carrier) still gets through.
let limiter = null;
const limited = (ip) => {
  const max = Number(process.env.SITE_FORMS_PER_MINUTE) || 20;
  if (!limiter || limiter.max !== max) limiter = Object.assign(makeLimiter({ windowMs: 60_000, max }), { max });
  return limiter(ip);
};

// The opt-in fields a join keeps (when the campaign has them) — only where
// the profile has none: what is on file is never overwritten.
const setFields = async (tx, ws, personId, pairs, emit) => {
  const values = [];
  for (const [name, value] of pairs) {
    if (value == null || value === '') continue;
    const f = (await tx.query(
      'select id from person_fields where workspace_id = $1 and lower(name) = $2 and retired_at is null limit 1', [ws, name],
    )).rows[0];
    if (!f) continue;
    const had = (await tx.query(
      'select 1 from person_field_values where workspace_id = $1 and person_id = $2 and field_id = $3', [ws, personId, f.id],
    )).rows[0];
    if (!had) values.push({ field_id: f.id, value });
  }
  if (values.length) await fieldActions['field.values.set'].handler(tx, { workspaceId: ws, user: null }, { person_id: personId, values }, emit);
};

// Where a plain post goes back to: the page it came from.
const pagePath = async (db, ws, root, f, k, c) => {
  if (f.page_id) {
    const p = (await db.query("select slug from site_pages where id = $1 and workspace_id = $2 and deleted_at is null and status = 'published'", [f.page_id, ws.id])).rows[0];
    if (p) return p.slug === 'home' ? `${root}/` : `${root}/${p.slug}`;
  }
  if (k.campaign) {
    const cmp = (await db.query('select slug from site_campaigns where id = $1 and workspace_id = $2 and deleted_at is null', [k.campaign, ws.id])).rows[0];
    if (cmp) return `${root}/act/${cmp.slug}`;
  }
  try {
    const ref = new URL(c.req.header('referer') || '');
    const self = new URL(c.req.url);
    if (ref.host === self.host && (ref.pathname === root || ref.pathname.startsWith(`${root}/`))) return ref.pathname;
  } catch { /* no usable referer */ }
  return `${root}/`;
};

const sysCtx = (ws) => ({ workspaceId: ws.id, workspace: ws, user: null, role: null, perms: null });
const FIELD = /^[a-z_]{1,40}$/;

// site: { ws, root (with the client path), origin }
export const formRoute = async (c, site) => {
  const kind = c.req.param('kind');
  if (!KINDS.includes(kind)) return c.json({ error: 'not found' }, 404);
  // A form on another site can't post here (or spend visitors' addresses
  // on someone else's list).
  if (c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'forms are sent from the site itself' }, 403);
  const { body, plain } = await readBody(c);
  if (!body) return c.json({ error: 'send the form as JSON or as a plain form' }, 415);
  const { ws, root } = site;
  const db = site.db;
  const hash = (f) => (f?.module_id ? `#m-${f.module_id}` : '');
  // An error names the form it is for (&module=), so the page says it there.
  const go = async (f, k, q) => c.redirect(`${await pagePath(db, ws, root, f || {}, k || {}, c)}?${q}${q.startsWith('error=') && f?.module_id ? `&module=${f.module_id}` : ''}${hash(f)}`, 303);
  const moduleOf = () => {
    const m = String(one(body.module_id) || '');
    return { module_id: /^[A-Za-z0-9_-]{1,64}$/.test(m) ? m : null, page_id: UUID.test(String(one(body.page_id) || '')) ? String(one(body.page_id)).toLowerCase() : null };
  };

  // The honeypot: a person never sees the field; a bot fills it. It hears
  // what a person would, and nothing is kept.
  if (String(one(body.website) ?? '').trim()) return plain ? go(moduleOf(), {}, `sent=${kind}`) : c.json({ ok: true });
  if (limited(clientIp(c))) {
    return plain ? go(moduleOf(), {}, 'error=busy') : c.json({ error: 'Too many tries from here — wait a minute and try again' }, 429);
  }

  let f;
  let k;
  try {
    f = common(body);
    // Ages on the campaign's own day, as the payments count them.
    k = ofKind(kind, body, f, campaignDay(new Date(), ws.settings?.tz));
    // The referral: the code sent with the form, else the one /r/:code remembered.
    if (!f.ref) {
      const remembered = String(getCookie(c, 'site_ref') || '').toLowerCase();
      if (CODE_RE.test(remembered)) f.ref = remembered;
    }
  } catch (e) {
    if (!(e instanceof FormError)) throw e;
    return plain ? go(f || moduleOf(), k || {}, `error=${encodeURIComponent(e.field)}`) : c.json({ error: e.message, field: e.field }, e.status);
  }

  await ensureSite(db, ws);
  const pays = kind === 'join' || kind === 'donate';
  if (pays && !(await paymentsReady())) {
    return plain ? go(f, k, 'error=payments')
      : c.json({ error: 'Online payments aren’t set up yet — please try again later, or get in touch to give another way' }, 503);
  }
  const back = pays ? await pagePath(db, ws, root, f, k, c) : null;

  let answer;
  try {
    const { result } = await runAction(db, { workspaceId: ws.id, actorId: null, action: `site.form.${kind}` }, (tx, emit) => record(tx, emit, {
      kind, ws, f, k, back, origin: site.origin,
    }));
    // Join and donate: Stripe is asked now, the form's write done.
    answer = result.checkout ? await payPage(db, ws, kind, result.checkout) : result.answer;
  } catch (e) {
    if (e instanceof FormError) return plain ? go(f, k, `error=${encodeURIComponent(e.field)}`) : c.json({ error: e.message, field: e.field }, e.status);
    if (e.status === 503) return plain ? go(f, k, 'error=payments') : c.json({ error: 'We couldn’t reach the payment service — please try again in a minute' }, 503);
    // Every other refusal (the payments' own: an amount, an age, a term…)
    // is a 400 in its own plain words, pointing at its field.
    if (e.status >= 400 && e.status < 500) {
      const field = FIELD.test(String(e.field || '')) ? e.field : null;
      if (!field) console.error(`site: a ${kind} form was refused with nothing to point at: ${e.message}`);
      return plain ? go(f, k, `error=${field || 'form'}`) : c.json({ error: field ? e.message : 'Please check the form and try again', field }, 400);
    }
    throw e;
  }
  if (plain) return answer.checkout_url ? c.redirect(answer.checkout_url, 303) : go(f, k, `sent=${kind}`);
  return c.json(answer);
};

// After the form's write: Stripe makes the payment page, then a short write
// keeps it with the checkout and keeps the answer — what a retry with the
// same client_key is told from then on.
const payPage = async (db, ws, kind, { actionId, checkoutId }) => {
  const { result } = await openCheckout(db, sysCtx(ws), checkoutId, {
    action: `site.form.${kind}`,
    also: async (tx, emit, { url }) => {
      const answer = { ok: true, checkout_url: url };
      const kept = (await tx.query(
        'update site_actions set answer = $3 where id = $1 and workspace_id = $2 and answer is null returning id', [actionId, ws.id, JSON.stringify(answer)],
      )).rows[0];
      if (kept) return answer;
      // Another try with the same key got there first: what it was told.
      const had = (await tx.query('select answer from site_actions where id = $1 and workspace_id = $2', [actionId, ws.id])).rows[0];
      return parseJ(had?.answer, null) || answer;
    },
  });
  return result;
};

// What a join or donate is for: its client_key carries it, so the same key
// with another amount (back from Stripe, a new choice) is a fresh checkout,
// never the old one again.
const paidFor = (kind, k) => (kind === 'join' ? `${k.amount_cents}-${k.term}` : `${k.amount_cents}-${k.cadence}-${k.slate || ''}`);

// Inside the one write. Throws FormError for what the database says no to
// (a closed petition, a full event, an amount over the limit).
// → { answer } done; { checkout: { actionId, checkoutId } } Stripe to be asked.
const record = async (tx, emit, { kind, ws, f, k, back, origin }) => {
  const pays = kind === 'join' || kind === 'donate';
  const key = f.client_key ? `${kind}:${f.client_key}${pays ? `:${paidFor(kind, k)}` : ''}` : null;
  if (key) {
    const prev = (await tx.query('select id, answer, checkout_id from site_actions where workspace_id = $1 and client_key = $2', [ws.id, key])).rows[0];
    if (prev) {
      const answer = parseJ(prev.answer, null);
      if (answer) return { answer };
      // Sent before, and Stripe never made the page (it failed, or the
      // answer was lost): the same checkout, asked again — never a second.
      if (pays) {
        const again = prev.checkout_id ? await retryCheckout(tx, sysCtx(ws), prev.checkout_id, emit) : null;
        if (again) return { checkout: { actionId: prev.id, checkoutId: again.id } };
        throw Object.assign(new Error('this checkout can’t be asked for again'), { status: 503 });
      }
      return { answer: { ok: true } };
    }
  }
  const settings = await readSettings(tx, ws.id);
  const source = `website-${kind}`;

  let campaign = null;
  if (k.campaign) {
    campaign = (await tx.query('select id, kind, title, status from site_campaigns where id = $1 and workspace_id = $2 and deleted_at is null', [k.campaign, ws.id])).rows[0];
    if (!campaign) throw new FormError('campaign', 'This petition isn’t on the site any more');
    if (campaign.kind !== kind) throw new FormError('campaign', kind === 'pledge' ? 'That isn’t a pledge' : 'That isn’t a petition');
    if (campaign.status !== 'open') throw new FormError('campaign', `This ${campaign.kind} is closed — thank you for your support`);
  }
  let shift = null;
  if (k.shift_id) {
    shift = (await tx.query(
      `select id, title, capacity, starts_at, coalesce(ends_at, starts_at) < now() as over from shifts
        where id = $1 and workspace_id = $2 and deleted_at is null and public`, [k.shift_id, ws.id],
    )).rows[0];
    if (!shift) throw new FormError('shift_id', 'That event isn’t taking sign-ups');
    if (shift.over) throw new FormError('shift_id', 'That event is over');
  }
  const page = f.page_id
    ? (await tx.query('select id from site_pages where id = $1 and workspace_id = $2', [f.page_id, ws.id])).rows[0] : null;

  // The person, and who sent them. Money is only ever the same email's, or
  // someone new's (people.js, strong); the money forms leave no tag.
  const referrerId = f.ref ? await personOfCode(tx, ws.id, f.ref) : null;
  const tags = pays ? [] : [`Website: ${kind}`, ...(campaign ? [tagOf('Signed: ', campaign.title)] : [])];
  const person = await takePerson(tx, ws.id, {
    first_name: f.first_name, last_name: f.last_name, email: f.email, phone: f.phone, postal: f.postal_code,
    address: k.address, city: k.city,
  }, { tags, source, strong: pays }, emit);
  if (!person.created) await refCodeFor(tx, ws.id, person.id, emit);
  const referrer = referrerId && referrerId !== person.id ? referrerId : null;
  const sys = sysCtx(ws);

  // What they asked for.
  if (kind === 'volunteer') {
    const parts = [
      k.roles.length ? `From the website: ${k.roles.join(', ')}` : 'From the website',
      k.availability ? `Free: ${k.availability}` : '',
      k.note ? `“${k.note}”` : '',
    ].filter(Boolean);
    const id = newId();
    const note = parts.join('. ').slice(0, 2000);
    await tx.query(
      `insert into door_requests (id, workspace_id, person_id, kind, note, asked_by) values ($1, $2, $3, 'volunteer', $4, null)`,
      [id, ws.id, person.id, note],
    );
    emit('door_request', id, 'create', { id, person_id: person.id, kind: 'volunteer', note, from: 'website' });
  }
  if (kind === 'rsvp') {
    const { ACTIONS } = await import('../../actions/index.js');
    const had = (await tx.query(
      'select id, status from shift_assignments where workspace_id = $1 and shift_id = $2 and person_id = $3', [ws.id, shift.id, person.id],
    )).rows[0];
    if (!had || !['assigned', 'confirmed', 'completed'].includes(had.status)) {
      try {
        if (had) await ACTIONS['shift.setStatus'].handler(tx, sys, { id: had.id, status: 'assigned' }, emit);
        else await ACTIONS['shift.assign'].handler(tx, sys, { shift_id: shift.id, person_id: person.id }, emit);
      } catch (e) {
        if (e.status === 409) throw new FormError('shift_id', 'That event is full — pick another');
        throw e;
      }
    }
  }
  if (kind === 'contact') {
    // A request for the desk ("Something else", with what they wrote): the
    // office answers it, and a talk with them closes it (ext/followups).
    // Never written onto their note — volunteers read that as the person's
    // own words, and a visitor may be anyone.
    const id = newId();
    const note = `From the website${k.topic ? ` (${k.topic})` : ''}: ${k.message}`;
    await tx.query(
      `insert into door_requests (id, workspace_id, person_id, kind, note, asked_by) values ($1, $2, $3, 'other', $4, null)`,
      [id, ws.id, person.id, note],
    );
    emit('door_request', id, 'create', { id, person_id: person.id, kind: 'other', note, from: 'website' });
  }
  if (kind === 'join' && (person.created || person.by === 'email')) {
    await setFields(tx, ws.id, person.id, [
      ['birth date', k.birth_date],
      ['citizenship', k.citizenship === 'citizen' ? 'Canadian citizen' : k.citizenship === 'pr' ? 'Permanent resident' : null],
    ], emit);
  }
  if (kind === 'donate') {
    // What no one may give in a year, before they go to pay. What this
    // person gave before is never asked here — the answer would tell
    // whoever typed their name: the payment is checked against it when it
    // lands, and refunded if it goes over (ext/payments).
    const { limit_cents: limit, monthly_max_cents: monthly } = await limitsFor(tx, ws);
    if (limit && k.cadence === 'once' && k.amount_cents > limit) {
      throw new FormError('amount_cents', `One person may give at most ${money(limit)} in a year`);
    }
    if (monthly && k.cadence === 'monthly' && k.amount_cents > monthly) {
      throw new FormError('amount_cents', `A monthly gift is at most ${money(monthly)} — the yearly limit over twelve months`);
    }
  }
  if (kind === 'join') {
    const { limit_cents: limit } = await limitsFor(tx, ws);
    if (limit && k.amount_cents > limit) throw new FormError('amount_cents', `One person may give at most ${money(limit)} in a year`);
  }

  // The words beside the boxes, as the page showed them (the newsletter's
  // yes to email is the words beside its button).
  const words = consentWording(settings?.org, settings?.seo);
  await consentFromForm(tx, ws.id, {
    personId: person.id, name: person.name, email: f.email, phone: f.phone,
    wantsEmail: f.consent_email, wantsSms: f.consent_sms, source,
    wording: kind === 'newsletter' ? { ...words, email: words.newsletter } : words,
  }, emit);
  if (referrer && person.created) await broughtInBy(tx, ws.id, person.id, referrer, emit);

  // The action itself.
  const id = newId();
  const payload = {
    who: { first_name: f.first_name, last_name: f.last_name, email: f.email, phone: f.phone, postal_code: f.postal_code },
    ...Object.fromEntries(Object.entries(k).filter(([key]) => !['campaign', 'shift_id', 'declaration', 'youth'].includes(key))),
    ...(k.shift_id ? { shift_id: k.shift_id } : {}),
    ...(k.declaration ? { declaration: true } : {}),
    consent_email: f.consent_email, consent_sms: f.consent_sms, matched: person.created ? null : person.by,
  };
  await tx.query(
    `insert into site_actions (id, workspace_id, person_id, kind, campaign_id, page_id, module_id, payload, source, referrer_id, client_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [id, ws.id, person.id, kind, campaign?.id || null, page?.id || null, f.module_id, JSON.stringify(payload), f.source, referrer, key],
  );
  emit('site_action', id, 'create', {
    kind, person_id: person.id, campaign_id: campaign?.id || null, page_id: page?.id || null,
    module_id: f.module_id, source: f.source, referrer_id: referrer,
  });

  if (pays) {
    // The checkout, kept with this write; Stripe is asked once it's done.
    const here = `${origin}${back}`;
    const anchor = f.module_id ? `#m-${f.module_id}` : '';
    const { id: checkoutId } = await prepareCheckout(tx, sys, {
      personId: person.id,
      kind: kind === 'join' ? 'membership' : 'donation',
      amountCents: k.amount_cents,
      cadence: kind === 'join' ? 'once' : k.cadence,
      slate: k.slate || null,
      // The words beside the box they ticked, exactly.
      declaration: kind === 'join' ? JOIN_DECLARATION : DONATE_DECLARATION,
      // Stripe's page starts with the email they typed — never one on file.
      email: f.email || null,
      // Membership: payments works out the minimum (the youth rate from the
      // birth date), the age and the citizenship from these — not from the
      // metadata, which is only kept for the record.
      ...(kind === 'join' ? { term: k.term, birthDate: k.birth_date || null, citizenship: k.citizenship || null } : {}),
      successUrl: `${here}?sent=${kind}${anchor}`,
      cancelUrl: `${here}?cancelled=${kind}${anchor}`,
      metadata: {
        site_action_id: id, kind,
        ...(kind === 'join' ? { term: String(k.term), youth: k.youth ? 'yes' : 'no', ...(k.birth_date ? { birth_date: k.birth_date } : {}), ...(k.citizenship ? { citizenship: k.citizenship } : {}) } : {}),
      },
    }, emit);
    await tx.query('update site_actions set checkout_id = $3 where id = $1 and workspace_id = $2', [id, ws.id, checkoutId]);
    return { checkout: { actionId: id, checkoutId } };
  }
  const answer = { ok: true };
  await tx.query('update site_actions set answer = $3 where id = $1 and workspace_id = $2', [id, ws.id, JSON.stringify(answer)]);
  return { answer };
};
