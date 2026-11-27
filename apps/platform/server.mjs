// base.win's control centre (ops.base.win): one sign-in for every campaign.
// Server-rendered pages for one person, a few forms and lists; its own small
// database (db.sql). It reads each campaign's public /api/health, and no
// campaign ever calls it. With RENDER_API_KEY set it also reads what Render
// says about each campaign's service and database, and makes a short list of
// named changes there, each behind a code typed for it and on the log. It
// keeps no setting's value, reads no secret and never connects to a
// campaign's database. Without the key it walks you through Render by hand,
// as before. See README.md.
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { cfg } from './config.mjs';
import { openDb, dbAnswers } from './db.mjs';
import { headers, hostSplit, sameOrigin } from './web.mjs';
import { authRoutes, requireSession, makeLimits } from './auth-routes.mjs';
import { verifyLog, listLog, PAGE } from './log.mjs';
import { logPage } from './pages/log.mjs';
import { campaignRoutes } from './campaign-routes.mjs';
import { wizardRoutes } from './wizard-routes.mjs';
import { renderRoutes } from './render-routes.mjs';
import { sharedRender } from './render-api.mjs';
import { startPoller } from './poller.mjs';

const file = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
// The app's own look: its variables and shared classes, read once at start.
const STATIC = {
  '/app.css': ['text/css; charset=utf-8', file('../../web/src/app.css')],
  '/ops.css': ['text/css; charset=utf-8', file('./ops.css')],
  '/ops.js': ['text/javascript; charset=utf-8', file('./ops.js')],
};

// fetcher: tests hand in a fake for the health checks. render: tests hand in
// a Render client made over a stand-in for Render. waits: how long Make it
// in Render waits between looks (tests: not at all).
export const makeApp = ({ db, fetcher, render, waits } = {}) => {
  const app = new Hono();
  app.use('*', headers);
  // Any host: the platform's own health check (Render's), nothing else.
  app.get('/healthz', async (c) => {
    const ok = await dbAnswers(db);
    return c.json({ ok, db: ok ? 'ok' : 'not reachable' }, ok ? 200 : 503);
  });
  app.use('*', hostSplit);
  for (const [path, [type, body]] of Object.entries(STATIC)) {
    app.get(path, (c) => c.body(body, 200, { 'Content-Type': type }));
  }
  app.use('*', sameOrigin);
  const ctx = { db, fetcher, limits: makeLimits(), waits };
  // The Render client, asked for on each request: none without a key, none
  // while this service doesn't know its own Render id.
  ctx.render = () => render ?? (cfg().render && cfg().ownService ? sharedRender() : null);
  authRoutes(app, ctx);
  app.use('*', requireSession(db));
  campaignRoutes(app, ctx);
  wizardRoutes(app, ctx);
  renderRoutes(app, ctx);
  app.get('/log', async (c) => {
    const before = /^\d{1,15}$/.test(c.req.query('before') || '') ? Number(c.req.query('before')) : null;
    const rows = await listLog(db, { before });
    const names = new Map((await db.query('select name, display from campaigns')).rows.map((r) => [r.name, r.display]));
    const older = rows.length === PAGE ? rows[rows.length - 1].seq : null;
    return c.html(String(logPage({ check: await verifyLog(db), rows, names, older })));
  });
  return app;
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  // On Render with no database address it would run on the in-memory one
  // and forget the operator, every campaign and the log at each restart.
  if (cfg().onRender && !cfg().databaseUrl) {
    console.error('The control centre can’t start: DATABASE_URL is empty. In Render, open base-platform → Environment, set DATABASE_URL to base-platform-db’s Internal Database URL, then Save and deploy.');
    process.exit(1);
  }
  const { serve } = await import('@hono/node-server');
  const db = await openDb(cfg().databaseUrl);
  const app = makeApp({ db });
  serve({ fetch: app.fetch, port: cfg().port }, () => console.log(`base.win control centre on :${cfg().port} for ${cfg().host}`));
  startPoller(db);
}
