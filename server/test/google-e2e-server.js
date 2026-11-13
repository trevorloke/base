// base.win for e2e-google-signin.mjs: the real server (server/index.js),
// plus one test purpose ('test.purpose', anyone, no area) so the Google
// card's connections can be driven end to end, and — with POKE_PORT — a
// tiny local listener that makes one googleFetch for a person's grant
// (GET /fetch?email=…), the way a feature would after the fake Google
// revokes it. Test-only: nothing here is loaded by the real server.
//
//   GOOGLE_… settings as the suite gives them; POKE_PORT=5303 \
//   node server/test/google-e2e-server.js
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { definePurpose } from '../lib/google/purposes.js';

definePurpose('test.purpose', {
  label: 'Test connection', scopes: ['https://www.googleapis.com/auth/test.read'],
  roles: ['manager', 'treasurer', 'staff', 'volunteer'], area: null,
});
// index.js starts listening only when it is the script node ran.
process.argv[1] = fileURLToPath(new URL('../index.js', import.meta.url));
await import('../index.js');

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
