// Lists — saved filters and hand-picked lists of people: the one audience
// for an email or a text, a phone bank (ext/banks), a sweep of the doors
// (ext/passes), a report or a CSV.
//
//   sql.js       lists, list_members
//   audience.js  who a list (or a filter) names, who of them can be reached
//                (lib/reach.js decides), and its numbers, kept for a minute
//   actions.js   list.create/snapshot/update/delete/add/remove (desk)
//   api.js       GET /lists, /lists/:id/counts, /lists/preview, /lists/tags,
//                /lists/:id, /lists/:id/export.csv (desk)
//
// Two People filters of its own, so a saved filter (and People, and Calls)
// can say "is on another list" or "is not" (lib/audience.js FILTER_KEYS):
//   list=<id>      on that list as it stands — a hand-picked one, or
//                  whoever its filter names today
//   notlist=<id>   not on it
// A list a volunteer asks for, one that isn't there, or one that leads back
// to itself matches nobody, never everybody.
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
import { loadList, onListSql, peopleChanged } from './audience.js';

const str = (v) => String(v ?? '').trim().slice(0, 60);
const MAX_DEPTH = 4; // a list on a list on a list… and no further

const personsWhere = async (db, ctx, query, w) => {
  // unread: somewhere down the lists this one stands on, one couldn't be
  // read — then the whole rule names nobody ("not on a list nobody can
  // read" is not everybody).
  const unread = ctx.listUnread || { yes: false };
  for (const [key, not] of [['list', false], ['notlist', true]]) {
    const id = str(query?.[key]).toLowerCase();
    if (!id) continue;
    const trail = ctx.listTrail || [];
    // Lists are the desk's: a volunteer never sorts people by one.
    const list = ctx.role === 'volunteer' || trail.includes(id) || trail.length >= MAX_DEPTH ? null : await loadList(db, ctx.workspaceId, id);
    if (!list) { unread.yes = true; w.where += ' and false'; continue; }
    const on = await onListSql(db, { ...ctx, listUnread: unread }, list, w.params);
    // coalesce: someone the other list's filter can't say yes or no about isn't on it.
    w.where += not ? ` and not coalesce(${on}, false)` : ` and ${on}`;
  }
  if (unread.yes) w.where += ' and false';
};

// Many people changed at once (an import, a merge, the sample campaign):
// every list's kept numbers are counted again (audience.js).
const BULK = /^(import\.|sample\.|person\.merge)/;
const events = async (tx, meta) => {
  if (BULK.test(String(meta.action || ''))) peopleChanged(meta.workspaceId);
};

export const hooks = { personsWhere, events };
export const exportTables = ['lists', 'list_members'];
export const deskOnlyReads = [/^\/api\/lists(\/|$)/];
