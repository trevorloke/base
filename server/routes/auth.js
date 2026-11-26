// /api/auth — first-run setup creates user + the campaign's workspace +
// manager membership in one transaction; after that, sign-up is closed and
// everyone else joins by invite (/join). Login binds the session to the
// user's workspace membership.
import { areasFor } from '../lib/perms.js';
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { demoEmail } from '../lib/demo.js';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { getDb } from '../db/client.js';
import { newId, runAction } from '../lib/events.js';
import {
  hashPassword, verifyPassword, dummyVerify,
  createSession, destroySession, loadContext, SESSION_COOKIE,
} from '../lib/auth.js';
import { JURISDICTIONS, orgName, jurisdiction, envName, setupClosedMessage, orgOut } from '../lib/org.js';
import { createWorkspace, recordCreated, noWorkspace, setupOpen, SIGNUP_LOCK } from '../lib/setup.js';
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
// Election-day sign-in codes (ext/voted).
import { usableCode, EXPIRED } from '../ext/voted/signin.js';
import { codeSessionEnds } from '../ext/voted/clock.js';
// Forgot password (ext/passwords).
import { RUN_OUT, TOKEN_RE, checkLink, queueReset, resetByEmail, resetEvent, useLink } from '../ext/passwords/reset.js';
// base.win support's way in from the control centre (lib/entry.js, ext/operator).
import { ownOrigin, parseKeys, verifyEntry } from '../lib/entry.js';
import { instanceOf } from '../ext/operator/identity.js';
import { enter, ENTRY_HOURS } from '../ext/operator/enter.js';
import { sampleSignup } from '../lib/samplecampaign.js';
import { defaultCandidates } from '@starbase/shared/scale';

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

// Setup is open until the first workspace exists (or STARBASE_OPEN_SIGNUP=1)
// — except on a server that holds the control centre's key: that one is set
// up from the control centre (its first entry makes the campaign), so a
// stranger who finds it fresh can't claim it.
const FROM_CONTROL_CENTRE = 'This campaign is set up from the base.win control centre.';
// Why sign-up is closed, in the words for this server.
const closedWords = async (db) => (parseKeys().length && (await noWorkspace(db))
  ? FROM_CONTROL_CENTRE : setupClosedMessage(await campaignName(db)));

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
// org.candidates: who this server's rating scale starts with (shared/scale.js:
// nobody for most campaigns), each with its label, for a phone that has no
// copy of the campaign's scale yet — the phone's own code holds no list, so
// this one is its starting list (web components/scale.js). Worked out when
// asked: the list is the server's settings', read each time.
const startCandidates = () => defaultCandidates().map((c) => ({ code: c.code, name: c.name, label: c.label }));
const meOut = (ctx) => ({
  user: ctx.user, workspace: clientWorkspace(ctx.workspace), role: ctx.role, areas: areasFor(ctx), org: { ...orgOut(), candidates: startCandidates() },
  two_step: twoStepOut(ctx),
  // A volunteer with a candidate's seat (ext/candidates), else null.
  candidate: candidateOut(ctx.candidate),
  // A sign-in limited to Who voted (an election-day code, ext/voted): 'gotv'.
  scope: ctx.scope || null,
  // In as base.win support from the control centre (ext/operator): until when.
  operator: ctx.entry ? { until: ctx.entry.until } : null,
});
// …and their Google sign-in link (ext/google): whether Google sign-in is on
// here for their campaign, linked, and to which Google address — their
// own, shown only to them.
const meFor = async (db, ctx) => {
  const login = await loginOf(db, ctx.user.id);
  const on = googleSetup().signin && signinRules(ctx.workspace?.settings).signin;
  return { ...meOut(ctx), google: { on, linked: Boolean(login), email: login?.email || null } };
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
    // Forgot password can email a link (ext/passwords); else it says to ask a manager.
    resetByEmail: resetByEmail(),
    // Closed because the control centre sets this campaign up (its key, no campaign yet).
    fromControlCentre: !open && (await closedWords(db)) === FROM_CONTROL_CENTRE,
  });
});

