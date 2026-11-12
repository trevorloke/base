// Scheduling a manager can do without a keyboard.
//
// A shift has a kind (shared/shiftkinds.js: Canvass, Burma Shave, Mainstreet
// …) that brings its usual hours and its name, and a place picked by tap — a
// turf, a place used before, or a point on the map the server names. Many
// shifts are made in one write, a week is copied in one, and a repeating
// slot is changed or ended from one of its shifts. Nothing asks how many
// people: a limit is still kept where one is set, and a shift may carry a
// target ("need") that never refuses anyone. Everyone on a week's shifts is
// told with one tap, and — once a manager turns it on — reminded the
// evening before.
//
//   sql.js      places, the shifts' new columns, the settings, the notices
//   rules.js    the campaign's clock, a saved place, a made name — shared
//               with the core's shift.create / shift.update
//   places.js   the "Where" chips, a name for a point on the map, and
//               place.save · place.rename · place.remove
//   many.js     shift.createMany · shift.copyWeek · shift.series.update ·
//               shift.series.cancel — each one transaction
//   hours.js    shift.hours · shift.setHours — a booking's own hours
//               inside its shift ("only part of it")
//   tell.js     shift.tellWeek · shift.reminders, and the two jobs that
//               send: a notice's rows, and the evening before
//   brief.js    Today's short shifts (brief hook)
//   api.js      GET /places · /places/name · /schedule/week ·
//               /schedule/notices/:id (desk)
import { placeActions } from './places.js';
import { manyActions } from './many.js';
import { tellActions } from './tell.js';
import { hoursActions } from './hours.js';
import { briefShortShifts } from './brief.js';

export { sql } from './sql.js';
export { api } from './api.js';
export { jobs } from './tell.js';

export const actions = { ...placeActions, ...manyActions, ...tellActions, ...hoursActions };

export const hooks = { brief: briefShortShifts };

// In the full export: its tables.
export const exportTables = ['places', 'schedule_settings', 'shift_notices'];

// The lists to pick from are the desk's (or a volunteer's granted Shifts).
// A volunteer's own shifts carry their place's words and pin themselves.
export const deskOnlyReads = ['/places', '/places/name', '/schedule/week', '/schedule/notices/:id'];
