// The one route pair for every Google flow — signing in, linking Google to
// your account, and connecting it for a purpose (Gmail, Drive, Calendar):
//
//   GET /api/auth/google/start?do=signin|link|connect&app=field|desk
//       [&for=<purpose>][&back=<app path>]   → 302 to Google, or back into
//       the app with ?google=<code>
//   GET /api/auth/google/back?state=…&code=…  → 302 into the app
//
// The redirect address Google knows is <STARBASE_PUBLIC_URL>/api/auth/google/back,
// nothing else. Every answer is a 302 to a path (lib/mount.js puts the
// client's path in front under BASE_PATH), except signing in from another
// address, which goes to the same start at the public one.
// Nothing from a flow is logged or put on the event log: not the code, the
// state, the verifier, the nonce, a token, the sub or the Google email.
import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../../db/client.js';
import { loadContext, SESSION_COOKIE } from '../../lib/auth.js';
import { clientIp, doorClientIp, makeLimiter } from '../../lib/guard.js';
import { configuredUrl } from '../../lib/calendar.js';
import { accountsBase, AUTH_PATH, clientId, googleSetup, redirectUri, signinRules } from '../../lib/google/config.js';
import { readIdToken, tokenCall, tokenPaused } from '../../lib/google/flow.js';
import { mayUse, purposeOf } from '../../lib/google/purposes.js';
import { cookieOpts } from '../../routes/auth.js';
import { signinBack, linkBack } from './signin.js';
import { connectBack } from './connect.js';

export const FLOW_COOKIE = 'mv2_google';
const FLOW_MINUTES = 10;
// Lax, not Strict: Google's return is a cross-site navigation, which never
// carries a Strict cookie. It holds the raw state and nothing else.
const flowCookie = { httpOnly: true, sameSite: 'Lax', path: '/', secure: cookieOpts.secure, maxAge: FLOW_MINUTES * 60 };

// Starts from one address: 60 in 15 minutes. Failed returns (a state that
// doesn't match, no flow, an ID token refused): 20. Their own counts, never
// password sign-in's.
const starts = makeLimiter({ windowMs: 15 * 60_000, max: 60 });
const backFails = makeLimiter({ windowMs: 15 * 60_000, max: 20 });

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
const DOS = ['signin', 'link', 'connect'];
const APPS = ['field', 'desk'];
const BACK_RE = /^\/[a-z0-9/_-]{0,120}$/;

// Paths inside the app (mount puts the client's path in front). Under
// BASE_PATH the apps are /field and /desk; at a root, / and /admin.
export const appPaths = (c, app) => {
  const under = Boolean(c.env?.base);
  const desk = app === 'desk';
  const root = under ? (desk ? '/desk' : '/field') : (desk ? '/admin' : '');
  return { root: root || '/', login: `${root}/login`, profile: `${root}/profile`, rootSlash: under ? `${root}/` : (desk ? '/admin' : '/') };
};
const cleanBack = (c, app, back) => (typeof back === 'string' && BACK_RE.test(back) && !back.includes('//') ? back : appPaths(c, app).profile);
const withCode = (path, code) => `${path}${path.includes('?') ? '&' : '?'}google=${encodeURIComponent(code)}`;

const goTo = (c, location) => {
  c.header('Cache-Control', 'no-store');
  c.header('Referrer-Policy', 'no-referrer');
  return c.redirect(location, 302);
};

// The address the browser used: the door's, when the door vouches for the
// request; else this request's own; and the client's path.
const browserAddress = (c) => {
  let origin = new URL(c.req.url).origin;
  if (doorClientIp(c)) {
    const proto = String(c.req.header('x-forwarded-proto') || 'https').split(',')[0].trim();
    const host = String(c.req.header('x-forwarded-host') || '').split(',')[0].trim();
    if (host && /^https?$/.test(proto)) origin = `${proto}://${host}`;
  }
  return `${origin}${c.env?.base || ''}`.replace(/\/+$/, '');
};
export const atPublicAddress = (c) => browserAddress(c) === configuredUrl();

const b64url = (buf) => buf.toString('base64url');

export const publicRoutes = new Hono();

