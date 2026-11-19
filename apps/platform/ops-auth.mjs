// The operator's sign-in: setup (first run and break-glass), the password,
// the authenticator code, recovery codes, sessions and the ten-minute code
// window. The password and recovery codes are scrypt hashes; the
// authenticator key is sealed with a key made from OPS_SECRET, so a copy of
// the database alone opens nothing.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword, dummyVerify } from '../../server/lib/auth.js';
import {
  base32Decode, verifyTotp, newRecoveryCodes, newRecoverySalt, hashRecoveryCode, looksLikeRecoveryCode,
} from '../../server/lib/twostep.js';
import { cfg } from './config.mjs';
import { appendLog } from './log.mjs';

export { hashPassword, verifyPassword, dummyVerify };

export const SETUP_CODE_MIN = 24;
export const SETUP_TRIES_MAX = 30;
export const CODE_WINDOW_S = 600;
export const LOCK_AFTER = 20;
const SESSION_HOURS = 12;
const IDLE_MINUTES = 30;
const SETUP_TICKET_MINUTES = 10;

export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const derive = (info) => Buffer.from(hkdfSync('sha256', Buffer.from(cfg().secret, 'utf8'), Buffer.alloc(0), info, 32));
const secretUsable = () => cfg().secret.length >= SETUP_CODE_MIN;

// The setup code as kept: an HMAC keyed from OPS_SECRET, so the database
// never holds the code and a changed OPS_SECRET reopens setup.
export const setupCodeHash = (code = cfg().setupCode) =>
  createHmac('sha256', derive('base.win/ops-setup/v1')).update(String(code)).digest('hex');

// `v1.<iv>.<tag>.<sealed>`, base64url, AES-256-GCM.
export const seal = (plain) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', derive('base.win/ops-totp/v1'), iv, { authTagLength: 16 });
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
};
export const unseal = (stored) => {
  const [v, iv, tag, body] = String(stored || '').split('.');
  if (v !== 'v1' || !iv || !tag || body === undefined) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', derive('base.win/ops-totp/v1'), Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  } catch { return null; }
};

export const getOperator = async (db) => (await db.query('select * from operators limit 1')).rows[0] || null;

// → { open, problem: null | 'short' | 'secret', operator }
export const setupState = async (db) => {
  const operator = await getOperator(db);
  if (cfg().setupCode.length < SETUP_CODE_MIN) return { open: false, problem: 'short', operator };
  if (!secretUsable()) return { open: false, problem: 'secret', operator };
  return { open: !operator || operator.setup_code_hash !== setupCodeHash(), problem: null, operator };
};

// The setup code typed, compared in constant time.
export const setupCodeMatches = (typed) =>
  timingSafeEqual(createHash('sha256').update(String(typed ?? '').trim()).digest(), createHash('sha256').update(cfg().setupCode).digest());

export const setupTries = async (db) =>
  Number((await db.query('select n from setup_tries where code_hash = $1', [setupCodeHash()])).rows[0]?.n || 0);
export const countSetupTry = (db) => db.query(
  'insert into setup_tries (code_hash, n) values ($1, 1) on conflict (code_hash) do update set n = setup_tries.n + 1', [setupCodeHash()]);

// ── Setup tickets ──
export const newSetupTicket = async (db) => {
  const token = randomBytes(32).toString('base64url');
  await db.query('delete from operator_setup where expires_at < now()');
  await db.query(`insert into operator_setup (token_hash, setup_code_hash, expires_at)
    values ($1, $2, now() + make_interval(mins => ${SETUP_TICKET_MINUTES}))`, [sha256(token), setupCodeHash()]);
  return token;
};
export const SETUP_TICKET_SECONDS = SETUP_TICKET_MINUTES * 60;
export const getSetupTicket = async (db, token) => (token ? (await db.query(
  'select * from operator_setup where token_hash = $1 and expires_at > now()', [sha256(token)])).rows[0] || null : null);

