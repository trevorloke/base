// Two-step sign-in: after the password, a 6-digit code from an
// authenticator app on the person's phone (TOTP — RFC 6238 on top of RFC
// 4226 HOTP: HMAC-SHA-1, 30-second steps), or one of ten one-time recovery
// codes. Ported from the website's own (apps/web/src/lib/server/totp.ts and
// mfa.ts). Tables: ext/twostep/sql.js; the screens: web/src/components/TwoStep.jsx.
//
// The secret at rest is sealed with AES-256-GCM under a key from the
// environment, STARBASE_TWO_STEP_KEY (32 characters or more; several,
// separated by commas, while moving to a new one: the first seals, every one
// opens). Unset, base.win makes a key of its own and keeps it in the
// database (app_secrets) — it works, but anyone with a copy of the database
// could then read the secrets, so Settings → Services warns until the
// setting is there. A secret sealed with an older key moves to the current
// one the next time its code is used.
//
// Recovery codes are kept only as slow hashes (scrypt, a salt per person),
// so a copy of the database doesn't give them away. A code from the app
// works once: the step it matched is kept, and that step or any earlier one
// is refused after.
//
// Who must use it: a manager can require it for everyone the desk opens for
// (workspace settings.twoStepRequired) — the desk roles (manager, treasurer,
// staff) and a volunteer given an area under Admin → Permissions. Other
// volunteers' sign-in is unchanged unless they turn it on themselves.
import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, scrypt, timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { makeLimiter } from './guard.js';
import { AREA_KEYS, decide } from './perms.js';
import { qrSvgPath } from './qr.js';

const scryptAsync = promisify(scrypt);

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
// Steps accepted either side of now, for a phone clock that is a little off.
export const TOTP_WINDOW = 1;

// ── Base32 (RFC 4648, no padding), the format authenticator apps take ──
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

// Decodes base32, ignoring case, spaces, dashes and padding. Throws on any other character.
export function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '');
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error('Not a base32 string');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// A new shared secret: 160 random bits (RFC 4226's recommended length), as base32.
export const newTotpSecret = () => base32Encode(randomBytes(20));
// "ABCD EFGH IJKL …", easier to type into an app by hand.
export const groupSecret = (secret) => String(secret).replace(/(.{4})(?=.)/g, '$1 ');

// ── HOTP and TOTP ──
export function hotp(key, counter, digits = TOTP_DIGITS, algorithm = 'sha1') {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

// The time step a moment falls in (RFC 6238's T).
export const totpStep = (nowMs, stepSeconds = TOTP_STEP_SECONDS) => Math.floor(nowMs / 1000 / stepSeconds);

export const totp = (key, nowMs, { digits = TOTP_DIGITS, algorithm = 'sha1', stepSeconds = TOTP_STEP_SECONDS } = {}) =>
  hotp(key, totpStep(nowMs, stepSeconds), digits, algorithm);

const safeEqual = (a, b) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

// Check a code against the steps around now → the step it matched, or null.
// A step at or before afterStep (the last one this account used) is never
// accepted, so a code seen once can't be replayed.
export function verifyTotp(key, code, { nowMs = Date.now(), window = TOTP_WINDOW, afterStep = null } = {}) {
  const candidate = String(code ?? '').replace(/\s/g, '');
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(candidate)) return null;
  const current = totpStep(nowMs);
  // Now first, then the neighbours: the step recorded is the one the app most likely showed.
  const offsets = [0];
  for (let i = 1; i <= window; i++) offsets.push(-i, i);
  let matched = null;
  for (const offset of offsets) {
    const step = current + offset;
    if (afterStep != null && step <= afterStep) continue;
    // Every candidate is compared, so the time taken doesn't say which matched.
    if (safeEqual(hotp(key, step), candidate) && matched === null) matched = step;
  }
  return matched;
}