publicRoutes.get('/api/auth/google/start', async (c) => {
  const q = c.req.query();
  const kind = q.do;
  const app = q.app === undefined ? 'field' : q.app;
  if (!DOS.includes(kind) || !APPS.includes(app)) return c.json({ error: 'not a Google sign-in this server knows' }, 400);
  const paths = appPaths(c, app);
  const back = kind === 'signin' ? null : cleanBack(c, app, q.back);
  const purpose = kind === 'connect' ? purposeOf(q.for) : null;
  if (kind === 'connect' && !purpose) return c.json({ error: 'not a Google connection this server knows' }, 400);
  const fail = (code) => goTo(c, withCode(kind === 'signin' ? paths.login : back, code));

  const db = await getDb();
  const setup = googleSetup();
  // 1. Set up, and (signing in or linking) allowed by the campaign.
  if (!(kind === 'connect' ? setup.connect : setup.signin)) return fail('not-set-up');
  // 2. Not while Google's token endpoint is paused (never an API's pause).
  const paused = tokenPaused();
  if (paused) return fail(paused.code === 'client' ? 'not-set-up' : 'unavailable');
  // 3. Starts from one address.
  if (starts(clientIp(c))) return fail('too-many');
  // 4. The public address, the only one Google sends people back to.
  if (!atPublicAddress(c)) {
    if (kind !== 'signin') return fail('wrong-address');
    const query = new URLSearchParams({ do: 'signin', app }).toString();
    return goTo(c, `${configuredUrl()}/api/auth/google/start?${query}`);
  }
  // 5. Linking and connecting: signed in, two-step set up when it's owed.
  let ctx = null;
  if (kind !== 'signin') {
    ctx = await loadContext(db, getCookie(c, SESSION_COOKIE));
    if (!ctx) return fail('expired');
    if (ctx.twoStep?.mustSetUp) return fail('two-step-first');
  }
  let hd = null;
  if (kind !== 'connect') {
    const settings = kind === 'link'
      ? ctx.workspace.settings
      : (await db.query('select settings from workspaces order by created_at limit 1')).rows[0]?.settings;
    const rules = signinRules(typeof settings === 'string' ? JSON.parse(settings) : settings);
    if (!rules.signin) return fail('off');
    hd = rules.domain;
  } else {
    // 6. A purpose this person may use now.
    if (!(await mayUse(db, { userId: ctx.user.id, workspaceId: ctx.workspaceId }, purpose))) return fail('not-allowed');
    hd = purpose.domain(ctx.workspace.settings || {}) || null;
  }

  const state = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48)); // 64 characters
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  await db.query('delete from google_flows where expires_at < now()');
  await db.query(
    `insert into google_flows (state_hash, kind, app, nonce, verifier, purpose, back, user_id, workspace_id, session_hash, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + interval '${FLOW_MINUTES} minutes')`,
    [sha256(state), kind, app, nonce, verifier, purpose?.key || null, back,
     ctx?.user.id || null, ctx?.workspaceId || null, ctx?.session || null],
  );
  setCookie(c, FLOW_COOKIE, state, flowCookie);

  let hint = null;
  if (ctx) {
    hint = ctx.user.email;
    if (kind === 'connect') hint = (await db.query('select email from google_grants where user_id = $1', [ctx.user.id])).rows[0]?.email || hint;
  }
  const params = new URLSearchParams({
    client_id: clientId(), redirect_uri: redirectUri(), response_type: 'code',
    scope: kind === 'connect' ? ['openid', 'email', ...purpose.scopes].join(' ') : 'openid email profile',
    state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
  });
  if (kind === 'signin') params.set('prompt', 'select_account');
  if (kind === 'connect') {
    // A refresh token every time: without one, the connect is refused.
    params.set('access_type', 'offline');
    params.set('include_granted_scopes', 'true');
    params.set('prompt', 'consent');
  }
  if (hint) params.set('login_hint', hint);
  if (hd) params.set('hd', hd);
  return goTo(c, `${accountsBase()}${AUTH_PATH}?${params}`);
});

publicRoutes.get('/api/auth/google/back', async (c) => {
  const db = await getDb();
  const ip = clientIp(c);
  const q = c.req.query();
  const field = appPaths(c, 'field');
  if (backFails.count(ip) >= 20) {
    deleteCookie(c, FLOW_COOKIE, { path: '/' });
    return goTo(c, withCode(field.login, 'too-many'));
  }
  // 1. The state Google returns is the one this browser was given, for a
  //    flow still waiting. Used once, whatever happens next.
  const cookieState = getCookie(c, FLOW_COOKIE);
  deleteCookie(c, FLOW_COOKIE, { path: '/' });
  const hashes = [...new Set([q.state, cookieState].filter(Boolean).map(sha256))];
  const flows = hashes.length
    ? (await db.query('delete from google_flows where state_hash = any($1) returning *, expires_at > now() as live', [hashes])).rows
    : [];
  const flow = q.state && cookieState && q.state === cookieState ? flows.find((f) => f.live) : null;
  if (!flow) {
    backFails(ip);
    return goTo(c, withCode(flows[0] ? (flows[0].kind === 'signin' ? appPaths(c, flows[0].app).login : flows[0].back) : field.login, 'expired'));
  }
  const paths = appPaths(c, flow.app);
  const fail = (code) => goTo(c, withCode(flow.kind === 'signin' ? paths.login : flow.back, code));

  // 2. Google's own refusals.
  if (q.error) {
    if (q.error === 'access_denied') return fail('cancelled');
    if (q.error === 'admin_policy_enforced') return fail('blocked');
    return fail('unavailable');
  }
  if (!q.code) return fail('unavailable');
  // 3. The code for tokens, with the verifier only this server has.
  const paused = tokenPaused();
  if (paused) return fail(paused.code === 'client' ? 'not-set-up' : 'unavailable');
  const r = await tokenCall({
    grant_type: 'authorization_code', code: q.code, redirect_uri: redirectUri(), code_verifier: flow.verifier,
  });
  if (r.trouble) return fail(r.trouble.code === 'client' ? 'not-set-up' : 'unavailable');
  if (!r.ok) return fail(r.error === 'invalid_grant' ? 'expired' : 'unavailable');
  // 4. Who Google says this is.
  const who = readIdToken(r.body?.id_token, { nonce: flow.nonce });
  if (who.refused) {
    backFails(ip);
    console.warn(`google: id token refused (${who.refused})`);
    return fail('unavailable');
  }
  // 5. Sign in, link, or connect.
  const done = flow.kind === 'signin' ? await signinBack(c, db, flow, who)
    : flow.kind === 'link' ? await linkBack(c, db, flow, who)
      : await connectBack(c, db, flow, who, r.body);
  if (done.code) return fail(done.code);
  return goTo(c, done.to);
});

export { goTo, withCode };
