// CallHub over plain fetch — no SDK, no new dependency. Everything here is a
// leaf: settings, the address results come back to, one request helper and
// the error it throws.
//
//   CALLHUB_API_KEY   the account's API key (CallHub → Settings → API key) —
//                     the host's environment only, never the repo
//   CALLHUB_API_BASE  the API's address for this account. Default
//                     https://api.callhub.io; some accounts are on another
//                     host (https://api-na1.callhub.io). Tests point it at a
//                     stand-in (test/fake-callhub.js).
//
// Built from CallHub's published documentation, which could not be opened
// while this was written (INTEGRATIONS.md lists what is unconfirmed): the
// calls are the documented ones, and what comes back is read tolerantly.
import { createHmac, timingSafeEqual } from 'node:crypto';

const env = (k) => String(process.env[k] || '').trim();
export const apiKey = () => env('CALLHUB_API_KEY');
export const callhubOn = () => Boolean(apiKey());
// "api-na1.callhub.io", "https://api-na1.callhub.io/v1/": the same host.
export const apiBase = () => {
  const raw = env('CALLHUB_API_BASE') || 'https://api.callhub.io';
  return (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).replace(/\/+$/, '').replace(/\/v[12]$/i, '');
};

// The last part of the address CallHub sends results to. Nothing documents
// a signature on those deliveries, so the address itself is the lock: 32
// hex characters made from the API key (HMAC-SHA256 over a fixed label).
// One secret to set, nothing stored, and a new key is a new address (Check
// then says to connect again). Never in an answer or on the log.
const LABEL = 'base.win callhub results v1';
export const pathKey = () => (apiKey() ? createHmac('sha256', apiKey()).update(LABEL).digest('hex').slice(0, 32) : '');
export const HOOK_PREFIX = '/hooks/callhub/';
export const hookUrl = (base) => `${String(base || '').replace(/\/+$/, '')}${HOOK_PREFIX}${pathKey()}`;
// Compared whole, in the same time, so a guess learns nothing.
export const pathKeyMatches = (given) => {
  const want = Buffer.from(pathKey());
  const got = Buffer.from(String(given ?? ''));
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
};

// throttled: CallHub said to slow down (429, or its "Request was
// throttled"); retryAfter: in how many seconds it will take the next call,
// when it says. theirs: the message is CallHub's own words (an answer it
// gave), not ours for an answer that never came.
export class CallHubError extends Error {
  constructor(message, { status = 0, throttled = false, retryAfter = null, theirs = false } = {}) {
    super(message);
    this.name = 'CallHubError';
    this.httpStatus = status;
    this.throttled = throttled;
    this.retryAfter = retryAfter;
    this.theirs = theirs;
  }
}

// CallHub's own words for a refusal: { detail: "…" }, or { field: ["…"] }.
const wordsOf = (body, status) => {
  if (body && typeof body.detail === 'string' && body.detail.trim()) return body.detail.trim();
  if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body)) {
      const said = Array.isArray(v) ? v.find((x) => typeof x === 'string') : typeof v === 'string' ? v : null;
      if (said) return `${k}: ${said}`;
    }
  }
  return `CallHub answered ${status}`;
};

// Writes go out one a second (CallHub's documented pace for create calls).
let paceMs = 1000;
export const _setPaceForTest = (ms) => { paceMs = ms; };
export const pause = () => (paceMs > 0 ? new Promise((r) => { setTimeout(r, paceMs); }) : null);

// One call to CallHub. `path` is under /v1 ("/phonebooks/"), or a whole
// address CallHub gave for the next page. That one is followed only on the
// API's own host, and always at the address set here (a "next" written
// http:// by a server behind a proxy still goes out as https), so the key
// never goes anywhere else. Never a key in an error.
export const callhub = async (method, path, { body, idempotencyKey, timeoutMs = 10_000 } = {}) => {
  const base = apiBase();
  let url = `${base}/v1${path}`;
  if (/^https?:\/\//i.test(path)) {
    const next = new URL(path);
    if (next.hostname !== new URL(base).hostname) throw new CallHubError('CallHub pointed at another address; not followed');
    url = `${new URL(base).origin}${next.pathname}${next.search}`;
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Token ${apiKey()}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        // CallHub documents none; sent so a repeat is recognisable if it ever reads one.
        ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 200) } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new CallHubError(timedOut ? `CallHub didn’t answer in ${Math.round(timeoutMs / 1000)} s` : `CallHub couldn’t be reached (${String(e?.message || e).slice(0, 120)})`);
  }
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (res.ok) return data;
  const words = wordsOf(data, res.status).slice(0, 300);
  const throttled = res.status === 429 || /throttled/i.test(words);
  const header = Number(res.headers.get('retry-after'));
  const inWords = Number((/available in (\d+) second/i.exec(words) || [])[1]);
  const retryAfter = Number.isFinite(header) && header > 0 ? header : Number.isFinite(inWords) && inWords > 0 ? inWords : null;
  throw new CallHubError(words, { status: res.status, throttled, retryAfter, theirs: words !== `CallHub answered ${res.status}` });
};

// Every row of a paged list (count, next, results) — ten to a page; at most
// `pages` of them, which is far more than a campaign has webhooks or lists.
export const listAll = async (path, { pages = 20, timeoutMs = 8000 } = {}) => {
  const out = [];
  let next = path;
  for (let i = 0; next && i < pages; i += 1) {
    const page = await callhub('GET', next, { timeoutMs });
    if (Array.isArray(page)) { out.push(...page); break; }
    out.push(...(Array.isArray(page?.results) ? page.results : []));
    next = typeof page?.next === 'string' && page.next ? page.next : null;
  }
  return out;
};

// An object's id: given outright, or the last part of its address
// ("…/v1/phonebooks/123/" → "123").
export const idOf = (o) => {
  if (o?.id != null && String(o.id).trim()) return String(o.id);
  const m = /\/([^/]+)\/?$/.exec(String(o?.url || ''));
  return m ? m[1] : null;
};
