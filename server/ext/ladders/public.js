// /lu/:runId — the unsubscribe at the foot of every ladder email.
//   GET   asks: one "Unsubscribe" button (mail scanners open links by
//         themselves, so opening the link never unsubscribes anyone)
//   POST  does it — the button, or a mail app's one-click unsubscribe
//         (the List-Unsubscribe-Post header on every ladder email)
// It uses the newsletter's own list: an address on it is marked
// unsubscribed there, so newsletters and every ladder email stop alike. An
// address that was never on the list gets no list row; the person is
// flagged do-not-email instead (email steps skip them). Either way a later
// signup is the only way back on. A system action, on the hash chain like /u.
import { Hono } from 'hono';
import { getDb } from '../../db/client.js';
import { runAction } from '../../lib/events.js';
import { NO_EMAIL_TAG, noEmail, tagsOf } from './shape.js';
import { page as publicPage } from '../../lib/publicpage.js';
import { campaignBrand } from '../../lib/brand.js';

export const publicRoutes = new Hono();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// The public pages' look (lib/publicpage.js): the campaign's brand, its logo
// over its name, one button.
const page = (row, title, inner, brand) => publicPage(row ? { name: row.name, settings: row.settings } : null, title, inner, { brand });

const bad = async (c) => c.html(page(null, 'Unsubscribe',
  "<h1>This unsubscribe link isn't valid — reply to the email to be removed.</h1>", await campaignBrand()), 404);

// The run, its person's address, and whether that address is already off.
const load = async (db, id) => {
  if (!UUID.test(id)) return null;
  const row = (await db.query(
    `select r.id, r.workspace_id, p.email, w.name, w.settings from ladder_runs r
     join persons p on p.id = r.person_id join workspaces w on w.id = r.workspace_id
     where r.id = $1`,
    [id],
  )).rows[0];
  const email = String(row?.email || '').trim().toLowerCase();
  return row && email ? { ...row, email } : null;
};
const isOff = async (db, ws, email) => {
  const sub = (await db.query('select status from subscriptions where workspace_id = $1 and email = $2', [ws, email])).rows[0];
  if (sub) return sub.status === 'unsubscribed';
  const people = (await db.query(
    'select tags from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null', [ws, email],
  )).rows;
  return people.length > 0 && people.every(noEmail);
};
const done = (c, row) => c.html(page(row, 'Unsubscribed',
  `<h1>Unsubscribed.</h1><div class="done">You won't receive further newsletters or automatic emails from ${esc(row.name)}.</div>`));

publicRoutes.get('/lu/:id', async (c) => {
  const db = await getDb();
  const row = await load(db, c.req.param('id'));
  if (!row) return bad(c);
  if (await isOff(db, row.workspace_id, row.email)) return done(c, row);
  return c.html(page(row, 'Unsubscribe', `<h1>Unsubscribe from ${esc(row.name)}?</h1>
<form method="post" action="/lu/${esc(row.id)}"><button type="submit">Unsubscribe</button></form>`));
});

publicRoutes.post('/lu/:id', async (c) => {
  const db = await getDb();
  const row = await load(db, c.req.param('id'));
  if (!row) return bad(c);
  const ws = row.workspace_id;
  await runAction(db, { workspaceId: ws, actorId: null, action: 'public.unsubscribe' }, async (tx, emit) => {
    const sub = (await tx.query(
      'select id, status from subscriptions where workspace_id = $1 and email = $2', [ws, row.email],
    )).rows[0];
    if (sub) {
      // A second click finds them already off the list: nothing to write.
      if (sub.status === 'unsubscribed') return;
      await tx.query(
        "update subscriptions set status = 'unsubscribed', unsubscribed_at = now() where id = $1 and workspace_id = $2",
        [sub.id, ws],
      );
      emit('subscription', sub.id, 'update', { status: 'unsubscribed', source: 'ladder-unsubscribe' });
      return;
    }
    // Never on the list: flag everyone with this address do-not-email.
    const people = (await tx.query(
      'select id, tags from persons where workspace_id = $1 and lower(email) = $2 and deleted_at is null', [ws, row.email],
    )).rows;
    for (const p of people) {
      if (noEmail(p)) continue;
      const tags = [...tagsOf(p), NO_EMAIL_TAG];
      await tx.query('update persons set tags = $3, updated_at = now() where id = $1 and workspace_id = $2',
        [p.id, ws, JSON.stringify(tags)]);
      emit('person', p.id, 'update', { tags, source: 'ladder-unsubscribe' });
    }
  });
  return done(c, row);
});
