// The open pass, and the shared door rule — what routes/api.js reads to
// derive walk lists and turf counts while a pass is open.
//   openPass(q, ws)  { id, name, kind, who, list_id, tries, started_at } or
//                    null — q is a db or a transaction (the hooks run inside
//                    one). list_id: the List the pass walks, if it walks one.
//   listedWhere(db, ctx, pass)  for a pass that walks a list: the WHERE
//                    (persons p) and params for "on it now" — read once per
//                    request, then joined into each turf's read
//                    (lib/audience.js joinWhere) as pass_listed; null for a
//                    pass that walks no list.
//   doorState / inUniverse / inPass  from shared/passes.js (one rule for the
//                    server and the phone).
import { asDesk, loadList, whereFor } from '../lists/audience.js';

export const openPass = async (q, ws) => (await q.query(
  'select id, name, kind, who, list_id, tries, started_at from canvass_passes where workspace_id = $1 and ended_at is null',
  [ws],
)).rows[0] || null;

// The list is read as the desk reads it, whoever is walking. One that is
// gone names nobody (list.delete refuses while the open pass walks it).
export const listedWhere = async (db, ctx, pass) => {
  if (!pass?.list_id) return null;
  const list = await loadList(db, ctx.workspaceId, pass.list_id);
  return list ? whereFor(db, asDesk(ctx), { list }) : { where: 'false', params: [] };
};

export { doorState, inUniverse, inPass } from '@starbase/shared/passes';