app.post('/signup', async (c) => {
  const db = await getDb();
  // Staging's sample campaign is made through this door at boot (lib/samplecampaign.js).
  const sample = sampleSignup(c);
  if (!sample && !(await setupOpen(db))) return c.json({ error: await closedWords(db) }, 403);
  const parsed = signupInput.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
  const input = { ...parsed.data, workspaceName: parsed.data.workspaceName || orgName(), jurisdiction: parsed.data.jurisdiction || jurisdiction() };
  if (!input.workspaceName) return c.json({ error: 'name the campaign' }, 400);

  const email = input.email.toLowerCase();
  const passwordHash = await hashPassword(input.password);
  const userId = newId();
  let workspaceId;
  try {
    workspaceId = await db.transaction(async (tx) => {
      // Checked again inside the write, under a lock held to commit, so two
      // first-run sign-ups at the same moment can't both land.
      await tx.query(`select pg_advisory_xact_lock(${SIGNUP_LOCK})`);
      if (sample ? !(await noWorkspace(tx)) : !(await setupOpen(tx))) throw new SetupClosed();
      await tx.query(
        'insert into users (id, email, name, password_hash) values ($1, $2, $3, $4)',
        [userId, email, input.name, passwordHash],
      );
      return createWorkspace(tx, { userId, name: input.workspaceName, jurisdiction: input.jurisdiction, candidate: input.candidate });
    });
  } catch (e) {
    if (e instanceof SetupClosed) return c.json({ error: await closedWords(db) }, 403);
    if (String(e.message).includes('users_email_key')) {
      return c.json({ error: 'an account with that email already exists' }, 409);
    }
    throw e;
  }
  await recordCreated(db, { workspaceId, userId, email, name: input.workspaceName, jurisdiction: input.jurisdiction });
  const token = await createSession(db, userId, workspaceId);
  setCookie(c, SESSION_COOKIE, token, cookieOpts);
  const ctx = await loadContext(db, token);
  return c.json(await meFor(db, ctx), 201);
});

