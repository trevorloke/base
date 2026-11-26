// Starbase server. Hono app: /api/auth (public), /api/* (workspace-scoped),
// static web build. Exported for in-process tests via app.request().
// The preset comes first: which client's own material this server has, if
// any, is settled before anything else reads it (lib/preset.js).
import { brandKey, brandNote, presetRoutes } from './lib/preset.js';
import { Hono } from 'hono';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { frameHosts } from './lib/demo.js';
import { seedSample } from './lib/samplecampaign.js';
import authRoutes from './routes/auth.js';
import apiRoutes from './routes/api.js';
import publicRoutes from './routes/public.js';
import { getDb, dbReachable, storeOf, storeRefusal } from './db/client.js';
import { EXTENSIONS } from './ext.js';
import { startJobRunner, stopJobRunner } from './lib/jobs.js';
import { staleTimeZoneData } from './lib/tzcheck.js';
import { clockNote } from './lib/clock.js';
import { envName, orgName } from './lib/org.js';
import { bodyLimit } from 'hono/body-limit';
import { appRedirect, basePath, mountAt } from './lib/mount.js';
import { doorKeySet } from './lib/guard.js';
import { brandPages } from './lib/brand.js';
import { siteGate } from './ext/site/public.js';
import { currentBuild } from './lib/build.js';
import { entryReadiness, ownOrigin, parseKeys } from './lib/entry.js';
import { setupOpen, noWorkspace } from './lib/setup.js';
import { configuredUrl } from './lib/calendar.js';
import { instanceOf } from './ext/operator/identity.js';
import { start as startUsage, flush as flushUsage } from './lib/gusage.js';

export const app = new Hono();

