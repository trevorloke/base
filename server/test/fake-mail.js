// A stand-in for the email sender (Resend or SendGrid), so the mail tests run
// with no account and no network — built like fake-stripe.js. Point base.win
// at it with RESEND_API_BASE / SENDGRID_API_BASE = fake.url. It answers the
// calls base.win makes, keeps what was sent, and posts delivery events
// signed exactly as the sender signs them.
//
//   const fake = await startFakeMail({ provider: 'resend', secret, deliver })
//     deliver(raw, headers) → { status, body } posts one delivery to the
//     webhook (in-process tests use app.request); without it events go to
//     webhookUrl with fetch.
//
// What it answers (what base.win calls):
//   Resend    POST /emails (one per idempotency key; the same key with other
//             words is refused 409) · GET /domains · GET /domains/:id ·
//             POST /domains · POST /domains/:id/verify · GET /webhooks
//   SendGrid  POST /v3/mail/send (202, the id in X-Message-Id) ·
//             GET /v3/whitelabel/domains · POST /v3/whitelabel/domains ·
//             POST /v3/whitelabel/domains/:id/validate
// For tests:
//   sent                 every email taken: { to, from, subject, ref, id, key, body }
//   calls                every request: { method, path, auth }
//   event(kind, { to, ref, messageId, id, … })
//                        one delivery event, signed and posted: 'delivered' |
//                        'bounced' | 'deferred' | 'complained' | 'suppressed'
//                        | 'failed' (the same id twice = a repeat). Answers
//                        { status, body, raw, headers }.
//   signed(raw, { id, t })   the headers the sender would put on those bytes
//   post(raw, headers)   any bytes, any headers, to the webhook
//   fail(code | false)   sends answer that status
//   hang(true | false)   sends never answer (until the request gives up)
//   domains(list) · publish(name) · hooks(list) · sendingOnly(true)
//                        what the account holds; publish: the domain's DNS
//                        records are in, so the next verify finds them
//   publicKey            SendGrid: the key for SENDGRID_WEBHOOK_PUBLIC_KEY
import http from 'node:http';
import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { signPayload } from '../lib/mail/resend.js';

const nowS = () => Math.floor(Date.now() / 1000);

// The sender's own event for each kind base.win knows.
const RESEND_TYPE = {
  delivered: 'email.delivered', bounced: 'email.bounced', deferred: 'email.delivery_delayed',
  complained: 'email.complained', suppressed: 'email.suppressed', failed: 'email.failed',
};
const SENDGRID_EVENT = {
  delivered: 'delivered', bounced: 'bounce', deferred: 'deferred',
  complained: 'spamreport', suppressed: 'dropped', failed: 'dropped',
};