// The public demo (lib/demo.js; never on production): no password — every
// visitor is signed in as the one demo account and sent to the app. Off
// unless STARBASE_DEMO_EMAIL names an account in the campaign. The visitor
// can do whatever that account can — a manager's is everything — so the
// campaign on this server is the sample one (lib/samplecampaign.js), with nobody
// real in it. The same limit from one address as sign-in.
app.get('/demo', async (c) => {
  const email = demoEmail();
  if (!email) return c.json({ error: 'not found' }, 404);
  if (triesFrom(clientIp(c))) return c.json({ error: TOO_MANY }, 429);
  const db = await getDb();
  const row = (await db.query(
    `select u.id, m.workspace_id from users u
       join memberships m on m.user_id = u.id
      where u.email = $1 order by m.created_at limit 1`,
    [email],
  )).rows[0];
  if (!row) return c.json({ error: 'the demo is not set up' }, 503);
  setCookie(c, SESSION_COOKIE, await createSession(db, row.id, row.workspace_id), cookieOpts);
  return c.redirect(`${c.env?.base || ''}/`, 302);
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
  // base.win support has no password ('none'): the same wait as a wrong one.
  if (!String(user.password_hash).startsWith('scrypt:')) await dummyVerify();
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

// ── Forgot password (ext/passwords/reset.js) ──
// Asking for a link: the same answer, at once, whatever the address — the
// work runs after it. Ten asks an hour from one address and three for one
// email (Sam@… and sam@… are one), on top of sign-in's own limit; past a
// limit the answer is the same and nothing is sent.
const asksFrom = makeLimiter({ windowMs: 60 * 60_000, max: 10 });
const asksFor = makeLimiter({ windowMs: 60 * 60_000, max: 3 });
app.post('/forgot', async (c) => {
  // `null` is JSON too: the same answer, never a 500.
  const { email } = (await c.req.json().catch(() => null)) || {};
  const e = String(email ?? '').trim().toLowerCase().slice(0, 320);
  const ip = clientIp(c);
  // Each limit counts this ask, in order; any one over stops it.
  const over = triesFrom(ip) || asksFrom(ip) || (e && asksFor(e));
  if (e && !over) queueReset(await getDb(), e);
  return c.json({ ok: true });
});

// The Reset screen, with the token from the link's #t=: whose link it is.
// No route takes the token in its path (it would land in logs).
app.post('/reset/check', async (c) => {
  if (triesFrom(clientIp(c))) return c.json({ error: TOO_MANY }, 429);
  const { token } = (await c.req.json().catch(() => null)) || {};
  const row = await checkLink(await getDb(), token);
  if (!row) return c.json({ error: RUN_OUT }, 404);
  return c.json({ email: row.email });
});

class RunOut extends Error {}
const resetInput = z.object({ token: z.string().regex(TOKEN_RE), password: z.string().min(8).max(200) });
// A new password: the link used, every sign-in of the account ended, and on
// the log of each campaign it's in. Two-step sign-in still asks its code.
app.post('/reset', async (c) => {
  const db = await getDb();
  if (triesFrom(clientIp(c))) return c.json({ error: TOO_MANY }, 429);
  const body = await c.req.json().catch(() => ({}));
  if (!TOKEN_RE.test(String(body?.token ?? ''))) return c.json({ error: RUN_OUT }, 404);
  const parsed = resetInput.safeParse(body);
  if (!parsed.success) return c.json({ error: 'Choose a password of 8 or more characters.' }, 400);
  const { token, password } = parsed.data;
  const link = await checkLink(db, token);
  if (!link) return c.json({ error: RUN_OUT }, 404);
  const campaigns = (await db.query(
    'select workspace_id from memberships where user_id = $1 order by created_at', [link.user_id],
  )).rows.map((r) => r.workspace_id);
  if (!campaigns.length) return c.json({ error: RUN_OUT }, 404);
  // The slow hash first, outside any lock.
  const passwordHash = await hashPassword(password);
  let used;
  try {
    ({ result: used } = await runAction(db, { workspaceId: campaigns[0], actorId: link.user_id, action: 'auth.password.reset' }, async (tx, emit) => {
      const row = await useLink(tx, token, passwordHash);
      if (!row) throw new RunOut();
      emit('user', row.user_id, 'update', resetEvent(row));
      return row;
    }));
  } catch (e) {
    if (e instanceof RunOut) return c.json({ error: RUN_OUT }, 404);
    throw e;
  }
  // Their other campaigns here keep the same line on their own logs.
  for (const ws of campaigns.slice(1)) {
    await runAction(db, { workspaceId: ws, actorId: used.user_id, action: 'auth.password.reset' }, async (tx, emit) => {
      emit('user', used.user_id, 'update', resetEvent(used));
    });
  }
  failsFor.clear(`email:${link.email}`);
  if ((await twoStepRow(db, used.user_id))?.on_since) {
    setCookie(c, PENDING_COOKIE, await startPending(db, used.user_id, campaigns[0]), pendingCookie);
    return c.json({ two_step: 'code' });
  }
  const sessionToken = await createSession(db, used.user_id, campaigns[0]);
  setCookie(c, SESSION_COOKIE, sessionToken, cookieOpts);
  return c.json(await meFor(db, await loadContext(db, sessionToken)));
});

// ── base.win support: in from the control centre (lib/entry.js, ext/operator) ──
// The Enter page (/admin/enter#t=…) posts the token it was handed. Only at
// this server's own address (its Render one), never under a client's path,
// so the operator's sign-in lives on this campaign's own origin. Every
// failure of the token gets the same answer; the token is never logged.
const ENTRY_RUN_OUT = 'That link has run out. Open the desk again from the control centre.';
const ENTRY_WORDS = {
  off: [403, 'This campaign has turned off base.win sign-in. A manager can turn it on in Settings → Members.'],
  'email-taken': [409, 'An account with your email is here but isn’t on the team. A manager can invite it again.'],
  'email-in-use': [409, 'An account with your email is on this team with its own password, so base.win support can’t come in as it. Use another email in the control centre, such as you+support@….'],
  entry: [401, ENTRY_RUN_OUT],
};
app.post('/operator', async (c) => {
  if (triesFrom(clientIp(c))) return c.json({ error: TOO_MANY }, 429);
  const keys = parseKeys();
  const aud = ownOrigin();
  if (!keys.length || !aud) return c.json({ error: 'base.win sign-in isn’t set up on this server yet.', code: 'not-ready' }, 503);
  const refuse = (code) => c.json({ error: ENTRY_WORDS[code][1], code }, ENTRY_WORDS[code][0]);
  if (c.env?.base) return refuse('entry');
  if (c.req.header('origin') !== aud) return refuse('entry');
  const { token } = (await c.req.json().catch(() => null)) || {};
  const db = await getDb();
  const checked = verifyEntry(token, { keys, aud, env: envName(), inst: await instanceOf(db), nowMs: Date.now() });
  if (!checked.ok) return refuse('entry');
  const r = await enter(db, checked.payload);
  if (r.refused) return refuse(r.refused);
  setCookie(c, SESSION_COOKIE, r.token, { ...cookieOpts, maxAge: ENTRY_HOURS * 3600 });
  const ctx = await loadContext(db, r.token);
  if (!ctx) return refuse('entry');
  return c.json({ ...(await meFor(db, ctx)), go: checked.payload.go, invite: checked.payload.invite });
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

  let user = (await db.query('select id, password_hash, support from users where email = $1', [inv.email])).rows[0];
  if (user?.support) return c.json({ error: 'This address is base.win support’s here; invite another address.' }, 409);
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

// An election-day sign-in code (ext/voted decision 17): once, within its 15
// minutes, for someone still in the campaign with an open post. The
// session it makes works for Who voted only (lib/auth.js scopeAllows) and
// ends with the post's last voting day's work, at most 30 days. The page
// that asks (GET /go/:token) never uses the code.
app.post('/go', async (c) => {
  const db = await getDb();
  if (triesFrom(clientIp(c))) return c.json({ error: TOO_MANY }, 429);
  const { token } = await c.req.json().catch(() => ({}));
  const row = await usableCode(db, token);
  if (!row) return c.json({ error: EXPIRED }, 410);
  // Used now, under the campaign's lock: two taps make one session.
  const ctx = { workspaceId: row.workspace_id, workspace: { settings: typeof row.settings === 'string' ? JSON.parse(row.settings) : row.settings || {} } };
  const ends = await codeSessionEnds(db, ctx, row.user_id);
  const { result } = await runAction(db, { workspaceId: row.workspace_id, actorId: row.user_id, action: 'gotv.signin.use' }, async (tx, emit) => {
    const used = (await tx.query('update gotv_signin set used_at = now() where id = $1 and used_at is null and expires_at > now() returning id', [row.id])).rows[0];
    if (!used) return null;
    emit('session', row.id, 'create', { via: row.id, user_id: row.user_id, scope: 'gotv' });
    return createSession(tx, row.user_id, row.workspace_id, { scope: 'gotv', via: row.id, expiresAt: ends });
  });
  if (!result) return c.json({ error: EXPIRED }, 410);
  setCookie(c, SESSION_COOKIE, result, cookieOpts);
  const base = c.env?.base || '';
  return c.json({ ok: true, to: base ? `${base}/field/gotv` : '/gotv' });
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
