// /api/auth — first-run setup creates user + the campaign's workspace +
// manager membership in one transaction; after that, sign-up is closed and
// everyone else joins by invite (/join). Login binds the session to the
// user's workspace membership.
import { areasFor } from '../lib/perms.js';
import { runHooks } from '../lib/hooks.js';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { getDb } from '../db/client.js';
import { newId, runAction } from '../lib/events.js';
import {
  hashPassword, verifyPassword, dummyVerify,
  createSession, destroySession, loadContext, SESSION_COOKIE,
} from '../lib/auth.js';
import { JURISDICTIONS, orgName, jurisdiction, timeZone, openSignupForced, setupClosedMessage, orgOut } from '../lib/org.js';
import { clientIp, makeLimiter, crossSiteWrite } from '../lib/guard.js';
import {
  checkCode, codeFails, countMiss, endPending, PENDING_COOKIE, PENDING_MINUTES, PENDING_TRIES,
  recoveryHashFor, startPending, takeTry, twoStepOut, twoStepRow,
} from '../lib/twostep.js';
import { LOCKED_SIGN_IN, tellLocked } from '../ext/twostep/locked.js';
import { hostOfRequest, noteAppHost } from '../ext/site/store.js';
import { candidateOut, linkOnJoin } from '../ext/candidates/invite.js';
// Google sign-in (ext/google, lib/google/): whether it's on here, and the
// person's own link.
import { googleSetup, signinRules } from '../lib/google/config.js';
import { loginOf } from '../lib/google/flow.js';

const app = new Hono();

// Writes must be the app's own (JSON, same origin) — see routes/api.js.
app.use('*', async (c, next) => {
  const why = crossSiteWrite(c);
  if (why) return c.json({ error: why }, c.req.header('sec-fetch-site') && !/JSON/.test(why) ? 403 : 415);
  await next();
});

// Secure cookies behind TLS: on in production unless STARBASE_SECURE_COOKIES=0
// (e.g. a local container on plain http); force on anywhere with =1.
const secureFlag = process.env.STARBASE_SECURE_COOKIES;
const secure = secureFlag ? secureFlag === '1' : process.env.NODE_ENV === 'production';
// Strict: the cookie goes only with requests the app itself makes (the app
// is one origin; a link opened from an email loads the app, which then asks
// for /api/auth/me itself).
export const cookieOpts = { httpOnly: true, sameSite: 'Strict', path: '/', secure, maxAge: 30 * 86400 };

// Sign-in guesses: 30 tries from one address and 10 failures against one
// email per 15 minutes, then 429 for the rest of the window.
const triesFrom = makeLimiter({ windowMs: 15 * 60_000, max: 30 });
const failsFor = makeLimiter({ windowMs: 15 * 60_000, max: 10 });
const TOO_MANY = 'too many sign-in attempts — wait 15 minutes';

const signupInput = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().email().max(320),
  password: z.string().min(8).max(200),
  // The deployment names the campaign (STARBASE_ORG_NAME); when it doesn't,
  // the first sign-up does. Tests make several workspaces to check they
  // stay apart, so a name and jurisdiction are always taken when given.
  workspaceName: z.string().trim().min(1).max(200).optional(),
  candidate: z.string().trim().max(200).optional(),
  jurisdiction: z.enum(JURISDICTIONS).optional(),
});

// Setup is open until the first workspace exists (or STARBASE_OPEN_SIGNUP=1).
const setupOpen = async (db) => openSignupForced()
  || !(await db.query('select 1 from workspaces limit 1')).rows[0];

// The campaign's own name once it is set up: its workspace's, as a manager
// last named it (Settings → Campaign) — not STARBASE_ORG_NAME, which only
// names it until then (the first sign-up takes it). One campaign per
// deployment: the first one made.
const campaignName = async (db) =>
  (await db.query('select name from workspaces order by created_at limit 1')).rows[0]?.name || orgName();

class SetupClosed extends Error {}
class WrongCode extends Error {
  constructor(check) { super('wrong code'); this.check = check; }
}

