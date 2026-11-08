// Signing in once (SUITE.md, "Signing in once: base ground is the hub").
// base air and base web don't keep their own passwords for staff: they ask
// base ground who is signed in, then sign that person in to their own
// account, linked once to (client, sub) — never by the email alone.
//
//   GET  /api/sso/authorize?app=air|web&redirect_uri=…&state=…
//        (the browser, sent by the app) → 302 to redirect_uri?code=…&state=…
//        Not signed in: to the desk's sign-in, and back here after.
//        A volunteer (no desk role, no areas) is refused.
//   POST /api/sso/token  (the app's SERVER; Authorization: Bearer <secret>)
//        { code, redirect_uri } → { sub, email, name, role, areas, organization, client }
//        once; anything wrong is 400 { error: 'invalid_grant' }, no detail.
//        sub: this person's stable id here (their user id, an opaque
//        string that never changes, even when their email does) — the app
//        links its own account to (client, sub), never to the email alone.
//        client: the client's slug.
//   GET  /api/suite      (signed in) the apps this person may open, for the
//        base switcher in the top bar.
//
// Settings (each app is set up when both of its are set):
//   BASE_AIR_URL, BASE_AIR_SSO_SECRET   base air, e.g. https://base.win/imaginesurrey/air
//   BASE_WEB_URL, BASE_WEB_SSO_SECRET   base web, e.g. https://imaginesurrey.ca
//   BASE_CLIENT                         the client's slug in the token's answer;
//                                       unset: the last part of BASE_PATH
//
// A code is 32 random bytes; only its SHA-256 is kept, with who, which app,
// the exact redirect_uri and an expiry 60 seconds out. It is spent by the
// one update that checks it, so two tries at once can't both succeed. The
// rows stay 90 days as the record of who opened which app when.
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getDb } from '../../db/client.js';
import { loadContext, SESSION_COOKIE } from '../../lib/auth.js';
import { areasFor, permsOf } from '../../lib/perms.js';
import { orgName } from '../../lib/org.js';
import { basePath, clientSlug } from '../../lib/basepath.js';
import { clientIp, makeLimiter } from '../../lib/guard.js';
import { page, esc } from '../../lib/publicpage.js';
import { APPS, env, isStaff, appUrl, appReady, redirectOk } from '../../lib/suite.js';

export const sql = `
create table if not exists sso_codes (
  code_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  app text not null check (app in ('air', 'web')),
  redirect_uri text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists sso_codes_created_idx on sso_codes (created_at);
`;

const CODE_SECONDS = 60;
const KEEP_DAYS = 90;
const sha = (s) => createHash('sha256').update(String(s)).digest();
// Equal or not, in the same time whatever the two are (hashing first makes
// them the same length).
const sameSecret = (a, b) => timingSafeEqual(sha(a), sha(b)) && Boolean(a) && Boolean(b);

const refusePage = (c, status, title, words) => c.html(page(null, title, `<h1>${esc(title)}</h1><p>${words}</p>`, { noindex: true }), status);

export const publicRoutes = new Hono();

