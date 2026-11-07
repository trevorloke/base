// Passes — sweep every turf again, and come back to not-home doors.
//
// Without a pass a door is done the moment anyone there was ever knocked: a
// turf walked once is finished forever, a "No answer" counts as done, and
// every located person in the polygon is on the list. A PASS is a campaign-
// wide sweep with a purpose (Persuasion · Get out the vote · Lit drop ·
// Find out who's who), a universe (All doors · Not rated yet · Undecided or
// not rated · Yes (1–2) · Everyone but opposed) and a try rule (1–5
// not-homes before a door is given up). While one is open, "doors left" on
// every turf means doors in the universe not yet finished IN THIS PASS: a
// "No answer" keeps the door on the list ("Try again · 1 of 2") until the
// tries run out; a talk (or refused / moved / no access) finishes it; a lit
// drop finishes a door on any visit. One open pass per campaign; starting a
// new one ends the old one. With no pass open, the lists work exactly as
// they always did.
//
// The rule lives in shared/passes.js (doorState · inUniverse · inPass) and
// runs on the server and on the phone's overlay of knocks still in its
// outbox. routes/api.js reads openPass() from rule.js once per walk-list or
// turf read, and loadLocated carries each person's pass_tries and
// pass_last_outcome (this pass's door contacts, by contacts.pass_id).
//
//   sql.js      canvass_passes; contacts.pass_id
//   rule.js     openPass(q, ws) and the shared rule
//   actions.js  pass.start · pass.end · pass.update (desk roles)
//   hooks.js    contactLogged stamps a door knock with the open pass;
//               brief carries the open pass to Today (kept offline)
//   api.js      GET /passes (any role: the open pass; past passes for the desk)
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';
import { stampPass, briefPass } from './hooks.js';

export const hooks = { contactLogged: stampPass, brief: briefPass };

// In the full export: every pass (contacts.pass_id rides along in the core
// contacts export).
export const exportTables = ['canvass_passes'];

// GET /passes is for every role; past passes are stripped for volunteers in
// the handler itself.
export const deskOnlyReads = [];
