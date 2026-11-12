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
//   calltime.js call time: calltime.log (the candidate) · calltime.drop (Donations),
//               GET /calltime/pledges (Donations) · /calltime/:bankId (the candidate)
//   room.js     what a donor may still give, less open call-time pledges
//   hand.js     a call-time bank's numbers go to the account in the seat
// A member removed from the campaign leaves their seat in the same write
// (events hook below).
import { handCallTime } from './hand.js';

export { sql } from './sql.js';
import { actions as seatActions } from './actions.js';
import { actions as calltime, briefPledges } from './calltime.js';

export const actions = { ...seatActions, ...calltime };
export { api } from './api.js';

const leaveSeat = async (tx, meta, events) => {
  for (const e of events) {
    if (e.entityType !== 'membership' || e.op !== 'void') continue;
    const seats = (await tx.query(
      'update candidates set user_id = null where workspace_id = $1 and user_id = $2 and removed_at is null returning id',
      [meta.workspaceId, e.entityId],
    )).rows;
    for (const s of seats) await handCallTime(tx, meta.workspaceId, s.id, null);
    for (const s of seats) meta.emit('candidate', s.id, 'update', { unlinked: e.entityId, left: true });
  }
};
export const hooks = { events: leaveSeat, brief: briefPledges };
// The pledges' notes go to Data readers in the export, as every gift does.
export const exportTables = ['candidates', 'calltime_results'];