// How big a request body may be: 256 KB for anything, more for the two
// uploads (a CSV import's 2,000 rows; a picture, as base64). Hono buffers a
// body before parsing, so without this a few big requests could take all
// the memory — no sign-in needed.
const BODY_MAX = { '/api/data/import': 16 * 1024 * 1024, '/api/actions/learn.asset.upload': 17 * 1024 * 1024, '/api/actions/blast.attach': 7 * 1024 * 1024, '/api/actions/blast.picture': 4 * 1024 * 1024, '/api/actions/site.picture': 7 * 1024 * 1024 };
BODY_MAX['/api/actions/brand.picture'] = 4 * 1024 * 1024; // the campaign's logo, mark or an app icon (ext/brand)
app.use('*', (c, next) => bodyLimit({
  maxSize: BODY_MAX[c.req.path] || 256 * 1024,
  onError: (cc) => cc.json({ error: 'request too large' }, 413),
})(c, next));
// A feature's own limit for an address of its own (bodyMax: { path: bytes }):
// the email sender's delivery events come in batches (ext/mail).
for (const e of EXTENSIONS) Object.assign(BODY_MAX, e.bodyMax || {});
// Headers every answer carries: not framed by another site (voter data on
// screen; the demo's frame on staging is the one exception, below), no sniffing a type, no full URLs leaking off-site. A route that
// set its own keeps it. The API's answers also name the web build this
// server hands out (lib/build.js): a page from before a deploy sees that it
// is older than the server, and says so.
app.use('*', async (c, next) => {
  await next();
  const h = c.res.headers;
  // A page whose route set no policy of its own (the app's page): no
  // plugins, and no <base> pointing its links elsewhere. A site page or a
  // file that set one keeps exactly its own.
  const pagePolicy = !h.has('Content-Security-Policy') && /^text\/html/i.test(h.get('Content-Type') || '');
  // The voter guide's embed names the sites that may frame it in its CSP
  // (frame-ancestors) and so carries no X-Frame-Options (ext/site public.js).
  const framedBy = /frame-ancestors (?!'none')/.test(h.get('Content-Security-Policy') || '');
  if (!h.has('X-Frame-Options') && !framedBy) {
    // The demo's frame (lib/demo.js; never on production): the sites named
    // may frame the app, and no other. Everywhere else, nobody may.
    const frames = frameHosts();
    const csp = h.get('Content-Security-Policy') || '';
    if (!frames.length) h.set('X-Frame-Options', 'DENY');
    else if (!/frame-ancestors/i.test(csp)) h.set('Content-Security-Policy', `${csp ? `${csp}; ` : ''}frame-ancestors 'self' ${frames.join(' ')}`);
  }
  if (pagePolicy) {
    const csp = h.get('Content-Security-Policy');
    h.set('Content-Security-Policy', `${csp ? `${csp}; ` : ''}object-src 'none'; base-uri 'self'`);
  }
  if (!h.has('X-Content-Type-Options')) h.set('X-Content-Type-Options', 'nosniff');
  if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  const build = c.req.path.startsWith('/api/') ? currentBuild() : null;
  if (build) h.set('X-Build', build);
});
// The campaign's own domain (SITE_HOSTS, or a domain set under Website):
// only the public website answers there — never an app route, never the
// sign-in cookie (ext/site/public.js). Everywhere else, the site is /site/.
app.use('*', siteGate);
// commit: which build is live (Render sets RENDER_GIT_COMMIT), so anyone can
// check a deploy landed — open /api/health and compare with GitHub.
const COMMIT = String(process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || '').slice(0, 7) || null;
// It asks the database too: a server up with its database down can't sign
// anyone in, so it says so (503, "database": "not reachable") and the host
// keeps the old version or restarts it.
// For the base.win control centre (ext/operator), nothing secret and nothing
// about people: this server's own address and instance (what an entry token
// must name), the campaign's public address, whether entry is set up and the
// keys it holds (by kid), whether first-run sign-up is open, whether the
// campaign has been made (a workspace exists: campaignMade), and whether the
// door's key is set (never the key). Never the campaign's switch.
// store: where the campaign is kept — "postgres" (DATABASE_URL) or
// "embedded" (the built-in database, which on a host needs a disk).
// brand: what the campaign starts from — base, or its preset's name.
const publicAddress = () => {
  const raw = configuredUrl();
  try { return raw && /^https?:$/.test(new URL(raw).protocol) ? raw : null; } catch { return null; }
};
app.get('/api/health', async (c) => {
  const database = await dbReachable();
  const db = database ? await getDb().catch(() => null) : null;
  const instance = db ? await instanceOf(db).catch(() => null) : null;
  const open = db ? await setupOpen(db).catch(() => null) : null;
  const made = db ? await noWorkspace(db).then((none) => !none, () => null) : null;
  return c.json({
    ok: database, database: database ? 'ok' : 'not reachable', service: 'starbase', env: envName(), organization: orgName(), brand: brandKey(), commit: COMMIT, build: currentBuild(), tzdataCurrent: !staleTimeZoneData(),
    ownOrigin: ownOrigin(), instance, address: publicAddress(), entry: entryReadiness(),
    platformKids: parseKeys().map((k) => k.kid), setupOpen: open, campaignMade: made, doorKey: doorKeySet(), store: storeOf(db),
  }, database ? 200 : 503);
});
app.route('/api/auth', authRoutes);
app.route('/', publicRoutes); // /u, /bu — no auth
for (const e of EXTENSIONS) if (e.publicRoutes) app.route('/', e.publicRoutes);
app.route('/api', apiRoutes);

// Static web build (SPA fallback to index.html for URL routing). Resolved
// from this file, not the working directory, so any launch location works.
const WEB_ROOT = relative(process.cwd(), fileURLToPath(new URL('../web/dist', import.meta.url))) || '.';
app.route('/', presetRoutes); // a preset's own files at the app's addresses (its icons), only under its brand
app.use('*', brandPages); // the app's page and manifest wear this deployment's look (lib/brand.js)
app.use('*', serveStatic({ root: WEB_ROOT }));
// A build file that isn't there (an older build's, asked for by a page left
// open across a deploy) is missing — 404, never the app's page under a .js
// name: a browser refuses that as a script and the screen stayed blank.
app.get('/assets/*', (c) => c.text('Not found', 404, { 'Cache-Control': 'no-store' }));
// Under a client's path (BASE_PATH, lib/mount.js) an address that isn't the
// app's — /join/…, an old /login — goes to the volunteers' app at /field.
app.get('*', async (c, next) => appRedirect(c) || next());
app.get('*', serveStatic({ root: WEB_ROOT, path: 'index.html' }));

