// Public pages. No auth. base ground's own forms (petitions, newsletter and
// volunteer signup, RSVP, donate) are not here: the campaign's website
// will feed those in. What stays is what every email needs:
//   GET/POST /u/:subscriptionId   unsubscribe from the newsletter (GET asks, POST does it)
//   GET/POST /bu/:recipientId     unsubscribe from an email blast to a list
//
// Every public write goes through runAction as the system (actor null), so
// the hash-chained event log — "Verify the records" — covers it like any desk
// action:
//   public.unsubscribe  one-click unsubscribe (/u, /bu)  subscription update, person update
import { Hono } from 'hono';
import { getDb } from '../db/client.js';
import { runAction } from '../lib/events.js';
import { page, esc, settingsOf } from '../lib/publicpage.js';
import { basePath } from '../lib/basepath.js';

const app = new Hono();

// Run one public write as a system action (no actor): its table writes and
// its events commit together, on the workspace's hash chain.
const publicAction = async (db, ws, action, handler) =>
  (await runAction(db, { workspaceId: ws.id, actorId: null, action }, handler)).result;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const badUnsubscribe = (c) => c.html(page(null, 'Unsubscribe',
  `<h1>This unsubscribe link isn't valid — reply to the email to be removed.</h1>`), 404);

// The link in every newsletter. Opening it only asks (mail scanners open
// links by themselves); the one button — or a mail app's one-click
// unsubscribe (List-Unsubscribe-Post) — sends the POST that does it.
const loadSub = async (db, sid) => {
  if (!UUID.test(sid)) return null;
  const row = (await db.query(
    'select s.id, s.status, s.workspace_id, w.name, w.slug, w.settings from subscriptions s join workspaces w on w.id = s.workspace_id where s.id = $1',
    [sid],
  )).rows[0];
  return row ? { row, ws: { id: row.workspace_id, name: row.name, slug: row.slug, settings: row.settings } } : null;
};
const unsubscribedPage = (c, ws) => c.html(page(ws, 'Unsubscribed', `<h1>Unsubscribed.</h1><div class="done">You won't receive further newsletters from ${esc(ws.name)}.</div>`));

app.get('/u/:id', async (c) => {
  const found = await loadSub(await getDb(), c.req.param('id'));
  if (!found) return badUnsubscribe(c);
  if (found.row.status === 'unsubscribed') return unsubscribedPage(c, found.ws);
  return c.html(page(found.ws, 'Unsubscribe', `<h1>Unsubscribe from ${esc(found.ws.name)}?</h1>
<form method="post" action="${basePath()}/u/${esc(found.row.id)}"><button type="submit">Unsubscribe</button></form>`));
});

app.post('/u/:id', async (c) => {
  const db = await getDb();
  const found = await loadSub(db, c.req.param('id'));
  if (!found) return badUnsubscribe(c);
  const { row, ws } = found;
  // A second click finds them already off the list: nothing to write or log.
  await publicAction(db, ws, 'public.unsubscribe', async (tx, emit) => {
    const n = await tx.query(
      `update subscriptions set status = 'unsubscribed', unsubscribed_at = now()
       where id = $1 and workspace_id = $2 and status <> 'unsubscribed'`,
      [row.id, ws.id],
    );
    if (n.affectedRows > 0) emit('subscription', row.id, 'update', { status: 'unsubscribed', source: 'unsubscribe-link' });
  });
  return unsubscribedPage(c, ws);
});

// ── Unsubscribe from email blasts (/bu/:recipientId) ──
// The link at the foot of an email blast to a list. Like a ladder email's
// (/lu): an address on the newsletter list is marked unsubscribed there;
// one that never was gets the do-not-email tag on everyone with it, so
// no blast or ladder emails them again. Opening only asks; the button, or
// a mail app's one-click unsubscribe, does it.
const loadBlastRecipient = async (db, id) => {
  if (!UUID.test(id)) return null;
  const row = (await db.query(
    `select r.id, r.workspace_id, r.email, w.name, w.slug, w.settings from blast_recipients r
     join blasts b on b.id = r.blast_id join workspaces w on w.id = r.workspace_id
     where r.id = $1 and b.kind = 'eblast'`, [id],
  )).rows[0];
  const email = String(row?.email || '').trim().toLowerCase();
  return row && email ? { ...row, email, ws: { id: row.workspace_id, name: row.name, slug: row.slug, settings: settingsOf(row) } } : null;
};
app.get('/bu/:id', async (c) => {
  const row = await loadBlastRecipient(await getDb(), c.req.param('id'));
  if (!row) return badUnsubscribe(c);
  return c.html(page(row.ws, 'Unsubscribe', `<h1>Unsubscribe from ${esc(row.name)}?</h1>
<form method="post" action="${basePath()}/bu/${esc(row.id)}"><button type="submit">Unsubscribe</button></form>`));
});
app.post('/bu/:id', async (c) => {
  const db = await getDb();
  const row = await loadBlastRecipient(db, c.req.param('id'));
  if (!row) return badUnsubscribe(c);
  const ws = row.ws;
  await publicAction(db, ws, 'public.unsubscribe', async (tx, emit) => {
    const sub = (await tx.query('select id, status from subscriptions where workspace_id = $1 and email = $2', [ws.id, row.email])).rows[0];
    if (sub && sub.status !== 'unsubscribed') {
      await tx.query("update subscriptions set status = 'unsubscribed', unsubscribed_at = now() where id = $1 and workspace_id = $2", [sub.id, ws.id]);
      emit('subscription', sub.id, 'update', { status: 'unsubscribed', source: 'blast-unsubscribe' });
    }
    const people = (await tx.query(
      'select id, tags from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null', [ws.id, row.email],
    )).rows;
    for (const p of people) {
      const tags = typeof p.tags === 'string' ? JSON.parse(p.tags) : (p.tags || []);
      if (tags.includes('do-not-email')) continue;
      const next = [...tags, 'do-not-email'];
      await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2', [p.id, ws.id, JSON.stringify(next)]);
      emit('person', p.id, 'update', { tags: next, source: 'blast-unsubscribe' });
    }
  });
  return c.html(page(ws, 'Unsubscribed', `<h1>Unsubscribed.</h1><div class="done">You won't receive further emails from ${esc(ws.name)}.</div>`));
});

export default app;
