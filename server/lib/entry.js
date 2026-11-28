// base.win support's way in: a one-minute token the control centre
// (ops.base.win) signs with its Ed25519 key and the operator's browser
// brings here. Pure checks only; the database work is ext/operator/enter.js.
// The token's bytes are pinned by a test vector shared with the control
// centre (server/test/entry-vector.json); change nothing here without it.
import { setting } from '@starbase/shared/old-names';
import { createHash, createPublicKey, verify } from 'node:crypto';

const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const PREFIX = 'bw-entry.v1.';
const SHAPE = /^bw-entry\.v1\.([A-Za-z0-9_-]{1,3000})\.([A-Za-z0-9_-]{86})$/;
const KEYS = ['v', 'kid', 'aud', 'env', 'inst', 'iat', 'exp', 'nonce', 'op', 'go', 'invite'];
const GO = ['/desk', '/desk/settings/members'];
const SKEW = 30;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A web origin, or null: https, or http only on this machine (tests); no
// path, query or fragment; scheme and host lowercased, the default port gone.
export const originOf = (x) => {
  let u;
  try { u = new URL(String(x || '').trim()); } catch { return null; }
  if (!u.hostname) return null;
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  return u.origin;
};

// This server's own address, the audience a token must name. Render sets
// RENDER_EXTERNAL_URL on every web service; BASE_OWN_URL overrides it.
export const ownOrigin = () => originOf(setting('BASE_OWN_URL') || process.env.RENDER_EXTERNAL_URL);

const rawOf = (k) => (Buffer.isBuffer(k) ? k : Buffer.from(String(k), 'base64url'));
// The first 8 hex of SHA-256 of the raw 32-byte key: only picks the key.
export const kidOf = (k) => createHash('sha256').update(rawOf(k)).digest('hex').slice(0, 8);

// BASE_PLATFORM_PUBKEY: one or more 43-character keys, comma-separated
// (two while the control centre changes its key). Junk is skipped.
export const parseKeys = (text = process.env.BASE_PLATFORM_PUBKEY) => {
  const out = [];
  for (const part of String(text || '').split(',').map((s) => s.trim())) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(part)) continue;
    const raw = Buffer.from(part, 'base64url');
    if (raw.length !== 32) continue;
    try {
      const key = createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });
      out.push({ kid: kidOf(raw), key });
    } catch { /* not a key */ }
  }
  return out;
};

// For health: 'ready', or why entry can't work here yet.
export const entryReadiness = () => {
  if (!String(process.env.BASE_PLATFORM_PUBKEY || '').trim()) return 'no-key';
  if (!parseKeys().length) return 'bad-key';
  if (!ownOrigin()) return 'no-origin';
  return 'ready';
};

const plain = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);
const exactly = (o, keys) => plain(o) && Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const anEmail = (e) => typeof e === 'string' && e.length <= 320 && EMAIL.test(e);

// { ok: true, payload } or { ok: false, why } — why is for tests only;
// the route answers every failure the same way.
export const verifyEntry = (token, { keys, aud, env, inst, nowMs }) => {
  const no = (why) => ({ ok: false, why });
  if (typeof token !== 'string' || token.length > 4096) return no('shape');
  const m = SHAPE.exec(token);
  if (!m) return no('shape');
  const [, P, S] = m;
  let p;
  try { p = JSON.parse(Buffer.from(P, 'base64url').toString('utf8')); } catch { return no('payload'); }
  if (!exactly(p, KEYS) || p.v !== 1) return no('payload');
  const pick = (keys || []).find((k) => k.kid === p.kid);
  if (!pick) return no('kid');
  let good = false;
  try { good = verify(null, Buffer.from(PREFIX + P, 'ascii'), pick.key, Buffer.from(S, 'base64url')); } catch { good = false; }
  if (!good) return no('sig');
  // Signed by the control centre from here on; still checked field by field.
  if (typeof aud !== 'string' || p.aud !== aud) return no('aud');
  if (typeof env !== 'string' || p.env !== env || typeof inst !== 'string' || p.inst !== inst) return no('env');
  const now = Math.floor(nowMs / 1000);
  if (!Number.isInteger(p.iat) || !Number.isInteger(p.exp) || p.exp <= p.iat || p.exp - p.iat > 120
    || p.iat > now + SKEW || now > p.exp + SKEW) return no('time');
  const op = p.op;
  if (!exactly(op, ['id', 'email', 'stepUpAt']) || typeof op.id !== 'string' || !UUID.test(op.id)
    || !anEmail(op.email) || !Number.isInteger(op.stepUpAt) || op.stepUpAt > p.iat
    || p.iat - op.stepUpAt > 600 + SKEW) return no('op');
  if (typeof p.nonce !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(p.nonce)) return no('nonce');
  if (!GO.includes(p.go)) return no('go');
  if (p.invite !== null && !(exactly(p.invite, ['email']) && anEmail(p.invite.email))) return no('invite');
  return { ok: true, payload: p };
};
