// Auth: scrypt password hashing (node:crypto — no native deps), hashed
// session tokens in the database, and a context loader that resolves the
// session to { user, workspace, role } via the memberships table. Tenancy is
// the membership row — a user's workspace is never a mutable column.
import { permsOf } from './perms.js';
import { requiredFor } from './twostep.js';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export const hashPassword = async (password) => {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt:${N}:${R}:${P}:${salt.toString('base64')}:${key.toString('base64')}`;
};

export const verifyPassword = async (password, stored) => {
  try {
    const [algo, n, r, p, saltB64, keyB64] = stored.split(':');
    if (algo !== 'scrypt') return false;
    const key = await scryptAsync(password, Buffer.from(saltB64, 'base64'), KEYLEN,
      { N: Number(n), r: Number(r), p: Number(p) });
    return timingSafeEqual(key, Buffer.from(keyB64, 'base64'));
  } catch {
    return false;
  }
};

// Constant-cost dummy verify for unknown emails (anti user-enumeration).
const DUMMY = hashPassword('dummy-password-for-timing');
export const dummyVerify = async () => { await verifyPassword('x', await DUMMY); };

const hashToken = (t) => createHash('sha256').update(t).digest('hex');
export const SESSION_COOKIE = 'mv2_session';
const SESSION_DAYS = 30;

// { scope, via, expiresAt }: a limited sign-in (an election-day code,
// ext/voted: scope 'gotv', made by the gotv_signin row `via`), ending at
// expiresAt and never later than the usual 30 days.
export const createSession = async (db, userId, workspaceId, { scope = null, via = null, expiresAt = null } = {}) => {
  const token = randomBytes(32).toString('hex');
  await db.query(
    `insert into sessions (token_hash, user_id, workspace_id, expires_at, scope, via)
     values ($1, $2, $3, least(now() + interval '${SESSION_DAYS} days', coalesce($4::timestamptz, 'infinity')), $5, $6)`,
    [hashToken(token), userId, workspaceId, expiresAt, scope, via],
  );
  return token;
};

// A sign-in limited to Who voted (scope 'gotv'): its page, the look-up,
// a mark, an undo, a check, the switch's state and signing out. Checked
// here, with the session, so no route can forget it.
export const GOTV_ONLY = 'This sign-in only works for Who voted.';
const GOTV_READS = [/^\/api\/gotv\/(find|places|open)$/, /^\/api\/voted\/status$/, /^\/api\/auth(\/|$)/];
const GOTV_WRITES = /^\/api\/actions\/(vote\.mark|vote\.undo|gotv\.check)$/;
export const scopeAllows = (ctx, method, path) => {
  if (!ctx?.scope) return true;
  if (ctx.scope !== 'gotv') return false;
  if (method === 'GET' || method === 'HEAD') return GOTV_READS.some((re) => re.test(path));
  return GOTV_WRITES.test(path) || /^\/api\/auth\/logout$/.test(path);
};

export const destroySession = async (db, token) => {
  if (token) await db.query('delete from sessions where token_hash = $1', [hashToken(token)]);
};

// Resolve a session token to the full request context, or null.
export const loadContext = async (db, token) => {
  if (!token) return null;
  const { rows } = await db.query(
    `select u.id as user_id, u.email, u.name as user_name, m.role, m.permissions,
            w.id as workspace_id, w.name as ws_name, w.slug as ws_slug, w.candidate, w.jurisdiction, w.settings,
            t.on_since is not null as two_step_on, s.scope as session_scope,
            c.id as cand_id, c.name as cand_name, c.office as cand_office, c.race as cand_race
     from sessions s
     join users u on u.id = s.user_id
     join memberships m on m.user_id = s.user_id and m.workspace_id = s.workspace_id
     join workspaces w on w.id = s.workspace_id
     left join two_step t on t.user_id = s.user_id
     left join candidates c on c.workspace_id = s.workspace_id and c.user_id = s.user_id
       and c.removed_at is null and m.role = 'volunteer'
     where s.token_hash = $1 and s.expires_at > now()`,
    [hashToken(token)],
  );
  const r = rows[0];
  if (!r) return null;
  const settings = typeof r.settings === 'string' ? JSON.parse(r.settings) : (r.settings || {});
  const own = typeof r.permissions === 'string' ? JSON.parse(r.permissions) : (r.permissions || {});
  // A candidate's seat (ext/candidates): only ever on a volunteer — any
  // other role is the desk, never a candidate. Their grants and denies are
  // the Candidates row's, not the Volunteers'.
  const candidate = r.cand_id ? { id: r.cand_id, name: r.cand_name, office: r.cand_office, race: r.cand_race } : null;
  // Grants and denies on top of the role (lib/perms.js).
  const perms = permsOf(candidate ? 'candidate' : r.role, settings, own);
  // Two-step sign-in (lib/twostep.js): on for this account, required here
  // (its role, or an area it was given), and so still to set up before
  // anything else.
  const required = requiredFor(r.role, settings, perms, { candidate: Boolean(candidate) });
  return {
    user: { id: r.user_id, email: r.email, name: r.user_name },
    role: r.role,
    candidate,
    // This sign-in (its hash), so an action can keep it and end the others.
    session: hashToken(token),
    // null: the whole app; 'gotv': Who voted only (scopeAllows).
    scope: r.session_scope || null,
    twoStep: { on: Boolean(r.two_step_on), required, mustSetUp: required && !r.two_step_on },
    perms,
    workspaceId: r.workspace_id,
    workspace: {
      id: r.workspace_id, name: r.ws_name, slug: r.ws_slug, candidate: r.candidate,
      jurisdiction: r.jurisdiction,
      settings,
    },
  };
};
