// The two hooks (lib/hooks.js).
//
//   stampPass   contactLogged: a door knock logged while a pass is open gets
//               contacts.pass_id — a new contact, and a visit_of amendment
//               (contact.id is the first contact's id there; the stamp it
//               already has stays, `pass_id is null`). A call or a text is
//               never stamped. A knock replayed from a phone whose tap
//               (client_at) predates the pass belongs to no pass: the
//               phone was in a dead zone before it started. Replays of a
//               knock already in never reach here (contact.log answers
//               duplicate first). Nothing is emitted: the contact's own
//               event is enough, and the stamp is derivable from it.
//   briefPass   brief: body.pass is the open pass (or null). The brief is
//               kept on every phone, so Today needs no second read.
import { openPass } from './rule.js';

export const stampPass = async (tx, ctx, { contact, input }) => {
  if (!contact?.id || contact.channel !== 'door') return;
  const open = await openPass(tx, ctx.workspaceId);
  if (!open) return;
  const at = input?.client_at ? new Date(input.client_at) : null;
  if (at && !Number.isNaN(at.getTime()) && at < new Date(open.started_at)) return;
  await tx.query(
    'update contacts set pass_id = $3 where id = $1 and workspace_id = $2 and pass_id is null',
    [contact.id, ctx.workspaceId, open.id],
  );
};

export const briefPass = async (db, ctx, body) => {
  body.pass = await openPass(db, ctx.workspaceId);
};
