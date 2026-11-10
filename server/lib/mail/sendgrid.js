// SendGrid (Twilio SendGrid) — everything base.win needs to know about this
// email sender, over plain fetch. Built against SendGrid's published API and
// its own event-webhook helper; INTEGRATIONS.md says what is still to
// confirm on a real account.
//
//   Send      POST /v3/mail/send (202; the email's id in X-Message-Id).
//             SendGrid has no idempotency key: a repeat can be a second
//             copy (idempotent: false). base.win's own ref rides as the
//             custom argument "ref" and comes back on every event.
//             SendGrid's own click, open and unsubscribe tracking is turned
//             off in each send: base.win counts its own and has its own
//             unsubscribe pages.
//   Events    a signed list per delivery: ECDSA (P-256, SHA-256) over the
//             timestamp header followed by the exact bytes, checked with the
//             Event Webhook's verification key (SENDGRID_WEBHOOK_PUBLIC_KEY).
//   Domain    GET/POST /v3/whitelabel/domains, …/:id/validate.
import { createHash, createPublicKey, createVerify } from 'node:crypto';
import { MailError, apiCall, env, has, isoOf, listOf, lower, noAnswer, refused, timeoutMs } from './common.js';

// SENDGRID_API_BASE is real, not only for tests: an EU subuser's is
// https://api.eu.sendgrid.com.
const api = () => (env('SENDGRID_API_BASE') || 'https://api.sendgrid.com').replace(/\/+$/, '');

const call = (method, path, body) => apiCall('SendGrid', `${api()}${path}`, {
  method, body, key: env('SENDGRID_API_KEY'),
  refusal: (res, json) => {
    if (res.status === 401) return new MailError('SendGrid refused the key', { status: 401 });
    // A key made for "Mail Send" only may not read anything else.
    if (res.status === 403) return new MailError('a sending-only key', { status: 403, restricted: true });
    const said = json?.errors?.[0]?.message;
    return new MailError(`SendGrid answered ${res.status}${said ? `: ${String(said).slice(0, 160)}` : ''}`, { status: res.status });
  },
});

// The key as SendGrid shows it (base64 of the DER), or as a PEM block.
const publicKey = (k) => (/BEGIN/.test(k)
  ? createPublicKey(k.replace(/\\n/g, '\n'))
  : createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }));

// ── Events, in base.win's words ──
// A drop is SendGrid refusing to send. When its reason is the address
// itself — it bounced before, reported spam, unsubscribed at SendGrid, is
// on its invalid list — the address is suppressed here too; any other
// reason (the message, the account) is a failure of that one email.
const dropOf = (reason) => {
  const r = String(reason || '');
  if (/spam report/i.test(r)) return { kind: 'suppressed', reason: 'complaint' };
  if (/bounced address|unsubscribed address|^invalid$/i.test(r.trim())) return { kind: 'suppressed', reason: 'bounce' };
  return { kind: 'failed' };
};
const one = (e) => {
  if (!e || typeof e !== 'object') return null;
  // The reference writes "spam report"; deliveries have been seen as "spamreport".
  const name = String(e.event || '').toLowerCase().replace(/[\s_]/g, '');
  const out = {
    id: e.sg_event_id ? String(e.sg_event_id) : createHash('sha1').update(JSON.stringify(e)).digest('hex'),
    kind: null,
    ref: [e.ref, e.custom_args?.ref, e.unique_args?.ref].find((v) => v != null && v !== '') ?? null,
    // X-Message-Id is the part of sg_message_id before the first dot.
    messageId: String(e.sg_message_id || '').split('.')[0] || null,
    email: lower(e.email) || null,
    at: isoOf(Number(e.timestamp) > 0 ? Number(e.timestamp) : null),
  };
  if (out.ref != null) out.ref = String(out.ref);
  if (name === 'delivered') out.kind = 'delivered';
  else if (name === 'bounce') {
    // "blocked" is the receiving server saying not now (a block list, a
    // full mailbox); only type "bounce" is an address that doesn't exist.
    if (e.type === 'bounce') { out.kind = 'bounced'; out.permanent = true; } else out.kind = 'deferred';
    out.detail = [e.status, e.reason].filter(Boolean).join(' ').slice(0, 500) || 'Bounced';
  } else if (name === 'deferred') {
    out.kind = 'deferred';
    out.detail = String(e.response || e.reason || 'Delivery delayed').slice(0, 500);
  } else if (name === 'spamreport') out.kind = 'complained';
  else if (name === 'dropped') {
    Object.assign(out, dropOf(e.reason));
    out.detail = String(e.reason || 'Dropped by SendGrid').slice(0, 500);
  } else return null; // processed, open, click, unsubscribe…: not base.win's
  return out;
};

// ── The sender's domain ──
const purposeOf = (k) => (/dkim/i.test(k) ? 'DKIM' : /spf|mail/i.test(k) ? 'SPF' : k);
const shape = (d, results = {}) => ({
  found: true,
  status: d.valid ? 'verified' : 'pending',
  records: Object.entries(d.dns || {}).filter(([, r]) => r && r.host).map(([k, r]) => ({
    purpose: purposeOf(k), type: String(r.type || '').toUpperCase(), name: r.host, value: r.data,
    ok: Boolean(results?.[k] ? results[k].valid : r.valid),
  })),
});
const NONE = { found: false, status: null, records: [] };
const find = async (name) => {
  const list = await call('GET', '/v3/whitelabel/domains');
  return (Array.isArray(list) ? list : []).find((d) => lower(d.domain) === name) || null;
};

