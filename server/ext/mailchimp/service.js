// Mailchimp on Settings → Services (ext/connections lists it): set up or
// not; Check — the key works, which audience, and whether Mailchimp sends
// unsubscribes to this base.win — reads only; Connect (mailchimp.connect,
// managers) is the one write: it gives Mailchimp the address they come back
// to.
//
// That address ends in a key made from the API key (mailchimp.js): it is
// given to Mailchimp and never shown, logged or put in an answer. If
// Mailchimp answers Connect with a signing secret, it is passed on once, to
// set as MAILCHIMP_WEBHOOK_SECRET, and kept nowhere here.
import { apiKey, AudienceError, audienceId, audiences, HOOK_PREFIX, hookUrl, mailchimp, mailchimpOn, MailchimpError, webhookSecrets } from './mailchimp.js';
import { deliveries } from './webhook.js';

const NEEDS = ['MAILCHIMP_API_KEY'];
const env = (k) => String(process.env[k] || '').trim();
// What could not be confirmed is said where the manager sets it up.
export const UNCONFIRMED = 'Built against Mailchimp’s published API: press Check on your own account before relying on it.';
const NO_SERVER = 'MAILCHIMP_API_KEY doesn’t end in its server (like -us19): copy the whole key';
// The webhook base.win asks for: who left, whose address died, whose address
// changed — and never its own changes echoed back (sources.api off).
const EVENTS = { subscribe: false, unsubscribe: true, profile: false, cleaned: true, upemail: true, campaign: false };
const SOURCES = { user: true, admin: true, api: false };

export const mailchimpService = () => {
  const on = mailchimpOn();
  return {
    key: 'mailchimp',
    name: 'Mailchimp',
    for: 'A list becomes a tag in your Mailchimp audience; unsubscribes and dead addresses come back',
    launch: false,
    missing: on ? [] : NEEDS,
    set: on ? NEEDS : [],
    state: on ? 'ready' : 'missing',
    detail: apiKey() && !on ? NO_SERVER : UNCONFIRMED,
    checkable: true,
    // Connect and Pull now (web: MailchimpPanel.jsx).
    ...(on ? { panel: 'mailchimp' } : {}),
  };
};
// Under "Coming in": the address, without its last part.
export const mailchimpInbound = (base) => ({
  name: 'Mailchimp — unsubscribed, dead addresses',
  url: `${String(base || '').replace(/\/+$/, '')}${HOOK_PREFIX}…`,
  how: 'Given to Mailchimp by Connect (Mailchimp, above). Its last part is made from the key and never shown',
});

// Two addresses that are one: a host however its capitals were typed, with
// or without a last slash.
const plain = (u) => {
  try { const x = new URL(String(u)); return `${x.protocol}//${x.host}${x.pathname.replace(/\/+$/, '')}${x.search}`; } catch { return String(u || '').replace(/\/+$/, ''); }
};
const here = (h, base) => plain(h?.url) === plain(hookUrl(base));
// Any address under this base.win's /hooks/mailchimp/: the one in use, or
// one made from an earlier key.
const ours = (h, base) => plain(h?.url).startsWith(`${plain(`${String(base || '').replace(/\/+$/, '')}${HOOK_PREFIX}`)}/`);
const sends = (h) => Boolean(h?.events?.unsubscribe && h?.events?.cleaned);
const webhooksOf = async (audience) => (await mailchimp('GET', `/lists/${audience}/webhooks`, { timeoutMs: 8000 }))?.webhooks || [];
const words = (e) => (e instanceof MailchimpError ? e.message : `Mailchimp didn’t answer: ${String(e?.message || e).slice(0, 160)}`);
const named = (a) => `“${a.name}” (${a.id})`;

// The audience in use, as Check names it: { id, name, subscribed } — or
// the one sentence saying why there isn't one.
const audienceForCheck = async () => {
  const id = env('MAILCHIMP_AUDIENCE_ID');
  if (id) {
    try {
      const a = await mailchimp('GET', `/lists/${encodeURIComponent(id)}`, { query: { fields: 'id,name,stats.member_count' }, timeoutMs: 8000 });
      return { id, name: a?.name || id, subscribed: a?.stats?.member_count };
    } catch (e) {
      if (e instanceof MailchimpError && e.httpStatus === 404) return { problem: `The key works, but there’s no audience “${id}” on this account — check MAILCHIMP_AUDIENCE_ID` };
      throw e;
    }
  }
  const all = await audiences();
  if (!all.length) return { problem: 'The key works, but the account has no audience yet — make one in Mailchimp first' };
  if (all.length > 1) return { problem: `The key works, but the account has ${all.length} audiences — set MAILCHIMP_AUDIENCE_ID to one: ${all.map(named).join(' · ')}` };
  return { id: String(all[0].id), name: all[0].name, subscribed: all[0].stats?.member_count };
};