// What the browser gets about the workspace: settings minus the sample
// bookkeeping (the ids of every sample row), which only the server needs.
const clientWorkspace = (ws) => {
  const { sample, ...settings } = ws.settings || {};
  return { ...ws, settings: sample ? { ...settings, sample: { loaded: true } } : settings };
};

// Who is signed in, as every sign-in answer and /me says it: the person,
// the campaign, the role and areas, the deployment, and two-step sign-in
// (on; required for their role; still to set up — lib/twostep.js).
const meOut = (ctx) => ({
  user: ctx.user, workspace: clientWorkspace(ctx.workspace), role: ctx.role, areas: areasFor(ctx), org: orgOut(),
  two_step: twoStepOut(ctx),
  // A volunteer with a candidate's seat (ext/candidates), else null.
  candidate: candidateOut(ctx.candidate),
});
// …and their Google sign-in link (ext/google): linked, and to which Google
// address — their own, shown only to them.
const meFor = async (db, ctx) => {
  const login = await loginOf(db, ctx.user.id);
  return { ...meOut(ctx), google: { linked: Boolean(login), email: login?.email || null } };
};

// Two-step sign-in: the code after the password. The ticket for it is a
// cookie of its own, alive for ten minutes; the session comes only with
// the right code.
export const pendingCookie = { ...cookieOpts, maxAge: PENDING_MINUTES * 60 };
const NO_MATCH = 'That code doesn’t match. Codes change every 30 seconds and each works once: type the newest one, or one of your recovery codes.';
const TOO_MANY_CODES = 'Too many wrong codes — wait 15 minutes, then try again.';

// The code, checked under the campaign's write lock (lib/events.js) so a
// recovery code spent at sign-in is on the record. The slow hash of a
// recovery code is made first, outside any lock. A wrong one is one more in
// the account's count (lib/twostep.js countMiss) — this write commits with
// it — and the one that locks the app's codes is told (tellLocked).
const signInCode = async (db, { userId, workspaceId }, code) => {
  const hash = await recoveryHashFor(db, userId, code);
  const { result } = await runAction(db, { workspaceId, actorId: userId, action: 'twostep.signin' }, async (tx, emit) => {
    const r = await checkCode(tx, userId, code, { hash });
    if (r.used === 'recovery') {
      emit('two_step', userId, 'update', { recovery_code_used: true, recovery_left: r.left, ...(r.unlocked ? { unlocked: true } : {}) });
    }
    if (!r.used && !r.unreadable) r.tally = await countMiss(tx, userId);
    return r;
  });
  if (result.tally?.justLocked) await tellLocked(db, userId);
  return result;
};

// URL slug for the workspace's public pages (/p/:slug/…, /n/:slug, /v/:slug).
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'campaign';
const uniqueSlug = async (tx, base) => {
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const taken = (await tx.query('select 1 from workspaces where slug = $1', [candidate])).rows[0];
    if (!taken) return candidate;
  }
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
};

// What the sign-in screens need before anyone is signed in. The name they
// show: while setup is open, the deployment's (what the first sign-up will
// set up); once it's done, the campaign's own, renames included.
app.get('/setup', async (c) => {
  const db = await getDb();
  const open = await setupOpen(db);
  // Sign in with Google: set up on this server and on for the campaign
  // (the first one, as campaignName); its domain rule, if any. Never the
  // client's id.
  const ws = (await db.query('select settings from workspaces order by created_at limit 1')).rows[0];
  const rules = signinRules(typeof ws?.settings === 'string' ? JSON.parse(ws.settings) : ws?.settings);
  return c.json({
    open, organization: open ? orgName() : await campaignName(db), org: orgOut(),
    google: googleSetup().signin && rules.signin, googleDomain: rules.domain,
  });
});

