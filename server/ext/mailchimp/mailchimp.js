// Mailchimp's Marketing API over plain fetch — no SDK, no new dependency.
// Everything here is a leaf: the settings, the address Mailchimp's webhook
// calls, one request helper and the error it throws.
//
//   MAILCHIMP_API_KEY         the account's key (Mailchimp → Account → Extras
//                             → API keys). Its ending is the server it lives
//                             on ("…-us19"). The host's environment only.
//   MAILCHIMP_AUDIENCE_ID     which audience, when the account has several
//   MAILCHIMP_WEBHOOK_SECRET  optional: the signing secret Connect showed
//                             once (a comma list while one is rolled)
//   MAILCHIMP_API_BASE        tests point it at a stand-in (test/fake-mailchimp.js)
//
// Built against Mailchimp's published API, which could not be opened while
// this was written (INTEGRATIONS.md lists what is unconfirmed): the calls
// are the documented ones, what comes back is read tolerantly, and every
// write is one that is safe to repeat.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const env = (k) => String(process.env[k] || '').trim();
export const apiKey = () => env('MAILCHIMP_API_KEY');
// "…-us19" → us19: a few letters and a number, nothing else, so a mistyped
// key can never name another host.
const serverOf = (key) => (/-([a-z]{2,4}\d{1,3})$/i.exec(key)?.[1] || '').toLowerCase();
export const apiBase = () => {
  const given = env('MAILCHIMP_API_BASE');
  if (given) return given.replace(/\/+$/, '').replace(/\/3\.0$/, '');
  const server = serverOf(apiKey());
  return server ? `https://${server}.api.mailchimp.com` : '';
};
// On: a key, and somewhere to call with it.
export const mailchimpOn = () => Boolean(apiKey() && apiBase());
export const webhookSecrets = () => env('MAILCHIMP_WEBHOOK_SECRET').split(',').map((s) => s.trim()).filter(Boolean);

export const lower = (s) => String(s ?? '').trim().toLowerCase();
// How Mailchimp names a member: the MD5 of the lower-cased address.
export const memberHash = (email) => createHash('md5').update(lower(email)).digest('hex');

// The last part of the address Mailchimp's webhook calls: 32 hex characters
// made from the API key (HMAC-SHA256 over a fixed label). One secret to set,
// nothing stored, and a new key is a new address (Check then says to connect
// again). Given to Mailchimp only: never in an answer or on the log.
const LABEL = 'base.win mailchimp webhook v1';
export const pathKey = () => (apiKey() ? createHmac('sha256', apiKey()).update(LABEL).digest('hex').slice(0, 32) : '');
export const HOOK_PREFIX = '/hooks/mailchimp/';
export const hookUrl = (base) => `${String(base || '').replace(/\/+$/, '')}${HOOK_PREFIX}${pathKey()}`;
// Compared whole, in the same time, so a guess learns nothing.
export const pathKeyMatches = (given) => {
  const want = Buffer.from(pathKey());
  const got = Buffer.from(String(given ?? ''));
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
};

// retryable: worth another try later — Mailchimp said "too many" (429), had
// a fault of its own (5xx), or never answered. Anything else will not
// change by waiting (a refused key, an audience that isn't there).
export class MailchimpError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'MailchimpError';
    this.httpStatus = status;
    this.retryable = retryable;
  }
}
export const REFUSED_KEY = 'Mailchimp refused the key — copy the whole key, with its ending (like -us19)';
// Mailchimp's own words for a refusal ({ title, detail }), never ours.
const wordsOf = (body, status) => {
  const said = [body?.detail, body?.title].find((s) => typeof s === 'string' && s.trim());
  return said ? `Mailchimp said: ${said.trim()}` : `Mailchimp answered ${status}`;
};

// One call to Mailchimp. `path` is under /3.0 ("/lists/abc/members").
// Never a key in an error: it travels as a password (Basic auth, any user
// name), never in an address. idempotencyKey: sent with every write so a
// repeat is recognisable if Mailchimp ever reads one — it documents none,
// which is why each write here is one that is safe to repeat by its nature.
export const mailchimp = async (method, path, { query, body, idempotencyKey, timeoutMs = 20_000 } = {}) => {
  const qs = query ? new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== '')).toString() : '';
  let res;
  try {
    res = await fetch(`${apiBase()}/3.0${path}${qs ? `?${qs}` : ''}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`base.win:${apiKey()}`).toString('base64')}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey).slice(0, 200) } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const code = [e?.cause?.code, e?.cause?.errors?.[0]?.code].find((c) => /^E[A-Z_]+$/.test(String(c || '')));
    throw new MailchimpError(`Mailchimp didn’t answer${timedOut ? ` in ${Math.round(timeoutMs / 1000)} s` : code ? ` (${code})` : ''}`, { retryable: true });
  }
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (res.ok) return data;
  if (res.status === 401 || res.status === 403) throw new MailchimpError(REFUSED_KEY, { status: res.status });
  throw new MailchimpError(wordsOf(data, res.status).slice(0, 300), { status: res.status, retryable: res.status === 429 || res.status >= 500 });
};

// Every row of a paged list (count, offset, total_items), a thousand at a
// time — Mailchimp's most. `rows` names the array in the answer.
export const PAGE = 1000;
export const pages = async (path, rows, query = {}) => {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await mailchimp('GET', path, { query: { ...query, count: PAGE, offset } });
    const got = Array.isArray(page?.[rows]) ? page[rows] : [];
    out.push(...got);
    if (got.length < PAGE || (Number.isFinite(page?.total_items) && out.length >= page.total_items)) return out;
  }
};

// ── Which audience ──
// MAILCHIMP_AUDIENCE_ID, or the account's only one. With several and none
// named nothing is guessed: `choose` carries them for Check to name.
export class AudienceError extends MailchimpError {
  constructor(message, { choose = null, ...rest } = {}) {
    super(message, rest);
    this.name = 'AudienceError';
    this.choose = choose;
  }
}
export const audiences = async () => (await mailchimp('GET', '/lists', {
  query: { count: 20, fields: 'lists.id,lists.name,lists.stats.member_count,total_items' }, timeoutMs: 8000,
}))?.lists || [];
// The account's only audience is asked for once in ten minutes, not with every tap.
let only = null; // { for, id, at }
const ONLY_MS = 10 * 60_000;
export const _forgetAudienceForTest = () => { only = null; };
const who = () => `${apiBase()}|${apiKey()}`;
// The audience without asking Mailchimp: the one named, or the only one as
// last found. null: not known just now.
export const knownAudience = () => env('MAILCHIMP_AUDIENCE_ID') || (only && only.for === who() && Date.now() - only.at < ONLY_MS ? only.id : null);
export const audienceId = async () => {
  const known = knownAudience();
  if (known) return known;
  const lists = await audiences();
  if (lists.length === 1) {
    only = { for: who(), id: String(lists[0].id), at: Date.now() };
    return only.id;
  }
  only = null;
  if (!lists.length) throw new AudienceError('The Mailchimp account has no audience yet — make one in Mailchimp first', { choose: [] });
  throw new AudienceError(`The account has ${lists.length} audiences — a manager sets MAILCHIMP_AUDIENCE_ID to one (Settings → Services → Mailchimp → Check names them)`, { choose: lists });
};
