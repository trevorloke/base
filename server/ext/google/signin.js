// Back from Google, signing in or linking (routes.js hands over once the
// state, the code and the ID token have checked out).
//
// Signing in only finds an account its owner linked while signed in (by
// Google's sub). It never makes one and never matches by email: a mailbox
// never becomes a key to base.win on its own. Then the same membership,
// the campaign's rules, and two-step sign-in as a password sign-in; Google
// stands in for the password only. Sign-in is not on the event log.
import { setCookie } from 'hono/cookie';
import { createSession, SESSION_COOKIE } from '../../lib/auth.js';
import { runAction } from '../../lib/events.js';
import { makeLimiter } from '../../lib/guard.js';
import { signinRules } from '../../lib/google/config.js';
import { PENDING_COOKIE, startPending, twoStepRow } from '../../lib/twostep.js';
import { cookieOpts, pendingCookie } from '../../routes/auth.js';
import { appPaths, withCode } from './routes.js';

// Google refusals for one linked account: 10 in 15 minutes, its own count —
// never password sign-in's, so Google can't lock anyone out of their password.
const refusals = makeLimiter({ windowMs: 15 * 60_000, max: 10 });
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : (v || {}));
const settingsOf = async (db, workspaceId) => parse((await db.query('select settings from workspaces where id = $1', [workspaceId])).rows[0]?.settings);

export const signinBack = async (c, db, flow, who) => {
  const paths = appPaths(c, flow.app);
  // 1. By link only.
  const login = (await db.query('select user_id from google_logins where sub = $1', [who.sub])).rows[0];
  if (!login) return { code: 'no-account' };
  const key = `user:${login.user_id}`;
  if (refusals.count(key) >= 10) return { code: 'too-many' };
  const refuse = (code) => { refusals(key); return { code }; };
  // 2. The same membership as /login: the first one.
  const membership = (await db.query(
    'select workspace_id from memberships where user_id = $1 order by created_at limit 1', [login.user_id],
  )).rows[0];
  if (!membership) return refuse('removed');
  // 3. The campaign's rules.
  const rules = signinRules(await settingsOf(db, membership.workspace_id));
  if (!rules.signin) return refuse('off');
  if (rules.domain && who.hd !== rules.domain) return refuse('domain');
  // 4. Two-step sign-in on: the code next, at the existing step.
  if ((await twoStepRow(db, login.user_id))?.on_since) {
    setCookie(c, PENDING_COOKIE, await startPending(db, login.user_id, membership.workspace_id, { via: 'google' }), pendingCookie);
    return { to: `${paths.login}?step=code` };
  }
  // 5. Signed in.
  const token = await createSession(db, login.user_id, membership.workspace_id);
  setCookie(c, SESSION_COOKIE, token, cookieOpts);
  await db.query('update google_logins set last_used_at = now() where user_id = $1', [login.user_id]);
  refusals.clear(key);
  return { to: paths.rootSlash };
};

class Taken extends Error {}

// Linking from Your profile (or right after joining): the person signed in
// with their password, and Google says which account. A different email
// from the account's is fine — they proved both.
export const linkBack = async (c, db, flow, who) => {
  const live = (await db.query(
    'select 1 from sessions where token_hash = $1 and user_id = $2 and expires_at > now()',
    [flow.session_hash, flow.user_id],
  )).rows[0];
  if (!live) return { code: 'expired' };
  const rules = signinRules(await settingsOf(db, flow.workspace_id));
  if (!rules.signin) return { code: 'off' };
  if (rules.domain && who.hd !== rules.domain) return { code: 'domain' };
  try {
    await runAction(db, { workspaceId: flow.workspace_id, actorId: flow.user_id, action: 'google.link' }, async (tx, emit) => {
      const bySub = (await tx.query('select user_id from google_logins where sub = $1', [who.sub])).rows[0];
      const mine = (await tx.query('select sub from google_logins where user_id = $1', [flow.user_id])).rows[0];
      if (bySub && bySub.user_id !== flow.user_id) throw new Taken();
      if (mine && mine.sub !== who.sub) throw new Taken();
      if (mine) {
        await tx.query('update google_logins set email = $2, hd = $3 where user_id = $1', [flow.user_id, who.email, who.hd]);
        return;
      }
      await tx.query('insert into google_logins (user_id, sub, email, hd) values ($1, $2, $3, $4)', [flow.user_id, who.sub, who.email, who.hd]);
      // Nothing about the Google account on the chain: not its email, not its sub.
      emit('google_login', flow.user_id, 'create', {});
    });
  } catch (e) {
    if (e instanceof Taken || /google_logins/.test(String(e.message))) return { code: 'taken' };
    throw e;
  }
  return { to: withCode(flow.back, 'linked') };
};
