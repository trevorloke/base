// A stand-in for a campaign's own website (hosted apart from base.win), so
// the unsubscribe sync is tested both ways with no website and no network —
// built from the website's contract like fake-mailchimp.js. The real handler
// cannot be imported here (it needs its own framework and database), so the
// contract test in website-consent.test.js holds this file to the website's
// source: the order of the checks, the statuses and the words.
//
//   const site = await startFakeWebsite({ key })
//     site.url                 give it to base.win as STARBASE_WEBSITE_URL
//
// Its side that takes base.win's unsubscribes, POST /api/in/consent, checks
// in the website's own order: 429 over 120 calls a minute · 503 with no
// inbound key · 401 a wrong key · 415 not JSON · 400 no Idempotency-Key ·
// 413 over 10,000 bytes · 400 not JSON, or outside the shape · then 200
// { ok: true, applied } — the same key and body again answers the first
// answer with replayed: true; the same key with another body is 409. A yes
// ("grant") is answered and never applied. Nothing it takes is sent back.
//
// Its side that sends base.win its own: the outbox. A withdrawal waits there
// and goes with sendNow() as the website sends it — keys sorted, its own
// headers, the row's id as the Idempotency-Key — and each answer is sorted
// as the website sorts it (classifyAnswer).
//
// For tests:
//   person({ email, phone })   someone the website has (so "applied" counts them)
//   ledger                     every no applied here: { email, phone, channel, reason, at, key }
//   calls                      every request: { method, path, auth, type, key, raw }
//   setKey(key | null)         its inbound key (null: not set → 503)
//   fail(code | false)         every call answers that status
//   down(true | false)         the connection is dropped: nobody answers
//   slow(ms)                   every call waits that long first
//   redirect(to | null)        every call is sent on to another address (307)
//   busy(n)                    the next n calls answer 429
//   withdraw(w, { at })        a no made on the website: into the outbox
//   outbox                     [{ id, payload, status: 'pending' | 'sent' | 'failed', attempts, lastError }]
//   sendNow({ url, key, deliver })   try every waiting row; deliver(path, { method, headers, body })
//                              → { status, json } posts in-process (tests use app.request)
import http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

// ── The website's sender (apps/web/src/lib/server/starbase.ts) ──
export const CONSENT_CHANNELS = ['email', 'sms'];
export const CONSENT_REASONS = ['unsubscribe', 'stop', 'preference', 'deletion'];
export const PEOPLE_ENDPOINT = '/in/v1/people';
export const CONSENT_ENDPOINT = '/in/v1/consent';