// The otpauth:// address an authenticator app reads from the QR code.
export function otpauthUri({ secret, account, issuer }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString().replace(/\+/g, '%20')}`;
}

// What the set-up screen shows: the key in groups of four, the address and
// its QR code. A very long name or email can make the address too long for
// a QR code here: then the shortest form apps accept, and failing that the
// key alone (typed in by hand).
export function setupFor(secret, { account, issuer }) {
  const uri = otpauthUri({ secret, account, issuer });
  const short = `otpauth://totp/${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`;
  let qr = null;
  for (const text of [uri, short]) {
    try { qr = qrSvgPath(text); break; } catch { /* too long for a QR code: try the shorter one */ }
  }
  return { key: secret, grouped: groupSecret(secret), uri, qr };
}

// ── The secret at rest ──
export const KEY_ENV = 'STARBASE_TWO_STEP_KEY';
export const KEY_MIN = 32;
const KEY_INFO = 'base.win/two-step-secret/v1';
const derive = (raw, info = KEY_INFO) => Buffer.from(hkdfSync('sha256', raw, Buffer.alloc(0), info, 32));

// The keys from the environment, the first one sealing: [{ kid, key }].
// A value too short to be a real key is left out (Settings → Services says so).
const envKeys = () => String(process.env[KEY_ENV] || '').split(/[\s,]+/).filter((k) => k.length >= KEY_MIN)
  .map((raw) => ({ kid: `e${derive(raw, 'base.win/two-step-kid/v1').toString('hex').slice(0, 10)}`, key: derive(raw) }));

// Where the sealing key comes from, for Settings → Services (no key in it).
export const keyStatus = () => {
  const raw = String(process.env[KEY_ENV] || '').trim();
  if (envKeys().length) return { source: 'env' };
  return { source: 'database', problem: raw ? 'short' : 'unset' };
};

// The key base.win made for itself, kept in the database: made once, the
// same for everyone after (two first uses at once agree on the stored one).
const DB_KEY = 'two_step_key';
const dbKey = async (db) => {
  await db.query('insert into app_secrets (name, value) values ($1, $2) on conflict (name) do nothing', [DB_KEY, randomBytes(32).toString('base64')]);
  const value = (await db.query('select value from app_secrets where name = $1', [DB_KEY])).rows[0].value;
  return { kid: 'db', key: derive(Buffer.from(value, 'base64')) };
};
const storedDbKey = async (db) => {
  const row = (await db.query('select value from app_secrets where name = $1', [DB_KEY])).rows[0];
  return row ? { kid: 'db', key: derive(Buffer.from(row.value, 'base64')) } : null;
};

// `v1.<key id>.<iv>.<tag>.<sealed>`, base64url.
export async function sealSecret(db, plain) {
  const k = envKeys()[0] || await dbKey(db);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k.key, iv, { authTagLength: 16 });
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', k.kid, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

// → { plain, current } (current: sealed with the key that seals now), or
// null when it can't be read (tampered with, or its key is gone).
export async function openSecret(db, stored) {
  const [version, kid, iv, tag, body] = String(stored || '').split('.');
  if (version !== 'v1' || !kid || !iv || !tag || body === undefined) return null;
  const env = envKeys();
  const k = kid === 'db' ? await storedDbKey(db) : env.find((e) => e.kid === kid);
  if (!k) return null;
  try {
    // The whole 16-byte tag, never a shorter one (which GCM would accept).
    const decipher = createDecipheriv('aes-256-gcm', k.key, Buffer.from(iv, 'base64url'), { authTagLength: 16 });
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
    return { plain, current: env.length ? kid === env[0].kid : kid === 'db' };
  } catch {
    return null;
  }
}

