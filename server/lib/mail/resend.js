// Resend (resend.com) — everything base.win needs to know about this email
// sender, over plain fetch. Built against Resend's published API (its
// documentation and its own client library); INTEGRATIONS.md says what is
// still to confirm on a real account.
//
//   Send      POST /emails, one idempotency key per email (Resend keeps it a
//             day: a repeat is answered, not sent again); base.win's own ref
//             rides as the tag "ref" and comes back on every event.
//   Events    signed by Svix: HMAC-SHA256 over "<id>.<timestamp>.<body>" with
//             the secret's bytes (RESEND_WEBHOOK_SECRET, whsec_…), the id
//             the same on a redelivery.
//   Domain    GET/POST /domains, POST /domains/:id/verify — not with a
//             sending-only key.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { MailError, apiCall, env, has, isoOf, listOf, lower, noAnswer, refused, timeoutMs } from './common.js';

const api = () => (env('RESEND_API_BASE') || 'https://api.resend.com').replace(/\/+$/, '');
// Resend's own sender for an account with no domain yet: it reaches only
// the account's owner.
const TEST_SENDER = 'onboarding@resend.dev';
// What a Resend tag may carry; a ref that isn't this is left off, never a
// reason to refuse the email.
const TAG_RE = /^[A-Za-z0-9_-]{1,256}$/;
// A delivery signed more than five minutes from now (either way) is refused,
// as Svix's own library does: a captured one can't be replayed later.
const TOLERANCE_S = 300;
// Records the domain doesn't need for sending (receiving mail, Resend's own
// click tracking): not ours to ask for.
const NOT_FOR_SENDING = new Set(['Receiving', 'Tracking', 'TrackingCAA']);
const HOOK_NEEDS = ['email.bounced', 'email.complained'];

const call = (method, path, body) => apiCall('Resend', `${api()}${path}`, {
  method, body, key: env('RESEND_API_KEY'),
  refusal: (res, json) => {
    if (res.status === 401 && /restricted/i.test(`${json?.name || ''} ${json?.message || ''}`)) {
      return new MailError('a sending-only key', { status: 401, restricted: true });
    }
    if (res.status === 401 || res.status === 403) return new MailError('Resend refused the key', { status: res.status });
    return new MailError(`Resend answered ${res.status}${json?.message ? `: ${String(json.message).slice(0, 160)}` : ''}`, { status: res.status });
  },
});