// JSON with keys in sorted order at every level.
export const stableJson = (value) => JSON.stringify(value, (_key, v) => (
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

// A withdrawal as the website builds it: the email lower-cased, the time from toISOString().
export const consentPayload = (w) => {
  const email = typeof w.email === 'string' && w.email.trim() ? w.email.trim().toLowerCase() : undefined;
  const phone = typeof w.phone === 'string' && w.phone.trim() ? w.phone.trim().slice(0, 40) : undefined;
  if (!email && !phone) return null;
  return { ...(email ? { email } : {}), ...(phone ? { phone } : {}), channel: w.channel, action: 'withdraw', reason: w.reason, at: (w.at ?? new Date()).toISOString() };
};

// What one call came to, as the website sorts it.
export const classifyAnswer = (status, body, endpoint = PEOPLE_ENDPOINT) => {
  const b = body && typeof body === 'object' ? body : {};
  const message = typeof b.error === 'string' && b.error ? b.error.slice(0, 500) : `HTTP ${status}`;
  if (status >= 200 && status < 300) {
    const personId = typeof b.person_id === 'string' && b.person_id ? b.person_id : null;
    if (b.ok === true && (personId || endpoint === CONSENT_ENDPOINT)) return { kind: 'ok', personId, replayed: b.replayed === true };
    return { kind: 'retry', status, error: 'answered without ok' };
  }
  if (status === 404 && endpoint === CONSENT_ENDPOINT) return { kind: 'unsupported', status, error: 'Not supported yet' };
  if (status === 401 || status === 403 || status === 404) return { kind: 'config', status, error: message };
  if (status === 429 || status === 408 || status >= 500) return { kind: 'retry', status, error: message };
  return { kind: 'refused', status, error: message };
};

// The headers and bytes of one send.
export const requestFor = (key, payload, idempotencyKey) => ({
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json', 'idempotency-key': String(idempotencyKey).slice(0, 200) },
  body: stableJson(payload),
});

// ── The website's side that takes base.win's (starbase-inbound.ts, api/in/consent/route.ts) ──
const MAX_BODY = 10_000;
const trimmed = (max) => z.string().trim().min(1).max(max);
export const inboundConsentSchema = z.object({
  email: trimmed(320).toLowerCase().pipe(z.email()).optional().nullable(),
  phone: trimmed(40).optional().nullable(),
  channel: z.enum(CONSENT_CHANNELS),
  action: z.enum(['withdraw', 'grant']),
  reason: z.enum(CONSENT_REASONS),
  at: z.iso.datetime({ offset: true }),
}).strict().refine((v) => v.email || v.phone, { message: 'an email or a phone' });
const schemaError = (error) => {
  const issue = error.issues[0];
  return `${issue.path.length ? `${issue.path.join('.')}: ` : ''}${issue.message}`;
};
const bearerMatches = (header, key) => {
  if (!key) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  if (!m) return false;
  const digest = (s) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(m[1]), digest(key));
};
const phoneDigits = (raw) => {
  const digits = (raw ?? '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return digits.length === 10 ? digits : null;
};

export const startFakeWebsite = async ({ port = 0, key = null } = {}) => {
  const state = { key, fail: false, down: false, slow: 0, redirect: null, busy: 0, hits: { count: 0, resetAt: 0 } };
  const calls = [];
  const ledger = [];
  const people = [];
  const answers = new Map(); // Idempotency-Key → { hash, answer }
  const outbox = [];

  const rateLimited = () => {
    const now = Date.now();
    if (state.hits.resetAt < now) { state.hits = { count: 1, resetAt: now + 60_000 }; return false; }
    state.hits.count += 1;
    return state.hits.count > 120;
  };
  const apply = (c, idempotencyKey, raw) => {
    const hash = createHash('sha256').update(raw).digest('hex');
    const previous = answers.get(idempotencyKey);
    if (previous) {
      if (previous.hash !== hash) return { status: 409, body: { error: 'that Idempotency-Key was used with a different body' } };
      return { status: 200, body: { ...previous.answer, replayed: true } };
    }
    let answer;
    if (c.action === 'grant') answer = { ok: true, applied: 0, note: 'Grants are not applied from Starbase; only withdrawals are.' };
    else {
      const digits = phoneDigits(c.phone);
      const matches = people.filter((p) => (c.email && p.email === c.email) || (digits && phoneDigits(p.phone) === digits));
      // Nothing here forwards to base.win: a no that came from there is never sent back.
      ledger.push({ email: c.email ?? null, phone: c.phone ?? null, channel: c.channel, reason: c.reason, at: c.at, key: idempotencyKey });
      answer = { ok: true, applied: matches.length };
    }
    answers.set(idempotencyKey, { hash, answer });
    return { status: 200, body: answer };
  };
  const handle = (req, raw) => {
    const error = (message, status) => ({ status, body: { error: message } });
    if (state.fail) return error(`HTTP ${state.fail}`, state.fail);
    if (state.busy > 0) { state.busy -= 1; return error('more than 120 requests a minute', 429); }
    if (req.method !== 'POST' || new URL(req.url, 'http://x').pathname !== '/api/in/consent') return error('Not found', 404);
    if (rateLimited()) return error('more than 120 requests a minute', 429);
    if (!state.key) return error('Inbound consent is off: STARBASE_INBOUND_KEY isn\'t set on the website.', 503);
    if (!bearerMatches(req.headers.authorization, state.key)) return error('a valid key goes in the Authorization header: Bearer …', 401);
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return error('send JSON (Content-Type: application/json)', 415);
    const idempotencyKey = (req.headers['idempotency-key'] ?? '').trim();
    if (!idempotencyKey || idempotencyKey.length > 200) return error('send an Idempotency-Key header (1 to 200 characters)', 400);
    if (raw.length > MAX_BODY) return error('the body is too large', 413);
    let body;
    try { body = JSON.parse(raw); } catch { return error('the body isn’t JSON', 400); }
    const parsed = inboundConsentSchema.safeParse(body);
    if (!parsed.success) return error(schemaError(parsed.error), 400);
    return apply(parsed.data, idempotencyKey, raw);
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      calls.push({ method: req.method, path: req.url, auth: req.headers.authorization || null, type: req.headers['content-type'] || null, key: req.headers['idempotency-key'] ?? null, raw });
      if (state.down) { req.socket.destroy(); return; }
      if (state.slow) await new Promise((r) => { setTimeout(r, state.slow); });
      // The caller gave up while it waited: nothing is applied for a call nobody is listening to.
      if (req.socket.destroyed) return;
      if (state.redirect) { res.writeHead(307, { location: state.redirect }); res.end(); return; }
      const out = handle(req, raw);
      res.writeHead(out.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out.body));
    });
  });
  await new Promise((r) => { server.listen(port, '127.0.0.1', r); });
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    calls,
    ledger,
    outbox,
    person: (p) => { people.push({ email: p.email ? String(p.email).toLowerCase() : null, phone: p.phone || null }); },
    setKey: (k) => { state.key = k; },
    fail: (code) => { state.fail = code || false; },
    down: (yes) => { state.down = Boolean(yes); },
    slow: (ms) => { state.slow = ms || 0; },
    redirect: (to) => { state.redirect = to || null; },
    busy: (n) => { state.busy = n || 0; },
    reset: () => {
      calls.length = 0; ledger.length = 0; people.length = 0; outbox.length = 0; answers.clear();
      Object.assign(state, { fail: false, down: false, slow: 0, redirect: null, busy: 0, hits: { count: 0, resetAt: 0 } });
    },
    // A no made on the website itself: it waits in the outbox for base.win.
    withdraw: (w) => {
      const payload = consentPayload(w);
      if (!payload) return null;
      const row = { id: randomUUID(), payload, status: 'pending', attempts: 0, lastError: null };
      outbox.push(row);
      return row;
    },
    // Every waiting row, as the website sends it. → the answers, in order.
    sendNow: async ({ url: baseUrl = null, key: baseKey, deliver = null }) => {
      const out = [];
      for (const row of outbox.filter((r) => r.status === 'pending')) {
        const reqInit = requestFor(baseKey, row.payload, row.id);
        let status; let json = null;
        try {
          if (deliver) ({ status, json } = await deliver(CONSENT_ENDPOINT, reqInit));
          else {
            const res = await fetch(`${baseUrl}${CONSENT_ENDPOINT}`, { ...reqInit, signal: AbortSignal.timeout(10_000) });
            status = res.status;
            json = await res.json().catch(() => null);
          }
        } catch (e) {
          out.push({ kind: 'retry', status: null, error: String(e.message) });
          row.lastError = String(e.message);
          continue;
        }
        const answer = classifyAnswer(status, json, CONSENT_ENDPOINT);
        if (answer.kind === 'ok') Object.assign(row, { status: 'sent', attempts: row.attempts + 1, lastError: null });
        else if (answer.kind === 'refused') Object.assign(row, { status: 'failed', attempts: row.attempts + 1, lastError: `${answer.status}: ${answer.error}` });
        // config, unsupported: still waiting, no try used; retry: waiting, a try used.
        else Object.assign(row, { attempts: row.attempts + (answer.kind === 'retry' ? 1 : 0), lastError: answer.error });
        out.push(answer);
      }
      return out;
    },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
};
