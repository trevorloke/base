// Your shifts in your own Google Calendar. base.win makes one calendar of
// its own in a person's Google account (the narrowest permission there is:
// calendars it made, and only those) and keeps their shifts in it within a
// minute of any change: exactly what their calendar link carries (ext/
// calendar), with no instructions, no online link and nobody else. When it
// stops for any reason it controls, it deletes that calendar first.
// Built on GSI's one Google connection (lib/google/): no route, token or key
// of its own. Off until a manager turns it on.
//
//   sql.js      gcal_links, gcal_items (never exported)
//   google.js   the one mapping to Google's event body; the ids; the address
//   hook.js     whose calendar a write touched (never calls Google)
//   push.js     gcal.push, gcal.sweep
//   stop.js     gcal.stop, and cleanUp (GSI's onRevoke)
//   actions.js  gcal.settings · gcal.on · gcal.stop
//   api.js      GET /api/gcal
import { definePurpose } from '../../lib/google/purposes.js';
import { pushJobs } from './push.js';
import { cleanUp, stopJobs } from './stop.js';
import { events } from './hook.js';

export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
definePurpose('calendar.mine', {
  label: 'Your shifts in Google Calendar',
  scopes: [CALENDAR_SCOPE],
  roles: ['manager', 'treasurer', 'staff', 'volunteer'],
  // The calendar link's own rule applies instead (kept out of Shifts: the
  // voting days still go in), and no sign-in domain limits it.
  area: null,
  ownCard: true,
  onRevoke: cleanUp,
});

export const jobs = { ...pushJobs, ...stopJobs };
export const hooks = { events };
