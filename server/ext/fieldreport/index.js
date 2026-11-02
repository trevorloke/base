// Field, by turf — the desk's field numbers over a range of days: by turf
// (coverage, talks, support found, not-homes), by canvasser (doors, talks,
// supporters found, days out), by day, and as a spreadsheet; and each
// person's all-time line on Today (the brief's field.mine_all). Reads only:
// no tables, no actions.
//
//   numbers.js  the counting (ranges in the campaign's zone, door keys, turfs)
//   api.js      GET /field-report, GET /field-report.csv (desk, the data area)
import { mineAll, zoneOf } from './numbers.js';

export { api } from './api.js';

// Every role's Today carries their own all-time line — about them only.
const briefMineAll = async (db, ctx, body) => {
  if (!body.field) return;
  body.field.mine_all = await mineAll(db, ctx.workspaceId, ctx.user.id, zoneOf(ctx.workspace.settings?.tz));
};
export const hooks = { brief: briefMineAll };
export const deskOnlyReads = ['/field-report', '/field-report.csv'];
