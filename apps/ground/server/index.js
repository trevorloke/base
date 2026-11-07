// base ground server. Hono app: /api/auth (public), /api/* (workspace-scoped),
// static web build. Exported for in-process tests via app.request().
// Addresses (SUITE.md): the field app at /field/, the desk at /ground/, both
// under BASE_PATH (lib/basepath.js) — app.fetch takes the prefix off first.
import { Hono } from 'hono';
import { relative } from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import authRoutes from './routes/auth.js';
import apiRoutes from './routes/api.js';
import publicRoutes from './routes/public.js';
import { getDb } from './db/client.js';
import { EXTENSIONS } from './ext.js';
import { startJobRunner, stopJobRunner } from './lib/jobs.js';
import { staleTimeZoneData } from './lib/tzcheck.js';
import { envName, orgName } from './lib/org.js';
import { bodyLimit } from 'hono/body-limit';
import { basePath, withBasePath, publicUrlMismatch } from './lib/basepath.js';
import { headTags, injectHead } from './lib/htmlhead.js';

export const app = new Hono();
// Every request, from the network or a test's app.request(), passes the
// BASE_PATH wrapper first: under the prefix it is handled as if at the root;
// outside it, a 308 to the same address under the prefix (lib/basepath.js).
app.fetch = withBasePath(app.fetch);

// How big a request body may be: 256 KB for anything, more for the two
// uploads (a CSV import's 2,000 rows; a picture, as base64). Hono buffers a
// body before parsing, so without this a few big requests could take all
// the memory — no sign-in needed.
const BODY_MAX = { '/api/data/import': 16 * 1024 * 1024, '/api/actions/learn.asset.upload': 17 * 1024 * 1024, '/api/actions/blast.attach': 7 * 1024 * 1024, '/api/actions/blast.picture': 4 * 1024 * 1024 };
app.use('*', (c, next) => bodyLimit({
  maxSize: BODY_MAX[c.req.path] || 256 * 1024,
  onError: (cc) => cc.json({ error: 'request too large' }, 413),
})(c, next));
// Headers every answer carries: not framed by another site (voter data on
// screen), no sniffing a type, no full URLs leaking off-site. A route that
// set its own keeps it.
app.use('*', async (c, next) => {
  await next();
  const h = c.res.headers;
  if (!h.has('X-Frame-Options')) h.set('X-Frame-Options', 'DENY');
  if (!h.has('X-Content-Type-Options')) h.set('X-Content-Type-Options', 'nosniff');
  if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
});
// commit: which build is live (Render sets RENDER_GIT_COMMIT), so anyone can
// check a deploy landed — open /api/health and compare with GitHub.
const COMMIT = String(process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || '').slice(0, 7) || null;
app.get('/api/health', (c) => c.json({ ok: true, service: 'base-ground', env: envName(), organization: orgName(), commit: COMMIT, tzdataCurrent: !staleTimeZoneData() }));
app.route('/api/auth', authRoutes);
app.route('/', publicRoutes); // /u, /bu — no auth
for (const e of EXTENSIONS) if (e.publicRoutes) app.route('/', e.publicRoutes);
app.route('/api', apiRoutes);

// ── The two faces and the static web build ──
// Resolved from this file, not the working directory, so any launch location
// works. index.html is never sent as it is on disk: the server writes the
// prefix (and anything else in lib/htmlhead.js) into its head first.
const WEB_DIST = new URL('../web/dist/', import.meta.url);
const WEB_ROOT = relative(process.cwd(), fileURLToPath(WEB_DIST)) || '.';
let indexHtml = null;
const readIndex = async () => {
  // Read once in production; every time elsewhere, so a rebuild shows up.
  if (indexHtml && process.env.NODE_ENV === 'production') return indexHtml;
  indexHtml = await readFile(new URL('index.html', WEB_DIST), 'utf8');
  return indexHtml;
};
const sendIndex = async (c) => {
  let html;
  try { html = await readIndex(); } catch { return c.text('base ground: the web app isn’t built — run npm run build', 503); }
  const tags = await headTags({ db: await getDb() });
  // Never cached: it names the build's files, and a new deploy must show.
  return c.html(injectHead(html, tags), 200, { 'Cache-Control': 'no-cache' });
};
const FACE = /^\/(field|ground)(\/|$)/;
const go = (c, path, status) => c.redirect(`${basePath()}${path}${new URL(c.req.url).search}`, status);
// / is the field app's front door; the desk's old address keeps working.
app.get('/', (c) => go(c, '/field/', 302));
app.get('/index.html', sendIndex);
app.get('/admin', (c) => go(c, '/ground/', 308));
app.get('/admin/*', (c) => go(c, `/ground${c.req.path.slice('/admin'.length)}`, 308));
// An invite link (/join/<token>, in emails already sent) opens in the field app.
app.get('/join/*', (c) => go(c, `/field${c.req.path}`, 302));
// /web: base web's admin, signed in through base ground (SUITE.md).
app.get('/web', (c) => {
  const web = String(process.env.BASE_WEB_URL || '').trim().replace(/\/+$/, '');
  return web ? c.redirect(`${web}/auth/base`, 302) : c.notFound();
});
app.use('*', serveStatic({ root: WEB_ROOT }));
app.get('*', async (c) => {
  const path = c.req.path;
  if (FACE.test(path)) return sendIndex(c);
  // A missing file (an old build's /assets/…, a typo) is a 404 — never the
  // app under a .js name.
  if (path.startsWith('/assets/') || path.startsWith('/api/') || /\.[a-z0-9]+$/i.test(path)) return c.notFound();
  // Anything else is a field-app screen at its old address (/map, /login, a
  // home-screen icon from before): the same screen under /field.
  return go(c, `/field${path}`, 308);
});

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const port = Number(process.env.PORT) || 3200;
  const server = serve({ fetch: app.fetch, port }, () => {
    console.log(`base ground on :${port}`);
  });
  const tz = staleTimeZoneData();
  if (tz) console.warn(`base: ${tz}`);
  // BASE_PUBLIC_URL and BASE_PATH must agree, or emailed links miss the app.
  const mismatch = publicUrlMismatch();
  if (mismatch) console.warn(`\n*** base: ${mismatch} ***\n`);
  if (basePath()) console.log(`base ground under ${basePath()}`);
  // Background jobs (ladder steps, A/B winners). BASE_JOBS=off disables.
  if (process.env.BASE_JOBS !== 'off') {
    getDb().then((db) => startJobRunner(db, { everyMs: Number(process.env.BASE_JOBS_EVERY_MS) || 30_000 }));
  }
  // Deploys send SIGTERM: stop accepting requests, then close the database so
  // the embedded store flushes cleanly.
  const shutdown = async (sig) => {
    console.log(`${sig}: shutting down`);
    server.close();
    stopJobRunner();
    try { await (await getDb()).close(); } catch { /* already closed */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
