// The two hooks (lib/hooks.js).
//
//   stampPass   contactLogged: a door knock logged while a pass is open gets
//               contacts.pass_id — a new contact, and a visit_of amendment
//               (contact.id is the first contact's id there; the stamp it
//               already has stays, `pass_id is null`). A call or a text is
//               never stamped. A knock belongs to the pass that was open
//               when it was tapped (client_at, never later than now): one
//               tapped in a dead zone during last week's pass and sent
//               after it ended still counts there; one tapped before any
//               pass began belongs to none. A phone's clock can run a few
//               minutes slow, so a tap up to SKEW before the open pass
//               began still counts in it. Replays of a
//               knock already in never reach here (contact.log answers
//               duplicate first). Nothing is emitted: the contact's own
//               event is enough, and the stamp is derivable from it.
//   briefPass   brief: body.pass is the open pass (or null). The brief is
//               kept on every phone, so Today needs no second read.
import { openPass } from './rule.js';

const SKEW_MS = 5 * 60_000;

export const stampPass = async (tx, ctx, { contact, input }) => {
  if (!contact?.id || contact.channel !== 'door') return;
  const now = Date.now();
  const tapped = input?.client_at ? new Date(input.client_at).getTime() : NaN;
  const at = new Date(Number.isNaN(tapped) ? now : Math.min(tapped, now));
  let pass = (await tx.query(
    `select id from canvass_passes where workspace_id = $1 and started_at <= $2
       and (ended_at is null or ended_at > $2) order by started_at desc limit 1`,
    [ctx.workspaceId, at.toISOString()],
  )).rows[0];
  if (!pass) {
    const open = await openPass(tx, ctx.workspaceId);
    if (open && new Date(open.started_at).getTime() - at.getTime() <= SKEW_MS) pass = open;
  }
  if (!pass) return;
  await tx.query(
    'update contacts set pass_id = $3 where id = $1 and workspace_id = $2 and pass_id is null',
    [contact.id, ctx.workspaceId, pass.id],
  );
};

export const briefPass = async (db, ctx, body) => {
  body.pass = await openPass(db, ctx.workspaceId);
};