export const startFakeMail = async ({ provider = 'resend', port = 0, secret = 'whsec_dGVzdC1zZWNyZXQtZm9yLWZha2UtbWFpbA==', webhookUrl = null, deliver = null } = {}) => {
  let n = 0;
  const next = (p) => `${p}_${(++n).toString().padStart(4, '0')}${Math.random().toString(36).slice(2, 8)}`;
  const sent = [];
  sent.dropped = 0;
  const calls = [];
  const idem = new Map(); // idempotency key → { body, id }
  let failWith = false;
  let hanging = false;
  let restricted = false;
  let domainList = [];
  let hookList = [];
  const published = new Set();
  let base = '';
  const keys = provider === 'sendgrid' ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) : null;

  const post = deliver || (async (raw, headers) => {
    const r = await fetch(webhookUrl, { method: 'POST', headers, body: raw });
    return { status: r.status, body: await r.json().catch(() => null) };
  });

  // The headers the sender puts on a delivery of these bytes.
  const signed = (raw, { id = next('msg'), t = nowS(), signWith = secret } = {}) => {
    if (provider === 'resend') return { 'content-type': 'application/json', ...signPayload(raw, signWith, { id, t }) };
    const sig = createSign('sha256').update(String(t)).update(raw).sign({ key: signWith === secret ? keys.privateKey : signWith, dsaEncoding: 'der' });
    return {
      'content-type': 'application/json',
      'x-twilio-email-event-webhook-signature': sig.toString('base64'),
      'x-twilio-email-event-webhook-timestamp': String(t),
    };
  };

  // One event as the sender words it. `extra` goes into the sender's event
  // as is (a bounce's type, another spelling of an event's name).
  const build = (kind, { to, ref, messageId, id = next('evt'), at = new Date(), detail, extra = {}, tagsAs = 'object' } = {}) => {
    const email = sent.find((m) => (ref && m.ref === ref) || (messageId && m.id === messageId));
    const mid = messageId ?? email?.id ?? null;
    const address = to ?? email?.to ?? null;
    if (provider === 'resend') {
      const tags = ref ? (tagsAs === 'array' ? [{ name: 'ref', value: ref }] : { ref }) : undefined;
      const data = { email_id: mid, message_id: `<${mid}@fake.resend>`, from: email?.from || 'Team <team@example.org>', to: [address], subject: email?.subject || 'Hello', created_at: at.toISOString(), ...(tags ? { tags } : {}) };
      if (kind === 'bounced') data.bounce = { type: 'Permanent', subType: 'General', message: detail || 'The recipient’s mail server permanently rejected the email.' };
      if (kind === 'suppressed') data.suppressed = { type: 'bounce', message: detail || 'The address is on the suppression list.' };
      if (kind === 'failed') data.failed = { reason: detail || 'The email could not be sent.' };
      Object.assign(data, extra.data || {});
      return { id, raw: JSON.stringify({ type: extra.type || RESEND_TYPE[kind], created_at: at.toISOString(), data }) };
    }
    const ev = {
      email: address, timestamp: Math.floor(at.getTime() / 1000), event: SENDGRID_EVENT[kind], sg_event_id: id,
      sg_message_id: `${mid}.filterdrecv-fake-1-0`, ...(ref ? { ref } : {}),
      ...(kind === 'bounced' ? { type: 'bounce', status: '5.1.1', reason: detail || '550 5.1.1 The email account that you tried to reach does not exist.' } : {}),
      ...(kind === 'deferred' ? { response: detail || '451 try again later' } : {}),
      ...(kind === 'suppressed' ? { reason: detail || 'Bounced Address' } : {}),
      ...(kind === 'failed' ? { reason: detail || 'Invalid SMTPAPI header' } : {}),
      ...extra,
    };
    // As SendGrid posts them: an array, a line break after it.
    return { id, raw: `${JSON.stringify([ev])}\r\n` };
  };

  const api = {
    sent, calls,
    get url() { return base; },
    publicKey: keys ? keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') : null,
    signed,
    build,
    post,
    // One delivery event, signed as the sender signs it, to the webhook.
    event: async (kind, opts = {}) => {
      const { id, raw } = build(kind, opts);
      const headers = opts.sign === false ? { 'content-type': 'application/json' } : signed(raw, { id, t: opts.t, signWith: opts.signWith });
      const res = await post(raw, headers);
      return { ...res, raw, headers, id };
    },
    fail: (v) => { failWith = v; },
    hang: (v = true) => { hanging = v; },
    sendingOnly: (v = true) => { restricted = v; },
    domains: (list) => { domainList = list; },
    publish: (name) => { published.add(name); },
    hooks: (list) => { hookList = list; },
    reset: () => { sent.length = 0; sent.dropped = 0; calls.length = 0; idem.clear(); failWith = false; hanging = false; },
  };

  // The DNS records the sender asks for, as it lists them.
  const resendRecords = (d) => [
    { record: 'SPF', name: 'send', type: 'MX', value: 'feedback-smtp.us-east-1.amazonses.example', ttl: 'Auto', priority: 10, status: d.status === 'verified' ? 'verified' : d.spf || 'not_started' },
    { record: 'SPF', name: 'send', type: 'TXT', value: 'v=spf1 include:amazonses.example ~all', ttl: 'Auto', status: d.status === 'verified' ? 'verified' : d.spf || 'not_started' },
    { record: 'DKIM', name: 'resend._domainkey', type: 'TXT', value: 'p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQfake', ttl: 'Auto', status: d.status === 'verified' ? 'verified' : 'not_started' },
  ];
  const sendgridDns = (d) => ({
    mail_cname: { valid: !!d.valid, type: 'cname', host: `em1234.${d.domain}`, data: 'u1234.wl.sendgrid.example' },
    dkim1: { valid: !!d.valid, type: 'cname', host: `s1._domainkey.${d.domain}`, data: 's1.domainkey.u1234.wl.sendgrid.example' },
    dkim2: { valid: !!d.valid, type: 'cname', host: `s2._domainkey.${d.domain}`, data: 's2.domainkey.u1234.wl.sendgrid.example' },
  });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const auth = req.headers.authorization || null;
      calls.push({ method: req.method, path: url.pathname, auth });
      const json = (o, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(o === null ? '' : JSON.stringify(o)); };
      const params = body ? (() => { try { return JSON.parse(body); } catch { return null; } })() : {};
      const isSend = req.method === 'POST' && (url.pathname === '/emails' || url.pathname === '/v3/mail/send');
      try {
        if (!auth || !/^Bearer \S+/.test(auth)) return json({ statusCode: 401, name: 'missing_api_key', message: 'Missing API key', errors: [{ message: 'The provided authorization grant is invalid' }] }, 401);
        if (isSend && hanging) return undefined; // never answered: the request gives up by itself
        if (isSend && failWith) return json({ statusCode: failWith, name: 'application_error', message: 'Simulated refusal', errors: [{ message: 'Simulated refusal' }] }, failWith);

        if (provider === 'resend') {
          if (isSend) {
            const key = req.headers['idempotency-key'] || null;
            if (key && idem.has(key)) {
              const before = idem.get(key);
              if (before.body !== body) return json({ statusCode: 409, name: 'invalid_idempotent_request', message: 'Same idempotency key used with a different request payload.' }, 409);
              sent.dropped += 1;
              return json({ id: before.id });
            }
            const id = randomUUID();
            const ref = (params.tags || []).find((t) => t.name === 'ref')?.value || null;
            sent.push({ to: params.to?.[0], from: params.from, subject: params.subject, ref, id, key, body: params });
            if (key) idem.set(key, { body, id });
            return json({ id });
          }
          const restrictedNow = restricted && (url.pathname.startsWith('/domains') || url.pathname.startsWith('/webhooks'));
          if (restrictedNow) return json({ statusCode: 401, name: 'restricted_api_key', message: 'This API key is restricted to only send emails' }, 401);
          if (req.method === 'GET' && url.pathname === '/domains') {
            return json({ object: 'list', has_more: false, data: domainList.map(({ id, name, status, region }) => ({ id, name, status, region: region || 'us-east-1', created_at: '2026-10-01T00:00:00.000Z' })) });
          }
          if (req.method === 'POST' && url.pathname === '/domains') {
            if (domainList.some((d) => d.name === params.name)) return json({ statusCode: 403, name: 'validation_error', message: `The ${params.name} domain has been registered already.` }, 403);
            const d = { id: randomUUID(), name: params.name, status: 'not_started', region: params.region || 'us-east-1' };
            domainList.push(d);
            return json({ id: d.id, name: d.name, status: d.status, region: d.region, created_at: new Date().toISOString(), records: resendRecords(d) }, 201);
          }
          let m = url.pathname.match(/^\/domains\/([^/]+)\/verify$/);
          if (m && req.method === 'POST') {
            const d = domainList.find((x) => x.id === m[1]);
            if (!d) return json({ statusCode: 404, name: 'not_found', message: 'Domain not found' }, 404);
            d.status = published.has(d.name) ? 'verified' : 'pending';
            return json({ object: 'domain', id: d.id });
          }
          m = url.pathname.match(/^\/domains\/([^/]+)$/);
          if (m && req.method === 'GET') {
            const d = domainList.find((x) => x.id === m[1]);
            if (!d) return json({ statusCode: 404, name: 'not_found', message: 'Domain not found' }, 404);
            return json({ object: 'domain', id: d.id, name: d.name, status: d.status, region: d.region || 'us-east-1', created_at: '2026-10-01T00:00:00.000Z', records: resendRecords(d) });
          }
          if (req.method === 'GET' && url.pathname === '/webhooks') return json({ object: 'list', has_more: false, data: hookList });
        } else {
          if (isSend) {
            const id = next('sg').replace(/_/g, '');
            const p = params.personalizations?.[0] || {};
            sent.push({ to: p.to?.[0]?.email, from: params.from, subject: params.subject, ref: p.custom_args?.ref || null, id, key: null, body: params });
            return json(null, 202, { 'x-message-id': id });
          }
          if (restricted && url.pathname.startsWith('/v3/whitelabel')) return json({ errors: [{ field: null, message: 'access forbidden' }] }, 403);
          if (req.method === 'GET' && url.pathname === '/v3/whitelabel/domains') return json(domainList.map((d) => ({ id: d.id, domain: d.domain, subdomain: 'em1234', valid: !!d.valid, dns: sendgridDns(d) })));
          if (req.method === 'POST' && url.pathname === '/v3/whitelabel/domains') {
            const d = { id: 1000 + domainList.length, domain: params.domain, valid: false };
            domainList.push(d);
            return json({ id: d.id, domain: d.domain, subdomain: 'em1234', valid: false, dns: sendgridDns(d) }, 201);
          }
          const m = url.pathname.match(/^\/v3\/whitelabel\/domains\/(\d+)\/validate$/);
          if (m && req.method === 'POST') {
            const d = domainList.find((x) => String(x.id) === m[1]);
            if (!d) return json({ errors: [{ message: 'not found' }] }, 404);
            d.valid = published.has(d.domain);
            const one = { valid: d.valid, reason: d.valid ? null : 'Expected CNAME record was not found.' };
            return json({ id: d.id, valid: d.valid, validation_results: { mail_cname: one, dkim1: one, dkim2: one } });
          }
        }
        return json({ message: `unhandled ${req.method} ${url.pathname}` }, 404);
      } catch (e) {
        return json({ message: String(e.message) }, 500);
      }
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  api.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  api.port = server.address().port;
  return api;
};
