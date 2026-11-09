// Path to win — the desk's view of where the campaign stands against what
// it needs (ROADMAP item 8): per race, the votes needed to win (typed in,
// or worked out from eligible voters × turnout × share — the campaign's own
// numbers, never a jurisdiction's rules), the supporters found against the
// supporters needed, the weekly pace to election day beside the last 4
// weeks', a week-by-week trend from the ratings, and the turfs ranked by a
// score with its reasons, on a map (web/src/pages/PathToWin.jsx, /path-to-win).
//
//   sql.js      path_to_win (one row: election day, the races' numbers)
//   rules.js    the arithmetic: win number, pace, trend, the score (pure)
//   numbers.js  the counting, in SQL
//   actions.js  pathtowin.save (managers)
//   api.js      GET /pathtowin (the Data area: desk roles, or anyone given
//               it; a minute's kept copy of the counts)
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
import { forget } from './api.js';

// The kept counts go when the turfs change, or a list or the sample comes in
// or goes (everything moves at once); single knocks and ratings simply wait
// for the minute to pass.
const BULK = /^(import\.|sample\.)/;
const dropKept = async (tx, meta, events) => {
  if (BULK.test(String(meta.action || '')) || events.some((e) => e.entityType === 'turf')) forget(meta.workspaceId);
};
export const hooks = { events: dropKept };

// In the full export: the campaign's numbers.
export const exportTables = ['path_to_win'];

// Volunteers never read it unless given the Data area (lib/perms.js).
export const deskOnlyReads = ['/pathtowin'];
