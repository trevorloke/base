// base.win for e2e-google-signin.mjs: the real server (server/index.js),
// plus one test purpose ('test.purpose', anyone, no area) so the Google
// card's connections can be driven end to end, and — with POKE_PORT — a
// tiny local listener that makes one googleFetch for a person's grant
// (GET /fetch?email=…), the way a feature would after the fake Google
// revokes it. With CONNECT_HOST (a folder the suite built from
// google-connect-host.jsx) it also serves a stand-in feature screen with
// GoogleConnect on it, at /admin/e2e-google-connect and
// /e2e-google-connect. Test-only: nothing here is loaded by the real server.
//
//   GOOGLE_… settings as the suite gives them; POKE_PORT=5303 \
//   CONNECT_HOST=/tmp/host node server/test/google-e2e-server.js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePurpose } from '../lib/google/purposes.js';

definePurpose('test.purpose', {
  label: 'Test connection', scopes: ['https://www.googleapis.com/auth/test.read'],
  roles: ['manager', 'treasurer', 'staff', 'volunteer'], area: null,
});
// index.js starts listening only when it is the script node ran.
process.argv[1] = fileURLToPath(new URL('../index.js', import.meta.url));
const { app } = await import('../index.js');

// The stand-in screen goes in front of the app's own routes: the server
// reads app.fetch at each request (lib/mount.js), so wrapping it is enough.
const HOST_DIR = process.env.CONNECT_HOST;
if (HOST_DIR) {
  const inner = app.fetch;
  const TYPES = { '.js': 'text/javascript', '.css': 'text/css' };
  app.fetch = async (req, env) => {
    const p = new URL(req.url).pathname;
    if (p === '/admin/e2e-google-connect' || p === '/e2e-google-connect') {
      const css = JSON.parse(await readFile(join(HOST_DIR, 'css.json'), 'utf8'));
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Feature screen</title>${css.map((f) => `<link rel="stylesheet" href="/e2e-google-connect/${f}">`).join('')}</head>
<body><div id="root"></div><script type="module" src="/e2e-google-connect/host.js"></script></body></html>`;
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    const f = /^\/e2e-google-connect\/([\w.-]+\.(js|css))$/.exec(p);
    if (f) return new Response(await readFile(join(HOST_DIR, f[1])), { headers: { 'content-type': TYPES[`.${f[2]}`] } });
    return inner(req, env);
  };
}

const POKE = Number(process.env.POKE_PORT || 0);
if (POKE) {
  const { getDb } = await import('../db/client.js');
  const { grantFor, googleFetch } = await import('../lib/google/tokens.js');
  http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://poke');
      const db = await getDb();
      const who = (await db.query(
        'select m.user_id, m.workspace_id from memberships m join users u on u.id = m.user_id where u.email = $1 order by m.created_at limit 1',
        [u.searchParams.get('email')],
      )).rows[0];
      const grant = who ? await grantFor(db, { userId: who.user_id, workspaceId: who.workspace_id }, 'test.purpose') : null;
      const r = grant ? await googleFetch(db, grant, `${process.env.GOOGLE_OAUTH_BASE}/test-api/ping`) : null;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ state: grant?.state || null, ok: r?.ok ?? null, trouble: r?.trouble?.code || null }));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e.message));
    }
  }).listen(POKE, '127.0.0.1');
}
