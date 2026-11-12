// POST /hooks/mailchimp/<key> — where Mailchimp's audience webhook says
// someone unsubscribed, an address was cleaned, or an address changed. No
// sign-in.
//
// A delivery is only ever a HINT. Whatever it says, base.win then reads the
// member from Mailchimp itself (a job: pull.js) and acts on that answer —
// so a forged call can do nothing but cause one read, and only about an
// address this server already holds. Two locks all the same:
//   the address   its last part is made from the API key (mailchimp.js) and
//                 compared whole, in constant time, before a byte is read;
//                 a wrong one is "not found"
//   the signature when MAILCHIMP_WEBHOOK_SECRET is set, the delivery must
//                 carry X-Mailchimp-Signature (t=…,v1=… — HMAC-SHA256 over
//                 "<t>.<the exact bytes>", five minutes at most, the scheme
//                 Stripe's webhook uses) or it is refused with nothing read
// Each hint is done once by its nature: what it leads to is read from
// Mailchimp and only changes someone still on here. One address may send
// 600 a minute. GET and HEAD at the right address answer 200 — Mailchimp
// asks an address before it saves a webhook to it.
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { clientIp, makeLimiter } from '../../lib/guard.js';
import { enqueueJob, runJobsSoon } from '../../lib/jobs.js';
import { holders } from '../mail/webhook.js';
import { verifySignature } from '../payments/stripe.js';
import { HOOK_PREFIX, knownAudience, lower, mailchimpOn, pathKeyMatches, webhookSecrets } from './mailchimp.js';
import { MEMBER_JOB } from './pull.js';

const limited = makeLimiter({ windowMs: 60_000, max: 600 });
// When a delivery's signature was last refused, and when one was last taken
// (since this server started): Settings → Services' Check says so when the
// secret set here is not the webhook's — otherwise every hint would be
// refused and nobody would know.
const seen = { refusedAt: 0, takenAt: 0 };
export const deliveries = () => ({ ...seen });
const EMAIL = /^[^@\s]{1,200}@[^@\s]{1,200}$/;
const address = (v) => (EMAIL.test(lower(v)) ? lower(v) : null);

// What a delivery is about — a form (type, data[email], data[list_id], …)
// as Mailchimp posts it, or the same as JSON. → { email, list } |
// { was, now, list } | null
const readHint = (raw, type) => {
  let f;
  if (/json/i.test(type || '')) {
    let j;
    try { j = JSON.parse(raw.toString('utf8')); } catch { return null; }
    f = { type: j?.type, ...(j?.data && typeof j.data === 'object' ? j.data : {}) };
  } else {
    const p = new URLSearchParams(raw.toString('utf8'));
    f = { type: p.get('type') };
    for (const k of ['email', 'list_id', 'old_email', 'new_email']) f[k] = p.get(`data[${k}]`);
  }
  const list = f.list_id ? String(f.list_id) : null;
  if (f.type === 'upemail') {
    const was = address(f.old_email); const now = address(f.new_email);
    return was && now ? { was, now, list } : null;
  }
  // Any other kind that names an address: its member is read, whatever the delivery calls it.
  const email = address(f.email);
  return email ? { email, list } : null;
};

// A job for each campaign on this server that holds the address — none
// when nobody does (nothing to change, so nothing to read).
const queue = async (db, hint) => {
  // About another audience than the one in use here: not ours. (Not known
  // just now: the job reads the member in ours, and finds none.)
  const mine = knownAudience();
  if (hint.list && mine && hint.list !== mine) return;
  const payload = hint.email ? { email: hint.email } : { was: hint.was, now: hint.now };
  for (const ws of await holders(db, hint.email || hint.was)) {
    // One already waiting says the same.
    const waiting = (await db.query(
      `select 1 from jobs where workspace_id = $1 and kind = $2 and status = 'pending' and payload = $3::jsonb limit 1`, [ws, MEMBER_JOB, JSON.stringify(payload)],
    )).rows.length;
    if (!waiting) await enqueueJob(db, { workspaceId: ws, kind: MEMBER_JOB, payload });
  }
  runJobsSoon();
};

export const publicRoutes = new Hono();

publicRoutes.post(`${HOOK_PREFIX}:key`, async (c) => {
  if (limited(clientIp(c))) return c.json({ error: 'too many at once — send it again in a minute' }, 429, { 'Retry-After': '60' });
  if (!mailchimpOn() || !pathKeyMatches(c.req.param('key'))) return c.json({ error: 'not found' }, 404);
  const raw = Buffer.from(await c.req.arrayBuffer());
  const secrets = webhookSecrets();
  if (secrets.length && !verifySignature(raw, c.req.header('x-mailchimp-signature'), secrets).ok) {
    seen.refusedAt = Date.now();
    return c.json({ error: 'signature refused' }, 400);
  }
  seen.takenAt = Date.now();
  const hint = readHint(raw, c.req.header('content-type'));
  try {
    if (hint) await queue(await getDb(), hint);
  } catch (e) {
    console.error('mailchimp: a webhook was not taken — the daily pull will find it:', e.message);
    return c.json({ error: 'not done — send it again' }, 500);
  }
  // What Mailchimp sees for the delivery: never a person, never what was found.
  return c.json({ received: true });
});
// "Is anyone there?" at the right address: yes, and nothing more.
publicRoutes.on(['GET', 'HEAD'], `${HOOK_PREFIX}:key`, (c) => (!limited(clientIp(c)) && mailchimpOn() && pathKeyMatches(c.req.param('key'))
  ? c.json({ ok: true })
  : c.json({ error: 'not found' }, 404)));
// Nothing else answers under that address (not the app's own page either).
publicRoutes.all(`${HOOK_PREFIX}*`, (c) => c.json({ error: 'not found' }, 404));
publicRoutes.all('/hooks/mailchimp', (c) => c.json({ error: 'not found' }, 404));
