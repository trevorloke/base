// Voted — one fact, "this person has voted", that any volunteer sets with
// one tap on election day and every screen can read.
//
// On election day the office switches Election day on (Today → More →
// Election day, managers). From then the walk list's open door, the map's
// door card and the Calls card carry a 48px "Voted ✓" (with no signal too:
// the outbox keeps it and sends it once); the door's row shows "✓ Voted".
// Today reads "Election day · 212 of 640 supporters voted" and the screen
// behind it counts by band and by turf. A voted file from the campaign's
// website comes in through People → Import with a Voted column (1/0 or a
// date): it marks people and never un-marks anyone. A GOTV pass reads
// persons.voted_at to leave voted doors off the walk list.
//
//   sql.js      persons.voted_at; voted_marks (append-only); voted_settings
//   actions.js  vote.mark (anyone, deduped on client_id) · vote.settings (managers)
//   api.js      GET /voted/status (anyone) · /voted/summary (desk) · /voted/persons/:id
//   import.js   the import's Voted column (importRows hook)
//   brief.js    Today's numbers (brief hook), shared with the summary
//
// Live GOTV (scrutineers, the live feed, practice):
//   clock.js     voting days, each place's close, the work window, sending open
//   state.js     settings (kept 5 s), posts, active / practice / scope, votedCol
//   posts.js     gotv.post.set · .end · gotv.signin.code · gotv.practice.clear
//   find.js      a scrutineer's look-up, its limits
//   live.js      the after-commit listener, the hub, notifyGuide, touchVotedFeed
//   turfindex.js who is in each turf, in memory, sliced builds
//   summary.js   the desk's numbers, kept 15 s
//   scope.js     what routes/api.js asks (the row limit, the lock wait)
//   signin.js    GET /go/:token (the confirm page) and the code's session
export { sql } from './sql.js';
import './live.js';
export { actions } from './actions.js';
export { api } from './api.js';
import { importRows } from './import.js';
import { briefVoted } from './brief.js';

export const hooks = { importRows, brief: briefVoted };

// In the full export: every mark (and take-back) and the settings.
// gotv_practice is not exported: it is wiped when practice ends.
export const exportTables = ['voted_marks', 'voted_settings', 'gotv_posts', 'gotv_checks'];
export { publicRoutes } from './signin.js';

// The numbers by band and by turf are the desk's; the switch's state and a
// person's own marks are anyone's.
export const deskOnlyReads = ['/voted/summary', '/gotv/posts', '/gotv/checks'];
