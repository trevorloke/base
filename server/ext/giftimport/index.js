// Gifts made in another tool, brought in from its spreadsheet (Donations →
// More → Import a file), so the year's contribution limit, the donor tiers,
// next year's lapsed list and the disclosure all see them.
//
// The screen reads the file and the person matches its columns (no tool's
// column names are assumed); the server checks every row again. A check
// comes first — the same decisions, nothing saved. Then, a call at a time:
//
//   whose gift     the donor is found by email, else by first and last name
//                  with the same phone, postal code or street (match.js) —
//                  one sure record, or the gift waits in a pile under
//                  Donations → Needs you for a person to pick the donor,
//                  make a new person, or leave it out (listed at the pile's
//                  foot, to bring back whenever). Nothing lands on a guess.
//   the gift       through the one gift path (lib/gifts.js logGift): the
//                  limit is checked and the gift that crosses it flagged,
//                  as for a gift typed at the desk.
//   quiet          the other tool receipted it: no receipt number is used
//                  here and nothing is emailed (ext/receipts), no ladder
//                  starts (ext/ladders), and it is not in Stewardship's To
//                  thank. Its number and receipt number there are kept as
//                  text, and the screens mark it "Imported".
//   once only      each gift keeps a key (shared/giftfile.js): the other
//                  tool's id, or donor + amount + date + method. The same
//                  file again adds nothing, and says so. A row with the
//                  donor, amount and day of a gift on the books another way
//                  (typed at the desk) is pointed out, and left out if asked.
//   taken back     for a day, an import can be taken back whole: its gifts
//                  are voided through the one void path.
//
//   sql.js      gift_imports · gift_import_rows (the pile) · two indexes on gifts
//   rows.js     one row of the file, checked
//   match.js    whose gift it is
//   actions.js  gift.import · gift.importSettle · gift.importBringBack · gift.importUndo
//   api.js      GET /gifts/imports · /gifts/imports/waiting (money roles);
//               the brief's giftsWaiting (Donations → Needs you)
import { briefWaiting } from './api.js';

export { sql } from './sql.js';
export { actions } from './actions.js';
export { api, deskOnlyReads } from './api.js';
export const hooks = { brief: briefWaiting };

// In the full export: every file brought in, and what waited for a donor.
export const exportTables = ['gift_imports', 'gift_import_rows'];
