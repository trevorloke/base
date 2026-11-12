// Candidates — a seat on the slate, and the volunteer account that sits in
// it. A candidate's role stays 'volunteer' everywhere (memberships.role is
// never a fifth word), so every volunteer rule holds for them: no emails,
// no money, no gifts. What a seat adds is here, each part checking
// ctx.candidate (lib/auth.js) and keeping to the candidate's own rows; their
// grants are the Candidates row under Permissions (lib/perms.js).
//
//   sql.js      candidates; invites.candidate_id
//   invite.js   the invite row, linking a seat, what the app is told
//   actions.js  candidate.save · invite · unlink · remove (managers)
//   api.js      GET /candidates (managers) · GET /candidate/home (the candidate)
// A member removed from the campaign leaves their seat in the same write
// (events hook below).
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';

const leaveSeat = async (tx, meta, events) => {
  for (const e of events) {
    if (e.entityType !== 'membership' || e.op !== 'void') continue;
    const seats = (await tx.query(
      'update candidates set user_id = null where workspace_id = $1 and user_id = $2 and removed_at is null returning id',
      [meta.workspaceId, e.entityId],
    )).rows;
    for (const s of seats) meta.emit('candidate', s.id, 'update', { unlinked: e.entityId, left: true });
  }
};
export const hooks = { events: leaveSeat };
export const exportTables = ['candidates'];
