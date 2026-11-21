// The signed entry that opens a campaign's desk (spec §4.2): a one-minute,
// single-use token for the operator's own browser to hand to the campaign's
// own server, which checks it with BASE_PLATFORM_PUBKEY.
//   token = "bw-entry.v1." + P + "." + S
//   P = base64url(JSON of the 11 keys, in order, no whitespace)
//   S = base64url(Ed25519 over the ASCII of "bw-entry.v1." + P)
// The token is never kept, logged or shown anywhere but the redirect.
import { randomBytes, sign } from 'node:crypto';
import { privateKeyOf, publicKeyOf, signingValues } from './keys.mjs';
import { cfg } from './config.mjs';

const PREFIX = 'bw-entry.v1.';
export const LIFE_S = 60;
export const GOES = ['/desk', '/desk/settings/members'];

// The audience a token may name: https, or http://127.0.0.1 in tests only.
export const audAllowed = (aud, { allowLocal = cfg().allowLocal } = {}) => {
  let u;
  try { u = new URL(aud); } catch { return false; }
  if (u.origin !== aud) return false;
  if (u.protocol === 'https:') return true;
  return allowLocal && u.protocol === 'http:' && u.hostname === '127.0.0.1';
};

// The payload in its one order, whatever order it was given in.
const ordered = (p) => ({
  v: p.v, kid: p.kid, aud: p.aud, env: p.env, inst: p.inst, iat: p.iat, exp: p.exp, nonce: p.nonce,
  op: { id: p.op.id, email: p.op.email, stepUpAt: p.op.stepUpAt },
  go: p.go,
  invite: p.invite ? { email: p.invite.email } : null,
});

// Sign a whole payload with the first value of PLATFORM_SIGNING_KEY.
export const mint = (signingKey, payload, opts) => {
  if (!audAllowed(payload?.aud, opts)) throw new Error('mint: the audience must be an https origin');
  const first = signingValues(signingKey)[0] ?? String(signingKey).split(',')[0].trim();
  const P = Buffer.from(JSON.stringify(ordered(payload)), 'utf8').toString('base64url');
  const S = sign(null, Buffer.from(PREFIX + P, 'ascii'), privateKeyOf(first)).toString('base64url');
  return `${PREFIX}${P}.${S}`;
};

// A fresh token for one visit. → { token, payload }
export const mintFor = ({ aud, env, inst, op, go = '/desk', invite = null, nowMs = Date.now(), signingKey = cfg().signingKey }) => {
  const values = signingValues(signingKey);
  if (!values.length) throw new Error('mint: PLATFORM_SIGNING_KEY is missing or too short');
  if (!GOES.includes(go)) throw new Error('mint: go');
  const iat = Math.floor(nowMs / 1000);
  const payload = ordered({
    v: 1, kid: publicKeyOf(values[0]).kid, aud, env, inst, iat, exp: iat + LIFE_S,
    nonce: randomBytes(16).toString('base64url'),
    op: { id: op.id, email: String(op.email).toLowerCase(), stepUpAt: Math.floor(op.stepUpAt) },
    go, invite: invite ? { email: String(invite.email).toLowerCase() } : null,
  });
  return { token: mint(values[0], payload), payload };
};
