// Signed links the website hands out: a draft's preview (minutes) and a
// supporter's own email and text choices (/preferences, /unsubscribe —
// months, since they travel in emails). HMAC-SHA256 with the server's
// secret: SITE_SECRET from the environment, or one made on first use and
// kept in the database (site_keys), so links keep working across restarts
// and every server of a campaign agrees. The secret never leaves the server.
//
//   sign(kind, claims, ttlSeconds) → token     claims: { w, p } (workspace, page or person)
//   verify(kind, token) → claims | null        null: forged, another kind, or expired
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb } from '../../db/client.js';

let secret = null;
let loading = null;

const fromEnv = () => {
  const s = String(process.env.SITE_SECRET || '').trim();
  return s.length >= 16 ? s : null;
};

// The secret: the environment's, else the database's (made once).
export const siteSecret = async () => {
  const env = fromEnv();
  if (env) return env;
  if (secret) return secret;
  if (!loading) {
    loading = (async () => {
      const db = await getDb();
      await db.query(
        "insert into site_keys (name, secret) values ('hmac', $1) on conflict (name) do nothing",
        [randomBytes(32).toString('base64url')],
      );
      const row = (await db.query("select secret from site_keys where name = 'hmac'")).rows[0];
      secret = row.secret;
      return secret;
    })().finally(() => { loading = null; });
  }
  return loading;
};
// Tests swap databases between files; a fresh one has a fresh secret.
export const _forgetSecretForTest = () => { secret = null; };

const b64 = (s) => Buffer.from(s).toString('base64url');
const mac = (key, kind, body) => createHmac('sha256', key).update(`${kind}.${body}`).digest('base64url');

export const sign = async (kind, claims, ttlSeconds) => {
  const body = b64(JSON.stringify({ ...claims, e: Math.floor(Date.now() / 1000) + ttlSeconds }));
  return `${body}.${mac(await siteSecret(), kind, body)}`;
};

export const verify = async (kind, token) => {
  const m = /^([A-Za-z0-9_-]{8,2000})\.([A-Za-z0-9_-]{20,100})$/.exec(String(token || ''));
  if (!m) return null;
  const want = Buffer.from(mac(await siteSecret(), kind, m[1]));
  const got = Buffer.from(m[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!claims || typeof claims !== 'object' || !(Number(claims.e) > Date.now() / 1000)) return null;
  return claims;
};

export const PREVIEW_TTL = 30 * 60; // half an hour: long enough to look, short enough to leak harmlessly
export const PERSON_TTL = 400 * 24 * 3600; // an email's links work for over a year