app.post('/signup', async (c) => {
  const db = await getDb();
  if (!(await setupOpen(db))) return c.json({ error: setupClosedMessage(await campaignName(db)) }, 403);
  const parsed = signupInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const input = { ...parsed.data, workspaceName: parsed.data.workspaceName || orgName(), jurisdiction: parsed.data.jurisdiction || jurisdiction() };
  if (!input.workspaceName) return c.json({ error: 'name the campaign' }, 400);

  const email = input.email.toLowerCase();
  const passwordHash = await hashPassword(input.password);
  const userId = newId();
  const workspaceId = newId();
  try {
    await db.transaction(async (tx) => {
      // Checked again inside the write, under a lock held to commit, so two
      // first-run sign-ups at the same moment can't both land.
      await tx.query('select pg_advisory_xact_lock(7240526)');
      if (!(await setupOpen(tx))) throw new SetupClosed();
      await tx.query(
        'insert into users (id, email, name, password_hash) values ($1, $2, $3, $4)',
        [userId, email, input.name, passwordHash],
      );
      await tx.query(
        'insert into workspaces (id, name, slug, candidate, jurisdiction, settings) values ($1, $2, $3, $4, $5, $6)',
        [workspaceId, input.workspaceName, await uniqueSlug(tx, slugify(input.workspaceName)),
         input.candidate || null, input.jurisdiction, JSON.stringify({ tz: timeZone() })],
      );
      await tx.query(
        'insert into memberships (user_id, workspace_id, role) values ($1, $2, $3)',
        [userId, workspaceId, 'manager'],
      );
    });
  } catch (e) {
    if (e instanceof SetupClosed) return c.json({ error: setupClosedMessage(await campaignName(db)) }, 403);
    if (String(e.message).includes('users_email_key')) {
      return c.json({ error: 'an account with that email already exists' }, 409);
    }
    throw e;
  }
  // The campaign's first entries: who created it and who holds access.
  await runAction(db, { workspaceId, actorId: userId, action: 'workspace.create' }, async (tx, emit) => {
    emit('workspace', workspaceId, 'create', { name: input.workspaceName, jurisdiction: input.jurisdiction });
    emit('membership', userId, 'create', { email, role: 'manager' });
    // What every campaign starts with (ext/fields: the standard fields).
    await runHooks('workspaceCreated', tx, { workspaceId, user: { id: userId } }, { emit });
  });
  const token = await createSession(db, userId, workspaceId);
  setCookie(c, SESSION_COOKIE, token, cookieOpts);
  const ctx = await loadContext(db, token);
  return c.json(await meFor(db, ctx), 201);
});

app.post('/login', async (c) => {
  const db = await getDb();
  if (triesFrom(clientIp(c))) return c.json({ error: TOO_MANY }, 429);
  const { email, password } = await c.req.json().catch(() => ({}));
  if (!email || !password) return c.json({ error: 'email and password required' }, 400);
  const lower = String(email).toLowerCase().slice(0, 320);
  const key = `email:${lower}`;
  if (failsFor.count(key) >= 10) return c.json({ error: TOO_MANY }, 429);
  const user = (await db.query(
    'select id, password_hash from users where email = $1',
    [lower],
  )).rows[0];
  if (!user) {
    await dummyVerify();
    failsFor(key);
    return c.json({ error: 'invalid credentials' }, 401);
  }
  if (!(await verifyPassword(password, user.password_hash))) {
    failsFor(key);
    return c.json({ error: 'invalid credentials' }, 401);
  }
  failsFor.clear(key);
  const membership = (await db.query(
    'select workspace_id from memberships where user_id = $1 order by created_at limit 1',
    [user.id],
  )).rows[0];
  if (!membership) return c.json({ error: 'no workspace membership' }, 403);
  // Two-step sign-in on: the code next (POST /login/code), no session yet.
  if ((await twoStepRow(db, user.id))?.on_since) {
    setCookie(c, PENDING_COOKIE, await startPending(db, user.id, membership.workspace_id), pendingCookie);
    return c.json({ two_step: 'code' });
  }
  const token = await createSession(db, user.id, membership.workspace_id);
  setCookie(c, SESSION_COOKIE, token, cookieOpts);
  const ctx = await loadContext(db, token);
  return c.json(await meFor(db, ctx));
});