// Said loudly in the log when the server starts (it still starts): settings
// that leave a hosted server half set up. One line each.
//   - production with no STARBASE_PUBLIC_URL: nothing it sends can link back;
//   - on Render, a STARBASE_ENV that is neither "production" nor "staging"
//     (unset, or misspelled): what it is treated as (lib/org.js envName);
//   - no STARBASE_BRAND on a server named as a preset's campaign: it is
//     given that preset because of its name (lib/preset.js brandNote).
export const bootNotes = (env = process.env) => {
  const out = [];
  const brand = brandNote(env);
  if (brand) out.push(brand);
  const typed = String(env.STARBASE_ENV || '').trim();
  const name = envName(env);
  if (env.RENDER && typed !== name) {
    out.push(`starbase: WARNING — STARBASE_ENV is ${typed ? `“${typed}”, which is neither “production” nor “staging”` : 'not set'}: this server is treated as ${name}`
      + ' (the demo sign-in, the sample campaign and its reset stay off). Set STARBASE_ENV to production or staging: Render → this service → Environment.');
  }
  if (name === 'production' && !String(env.STARBASE_PUBLIC_URL || '').trim()) {
    out.push('starbase: WARNING — STARBASE_PUBLIC_URL is not set on a production server: emails can’t link back here (password resets, shift reminders) and Sign in with Google stays off.'
      + ' Set it to the campaign’s public address, https://<name>.base.win.');
  }
  return out;
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  // On Render with no database address: say why and stop, before anything
  // answers a request (db/client.js).
  const refused = storeRefusal();
  if (refused) {
    console.error(refused);
    process.exit(1);
  }
  for (const note of bootNotes()) console.warn(note);
  const port = Number(process.env.PORT) || 3200;
  // BASE_PATH=/imaginesurrey: this Ground answers under base.win/imaginesurrey
  // (lib/mount.js); unset, at the site's root.
  const base = basePath();
  const server = serve({ fetch: mountAt(app, base), port }, () => {
    console.log(`starbase on :${port}${base ? ` at ${base}` : ''}`);
  });
  // Staging's sample campaign, made once on an empty database (lib/samplecampaign.js).
  seedSample(app).catch((e) => console.error('sample:', e));
  const tz = staleTimeZoneData();
  if (tz) console.warn(`starbase: ${tz}`);
  const moved = clockNote();
  if (moved) console.warn(`starbase: ${moved}`);
  // Behind the base.win door without its key, everyone who comes through
  // the door is the door's one address to the limits per address.
  if (base && !doorKeySet()) {
    console.warn('starbase: under base.win (BASE_PATH) but BASE_DOOR_KEY is not set (32+ characters, the same as the door’s) — everyone who comes through the door counts as one address for sign-in tries and the website’s forms');
  }
  // Background jobs (ladder steps, A/B winners). STARBASE_JOBS=off disables.
  if (process.env.STARBASE_JOBS !== 'off') {
    // A database still starting (or restarting) is tried again, not a crash.
    const startJobs = () => getDb().then(
      (db) => startJobRunner(db, { everyMs: Number(process.env.STARBASE_JOBS_EVERY_MS) || 30_000 }),
      (e) => { console.error(`database not reachable yet (${e.message}); trying again in 10 s`); setTimeout(startJobs, 10_000).unref?.(); },
    );
    startJobs();
  }
  // Today's Google counts (lib/gusage.js), read back from the database.
  getDb().then(() => startUsage(), () => {});
  // Deploys send SIGTERM: stop accepting requests, then close the database so
  // the embedded store flushes cleanly.
  const shutdown = async (sig) => {
    console.log(`${sig}: shutting down`);
    server.close();
    stopJobRunner();
    await flushUsage().catch(() => {});
    try { await (await getDb()).close(); } catch { /* already closed */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
