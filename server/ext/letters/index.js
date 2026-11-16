// Letters to the editor and op-eds.
//
// A volunteer writes a letter or an op-ed (on the phone, with no signal if
// need be), picks up to three papers from Media's outlets and sends it to
// the campaign. The desk works on it with them under Media → Letters: notes
// back and forth, suggested edits the writer takes or leaves, change by
// change. The writer says "This is my final text" (Ready — theirs alone to
// say), then sends it from their own email to the paper, and says so. The
// letter stays in the writer's words, under their name; base.win never sends
// it for them. When it runs, the link is kept.
//
//   sql.js      letters, letter_versions, letter_notes, letter_sends
//   actions.js  myletter.* (the writer's own, no area) · letter.* (the desk,
//               area Media, never a volunteer)
//   api.js      /letters/mine, /letters/mine/:id, /letters/outlets (writer)
//               /media/letters, /media/letters/count, /media/letters/:id (desk)
//
// Privacy: the log holds no letter's words (ids, sides, statuses and each
// draft's sha256 only); the sign-off is read from the writer's person record,
// and stored on a letter only where they changed it for that letter; the
// address and phone typed for it go 30 days after it closes (letters.purge),
// at once when withdrawn; the export leaves every sign-off field out.
import { runAction } from '../../lib/events.js';
import { PURGE_DAYS } from './actions.js';

export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';

export const exportTables = [
  { table: 'letters', omit: ['sign_name', 'sign_city', 'sign_address', 'sign_phone'] },
  'letter_versions', 'letter_notes', 'letter_sends',
];

// The :id read checks the role itself.
export const deskOnlyReads = ['/media/letters', '/media/letters/count'];

// 30 days after a letter closed, the address and phone typed for it go —
// unless it was reopened (or closed again since: that close has its own job).
const purge = async (db, job) => {
  const { letter_id: id, closed_at: closedAt } = job.payload;
  await runAction(db, { workspaceId: job.workspace_id, actorId: null, action: 'letter.purge' }, async (tx, emit) => {
    const l = (await tx.query(
      `update letters set sign_address = null, sign_phone = null, updated_at = now()
       where id = $1 and workspace_id = $2 and closed_at is not null and closed_at <= $3::timestamptz
         and closed_at <= now() - make_interval(days => $4) and (sign_address is not null or sign_phone is not null)
       returning id`,
      [id, job.workspace_id, closedAt, PURGE_DAYS],
    )).rows[0];
    if (l) emit('letter', id, 'update', { id, purged: ['sign_address', 'sign_phone'] });
  });
};
export const jobs = { 'letters.purge': purge };

// Today, for every role: the writer's own letters and the campaign's unseen replies.
const brief = async (db, ctx, body) => {
  const r = (await db.query(
    `select count(*)::int as has,
            (count(*) filter (where last_side = 'campaign' and last_at > coalesce(writer_seen_at, 'epoch'::timestamptz)))::int as unseen
     from letters where workspace_id = $1 and writer_user = $2`,
    [ctx.workspaceId, ctx.user.id],
  )).rows[0];
  body.letters = { unseen: r.unseen, has: r.has > 0 };
};
export const hooks = { brief };
