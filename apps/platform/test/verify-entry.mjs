// Tests only: the campaign server's check of a token (spec §4.2), written
// again here from the spec, so the console's tokens are checked by the
// other side's rules and not by the code that made them. The fake client
// (fake-client.mjs) uses it too.
import { createHash, createPublicKey, verify } from 'node:crypto';

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const KEYS = ['v', 'kid', 'aud', 'env', 'inst', 'iat', 'exp', 'nonce', 'op', 'go', 'invite'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const plain = (o) => o != null && typeof o === 'object' && !Array.isArray(o);
const exactly = (o, keys) => plain(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const emailOk = (e) => typeof e === 'string' && e.length <= 320 && EMAIL_RE.test(e);

export const parseKeys = (raw) => String(raw || '').split(',').map((s) => s.trim())
  .filter((s) => /^[A-Za-z0-9_-]{43}$/.test(s) && Buffer.from(s, 'base64url').length === 32)
  .map((s) => {
    const rawKey = Buffer.from(s, 'base64url');
    return { kid: createHash('sha256').update(rawKey).digest('hex').slice(0, 8), key: createPublicKey({ key: Buffer.concat([SPKI, rawKey]), format: 'der', type: 'spki' }) };
  });

export const verifyEntry = (token, { keys, aud, env, inst, nowMs = Date.now() }) => {
  const no = (why) => ({ ok: false, why });
  if (typeof token !== 'string' || token.length > 4096) return no('shape');
  const m = /^bw-entry\.v1\.([A-Za-z0-9_-]{1,3000})\.([A-Za-z0-9_-]{86})$/.exec(token);
  if (!m) return no('shape');
  let p;
  try { p = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return no('payload'); }
  if (!exactly(p, KEYS) || p.v !== 1) return no('payload');
  const k = keys.find((x) => x.kid === p.kid);
  if (!k) return no('kid');
  if (!verify(null, Buffer.from(`bw-entry.v1.${m[1]}`, 'ascii'), k.key, Buffer.from(m[2], 'base64url'))) return no('sig');
  if (p.aud !== aud) return no('aud');
  if (p.env !== env || p.inst !== inst) return no('env');
  const now = Math.floor(nowMs / 1000);
  if (!Number.isInteger(p.iat) || !Number.isInteger(p.exp) || p.exp <= p.iat || p.exp - p.iat > 120 || p.iat > now + 30 || now > p.exp + 30) return no('time');
  const op = p.op;
  if (!exactly(op, ['id', 'email', 'stepUpAt']) || !UUID_RE.test(String(op.id)) || !emailOk(op.email)
    || !Number.isInteger(op.stepUpAt) || op.stepUpAt > p.iat || p.iat - op.stepUpAt > 630) return no('op');
  if (typeof p.nonce !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(p.nonce)) return no('nonce');
  if (p.go !== '/desk' && p.go !== '/desk/settings/members') return no('go');
  if (!(p.invite === null || (exactly(p.invite, ['email']) && emailOk(p.invite.email)))) return no('invite');
  return { ok: true, payload: p };
};