publicRoutes.get('/api/sso/authorize', async (c) => {
  const key = c.req.query('app');
  const redirectUri = c.req.query('redirect_uri');
  const state = c.req.query('state');
  // Nothing goes back to an address that isn't the app's own: these answer
  // here, never by a redirect.
  if (!Object.hasOwn(APPS, key || '')) return refusePage(c, 400, 'Unknown app', 'This sign-in link names no base app.');
  if (!appReady(key)) return refusePage(c, 400, `${APPS[key].name} isn’t set up`, `Ask a manager to connect ${esc(APPS[key].name)} under Settings → Services.`);
  if (!redirectOk(key, redirectUri)) return refusePage(c, 400, 'This sign-in link isn’t valid', `It doesn’t lead back to ${esc(APPS[key].name)}.`);
  if (!state || state.length > 500) return refusePage(c, 400, 'This sign-in link isn’t valid', 'It’s missing its state — open the app and try again.');

  const db = await getDb();
  const ctx = await loadContext(db, getCookie(c, SESSION_COOKIE));
  if (!ctx) {
    // The desk's sign-in, then back to this same address.
    const back = `${basePath()}/api/sso/authorize${new URL(c.req.url).search}`;
    return c.redirect(`${basePath()}/ground/login?next=${encodeURIComponent(back)}`, 302);
  }
  if (!isStaff(ctx.role, areasFor(ctx))) {
    return refusePage(c, 403, `${APPS[key].name} is for staff`, `You’re signed in as ${esc(ctx.user.name)}, a volunteer. <a href="${basePath()}/field/">Open the field app</a>.`);
  }

  const code = randomBytes(32).toString('base64url');
  await db.query(`delete from sso_codes where created_at < now() - interval '${KEEP_DAYS} days'`);
  await db.query(
    `insert into sso_codes (code_hash, user_id, workspace_id, app, redirect_uri, expires_at)
     values ($1, $2, $3, $4, $5, now() + interval '${CODE_SECONDS} seconds')`,
    [sha(code).toString('hex'), ctx.user.id, ctx.workspaceId, key, redirectUri],
  );
  const to = new URL(redirectUri);
  to.searchParams.set('code', code);
  to.searchParams.set('state', state);
  // The code is in the address: never cached, never sent on as a referrer.
  return c.body(null, 302, { Location: to.href, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
});

// Wrong secrets and spent codes from one address: 60 a minute, then 429.
const tokenTries = makeLimiter({ windowMs: 60_000, max: 60 });
const invalid = (c) => c.json({ error: 'invalid_grant' }, 400, { 'Cache-Control': 'no-store' });

publicRoutes.post('/api/sso/token', async (c) => {
  if (tokenTries.count(clientIp(c)) >= 60) return c.json({ error: 'too many requests' }, 429);
  const fail = () => { tokenTries(clientIp(c)); return invalid(c); };
  const auth = c.req.header('authorization') || '';
  const given = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] || '';
  // Which app is asking: the one whose secret this is. Every secret is
  // compared, every time, so the time taken says nothing.
  let key = null;
  for (const k of Object.keys(APPS)) {
    const mine = env(APPS[k].secret);
    if (sameSecret(given, mine) && appUrl(k) && !key) key = k;
  }
  if (!key) return fail();
  const body = await c.req.json().catch(() => null);
  const code = typeof body?.code === 'string' ? body.code : '';
  const redirectUri = typeof body?.redirect_uri === 'string' ? body.redirect_uri : '';
  if (!code || code.length > 200 || !redirectUri) return fail();

  const db = await getDb();
  // Spent by the same statement that checks it: known, this app's, the same
  // redirect_uri, not yet used, not expired.
  const row = (await db.query(
    `update sso_codes set used_at = now()
     where code_hash = $1 and app = $2 and redirect_uri = $3 and used_at is null and expires_at > now()
     returning user_id, workspace_id`,
    [sha(code).toString('hex'), key, redirectUri],
  )).rows[0];
  if (!row) return fail();
  const who = (await db.query(
    `select u.id, u.email, u.name, m.role, m.permissions, w.name as ws_name, w.settings
     from users u join memberships m on m.user_id = u.id and m.workspace_id = $2
     join workspaces w on w.id = m.workspace_id where u.id = $1`,
    [row.user_id, row.workspace_id],
  )).rows[0];
  if (!who) return fail();
  // As they are now, not as they were a minute ago: someone made a volunteer
  // in between is refused.
  const settings = typeof who.settings === 'string' ? JSON.parse(who.settings) : (who.settings || {});
  const own = typeof who.permissions === 'string' ? JSON.parse(who.permissions) : (who.permissions || {});
  const areas = areasFor({ role: who.role, perms: permsOf(who.role, settings, own) });
  if (!isStaff(who.role, areas)) return fail();
  return c.json({
    sub: String(who.id), email: who.email, name: who.name, role: who.role, areas,
    organization: orgName() || who.ws_name, client: clientSlug(),
  }, 200, { 'Cache-Control': 'no-store' });
});

// ── The base switcher: GET /api/suite ──
// field: everyone. ground, air and web: desk roles and anyone given an area —
// the same people the hand-off lets through (air and web once set up). The
// other app still decides: it only signs in someone it has an account for. Addresses of this app's own faces are root paths
// (the browser puts its prefix on, web/src/paths.js); the others are whole
// addresses, each through its /auth/base so the hop is already signed in.
export const suiteFor = (role, areas) => {
  const staff = isStaff(role, areas);
  const apps = [{ key: 'field', name: 'field', what: 'Canvass, calls and shifts', href: '/field/' }];
  if (staff) apps.push({ key: 'ground', name: 'ground', what: 'The campaign desk', href: '/ground/' });
  if (staff && appReady('air')) apps.push({ key: 'air', name: 'air', what: 'Listening and social', href: `${appUrl('air')}/auth/base` });
  if (staff && appReady('web')) apps.push({ key: 'web', name: 'web', what: 'The website’s admin', href: `${appUrl('web')}/auth/base` });
  return apps;
};

export const api = new Hono();
api.get('/suite', (c) => {
  const ctx = c.get('ctx');
  return c.json({ client: clientSlug(), apps: suiteFor(ctx.role, areasFor(ctx)) });
});
