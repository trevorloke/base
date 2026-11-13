// Moved: after a Moved tap at the door, a new address or Address unknown —
// and who lives at the new address and the old one.
//
//   person.move / person.unmove   actions.js (who may, what a move does)
//   GET /api/moves/door           api.js (the two lists, for the phone)
//   People ?moved=open            "Needs an address": the team's Moved taps
//                                 with no address yet (open.js)
//   People ?moved=unknown         "Address unknown"
//   movedCounts(db, ws)           { open, unknown } — Today's Needs you and
//                                 Reports' menu
//   movedOpenIds(db, ws, { after, limit })   the ids of Needs an address
//                                 (Reports' moved recipe), from the same SQL
//   hooks                         a real new address clears Address unknown;
//                                 Today's count; the sample's movers;
//                                 People's moved= filter
// Imports and duplicate merges leave a move alone (routes/data.js,
// ext/duplicates); the profile reads it (routes/api.js GET /persons/:id).
import { movedOpenWhere, movedCounts, movedOpenIds } from './open.js';
import { clearUnknown, briefMoved, sampleMovers } from './hooks.js';

export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
export { movedOpenWhere, movedCounts, movedOpenIds };

// moved=open | unknown; any other value matches nobody, as every cut does.
const personsWhere = async (db, ctx, query, w) => {
  const v = String(query?.moved ?? '').trim();
  if (!v) return;
  if (v === 'open') w.where += ` and ${movedOpenWhere('p', '$1')}`;
  else if (v === 'unknown') w.where += " and p.address_status = 'unknown'";
  else w.where += ' and false';
};

export const hooks = { events: clearUnknown, brief: briefMoved, sampleLoaded: sampleMovers, personsWhere };

// In the full export; merging duplicates moves them with the person
// (ext/duplicates personColumns).
export const exportTables = ['person_moves'];
