// A stand-in for Mailchimp's Marketing API, so the Mailchimp tests run with
// no account and no network — built like fake-stripe.js and fake-mail.js.
// Point base.win at it with MAILCHIMP_API_BASE = fake.url. It answers the
// calls base.win makes (all under /3.0), keeps one or more audiences with
// their members, tags (static segments) and webhooks, and posts audience
// webhooks as Mailchimp does: a form, signed when a secret is given.
//
//   const fake = await startFakeMailchimp({ apiKey, deliver })
//     deliver(raw, headers, url) → { status, body } posts one webhook
//     (in-process tests use app.request); without it webhooks go to the
//     address each was saved with, by fetch.
//
// What it answers:
//   GET  /ping · GET /lists · GET /lists/:id
//   POST /lists/:id                         batch subscribe (500 at most)
//   GET  /lists/:id/members                 ?status ?since_last_changed ?count ?offset
//   GET · PATCH /lists/:id/members/:hash    the md5 of the lower-cased address
//   GET · POST /lists/:id/segments          the tags
//   GET · POST /lists/:id/segments/:id[/members]   who is in a tag; add and remove (500 each)
//   GET · POST /lists/:id/webhooks · DELETE /lists/:id/webhooks/:id
// For tests:
//   audience(id, name)        one more audience (there is one to start: fake.id)
//   add(email, { status, first, last, changed, optIn })   someone who joined in Mailchimp itself
//   member(email) · tagged(name)   what Mailchimp holds: one member; the addresses in a tag
//   unsubscribe(email, { send }) · clean(email, { send })
//                             they left, or the address bounced for good — and
//                             the webhook says so (send: false: it never arrives)
//   hook(type, data, { sign, signWith, path })   any webhook, forged ones too
//   refuse(email, words)      batch subscribe refuses this address
//   limit({ after, times })   answer 429 — after that many more calls, that many times
//   fail(code | false)        every call answers that status
//   slow(ms)                  every call waits that long first (a browser check watching a sync)
//   signing(secret | null)    a webhook made from now on is signed with it (shown once, on create)
//   probe(fn | null)          saving a webhook first asks fn(url) → status; refused unless 200
//   calls                     every request: { method, path, query, body, auth }
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { signPayload } from '../ext/payments/stripe.js';

