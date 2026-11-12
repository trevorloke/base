// The `t=…,v1=…` signature: what Stripe puts on a webhook (base.win checks
// it, ext/payments), what Mailchimp's unsubscribes carry once the campaign
// has set their signing secret (ext/mailchimp), and what base.win puts on
// what a ladder sends to a web address (ext/ladders/webhook.js), so whoever
// receives it can check it the same way.
//
//   <Name>-Signature: t=<seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">[,v1=…]
//
// Checked over the exact bytes received, in constant time, against every
// secret given; a timestamp more than five minutes from now (either way) is
// refused, so a captured request can't be replayed later.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TOLERANCE_S = 300;
const hmacHex = (secret, t, raw) => createHmac('sha256', secret).update(`${t}.`).update(raw).digest('hex');

export const verifySignature = (raw, header, secrets, { toleranceS = TOLERANCE_S, nowS = Date.now() / 1000 } = {}) => {
  if (!secrets?.length) return { ok: false, why: 'no webhook secret is set' };
  if (!header) return { ok: false, why: 'no signature' };
  let t = null;
  const sigs = [];
  for (const part of String(header).split(',')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && t === null) t = v;
    else if (k === 'v1' && /^[0-9a-f]{64}$/i.test(v)) sigs.push(Buffer.from(v, 'hex'));
  }
  if (!t || !/^\d{1,12}$/.test(t)) return { ok: false, why: 'no timestamp' };
  if (!sigs.length) return { ok: false, why: 'no v1 signature' };
  if (Math.abs(nowS - Number(t)) > toleranceS) return { ok: false, why: 'too old (or the server clock is wrong)' };
  const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  for (const secret of secrets) {
    const want = Buffer.from(hmacHex(secret, t, body), 'hex');
    if (sigs.some((s) => s.length === want.length && timingSafeEqual(s, want))) return { ok: true, t: Number(t) };
  }
  return { ok: false, why: 'signature doesn’t match' };
};

// The header's value for these bytes (what base.win sends; tests and the
// stand-in Stripe sign with it too).
export const signPayload = (raw, secret, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${hmacHex(secret, t, Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8'))}`;

// Where a service signs nothing (CallHub), or not until its secret is set
// (Mailchimp), the lock is the address itself: its last part is 32 hex
// characters made from the service's API key (HMAC-SHA256 over a fixed
// label). One secret to set, nothing stored, and a new key is a new address.
export const pathKeyOf = (apiKey, label) => (apiKey ? createHmac('sha256', apiKey).update(label).digest('hex').slice(0, 32) : '');
// Compared whole, in the same time, so a guess learns nothing.
export const pathKeyIs = (given, want) => {
  const a = Buffer.from(String(want ?? ''));
  const b = Buffer.from(String(given ?? ''));
  return a.length > 0 && b.length === a.length && timingSafeEqual(b, a);
};
