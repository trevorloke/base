// base.win's control centre (ops.base.win): one sign-in for every campaign.
// Server-rendered pages for one person, a few forms and lists; its own small
// database (db.sql). It reads each campaign's public /api/health and nothing
// else, holds no campaign's database address, door key or Render key, and
// no campaign ever calls it. See README.md.
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { cfg } from './config.mjs';
import { openDb, dbAnswers } from './db.mjs';
import { headers, hostSplit, sameOrigin } from './web.mjs';

const file = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
// The app's own look: its variables and shared classes, read once at start.
const STATIC = {
  '/app.css': ['text/css; charset=utf-8', file('../../web/src/app.css')],
  '/ops.css': ['text/css; charset=utf-8', file('./ops.css')],
  '/ops.js': ['text/javascript; charset=utf-8', file('./ops.js')],
};

export const makeApp = ({ db }) => {
  const app = new Hono();
  app.use('*', headers);
  // Any host: the platform's own health check (Render's), nothing else.
  app.get('/healthz', async (c) => {
    const ok = await dbAnswers(db);
    return c.json({ ok, db: ok ? 'ok' : 'not reachable' }, ok ? 200 : 503);
  });
  app.use('*', hostSplit);
  for (const [path, [type, body]] of Object.entries(STATIC)) {
    app.get(path, (c) => c.body(body, 200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=300' }));
  }
  app.use('*', sameOrigin);
  return app;
};

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const { serve } = await import('@hono/node-server');
  const db = await openDb(cfg().databaseUrl);
  const app = makeApp({ db });
  serve({ fetch: app.fetch, port: cfg().port }, () => console.log(`base.win control centre on :${cfg().port} for ${cfg().host}`));
}