// The second step: a code from the app, or one of the recovery codes. Five
// tries and the password is asked again; ten for one person in 15 minutes
// and they wait (sign-in's own limit from one address counts too). Each try
// is counted before its code is checked, so codes sent at once can't all
// get in under a limit.
app.post('/login/code', async (c) => {
  const db = await getDb();
  if (triesFrom(clientIp(c))) return c.json({ error: TOO_MANY }, 429);
  const pending = await takeTry(db, getCookie(c, PENDING_COOKIE));
  if (!pending) {
    deleteCookie(c, PENDING_COOKIE, { path: '/' });
    return c.json({ error: 'That took too long — sign in again.', two_step: 'again' }, 401);
  }
  const who = `user:${pending.user_id}`;
  if (codeFails(who)) return c.json({ error: TOO_MANY_CODES }, 429);
  const { code } = await c.req.json().catch(() => ({}));
  const typed = String(code ?? '').slice(0, 40);
  const r = typed.trim() ? await signInCode(db, { userId: pending.user_id, workspaceId: pending.workspace_id }, typed) : { used: null };
  if (!r.used) {
    const left = Math.max(0, PENDING_TRIES - Number(pending.tries));
    const locked = Boolean(r.locked || r.tally?.locked);
    if (!left) {
      await endPending(db, pending.token_hash);
      deleteCookie(c, PENDING_COOKIE, { path: '/' });
      return c.json({ error: locked ? LOCKED_SIGN_IN : 'Too many wrong codes — sign in again.', two_step: 'again', ...(locked ? { locked } : {}) }, 401);
    }
    if (locked) return c.json({ error: LOCKED_SIGN_IN, two_step: 'code', locked, tries_left: left }, 401);
    return c.json({
      error: r.unreadable
        ? 'Codes from your app can’t be checked on this server any more. Type one of your recovery codes, or ask a manager to reset your two-step sign-in.'
        : NO_MATCH,
      two_step: 'code', tries_left: left,
    }, 401);
  }
  codeFails.clear(who);
  await endPending(db, pending.token_hash);
  deleteCookie(c, PENDING_COOKIE, { path: '/' });
  const token = await createSession(db, pending.user_id, pending.workspace_id);
  const ctx = await loadContext(db, token);
  // Removed from the campaign between the password and the code.
  if (!ctx) { await destroySession(db, token); return c.json({ error: 'no workspace membership' }, 403); }
  setCookie(c, SESSION_COOKIE, token, cookieOpts);
  // Google stood in for the password: the link counts as used now.
  if (pending.via === 'google') await db.query('update google_logins set last_used_at = now() where user_id = $1', [pending.user_id]);
  return c.json({ ...(await meFor(db, ctx)), ...(r.used === 'recovery' ? { recovery_left: r.left } : {}) });
});

// ── Invites: look up, then join (new account, or an existing one by password) ──
export const findInvite = async (db, token) => (await db.query(
  `select i.id, i.email, i.role, i.workspace_id, i.candidate_id, w.name as workspace_name
   from invites i join workspaces w on w.id = i.workspace_id
   where i.token_hash = $1 and i.accepted_at is null and i.expires_at > now()`,
  [createHash('sha256').update(String(token || '')).digest('hex')],
)).rows[0];

app.get('/invite/:token', async (c) => {
  const db = await getDb();
  const inv = await findInvite(db, c.req.param('token'));
  if (!inv) return c.json({ error: 'this invite link is invalid or has expired' }, 404);
  const existing = (await db.query('select 1 from users where email = $1', [inv.email])).rows[0];
  return c.json({ email: inv.email, role: inv.role, workspaceName: inv.workspace_name, hasAccount: !!existing });
});

const joinInput = z.object({
  token: z.string().min(10).max(200),
  name: z.string().trim().min(1).max(200).optional(),
  password: z.string().min(8).max(200),
  // An existing account with two-step sign-in on: its code too.
  code: z.string().trim().max(40).optional(),
});

