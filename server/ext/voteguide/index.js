// The voter guide (VG): one guide per campaign for the next vote — the
// voting days and hours, the voting places, what to bring, who can vote and
// the ballot — entered at the desk the day the elections office releases
// it, checked by a person and published by a manager. The public sees it as
// a website module (shared/site/components/voteguide.js), a banner on
// voting days and an embed for another website; canvassers read it in the
// field (GET /api/guide). Nothing in it is the product's own: it ships empty.
//
//   sql.js      places.kind, vote_guide, vote_days, vote_place_info, vote_contests
//   read.js     the guide with its moments, memoised by rev; the checklist
//   actions.js  site.guide.* (Website area; publish, unpublish, clear and
//               the embed addresses a manager's) · placeInUse
//   api.js      GET /guide (anyone) · GET /site/guide · POST /site/guide/import/preview
//   public.js   the website's side: the address lookup, the clock, the embed
export { sql } from './sql.js';
export { actions, placeInUse } from './actions.js';
export { api, guideLink } from './api.js';

// In the full export ('places' is ext/schedule's).
export const exportTables = ['vote_guide', 'vote_days', 'vote_place_info', 'vote_contests'];