// The webhook is there. With MAILCHIMP_WEBHOOK_SECRET set every delivery
// must be signed with it — so a webhook that isn't signed, or one signed
// with another secret, would have everything it sends refused: said here.
const signed = (hook, said) => {
  if (webhookSecrets().length) {
    if (hook.signing_enabled === false) {
      return { ok: false, said: `${said} — but MAILCHIMP_WEBHOOK_SECRET is set and that webhook isn’t signed, so what it sends is refused: take the setting away, or delete the webhook in Mailchimp and tap Connect` };
    }
    const d = deliveries();
    if (d.refusedAt > d.takenAt) {
      return { ok: false, said: `${said} — but the last thing Mailchimp sent was refused: its signature didn’t match MAILCHIMP_WEBHOOK_SECRET` };
    }
  }
  return { ok: true, said: `${said} · unsubscribes come back here` };
};

export const checkMailchimp = async (db, ws, base) => {
  if (!apiKey()) return { ok: false, said: 'MAILCHIMP_API_KEY isn’t set' };
  if (!mailchimpOn()) return { ok: false, said: NO_SERVER };
  try {
    await mailchimp('GET', '/ping', { timeoutMs: 8000 });
    const a = await audienceForCheck();
    if (a.problem) return { ok: false, said: a.problem };
    const count = Number.isFinite(Number(a.subscribed)) ? ` · ${Number(a.subscribed).toLocaleString('en-CA')} subscribed` : '';
    const said = `The key works · audience “${a.name}”${count}`;
    const hooks = await webhooksOf(a.id);
    const hook = hooks.find((h) => here(h, base) && sends(h));
    if (hook) return { ...signed(hook, said) };
    const stale = hooks.some((h) => ours(h, base) && !here(h, base));
    return { ok: false, said: `${said} — but Mailchimp ${stale ? 'sends unsubscribes to an address from an earlier key' : 'isn’t sending unsubscribes here yet'}: tap Connect` };
  } catch (e) {
    return { ok: false, said: words(e) };
  }
};

// → { ok, said, made?, secret? } — never throws. Nothing is written when
// Mailchimp already sends unsubscribes here.
export const connect = async (base) => {
  if (!apiKey()) return { ok: false, said: 'MAILCHIMP_API_KEY isn’t set' };
  if (!mailchimpOn()) return { ok: false, said: NO_SERVER };
  // Mailchimp is given this base.win's public address: without one it would
  // be told to send to wherever this page happens to be open.
  if (!env('STARBASE_PUBLIC_URL')) return { ok: false, said: 'Set the public address first (STARBASE_PUBLIC_URL): Mailchimp needs somewhere to send unsubscribes' };
  try {
    const audience = await audienceId();
    const hooks = await webhooksOf(audience);
    if (hooks.some((h) => here(h, base) && sends(h))) return { ok: true, said: 'Mailchimp already sends unsubscribes and dead addresses here' };
    const drop = (h) => mailchimp('DELETE', `/lists/${audience}/webhooks/${encodeURIComponent(h.id)}`, { timeoutMs: 8000 });
    const mine = hooks.filter((h) => ours(h, base) && h.id != null);
    // One at the right address with the events off makes room first (an
    // address is taken once); the right one is made; then any made from an
    // earlier key, which answers nothing now, goes — so there is never a
    // moment with a working webhook taken away and none put back.
    for (const h of mine.filter((x) => here(x, base))) await drop(h);
    const made = await mailchimp('POST', `/lists/${audience}/webhooks`, {
      body: { url: hookUrl(base), events: EVENTS, sources: SOURCES }, idempotencyKey: `base-mc-webhook-${audience}`, timeoutMs: 15_000,
    });
    for (const h of mine.filter((x) => !here(x, base))) await drop(h).catch(() => {});
    const secret = typeof made?.signing_secret === 'string' && made.signing_secret ? made.signing_secret : null;
    return { ok: true, made: true, said: 'Mailchimp now sends unsubscribes and dead addresses here', ...(secret ? { secret } : {}) };
  } catch (e) {
    return { ok: false, said: e instanceof AudienceError ? e.message : words(e) };
  }
};