app.post('/join', async (c) => {
  const db = await getDb();
  if (triesFrom(clientIp(c))) return c.json({ error: TOO_MANY }, 429);
  const parsed = joinInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const { token, name, password } = parsed.data;
  const inv = await findInvite(db, token);
  if (!inv) return c.json({ error: 'this invite link is invalid or has expired' }, 404);

  let user = (await db.query('select id, password_hash from users where email = $1', [inv.email])).rows[0];
  if (user && !(await verifyPassword(password, user.password_hash))) {
    return c.json({ error: 'that password does not match your existing base.win account' }, 401);
  }
  // An account with two-step sign-in on joins with its code as well — the
  // password alone never opens it. The code is checked in the join's own
  // write (below), so a join that fails never spends it; its slow hash, if
  // it's a recovery code, is made first.
  const twoStep = Boolean(user && (await twoStepRow(db, user.id))?.on_since);
  let codeHash = null;
  if (twoStep) {
    if (!parsed.data.code) return c.json({ error: 'Type the code from your authenticator app.', two_step: 'code' }, 401);
    if (codeFails(`user:${user.id}`)) return c.json({ error: TOO_MANY_CODES }, 429);
    codeHash = await recoveryHashFor(db, user.id, parsed.data.code);
  }
  if (!user && !name) return c.json({ error: 'name required' }, 400);
  const userId = user?.id || newId();
  const passwordHash = user ? null : await hashPassword(password);
  // On the hash chain: who now has access to the campaign, and in what role.
  try {
    await runAction(db, { workspaceId: inv.workspace_id, actorId: userId, action: 'member.join' }, async (tx, emit) => {
      if (twoStep) {
        const r = await checkCode(tx, user.id, parsed.data.code, { hash: codeHash });
        if (!r.used) throw new WrongCode(r);
        if (r.used === 'recovery') {
          emit('two_step', user.id, 'update', { recovery_code_used: true, recovery_left: r.left, ...(r.unlocked ? { unlocked: true } : {}) });
        }
      }
      if (!user) {
        await tx.query('insert into users (id, email, name, password_hash) values ($1, $2, $3, $4)',
          [userId, inv.email, name, passwordHash]);
      }
      const m = await tx.query(
        `insert into memberships (user_id, workspace_id, role) values ($1, $2, $3)
         on conflict (user_id, workspace_id) do nothing`,
        [userId, inv.workspace_id, inv.role],
      );
      const n = await tx.query('update invites set accepted_at = now() where id = $1 and accepted_at is null', [inv.id]);
      if (n.affectedRows === 0) throw new Error('invite already used');
      emit('invite', inv.id, 'update', { accepted: true });
      if (m.affectedRows > 0) emit('membership', userId, 'create', { email: inv.email, role: inv.role, user_id: userId });
      // A candidate's invite: their seat, if they joined as a volunteer.
      if (inv.candidate_id) await linkOnJoin(tx, emit, { workspaceId: inv.workspace_id, candidateId: inv.candidate_id, userId });
    });
  } catch (e) {
    if (!(e instanceof WrongCode)) throw e;
    // The join was rolled back: the wrong code is counted on its own.
    const tally = e.check.unreadable ? null : await countMiss(db, user.id);
    if (tally?.justLocked) await tellLocked(db, user.id);
    if (e.check.locked || tally?.locked) return c.json({ error: LOCKED_SIGN_IN, two_step: 'code', locked: true }, 401);
    return c.json({ error: NO_MATCH, two_step: 'code' }, 401);
  }
  if (twoStep) codeFails.clear(`user:${user.id}`);
  const sessionToken = await createSession(db, userId, inv.workspace_id);
  setCookie(c, SESSION_COOKIE, sessionToken, cookieOpts);
  const ctx = await loadContext(db, sessionToken);
  return c.json(await meFor(db, ctx));
});

app.post('/logout', async (c) => {
  const db = await getDb();
  await destroySession(db, getCookie(c, SESSION_COOKIE));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

app.get('/me', async (c) => {
  const db = await getDb();
  const ctx = await loadContext(db, getCookie(c, SESSION_COOKIE));
  if (!ctx) return c.json({ error: 'not signed in' }, 401);
  // The app opened here, signed in: never a website domain (as in routes/api.js).
  await noteAppHost(db, hostOfRequest(c));
  return c.json(await meFor(db, ctx));
});

export default app;
