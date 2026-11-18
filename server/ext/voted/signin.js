// The election-day sign-in code's page (decision 17). GET /go/:token never
// uses the token: it only shows the campaign's name and one button, "Sign
// in as Ana", which POSTs /api/auth/go (routes/auth.js) — so a link
// preview that fetches the page changes nothing. An unknown, used or
// expired code says so.
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { page, esc } from '../../lib/publicpage.js';
import { hashToken } from './posts.js';

export const publicRoutes = new Hono();
const NO_STORE = 'no-store';
export const EXPIRED = 'That code has expired — ask the office for a new one.';

// → { row } for a code that can still be used, else null.
export const usableCode = async (db, token) => {
  if (!/^[0-9a-f]{64}$/.test(String(token || ''))) return null;
  return (await db.query(
    `select s.id, s.workspace_id, s.user_id, u.name, w.name as ws_name, w.settings
       from gotv_signin s join users u on u.id = s.user_id join workspaces w on w.id = s.workspace_id
       join gotv_posts g on g.workspace_id = s.workspace_id and g.user_id = s.user_id and g.ended_at is null
       join memberships m on m.workspace_id = s.workspace_id and m.user_id = s.user_id
      where s.token_hash = $1 and s.used_at is null and s.expires_at > now()`, [hashToken(token)],
  )).rows[0] || null;
};

const CSS = '<style>.go{min-height:56px;font-size:17px}.said{margin-top:16px;min-height:1.5em}</style>';
publicRoutes.get('/go/:token', async (c) => {
  const db = await getDb();
  const row = await usableCode(db, c.req.param('token'));
  const headers = { 'Cache-Control': NO_STORE, 'Referrer-Policy': 'no-referrer' };
  if (!row) return c.html(page(null, 'Sign in to Who voted', `<h1>Sign in to Who voted</h1><p>${esc(EXPIRED)}</p>`, { noindex: true }), 410, headers);
  const first = String(row.name || '').trim().split(/\s+/)[0] || 'you';
  const ws = { name: row.ws_name, settings: row.settings };
  return c.html(page(ws, 'Sign in to Who voted', `${CSS}<h1>Sign in to Who voted</h1>
<form id="go" method="post" action="/api/auth/go"><button class="go" type="submit">Sign in as ${esc(first)}</button></form>
<p class="said" role="status" aria-live="polite"></p>
<script>
const f = document.getElementById('go');
f.addEventListener('submit', async (e) => {
  e.preventDefault();
  const said = document.querySelector('.said');
  f.querySelector('button').disabled = true;
  try {
    const r = await fetch(f.action, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: location.pathname.split('/').pop() }) });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.to) { location.replace(j.to); return; }
    said.textContent = j.error || ${JSON.stringify(EXPIRED)};
  } catch { said.textContent = 'No signal — try again.'; }
  f.querySelector('button').disabled = false;
});
</script>`, { noindex: true }), 200, headers);
});