// ── The webhook's signature (Svix) ──
const keyOf = (secret) => Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
const bytes = (raw) => (Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8'));
const mac = (secret, id, t, raw) => createHmac('sha256', keyOf(secret)).update(`${id}.${t}.`).update(bytes(raw)).digest();
// The headers Resend would put on these bytes (tests and the stand-in sign with it).
export const signPayload = (raw, secret, { id, t = Math.floor(Date.now() / 1000) } = {}) => ({
  'svix-id': id, 'svix-timestamp': String(t), 'svix-signature': `v1,${mac(secret, id, t, raw).toString('base64')}`,
});

// ── Events, in base.win's words ──
const KIND = {
  'email.delivered': 'delivered', 'email.bounced': 'bounced', 'email.delivery_delayed': 'deferred',
  'email.complained': 'complained', 'email.suppressed': 'suppressed', 'email.failed': 'failed',
};
// Our ref: the tags come back as { name: value } (and are sent as a list).
const refOf = (tags) => {
  const v = Array.isArray(tags) ? tags.find((t) => t?.name === 'ref')?.value : tags?.ref;
  return v == null || v === '' ? null : String(v);
};
const words = (...parts) => parts.filter(Boolean).join(': ').slice(0, 500);

// ── The sender's domain ──
const statusOf = (s) => (s === 'verified' ? 'verified' : /fail/.test(String(s)) ? 'failed' : 'pending');
const shape = (d) => ({
  found: true,
  status: statusOf(d.status),
  records: (d.records || []).filter((r) => !NOT_FOR_SENDING.has(r.record)).map((r) => ({
    purpose: r.record, type: r.type, name: r.name, value: r.value,
    ...(r.priority != null ? { priority: Number(r.priority) } : {}), ok: r.status === 'verified',
  })),
});
const NONE = { found: false, status: null, records: [] };
// Lists come twenty at a time unless asked: a hundred is the most (and far
// more domains or webhooks than one campaign's account holds).
const LIST = '?limit=100';
const find = async (name) => ((await call('GET', `/domains${LIST}`))?.data || []).find((d) => lower(d.name) === name) || null;

const sameUrl = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');
// What is missing for delivery events to come back, in one sentence — or null.
const hookShortfall = async (hookUrl) => {
  const hooks = (await call('GET', `/webhooks${LIST}`))?.data || [];
  const h = hooks.find((x) => sameUrl(x.endpoint || x.url, hookUrl));
  if (!h) return `Resend isn’t sending bounces and complaints here yet: add a webhook to ${hookUrl}.`;
  if (h.status && h.status !== 'enabled') return `The webhook to ${hookUrl} is off in Resend: turn it back on.`;
  const lacking = Array.isArray(h.events) ? HOOK_NEEDS.filter((e) => !h.events.includes(e)) : [];
  if (lacking.length) return `The webhook is there, but it doesn’t send ${lacking.join(', ')}.`;
  if (!has('RESEND_WEBHOOK_SECRET')) return 'Set RESEND_WEBHOOK_SECRET to the webhook’s signing secret.';
  return null;
};

export default {
  key: 'resend',
  name: 'Resend',
  needs: ['RESEND_API_KEY', 'MAIL_FROM'],   // Settings → Services names what is missing
  hookNeeds: ['RESEND_WEBHOOK_SECRET'],     // …and what delivery events need
  idempotent: true,                          // a repeat with the same key is never a second copy
  noFrom: 'MAIL_FROM not set: Resend’s test sender only reaches the account’s owner',
  ready: () => has('RESEND_API_KEY'),

  // One email. Never throws. → { sent, status: 'sent' | 'failed', id?, detail?, unknown? }
  async send({ from, to, subject, text, html, headers, attachments, idempotencyKey, ref }) {
    try {
      const res = await fetch(`${api()}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env('RESEND_API_KEY')}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 256) } : {}),
        },
        body: JSON.stringify({
          from: from?.raw || TEST_SENDER,
          to: [to],
          subject,
          text,
          ...(html ? { html } : {}),
          ...(headers && Object.keys(headers).length ? { headers } : {}),
          ...(attachments?.length ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content, ...(a.content_type ? { content_type: a.content_type } : {}) })) } : {}),
          ...(ref != null && TAG_RE.test(String(ref)) ? { tags: [{ name: 'ref', value: String(ref) }] } : {}),
        }),
        signal: AbortSignal.timeout(timeoutMs()),
      });
      // 409: Resend has seen this key in the last day, with other words or
      // still on its way — the first try reached it. Not sure it went: never
      // "refused", which would give the next try a new key and a second copy.
      if (res.status === 409 && idempotencyKey) return { ...(await refused(res)), unknown: true };
      if (!res.ok) return refused(res);
      const body = await res.json().catch(() => null);
      return { sent: true, status: 'sent', ...(typeof body?.id === 'string' && body.id ? { id: body.id } : {}) };
    } catch (e) {
      return noAnswer(e);
    }
  },

  // A delivery event arrived. raw: the exact bytes received. headers: (name) => value.
  verify(raw, headers, { nowS = Date.now() / 1000 } = {}) {
    const id = headers('svix-id') || headers('webhook-id');
    const t = headers('svix-timestamp') || headers('webhook-timestamp');
    const given = String(headers('svix-signature') || headers('webhook-signature') || '').split(/\s+/)
      .filter((s) => s.startsWith('v1,')).map((s) => Buffer.from(s.slice(3), 'base64'));
    const secrets = listOf('RESEND_WEBHOOK_SECRET');
    if (!secrets.length || !id || !given.length || !/^\d{1,12}$/.test(String(t || ''))) return false;
    if (Math.abs(nowS - Number(t)) > TOLERANCE_S) return false;
    return secrets.some((secret) => {
      const want = mac(secret, id, t, raw);
      return given.some((g) => g.length === want.length && timingSafeEqual(g, want));
    });
  },

  // → [{ id, kind, ref, messageId, email, at, permanent?, reason?, detail? }]
  //   kind: 'delivered' | 'bounced' | 'deferred' | 'complained' | 'suppressed' | 'failed'
  // One event per delivery; an event base.win doesn't use (its own opens and
  // clicks, contacts, domains) is no event. Not JSON throws.
  parse(raw, headers) {
    const e = JSON.parse(bytes(raw).toString('utf8'));
    let kind = KIND[e?.type];
    if (!kind) return [];
    const d = e.data || {};
    const out = {
      id: headers('svix-id') || headers('webhook-id') || null,
      kind,
      ref: refOf(d.tags),
      messageId: d.email_id ? String(d.email_id) : null,
      email: lower(Array.isArray(d.to) ? d.to[0] : d.to) || null,
      at: isoOf(e.created_at || d.created_at),
    };
    if (kind === 'bounced') {
      const b = d.bounce || {};
      // Only a bounce Resend calls permanent stops an address; any other
      // kind (a full mailbox, a bounce that doesn't say) may clear by itself.
      if (lower(b.type) === 'permanent') out.permanent = true;
      else kind = 'deferred';
      out.kind = kind;
      out.detail = words([b.type, b.subType].filter(Boolean).join(' / '), b.message) || 'Bounced';
    } else if (kind === 'deferred') out.detail = 'Delivery delayed';
    else if (kind === 'suppressed') {
      const s = d.suppressed || {};
      out.reason = /complain|spam/i.test(`${s.type || ''} ${s.message || ''}`) ? 'complaint' : 'bounce';
      out.detail = words(s.type, s.message) || 'On Resend’s suppression list';
    } else if (kind === 'failed') out.detail = words(d.failed?.reason) || 'Resend couldn’t send it';
    return [out];
  },

  // The sender's domain. → { found, status: 'verified' | 'pending' | 'failed' | null,
  //                          records: [{ purpose, type, name, value, priority?, ok }] }
  domain: {
    async get(name) { const d = await find(name); return d ? shape(await call('GET', `/domains/${d.id}`)) : NONE; },
    async add(name) { return shape(await call('POST', '/domains', { name, region: env('RESEND_REGION') || 'us-east-1' })); },
    // Asks Resend to look at the DNS records again, then reads them back
    // (its check runs on by itself: a record just added may read pending).
    async check(name) {
      const d = await find(name);
      if (!d) return NONE;
      await call('POST', `/domains/${d.id}/verify`);
      return shape(await call('GET', `/domains/${d.id}`));
    },
  },

  // Settings → Services: reads only, nothing sent.
  // → { ok, said, verified?, hook?, hookKnown? } — verified: the key and the
  // domain are right; hook: what delivery events still need, in a sentence
  // (null: nothing); hookKnown: whether the webhook could be read at all.
  async check({ domain, hookUrl }) {
    let domains;
    try {
      domains = (await call('GET', `/domains${LIST}`))?.data || [];
    } catch (e) {
      if (!e.restricted) return { ok: false, said: e.message };
      return {
        ok: true, verified: true, hookKnown: false,
        said: 'The key works (a sending-only key: the domain can’t be checked from here)',
        hook: has('RESEND_WEBHOOK_SECRET') ? null : 'Bounces and complaints aren’t coming back yet: add the webhook below, then set RESEND_WEBHOOK_SECRET.',
      };
    }
    if (!domain) return { ok: false, said: 'The key works; MAIL_FROM isn’t set, so mail comes from Resend’s test sender' };
    const d = domains.find((x) => lower(x.name) === domain);
    if (!d) return { ok: false, said: `The key works, but ${domain} isn’t a domain on this Resend account` };
    if (d.status !== 'verified') return { ok: false, said: `The key works; ${domain} is “${d.status}” in Resend — finish its DNS records` };
    let hook;
    try { hook = await hookShortfall(hookUrl); } catch (e) { hook = `Resend’s webhooks couldn’t be read (${e.message}).`; }
    return { ok: true, verified: true, hookKnown: true, said: `The key works and ${domain} is verified`, hook };
  },

  hook: {
    events: ['email.delivered', 'email.bounced', 'email.complained', 'email.delivery_delayed', 'email.suppressed', 'email.failed'],
    where: 'Resend: Webhooks → Add webhook',
    secret: 'Then set RESEND_WEBHOOK_SECRET to the webhook’s signing secret.',
  },
};