// Finish setup: one operator, under a lock, still open and still the code
// the ticket was made under. → { ok, operatorId, reopened, codes, token } | { ok: false }
export const finishSetup = async (db, ticket, { step = null } = {}) => {
  const codes = newRecoveryCodes();
  const salt = newRecoverySalt();
  const hashes = [];
  for (const code of codes) hashes.push(await hashRecoveryCode(code, salt));
  return db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext('ops-setup'))");
    const current = setupCodeHash();
    const existing = (await tx.query('select * from operators limit 1 for update')).rows[0] || null;
    const stillOpen = cfg().setupCode.length >= SETUP_CODE_MIN && secretUsable() && (!existing || existing.setup_code_hash !== current);
    const live = (await tx.query('select 1 from operator_setup where token_hash = $1 and expires_at > now()', [ticket.token_hash])).rows.length;
    if (!stillOpen || !live || ticket.setup_code_hash !== current) return { ok: false };
    const id = existing?.id || randomUUID();
    if (existing) {
      await tx.query(`update operators set email = $2, name = $3, password_hash = $4, totp_sealed = $5, totp_last_step = $9,
        recovery = $6, recovery_salt = $7, setup_code_hash = $8, fails = 0, updated_at = now() where id = $1`,
      [id, ticket.email, ticket.name, ticket.password_hash, ticket.totp_sealed, JSON.stringify(hashes), salt, current, step]);
    } else {
      await tx.query(`insert into operators (id, email, name, password_hash, totp_sealed, recovery, recovery_salt, setup_code_hash, totp_last_step)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, ticket.email, ticket.name, ticket.password_hash, ticket.totp_sealed, JSON.stringify(hashes), salt, current, step]);
    }
    await tx.query('delete from ops_sessions');
    await tx.query('delete from operator_setup');
    await tx.query('delete from setup_tries');
    await appendLog(tx, { operatorId: id, action: 'setup', payload: { reopened: Boolean(existing) } });
    const token = await createSession(tx, id);
    return { ok: true, operatorId: id, reopened: Boolean(existing), codes, token };
  });
};

// ── Sessions ──
export const createSession = async (q, operatorId) => {
  const token = randomBytes(32).toString('base64url');
  await q.query(`insert into ops_sessions (token_hash, operator_id, code_at, expires_at)
    values ($1, $2, now(), now() + make_interval(hours => ${SESSION_HOURS}))`, [sha256(token), operatorId]);
  return token;
};
export const SESSION_SECONDS = SESSION_HOURS * 3600;

// ── Known devices ──
// A browser that has signed in (or finished setup) keeps a signed mark for
// 90 days. Sign-in from it skips the per-email limit, so a stranger who
// knows the operator's email can't keep the operator out by spending that
// limit (the per-address limit and LOCK_AFTER still hold). The mark names
// the operator and the setup it was made under: setting up again (break-
// glass) forgets every device. `v1.<operator id>.<issued s>.<mac>`.
export const DEVICE_DAYS = 90;
export const DEVICE_SECONDS = DEVICE_DAYS * 86400;
const deviceMac = (op, issued) => createHmac('sha256', derive('base.win/ops-device/v1'))
  .update(`v1.${op.id}.${op.setup_code_hash}.${issued}`).digest('base64url');
export const deviceToken = (op, now = Date.now()) => {
  const issued = Math.floor(now / 1000);
  return `v1.${op.id}.${issued}.${deviceMac(op, issued)}`;
};
export const knownDevice = async (db, token, now = Date.now()) => {
  if (!token || typeof token !== 'string' || token.length > 200) return false;
  const [v, id, issued, mac] = token.split('.');
  if (v !== 'v1' || !id || !/^\d{1,12}$/.test(issued || '') || !mac) return false;
  const age = now / 1000 - Number(issued);
  if (age < -300 || age > DEVICE_SECONDS) return false;
  const op = await getOperator(db);
  if (!op || op.id !== id) return false;
  const want = Buffer.from(deviceMac(op, Number(issued)));
  const got = Buffer.from(mac);
  return want.length === got.length && timingSafeEqual(want, got);
};

// → { tokenHash, operator, codeAge (seconds) } or null. Ends at 12 hours,
// or after 30 minutes without a request; seen at most once a minute.
export const loadSession = async (db, token) => {
  if (!token || typeof token !== 'string' || token.length > 200) return null;
  const tokenHash = sha256(token);
  const row = (await db.query(`select s.token_hash, s.operator_id,
      extract(epoch from now() - s.code_at)::float8 as code_age,
      (s.last_seen_at < now() - interval '1 minute') as stale_seen
    from ops_sessions s
    where s.token_hash = $1 and s.expires_at > now() and s.last_seen_at > now() - make_interval(mins => ${IDLE_MINUTES})`, [tokenHash])).rows[0];
  if (!row) return null;
  if (row.stale_seen) await db.query('update ops_sessions set last_seen_at = now() where token_hash = $1', [tokenHash]);
  const operator = (await db.query('select id, email, name, fails from operators where id = $1', [row.operator_id])).rows[0];
  return operator ? { tokenHash, operator, codeAge: Number(row.code_age) } : null;
};
export const endSession = (db, token) => db.query('delete from ops_sessions where token_hash = $1', [sha256(String(token || ''))]);
export const codeFresh = (session) => session.codeAge <= CODE_WINDOW_S;

// ── Codes ──
// Check a code from the app, or a recovery code, for the operator (in a
// transaction). A code from the app works once (its step is kept). After
// LOCK_AFTER wrong codes, only a recovery code works, and one resets it.
// → { ok: true, via } | { ok: false, locked }
export const checkCode = async (tx, operatorId, code) => {
  const op = (await tx.query('select * from operators where id = $1 for update', [operatorId])).rows[0];
  if (!op) return { ok: false };
  const typed = String(code ?? '').trim();
  if (looksLikeRecoveryCode(typed)) {
    const hash = await hashRecoveryCode(typed, op.recovery_salt);
    const list = Array.isArray(op.recovery) ? op.recovery : [];
    const at = list.findIndex((h) => typeof h === 'string' && h.length === hash.length && timingSafeEqual(Buffer.from(h), Buffer.from(hash)));
    if (at >= 0) {
      const left = list.filter((_, i) => i !== at);
      await tx.query('update operators set recovery = $2, fails = 0, updated_at = now() where id = $1', [op.id, JSON.stringify(left)]);
      await appendLog(tx, { operatorId: op.id, action: 'recovery.used', payload: { left: left.length } });
      return { ok: true, via: 'recovery' };
    }
  } else if (op.fails < LOCK_AFTER) {
    const secret = unseal(op.totp_sealed);
    const step = secret ? verifyTotp(base32Decode(secret), typed, { afterStep: op.totp_last_step == null ? null : Number(op.totp_last_step) }) : null;
    if (step != null) {
      await tx.query('update operators set totp_last_step = $2, fails = 0, updated_at = now() where id = $1', [op.id, step]);
      return { ok: true, via: 'app' };
    }
  }
  const fails = op.fails + 1;
  await tx.query('update operators set fails = $2 where id = $1', [op.id, fails]);
  if (fails === LOCK_AFTER) await appendLog(tx, { operatorId: op.id, action: 'signin.locked', payload: {} });
  return { ok: false, locked: fails >= LOCK_AFTER };
};

// A right code on a stale window: the window starts again, logged.
export const stepUp = async (db, session, code) => db.transaction(async (tx) => {
  const r = await checkCode(tx, session.operator.id, code);
  if (!r.ok) return false;
  await tx.query('update ops_sessions set code_at = now() where token_hash = $1', [session.tokenHash]);
  await appendLog(tx, { operatorId: session.operator.id, action: 'stepup', payload: { via: r.via } });
  return true;
});

// Sign in: email, password and code, all three right. Every failure is the
// same answer; the wrong-code count moves only after a right password.
// → { token } | null
export const signIn = async (db, { email, password, code }) => {
  const op = await getOperator(db);
  const typedEmail = String(email ?? '').trim().toLowerCase();
  if (!op || op.email !== typedEmail) { await dummyVerify(); return null; }
  if (!(await verifyPassword(String(password ?? ''), op.password_hash))) return null;
  return db.transaction(async (tx) => {
    const r = await checkCode(tx, op.id, code);
    if (!r.ok) return null;
    await tx.query('update operators set fails = 0 where id = $1', [op.id]);
    const token = await createSession(tx, op.id);
    await appendLog(tx, { operatorId: op.id, action: 'signin', payload: { via: r.via } });
    return { token };
  });
};