// ── Recovery codes ──
export const RECOVERY_CODE_COUNT = 10;
// No 0/O/1/I/L, so a code copied onto paper reads back the same.
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
// Ten codes like "k7m2q-x9tbn" (about 49 bits each). Shown once.
export const newRecoveryCodes = (count = RECOVERY_CODE_COUNT) => Array.from({ length: count }, () => {
  const chars = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
});
// Case, spaces and dashes don't matter when a recovery code is typed back.
export const normalizeRecoveryCode = (code) => String(code ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
export const looksLikeRecoveryCode = (code) => normalizeRecoveryCode(code).length === 10;
export const newRecoverySalt = () => randomBytes(16).toString('base64');
// A slow hash (scrypt), salted per person.
export const hashRecoveryCode = async (code, salt) =>
  (await scryptAsync(normalizeRecoveryCode(code), Buffer.from(salt, 'base64'), 32, { N: 16384, r: 8, p: 1 })).toString('hex');

// ── Who must use it ──
// Once required: the desk roles, and anyone given an area (their own grant
// or their role's, and not denied — lib/perms.js), since an area opens the
// desk to a volunteer: a Data grant is the whole export, an Admin grant the
// team's roles and this very requirement. perms: the person's (ctx.perms).
export const DESK_ROLES = ['manager', 'treasurer', 'staff'];
export const givenAnArea = (perms) => AREA_KEYS.some((k) => decide(perms, k) === true);
export const requiredFor = (role, settings, perms = null) => settings?.twoStepRequired === true
  && (DESK_ROLES.includes(role) || givenAnArea(perms));

// What the app is told about the signed-in person (GET /api/auth/me).
export const twoStepOut = (ctx) => ({
  on: Boolean(ctx?.twoStep?.on),
  required: Boolean(ctx?.twoStep?.required),
  must_set_up: Boolean(ctx?.twoStep?.mustSetUp),
});

// While someone must still set it up, only this answers them: the set-up
// itself (and their own sign-in status at /api/auth/me).
const OPEN_WHILE_SETTING_UP = [/^GET \/api\/two-step$/, /^POST \/api\/actions\/twostep\.(start|confirm)$/];
export const openWhileSettingUp = (method, path) => OPEN_WHILE_SETTING_UP.some((re) => re.test(`${method} ${path}`));
export const SETUP_FIRST = 'set up two-step sign-in first — your campaign asks everyone at the desk to use it';

// ── Wrong codes ──
// Per person: 10 tries at a code in 15 minutes, then a pause (sign-in,
// joining, set-up, turning it off and new recovery codes all count). Each
// try is counted as it comes in — codeFails(key) counts and says whether
// that's one too many, before the code is checked — and a right code clears
// the count. Per sign-in: 5 tries, then the password is asked again.
export const codeFails = makeLimiter({ windowMs: 15 * 60_000, max: 10 });
export const CODE_FAILS_MAX = 10;
export const PENDING_TRIES = 5;
export const PENDING_MINUTES = 10;
export const PENDING_COOKIE = 'mv2_two_step';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ── The account's row (ext/twostep/sql.js two_step) ──
export const twoStepRow = async (db, userId, { lock = false } = {}) => (await db.query(
  `select user_id, secret, on_since, recovery, recovery_salt, last_step from two_step where user_id = $1${lock ? ' for update' : ''}`,
  [userId],
)).rows[0] || null;
const parseList = (v) => (typeof v === 'string' ? JSON.parse(v) : (v || []));

const isAppCode = (code) => /^\d{6}$/.test(String(code ?? '').trim().replace(/\s/g, ''));

// Would this code from the app be taken now? Read only — nothing is used up
// (checkCode does that, under the row's lock). For the slow work that
// follows only a right code (new recovery codes), done before the write.
// pending: the key being set up (not on yet) rather than the one in use.
export async function peekCode(db, userId, code, { pending = false } = {}) {
  const row = await twoStepRow(db, userId);
  if (!row?.secret || Boolean(row.on_since) === pending || !isAppCode(code)) return false;
  const open = await openSecret(db, row.secret);
  if (!open) return false;
  return verifyTotp(base32Decode(open.plain), code, { afterStep: row.last_step == null ? null : Number(row.last_step) }) !== null;
}

// A recovery code's hash is slow to make (on purpose): made before any lock
// is taken (checkCode's `hash`), from the salt as it is now. Null for
// anything that isn't shaped like a recovery code.
export async function recoveryHashFor(db, userId, code) {
  if (isAppCode(code) || !looksLikeRecoveryCode(code)) return null;
  const salt = (await db.query('select recovery_salt from two_step where user_id = $1', [userId])).rows[0]?.recovery_salt;
  return salt ? hashRecoveryCode(code, salt) : null;
}

// Check a code for an account with two-step sign-in on: a code from the
// app (never one already used) or, unless refused, a recovery code (then
// used up). Run inside a transaction — it locks the account's row, so two
// requests can't both spend one code. → { used: 'app' | 'recovery' | null,
// left (recovery codes left), unreadable (the secret's key is gone) }.
export async function checkCode(tx, userId, code, { allowRecovery = true, nowMs = Date.now(), hash } = {}) {
  const row = await twoStepRow(tx, userId, { lock: true });
  if (!row?.on_since) return { used: null };
  const typed = String(code ?? '').trim().slice(0, 40);
  if (isAppCode(typed)) {
    const open = row.secret ? await openSecret(tx, row.secret) : null;
    if (!open) return { used: null, unreadable: true };
    const step = verifyTotp(base32Decode(open.plain), typed, { nowMs, afterStep: row.last_step == null ? null : Number(row.last_step) });
    if (step === null) return { used: null };
    // Sealed with an older key (or the database's, now that one is set):
    // moved to the current key while it's open.
    const secret = open.current ? row.secret : await sealSecret(tx, open.plain);
    await tx.query('update two_step set last_step = $2, secret = $3, updated_at = now() where user_id = $1', [userId, step, secret]);
    return { used: 'app' };
  }
  if (!allowRecovery || !looksLikeRecoveryCode(typed) || !row.recovery_salt) return { used: null };
  const mine = hash || await hashRecoveryCode(typed, row.recovery_salt);
  const list = parseList(row.recovery);
  const left = list.filter((h) => !safeEqual(h, mine));
  if (left.length === list.length) return { used: null };
  await tx.query('update two_step set recovery = $2, updated_at = now() where user_id = $1', [userId, JSON.stringify(left)]);
  return { used: 'recovery', left: left.length };
}

// ── The second step at sign-in ──
// The password was right and two-step sign-in is on: a short-lived ticket
// (its hash in two_step_pending; the ticket itself in a cookie) waits for
// the code. A person signing in on a phone and a laptop at once has one
// each; the few newest are kept, and wrong codes count against the person
// whichever ticket they come on (codeFails).
export async function startPending(db, userId, workspaceId) {
  const token = randomBytes(32).toString('hex');
  await db.query('delete from two_step_pending where expires_at < now()');
  await db.query(
    `delete from two_step_pending where user_id = $1 and token_hash not in
       (select token_hash from two_step_pending where user_id = $1 order by created_at desc limit 4)`,
    [userId],
  );
  await db.query(
    `insert into two_step_pending (token_hash, user_id, workspace_id, expires_at)
     values ($1, $2, $3, now() + interval '${PENDING_MINUTES} minutes')`,
    [sha256(token), userId, workspaceId],
  );
  return token;
}
// A try on a waiting sign-in, taken before its code is checked — one row
// update, so codes sent all at once can't each slip in under the limit. →
// the ticket (tries counting this one), or null: gone, stale or used up.
export const takeTry = async (db, token) => (token ? (await db.query(
  `update two_step_pending set tries = tries + 1
   where token_hash = $1 and expires_at > now() and tries < $2
   returning token_hash, user_id, workspace_id, tries`,
  [sha256(String(token)), PENDING_TRIES],
)).rows[0] || null : null);
export const endPending = (db, tokenHash) => db.query('delete from two_step_pending where token_hash = $1', [tokenHash]);

// From the server's own shell (scripts/reset-two-step.mjs), for what a
// manager can't do from the app: the only manager lost their phone and their
// recovery codes, or the person belongs to more than one campaign here.
// Clears it, ends their sign-ins, and puts it on each of their campaigns'
// event logs. → the campaigns' ids, or null when there's no such account.
export async function resetFromServer(db, email, runAction) {
  const user = (await db.query('select id from users where email = $1', [String(email || '').trim().toLowerCase()])).rows[0];
  if (!user) return null;
  const spaces = (await db.query('select workspace_id from memberships where user_id = $1', [user.id])).rows.map((r) => r.workspace_id);
  await db.query('delete from two_step where user_id = $1', [user.id]);
  await db.query('delete from two_step_pending where user_id = $1', [user.id]);
  await db.query('delete from sessions where user_id = $1', [user.id]);
  for (const workspaceId of spaces) {
    await runAction(db, { workspaceId, actorId: null, action: 'twostep.reset' }, async (tx, emit) => {
      emit('two_step', user.id, 'void', { reset: true, from: 'the server' });
    });
  }
  return spaces;
}
