// A–Z by last name: the one order for every list of people (People, a
// list's people, the call list, Knows, volunteers, crews, downloads, the
// person search). The surname folded (shared/names.js; an organisation or a
// one-word name by its whole name), then the whole name as written, then
// the id. collate "C" so the order is byte order on every database — under
// an en_US collation spaces and hyphens would be skipped and the browser's
// azSort (shared/names.js) would disagree — and so ext/search's
// persons_ws_az_idx can serve it. Walk lists keep street order (lib/geo.js).
//   azKey('p')            → the ORDER BY, exactly
//   azAfter('p', n, '>')  → the people after the one whose id is $n
//                           ($1 is the workspace); '<=' up to them
export const azKey = (a = 'p') => `person_fold(coalesce(${a}.last_name, ${a}.name)) collate "C", person_fold(${a}.name) collate "C", ${a}.id`;

export const azAfter = (a, n, op) => `(${azKey(a)}) ${op} (select person_fold(coalesce(x.last_name, x.name)) collate "C", person_fold(x.name) collate "C", x.id from persons x where x.id = $${n} and x.workspace_id = $1)`;
