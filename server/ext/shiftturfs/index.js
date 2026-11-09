// Shifts on a turf — a shift can carry the walk lists it is for ("Saturday
// canvass" → Newton block, 72 Ave east), and "Count me in" puts them on the
// volunteer's phone.
//
// Who gets them: a shift's person is an app user when their email is a
// member's login email (lower(email), as MINE_ON_SHIFT in routes/api.js and
// selfPerson in actions/field.js match them). Someone with no sign-in is on
// the shift but not on its turfs; the desk adds them on the map.
//
// What the core emits that this relies on (hooks.js has the full list):
//   shift.assign     create { id, shift_id, person_id } — NO status (the
//                    column defaults to 'assigned')
//   shift.join       create { …, status: 'confirmed', self: true } or
//                    update { status: 'confirmed', self: true }
//   shift.leave      update { status: 'declined' }
//   shift.setStatus  update { status }
//   shift.unassign   deletes the row, then void with payload {} and entityId
//                    = the assignment id (walker rows carry everything else)
//   the sample       create { shift_id, person_id, sample: true }
//
// Leaving, being taken off, declined or no_show take back only what a shift
// gave: a turf given by hand stays, and so does one another of their shifts
// still holds (walkers.js).
//
// The crew board (web/src/pages/ShiftCrew.jsx) narrows that per person:
// placed on one of the shift's turfs, they walk only it; on "No walk list",
// none; not placed (the default), every turf the shift carries — so a
// shift nobody has split works exactly as it always did.
//
//   sql.js      shift_turfs, shift_turf_walkers, shift_crew
//   walkers.js  userForPerson, putOn (honours shift_crew), takeOff, handOver,
//               placeAssignment, unplaceFrom, setJob
//   hooks.js    the events hook (above) and Today's brief (shiftTurfs)
//   actions.js  shift.turfs.set · shift.place (desk)
//   api.js      GET /shiftturfs, /shiftturfs/:shiftId (any role; names and colours)
import { onShiftEvents, briefShiftTurfs } from './hooks.js';

export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';

export const hooks = { events: onShiftEvents, brief: briefShiftTurfs };

// In the full export: its tables.
export const exportTables = ['shift_turfs', 'shift_turf_walkers', 'shift_crew'];

// Volunteers read the turf names of shifts (the Shifts screen, Today).
export const deskOnlyReads = [];
