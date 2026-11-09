// Volunteers: the roster, the crew board's reads, and one-step booking.
//
// Shifts → Volunteers (web/src/pages/Volunteers.jsx) lists everyone who
// volunteers — roles, shifts done, no-shows, the next shift, last active,
// asked to volunteer — filtered New · Active · Lapsed and by role, with
// call, text and "Put on a shift" on each. A shift's crew board
// (web/src/pages/ShiftCrew.jsx) drags people from a tray of volunteers (free
// or busy then) onto the shift and its turfs.
//
//   sql.js      an index for the "volunteer" tag
//   data.js     loadVolunteers: who they are and how each is doing
//   api.js      GET /volunteers · GET /crew/:shiftId (desk)
//   actions.js  shift.add (desk): book, place, and close "Wants to volunteer"
//
// Where someone walks on a shift (placed on a turf, no walk list, or every
// turf) and their job (team lead, driver) live with the shift's turfs:
// ext/shiftturfs (shift_crew, shift.place).
export { sql } from './sql.js';
export { api } from './api.js';
export { actions } from './actions.js';

// Contact details and how each volunteer is doing: the desk's (or a
// volunteer a manager granted Shifts, who sees no phone or email).
export const deskOnlyReads = ['/volunteers', '/crew/:shiftId'];
