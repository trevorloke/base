// A stand-in for CallHub, so the dialer tests run with no account and no
// network. Point base.win at it with CALLHUB_API_BASE=http://127.0.0.1:<port>.
// It answers the API calls base.win makes and sends a call's result
// (CallHub's `cc.notes` webhook) the ways CallHub may send it.
//
// CallHub's own documentation could not be opened while this was written:
// what is here follows its published reference as search results quote it
// and two third-party clients (INTEGRATIONS.md says which parts are
// unconfirmed). It is a stand-in for the tests, not a description of CallHub.
//
//   In a test:   const fake = await startFakeCallHub({ apiKey, deliver })
//                deliver(raw, headers, target) → { status, body } posts one
//                result to the webhook (in-process tests use app.request);
//                without it results go to each cc.notes webhook's target
//                with fetch.
//   On its own:  PORT=4981 CALLHUB_API_KEY=… node server/test/fake-callhub.js
//
// The API (what base.win calls; every call wants "Authorization: Token <key>"):
//   GET    /v1/agents/                         the key works
//   POST   /v1/phonebooks/                     201 { url, name } (the id is in the url)
//   POST   /v1/phonebooks/:id/upsert_contact/  one contact per number; a
//                                              number already there is the same contact
//   GET    /v1/webhooks/ · POST /v1/webhooks/ · DELETE /v1/webhooks/:id/
//   GET    /v1/dnc_lists/ · POST /v1/dnc_lists/
//   POST   /v1/dnc_contacts/                   { dnc: <a list's url>, phone_number, category }
//   PUT    /v1/dnc_contacts/:id/               the same, for an entry already there
//   DELETE /v1/dnc_contacts/:id/               the number comes off the list
// Lists are paged ten at a time (count, next, results), as CallHub's are.
// For tests, in code or over HTTP (POST /__name with JSON):
//   note(fields, { envelope: 'data' | 'flat', as: 'json' | 'form' })
//                                 a call's result, to every cc.notes webhook
//   throttle(after, seconds)      after `after` more upserts, every upsert is
//                                 throttled (429, "Expected available in
//                                 <seconds> seconds"); throttle(false) ends it
//   dailyLimit(n)                 upsert_contact's limit a day (3,600)
//   refuse(status | false)        every API call answers this status (500, 401…)
//   reject(numbers | 'all' | false)  upsert_contact won't take these numbers
//                                 (400, { contact: ["Enter a valid phone number."] })
//   oneHookPerEvent(true | false) a second webhook for an event is refused (400)
//   uniqueDnc(true | false)       a number already on a do-not-call list is
//                                 refused a second entry there (400)
//   rejectDnc(numbers | 'all' | false)  dnc_contacts won't take these numbers
//                                 (400, { phone_number: ["Enter a valid phone number."] })
//   keepDnc(true | false)         a number can't be taken off a do-not-call
//                                 list (DELETE answers 405)
//   calls · phonebooks · contacts · dnc · dncLists · webhooks · delivered
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const PAGE = 10;
const parseBody = (req, body) => {
  const type = req.headers['content-type'] || '';
  if (!body) return {};
  if (type.includes('application/json')) { try { return JSON.parse(body); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(body));
};

export const startFakeCallHub = async ({ port = 0, apiKey = process.env.CALLHUB_API_KEY || null, deliver = null } = {}) => {
  let n = 100;
  const next = () => (n += 1);
  const calls = [];        // every API request, as it came
  const phonebooks = new Map(); // id → { id, name, description, numbers: Set }
  const contacts = new Map();   // number → the contact as last upserted
  const webhooks = [];     // { id, event, target }
  const dncLists = [];     // { id, name }
  const dnc = [];          // { id, list, phone_number, category }
  const delivered = [];    // every result sent, with the answer
  let base = '';
  let limit = 3600;
  let upserts = 0;
  let throttled = null;    // { after, seconds }
  let refused = false;
  let rejected = null;     // a Set of numbers, or 'all'
  let onePerEvent = false;
  let dncOnce = false;
  let dncRejected = null;  // a Set of numbers, or 'all'
  let dncKept = false;

  const urlOf = (kind, id) => `${base}/v1/${kind}/${id}/`;
  const paged = (rows, url) => {
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const slice = rows.slice((page - 1) * PAGE, page * PAGE);
    const more = page * PAGE < rows.length;
    return { count: rows.length, next: more ? `${base}${url.pathname}?page=${page + 1}` : null, previous: null, results: slice };
  };

  const post = deliver || (async (raw, headers, target) => {
    const r = await fetch(target, { method: 'POST', headers, body: raw });
    return { status: r.status, body: await r.json().catch(() => null) };
  });

  // One call's result, as CallHub's reference lists its keys. envelope:
  // inside a top-level `data` (how one third-party client reads it) or at the
  // top level; as: JSON, or a form (the agent as dotted keys, the survey as
  // JSON text).
  const note = async (fields = {}, { envelope = 'data', as = 'json' } = {}) => {
    const agent = { id: 7, username: 'caller', email: 'caller@example.org', ...(fields.agent || {}) };
    const payload = {
      contact: '', mobile: '', first_name: '', last_name: '', email: '', address: '', city: '', state: '', zipcode: '', country: '',
      company_name: '', company_website: '', job_title: '', notes: '', disposition: '', record_url: '', campaign: 'Test campaign',
      surveys: [], nationbuilder_id: null, nationbuilder_tags: [], ...fields, agent,
    };
    let raw; let type;
    if (as === 'form') {
      const flat = {};
      for (const [k, v] of Object.entries(payload)) {
        if (k === 'agent') for (const [ak, av] of Object.entries(v)) flat[`agent.${ak}`] = String(av ?? '');
        else flat[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
      }
      raw = new URLSearchParams(envelope === 'data' ? { event: 'cc.notes', data: JSON.stringify(payload) } : flat).toString();
      type = 'application/x-www-form-urlencoded';
    } else {
      raw = JSON.stringify(envelope === 'data' ? { event: 'cc.notes', data: payload } : payload);
      type = 'application/json';
    }
    const targets = webhooks.filter((w) => w.event === 'cc.notes').map((w) => w.target);
    const out = [];
    for (const target of targets) {
      const res = await post(raw, { 'content-type': type }, target);
      delivered.push({ target, type, raw, status: res.status, body: res.body });
      out.push({ target, ...res });
    }
    return out.length === 1 ? out[0] : out;
  };

  const api = {
    calls, phonebooks, contacts, webhooks, dncLists, dnc, delivered,
    get url() { return base; },
    note,
    throttle: (after, seconds = 30) => { throttled = after === false || after == null ? null : { after: upserts + Number(after), seconds }; },
    dailyLimit: (v) => { limit = Number(v); },
    refuse: (status) => { refused = status || false; },
    reject: (numbers) => { rejected = numbers === 'all' ? 'all' : numbers ? new Set(numbers) : null; },
    oneHookPerEvent: (on) => { onePerEvent = Boolean(on); },
    uniqueDnc: (on) => { dncOnce = Boolean(on); },
    rejectDnc: (numbers) => { dncRejected = numbers === 'all' ? 'all' : numbers ? new Set(numbers) : null; },
    keepDnc: (on) => { dncKept = Boolean(on); },
    // What left base.win for one phonebook: its contacts, in the order sent.
    sent: (phonebookId) => calls.filter((c) => c.method === 'POST' && c.path === `/v1/phonebooks/${phonebookId}/upsert_contact/` && c.status < 300).map((c) => c.params),
    upserts: () => calls.filter((c) => c.method === 'POST' && /\/upsert_contact\/$/.test(c.path)),
    reset: () => {
      calls.length = 0; delivered.length = 0; webhooks.length = 0; dncLists.length = 0; dnc.length = 0;
      phonebooks.clear(); contacts.clear(); upserts = 0; throttled = null; refused = false; limit = 3600; rejected = null; onePerEvent = false; dncOnce = false; dncRejected = null; dncKept = false;
    },
  };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://x');
      const params = parseBody(req, body);
      const call = { method: req.method, path: url.pathname, params, auth: req.headers.authorization || null,
        idem: req.headers['idempotency-key'] || null, type: req.headers['content-type'] || null, status: 0 };
      const json = (o, status = 200, headers = {}) => {
        call.status = status;
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(o === null ? '' : JSON.stringify(o));
      };
      try {
        // ── Test controls ──
        if (url.pathname.startsWith('/__')) {
          const name = url.pathname.slice(3);
          if (req.method === 'GET') {
            const read = { log: () => calls, delivered: () => delivered, webhooks: () => webhooks, dnc: () => dnc,
              phonebooks: () => [...phonebooks.values()].map((p) => ({ ...p, numbers: [...p.numbers] })) }[name];
            return read ? json(read()) : json({ detail: 'Not found.' }, 404);
          }
          const fn = { note: () => note(params.fields || {}, params.options || {}), throttle: () => api.throttle(params.after, params.seconds),
            dailyLimit: () => api.dailyLimit(params.limit), refuse: () => api.refuse(params.status), reject: () => api.reject(params.numbers),
            oneHookPerEvent: () => api.oneHookPerEvent(params.on), uniqueDnc: () => api.uniqueDnc(params.on), rejectDnc: () => api.rejectDnc(params.numbers),
            keepDnc: () => api.keepDnc(params.on),
            reset: () => api.reset() }[name];
          if (!fn) return json({ detail: 'Not found.' }, 404);
          return json({ ok: true, result: await fn() ?? null });
        }
        calls.push(call);
        if (refused) return json({ detail: refused === 401 ? 'Invalid token.' : 'Simulated outage' }, refused);
        if (!/^Token \S+/.test(call.auth || '') || (apiKey && call.auth !== `Token ${apiKey}`)) return json({ detail: 'Invalid token.' }, 401);

        if (req.method === 'GET' && url.pathname === '/v1/agents/') {
          return json(paged([{ id: 7, username: 'caller', email: 'caller@example.org', owner: [{ username: 'campaign' }] }], url));
        }
        if (req.method === 'POST' && url.pathname === '/v1/phonebooks/') {
          if (!String(params.name || '').trim()) return json({ name: ['This field is required.'] }, 400);
          const id = next();
          phonebooks.set(String(id), { id, name: String(params.name), description: String(params.description || ''), numbers: new Set() });
          return json({ url: urlOf('phonebooks', id), name: String(params.name), description: String(params.description || ''), count: 0 }, 201);
        }
        let m = url.pathname.match(/^\/v1\/phonebooks\/([^/]+)\/upsert_contact\/$/);
        if (m && req.method === 'POST') {
          const book = phonebooks.get(m[1]);
          if (!book) return json({ detail: 'Not found.' }, 404);
          if (throttled && upserts >= throttled.after) {
            return json({ detail: `Request was throttled. Expected available in ${throttled.seconds} seconds.` }, 429, { 'retry-after': String(throttled.seconds) });
          }
          if (upserts >= limit) return json({ detail: 'Request was throttled. Expected available in 86400 seconds.' }, 429, { 'retry-after': '86400' });
          const number = String(params.contact || '').trim();
          if (!number) return json({ contact: ['This field is required.'] }, 400);
          if (rejected === 'all' || rejected?.has(number)) return json({ contact: ['Enter a valid phone number.'] }, 400);
          upserts += 1;
          const had = contacts.get(number);
          const contact = { id: had?.id || next(), ...params };
          contacts.set(number, contact);
          book.numbers.add(number);
          return json({ ...contact, url: urlOf('contacts', contact.id) }, had ? 200 : 201);
        }
        if (url.pathname === '/v1/webhooks/') {
          if (req.method === 'GET') return json(paged(webhooks.map((w) => ({ ...w, url: urlOf('webhooks', w.id) })), url));
          if (req.method === 'POST') {
            if (!params.event || !params.target) return json({ detail: 'event and target are required' }, 400);
            if (onePerEvent && webhooks.some((w) => w.event === String(params.event))) return json({ event: ['A webhook for this event already exists.'] }, 400);
            const w = { id: next(), event: String(params.event), target: String(params.target) };
            webhooks.push(w);
            return json({ ...w, url: urlOf('webhooks', w.id) }, 201);
          }
        }
        m = url.pathname.match(/^\/v1\/webhooks\/([^/]+)\/$/);
        if (m && req.method === 'DELETE') {
          const i = webhooks.findIndex((w) => String(w.id) === m[1]);
          if (i < 0) return json({ detail: 'Not found.' }, 404);
          webhooks.splice(i, 1);
          return json(null, 204);
        }
        if (url.pathname === '/v1/dnc_lists/') {
          if (req.method === 'GET') return json(paged(dncLists.map((l) => ({ url: urlOf('dnc_lists', l.id), name: l.name })), url));
          if (req.method === 'POST') {
            if (!String(params.name || '').trim()) return json({ name: ['This field is required.'] }, 400);
            const l = { id: next(), name: String(params.name) };
            dncLists.push(l);
            return json({ url: urlOf('dnc_lists', l.id), name: l.name }, 201);
          }
        }
        if (req.method === 'POST' && url.pathname === '/v1/dnc_contacts/') {
          const list = dncLists.find((l) => urlOf('dnc_lists', l.id) === String(params.dnc || ''));
          if (!list) return json({ dnc: ['Invalid hyperlink - Object does not exist.'] }, 400);
          if (!String(params.phone_number || '').trim()) return json({ phone_number: ['This field is required.'] }, 400);
          if (dncRejected === 'all' || dncRejected?.has(String(params.phone_number))) return json({ phone_number: ['Enter a valid phone number.'] }, 400);
          if (dncOnce && dnc.some((d) => d.list === list.name && d.phone_number === String(params.phone_number))) {
            return json({ phone_number: ['dnc contact with this phone number already exists.'] }, 400);
          }
          const row = { id: next(), list: list.name, phone_number: String(params.phone_number), category: Number(params.category ?? 3) };
          dnc.push(row);
          return json({ url: urlOf('dnc_contacts', row.id), dnc: params.dnc, phone_number: row.phone_number, category: row.category }, 201);
        }
        m = url.pathname.match(/^\/v1\/dnc_contacts\/([^/]+)\/$/);
        if (m && req.method === 'PUT') {
          const row = dnc.find((d) => String(d.id) === m[1]);
          if (!row) return json({ detail: 'Not found.' }, 404);
          if (dncRejected === 'all' || dncRejected?.has(row.phone_number)) return json({ phone_number: ['Enter a valid phone number.'] }, 400);
          if (params.category != null) row.category = Number(params.category);
          return json({ url: urlOf('dnc_contacts', row.id), dnc: params.dnc, phone_number: row.phone_number, category: row.category });
        }
        if (m && req.method === 'DELETE') {
          if (dncKept) return json({ detail: 'Method "DELETE" not allowed.' }, 405);
          const i = dnc.findIndex((d) => String(d.id) === m[1]);
          if (i < 0) return json({ detail: 'Not found.' }, 404);
          dnc.splice(i, 1);
          return json(null, 204);
        }
        return json({ detail: 'Not found.' }, 404);
      } catch (e) {
        return json({ detail: String(e.message) }, 500);
      }
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  api.close = () => new Promise((r) => server.close(r));
  api.port = server.address().port;
  return api;
};

// On its own: the browser suite runs it next to a server.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const fake = await startFakeCallHub({ port: Number(process.env.PORT) || 4981 });
  console.log(`fake callhub on ${fake.url}`);
}
