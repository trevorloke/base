// The open pass, and the shared door rule — what routes/api.js reads to
// derive walk lists and turf counts while a pass is open.
//   openPass(q, ws)  { id, name, kind, who, tries, started_at } or null —
//                    q is a db or a transaction (the hooks run inside one).
//   doorState / inUniverse / inPass  from shared/passes.js (one rule for the
//                    server and the phone).
export const openPass = async (q, ws) => (await q.query(
  'select id, name, kind, who, tries, started_at from canvass_passes where workspace_id = $1 and ended_at is null',
  [ws],
)).rows[0] || null;

export { doorState, inUniverse, inPass } from '@starbase/shared/passes';
