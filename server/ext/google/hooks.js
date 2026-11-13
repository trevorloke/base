// Connections follow the team (lib/hooks.js events, inside the same write):
//
//   member.setRole, permission.member.set (a membership update) and a
//   role's defaults (a workspace update carrying permissions): each
//   affected person with a grant loses every purpose no membership of
//   theirs on this server allows any more; none left, the grant goes and is
//   revoked (unless another row holds that Google account).
//   member.remove (a membership void): someone in no other campaign here
//   loses their grant, revoked the same way.
//
// The membership entity is shared with paid memberships (ext/membership,
// ext/payments), so only these actions count — never the entity alone.
import { grantRowOf, removePurposes } from '../../lib/google/tokens.js';
import { mayUseAnywhere } from '../../lib/google/purposes.js';

const CHANGES = ['member.setRole', 'permission.member.set'];

const recheck = async (tx, emit, userId, workspaceId) => {
  const row = await grantRowOf(tx, userId, { lock: true });
  if (!row) return;
  const gone = [];
  for (const p of row.purposes) if (!(await mayUseAnywhere(tx, userId, p))) gone.push(p);
  if (gone.length) await removePurposes(tx, emit, row, gone, { workspaceId });
};

export const events = async (tx, meta, evs) => {
  const users = new Set();
  let everyone = false;
  for (const ev of evs) {
    if (ev.entityType === 'membership' && ev.op === 'update' && CHANGES.includes(meta.action)) users.add(ev.entityId);
    if (ev.entityType === 'workspace' && ev.op === 'update' && ev.payload?.permissions) everyone = true;
    if (ev.entityType === 'membership' && ev.op === 'void' && meta.action === 'member.remove') {
      const still = (await tx.query('select 1 from memberships where user_id = $1 limit 1', [ev.entityId])).rows[0];
      if (still) users.add(ev.entityId);
      else {
        const row = await grantRowOf(tx, ev.entityId, { lock: true });
        if (row) await removePurposes(tx, meta.emit, row, row.purposes, { workspaceId: meta.workspaceId });
      }
    }
  }
  if (everyone) {
    const rows = (await tx.query(
      'select g.user_id from google_grants g join memberships m on m.user_id = g.user_id and m.workspace_id = $1',
      [meta.workspaceId],
    )).rows;
    for (const r of rows) users.add(r.user_id);
  }
  for (const userId of users) await recheck(tx, meta.emit, userId, meta.workspaceId);
};