// What is missing for delivery events to come back, in one sentence — or
// null. SendGrid's webhook settings aren't read from here: the proof that it
// points at this server is an event that came in.
const hookShortfall = (eventsSeen) => {
  if (!has('SENDGRID_WEBHOOK_PUBLIC_KEY')) return 'Set SENDGRID_WEBHOOK_PUBLIC_KEY to the Event Webhook’s verification key.';
  if (!eventsSeen) return 'No delivery event has come in from SendGrid yet: send a test email, then check again.';
  return null;
};

export default {
  key: 'sendgrid',
  name: 'SendGrid',
  needs: ['SENDGRID_API_KEY', 'MAIL_FROM'],
  hookNeeds: ['SENDGRID_WEBHOOK_PUBLIC_KEY'],
  idempotent: false,
  noFrom: 'MAIL_FROM not set: SendGrid needs a sender on your domain',
  // No test sender here: without MAIL_FROM nothing can go, so nothing is tried.
  ready: () => has('SENDGRID_API_KEY') && has('MAIL_FROM'),

  // One email. Never throws. → { sent, status: 'sent' | 'failed', id?, detail?, unknown? }
  async send({ from, to, subject, text, html, headers, attachments, ref }) {
    try {
      const res = await fetch(`${api()}/v3/mail/send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env('SENDGRID_API_KEY')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }], ...(ref != null && ref !== '' ? { custom_args: { ref: String(ref) } } : {}) }],
          from: { email: from.email, ...(from.name ? { name: from.name } : {}) },
          subject,
          // The plain part first: SendGrid refuses them the other way round.
          content: [{ type: 'text/plain', value: text }, ...(html ? [{ type: 'text/html', value: html }] : [])],
          ...(headers && Object.keys(headers).length ? { headers } : {}),
          ...(attachments?.length ? { attachments: attachments.map((a) => ({ content: a.content, filename: a.filename, ...(a.content_type ? { type: a.content_type } : {}) })) } : {}),
          tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false }, subscription_tracking: { enable: false } },
        }),
        signal: AbortSignal.timeout(timeoutMs()),
      });
      if (!res.ok) return refused(res);
      const id = res.headers.get('x-message-id');
      return { sent: true, status: 'sent', ...(id ? { id } : {}) };
    } catch (e) {
      return noAnswer(e);
    }
  },

  // A delivery of events arrived. raw: the exact bytes. headers: (name) => value.
  // No age limit on the timestamp (SendGrid's own helper has none, and how it
  // stamps a retry isn't documented): each event is done once, by its id.
  verify(raw, headers) {
    const sig = headers('x-twilio-email-event-webhook-signature');
    const t = headers('x-twilio-email-event-webhook-timestamp');
    if (!sig || t == null || t === '') return false;
    const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
    return listOf('SENDGRID_WEBHOOK_PUBLIC_KEY').some((k) => {
      try {
        return createVerify('sha256').update(String(t)).update(body).verify({ key: publicKey(k), dsaEncoding: 'der' }, Buffer.from(String(sig), 'base64'));
      } catch {
        return false; // not a key, or not a signature: refused, never a crash
      }
    });
  },

  // → [{ id, kind, ref, messageId, email, at, permanent?, reason?, detail? }]
  // Several events per delivery; the ones base.win doesn't use are left out.
  parse(raw) {
    const list = JSON.parse((Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw))).toString('utf8'));
    return Array.isArray(list) ? list.map(one).filter(Boolean) : [];
  },

  domain: {
    async get(name) { const d = await find(name); return d ? shape(d) : NONE; },
    async add(name) { return shape(await call('POST', '/v3/whitelabel/domains', { domain: name, automatic_security: true })); },
    async check(name) {
      const d = await find(name);
      if (!d) return NONE;
      const v = await call('POST', `/v3/whitelabel/domains/${d.id}/validate`);
      return shape({ ...d, valid: Boolean(v?.valid) }, v?.validation_results || {});
    },
  },

  // Settings → Services: reads only, nothing sent (see resend.js for the answer).
  async check({ domain, eventsSeen }) {
    let domains;
    try {
      domains = await call('GET', '/v3/whitelabel/domains');
    } catch (e) {
      if (!e.restricted) return { ok: false, said: e.message };
      return { ok: true, verified: true, hookKnown: Boolean(eventsSeen), said: 'The key works (a sending-only key: the domain can’t be checked from here)', hook: hookShortfall(eventsSeen) };
    }
    if (!domain) return { ok: false, said: 'The key works; MAIL_FROM isn’t set, and SendGrid needs a sender on your domain' };
    const d = (Array.isArray(domains) ? domains : []).find((x) => lower(x.domain) === domain);
    if (!d) return { ok: false, said: `The key works, but ${domain} isn’t an authenticated domain on this SendGrid account` };
    if (!d.valid) return { ok: false, said: `The key works; ${domain} isn’t verified in SendGrid yet — finish its DNS records` };
    return { ok: true, verified: true, hookKnown: true, said: `The key works and ${domain} is verified`, hook: hookShortfall(eventsSeen) };
  },

  hook: {
    events: ['delivered', 'bounce', 'dropped', 'deferred', 'spamreport'],
    where: 'SendGrid: Settings → Mail Settings → Event Webhooks',
    secret: 'Turn on Signed Event Webhook there, then set SENDGRID_WEBHOOK_PUBLIC_KEY to its verification key.',
  },
};