const md5 = (s) => createHash('md5').update(String(s).trim().toLowerCase()).digest('hex');
const lower = (s) => String(s ?? '').trim().toLowerCase();
const VALID = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const startFakeMailchimp = async ({ port = 0, apiKey = null, deliver = null } = {}) => {
  const calls = [];
  const audiences = new Map();
  const refusals = new Map();
  let n = 0;
  let limited = null; // { after, times }
  let failWith = false;
  let slowMs = 0;
  let signWith = null;
  let probeWith = null;
  let base = '';
  const next = () => (n += 1);
  const audience = (id, name = 'Sample Campaign') => {
    const a = { id, name, members: new Map(), segments: new Map(), webhooks: [] };
    audiences.set(id, a);
    return a;
  };
  const first = audience('aud0001');

  const memberOut = (m) => ({
    id: m.id, email_address: m.email_address, status: m.status, merge_fields: m.merge_fields, last_changed: m.last_changed,
    timestamp_opt: m.timestamp_opt, ...(m.unsubscribe_reason ? { unsubscribe_reason: m.unsubscribe_reason } : {}),
  });
  const put = (a, email, { status = 'subscribed', first: f = '', last: l = '', changed = new Date(), optIn = changed } = {}) => {
    const m = { id: md5(email), email_address: email, status, merge_fields: { FNAME: f, LNAME: l }, last_changed: new Date(changed).toISOString(), timestamp_opt: new Date(optIn).toISOString() };
    a.members.set(m.id, m);
    return m;
  };

  const post = deliver || (async (raw, headers, url) => {
    const r = await fetch(url, { method: 'POST', headers, body: raw });
    return { status: r.status, body: await r.json().catch(() => null) };
  });
  // One webhook as Mailchimp posts it: a form, signed when the webhook has a secret.
  const formOf = (type, data) => {
    const f = new URLSearchParams({ type, fired_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
    for (const [k, v] of Object.entries(data)) f.append(`data[${k}]`, String(v));
    return f.toString();
  };
  const headersFor = (raw, secret) => ({
    'content-type': 'application/x-www-form-urlencoded',
    ...(secret ? { 'x-mailchimp-signature': signPayload(raw, secret) } : {}),
  });
  const fire = async (a, type, data, by = 'user') => {
    const out = [];
    for (const w of a.webhooks) {
      if (!w.events?.[type] || !w.sources?.[by]) continue;
      const raw = formOf(type, { list_id: a.id, ...data });
      out.push(await post(raw, headersFor(raw, w.secret), w.url));
    }
    return out;
  };
  const change = async (email, status, type, { send = true, reason = '', at = new Date(), audienceId = first.id } = {}) => {
    const a = audiences.get(audienceId);
    const m = a.members.get(md5(email)) || put(a, email);
    m.status = status;
    m.last_changed = new Date(at).toISOString();
    if (status === 'unsubscribed') m.unsubscribe_reason = reason || 'N/A (Unsubscribed by subscriber)';
    return send ? fire(a, type, { email: m.email_address, id: m.id.slice(0, 10), reason: reason || (type === 'cleaned' ? 'hard' : 'manual') }) : [];
  };

  const api = {
    calls,
    id: first.id,
    get url() { return base; },
    audience,
    add: (email, opts = {}) => put(audiences.get(opts.audienceId || first.id), email, opts),
    member: (email, audienceId = first.id) => audiences.get(audienceId).members.get(md5(email)) || null,
    members: (audienceId = first.id) => [...audiences.get(audienceId).members.values()],
    tagged: (name, audienceId = first.id) => {
      const s = [...audiences.get(audienceId).segments.values()].find((x) => x.name === name);
      return s ? [...s.members].sort() : null;
    },
    webhooks: (audienceId = first.id) => audiences.get(audienceId).webhooks,
    unsubscribe: (email, opts) => change(email, 'unsubscribed', 'unsubscribe', opts),
    clean: (email, opts) => change(email, 'cleaned', 'cleaned', opts),
    // Any webhook to an address: `path` when given, else the first saved one.
    hook: async (type, data, { sign = null, path = null, audienceId = first.id, json = false } = {}) => {
      const url = path || audiences.get(audienceId).webhooks[0]?.url;
      const raw = json ? JSON.stringify({ type, fired_at: new Date().toISOString(), data }) : formOf(type, data);
      const headers = { ...headersFor(raw, sign), ...(json ? { 'content-type': 'application/json' } : {}) };
      return post(raw, headers, url);
    },
    refuse: (email, words = 'looks fake or invalid, please enter a real email address.') => { refusals.set(lower(email), words); },
    limit: (v = {}) => { limited = v === false ? null : { after: v.after ?? 0, times: v.times ?? 1 }; },
    fail: (v) => { failWith = v; },
    slow: (ms) => { slowMs = Number(ms) || 0; },
    signing: (secret) => { signWith = secret; },
    probe: (fn) => { probeWith = fn; },
    reset: () => {
      calls.length = 0; refusals.clear(); limited = null; failWith = false; slowMs = 0; signWith = null; probeWith = null;
      for (const a of audiences.values()) { a.members.clear(); a.segments.clear(); a.webhooks.length = 0; }
      for (const id of [...audiences.keys()]) if (id !== first.id) audiences.delete(id);
    },
  };

  const problem = (status, title, detail) => [{ type: 'https://mailchimp.com/developer/marketing/docs/errors/', title, status, detail, instance: randomUUID() }, status];

  const handle = async (req, url, body) => {
    const parts = url.pathname.replace(/^\/3\.0/, '').split('/').filter(Boolean);
    const q = url.searchParams;
    const count = Math.min(Number(q.get('count')) || 10, 1000);
    const offset = Number(q.get('offset')) || 0;
    const page = (rows) => rows.slice(offset, offset + count);
    if (!url.pathname.startsWith('/3.0/')) return problem(404, 'Resource Not Found', 'The requested resource could not be found.');
    if (req.method === 'GET' && parts.join('/') === 'ping') return [{ health_status: "Everything's Chimpy!" }, 200];
    if (parts[0] !== 'lists') return problem(404, 'Resource Not Found', 'The requested resource could not be found.');
    const listOut = (a) => ({ id: a.id, name: a.name, stats: { member_count: [...a.members.values()].filter((m) => m.status === 'subscribed').length } });
    if (parts.length === 1 && req.method === 'GET') {
      const rows = [...audiences.values()].map(listOut);
      return [{ lists: page(rows), total_items: rows.length }, 200];
    }
    const a = audiences.get(parts[1]);
    if (!a) return problem(404, 'Resource Not Found', 'The requested resource could not be found.');
    if (parts.length === 2 && req.method === 'GET') return [listOut(a), 200];

    // Batch subscribe: new addresses in; someone already there is only changed when asked.
    if (parts.length === 2 && req.method === 'POST') {
      const members = body?.members || [];
      if (members.length > 500) return problem(400, 'Invalid Resource', 'The members array may hold up to 500 members.');
      const out = { new_members: [], updated_members: [], errors: [] };
      for (const m of members) {
        const email = String(m.email_address || '');
        const have = a.members.get(md5(email));
        if (!VALID.test(email)) out.errors.push({ email_address: email, error: 'Please provide a valid email address.', error_code: 'ERROR_GENERIC' });
        else if (refusals.has(lower(email))) out.errors.push({ email_address: email, error: `${email} ${refusals.get(lower(email))}`, error_code: 'ERROR_GENERIC' });
        else if (have && !body.update_existing) out.errors.push({ email_address: email, error: `${email} is already a list member, do you want to update? please provide update_existing:true in the request body`, error_code: 'ERROR_CONTACT_EXISTS' });
        else if (have) { Object.assign(have, { status: m.status, merge_fields: { ...have.merge_fields, ...m.merge_fields }, last_changed: new Date().toISOString() }); out.updated_members.push(memberOut(have)); }
        else out.new_members.push(memberOut(put(a, email, { status: m.status, first: m.merge_fields?.FNAME, last: m.merge_fields?.LNAME })));
      }
      return [{ ...out, total_created: out.new_members.length, total_updated: out.updated_members.length, error_count: out.errors.length }, 200];
    }

    if (parts[2] === 'members' && parts.length === 3 && req.method === 'GET') {
      const since = q.get('since_last_changed') ? new Date(q.get('since_last_changed')).getTime() : null;
      const rows = [...a.members.values()]
        .filter((m) => (!q.get('status') || m.status === q.get('status')) && (since === null || new Date(m.last_changed).getTime() > since))
        .sort((x, y) => x.email_address.localeCompare(y.email_address));
      return [{ members: page(rows).map(memberOut), list_id: a.id, total_items: rows.length }, 200];
    }
    if (parts[2] === 'members' && parts.length === 4) {
      const m = a.members.get(parts[3]);
      if (!m) return problem(404, 'Resource Not Found', 'The requested resource could not be found.');
      if (req.method === 'GET') return [memberOut(m), 200];
      if (req.method === 'PATCH') {
        Object.assign(m, { ...(body.status ? { status: body.status } : {}), last_changed: new Date().toISOString() });
        // base.win's own change: an "api" source, which its webhook leaves off.
        if (body.status === 'unsubscribed') await fire(a, 'unsubscribe', { email: m.email_address, id: m.id.slice(0, 10), reason: 'manual' }, 'api');
        return [memberOut(m), 200];
      }
    }

    if (parts[2] === 'segments') {
      const segOut = (s) => ({ id: s.id, name: s.name, type: 'static', member_count: s.members.size, list_id: a.id });
      if (parts.length === 3 && req.method === 'GET') {
        const rows = [...a.segments.values()].map(segOut);
        return [{ segments: page(rows), list_id: a.id, total_items: rows.length }, 200];
      }
      if (parts.length === 3 && req.method === 'POST') {
        if ([...a.segments.values()].some((s) => s.name === body.name)) return problem(400, 'Invalid Resource', 'Sorry, that tag already exists.');
        const s = { id: 7000 + next(), name: body.name, members: new Set() };
        a.segments.set(String(s.id), s);
        for (const e of body.static_segment || []) if (a.members.has(md5(e))) s.members.add(lower(e));
        return [segOut(s), 200];
      }
      const s = a.segments.get(parts[3]);
      if (!s) return problem(404, 'Resource Not Found', 'The requested resource could not be found.');
      if (parts.length === 5 && parts[4] === 'members' && req.method === 'GET') {
        const rows = [...s.members].sort().map((e) => a.members.get(md5(e))).filter(Boolean);
        return [{ members: page(rows).map(memberOut), total_items: rows.length }, 200];
      }
      if (parts.length === 4 && req.method === 'POST') {
        const add = body.members_to_add || [];
        const remove = body.members_to_remove || [];
        if (add.length > 500 || remove.length > 500) return problem(400, 'Invalid Resource', 'Up to 500 addresses at a time.');
        const out = { members_added: [], members_removed: [], errors: [] };
        const missing = [];
        for (const e of add) {
          if (!a.members.has(md5(e))) missing.push(e);
          else if (!s.members.has(lower(e))) { s.members.add(lower(e)); out.members_added.push({ email_address: e }); }
        }
        for (const e of remove) if (s.members.delete(lower(e))) out.members_removed.push({ email_address: e });
        if (missing.length) out.errors.push({ email_addresses: missing, error: 'Email addresses do not exist on the list' });
        return [{ ...out, total_added: out.members_added.length, total_removed: out.members_removed.length, error_count: missing.length }, 200];
      }
    }

    if (parts[2] === 'webhooks') {
      const hookOut = ({ secret, ...w }) => ({ ...w, signing_enabled: Boolean(secret) });
      if (parts.length === 3 && req.method === 'GET') return [{ webhooks: a.webhooks.map(hookOut), list_id: a.id, total_items: a.webhooks.length }, 200];
      if (parts.length === 3 && req.method === 'POST') {
        // Mailchimp asks the address before it saves it.
        if (probeWith && (await probeWith(body.url)) !== 200) return problem(400, 'Invalid Resource', 'We couldn’t validate the URL you provided. Please check the URL and try again.');
        const w = { id: `wh${next()}`, url: body.url, events: body.events || {}, sources: body.sources || {}, list_id: a.id, secret: signWith };
        a.webhooks.push(w);
        return [{ ...hookOut(w), ...(signWith ? { signing_secret: signWith } : {}) }, 200];
      }
      if (parts.length === 4 && req.method === 'DELETE') {
        const i = a.webhooks.findIndex((w) => w.id === parts[3]);
        if (i < 0) return problem(404, 'Resource Not Found', 'The requested resource could not be found.');
        a.webhooks.splice(i, 1);
        return [null, 204];
      }
    }
    return problem(404, 'Resource Not Found', `unhandled ${req.method} ${url.pathname}`);
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const auth = req.headers.authorization || '';
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      calls.push({ method: req.method, path: url.pathname.replace(/^\/3\.0/, ''), query: Object.fromEntries(url.searchParams), body, auth });
      const send = ([o, status]) => { res.writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' }); res.end(o === null ? '' : JSON.stringify(o)); };
      try {
        // Basic auth, any user name, the key as the password (or a Bearer key).
        const basic = /^Basic (.+)$/.exec(auth);
        const given = basic ? Buffer.from(basic[1], 'base64').toString('utf8').split(':').slice(1).join(':') : (/^Bearer (.+)$/.exec(auth)?.[1] || '');
        if (!given || (apiKey && given !== apiKey)) return send(problem(401, 'API Key Invalid', "Your API key may be invalid, or you've attempted to access the wrong datacenter."));
        if (slowMs) await new Promise((r) => { setTimeout(r, slowMs); });
        if (failWith) return send(problem(failWith, 'Internal Server Error', 'An unexpected internal error has occurred.'));
        if (limited) {
          if (limited.after > 0) limited.after -= 1;
          else {
            limited.times -= 1;
            if (limited.times <= 0) limited = null;
            return send(problem(429, 'Too Many Requests', 'You have exceeded the limit of 10 simultaneous connections.'));
          }
        }
        return send(await handle(req, url, body));
      } catch (e) {
        return send(problem(500, 'Internal Server Error', String(e.message)));
      }
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  api.port = server.address().port;
  api.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
  return api;
};
