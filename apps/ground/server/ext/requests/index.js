// Ask the office: requests from the doors.
//
// A canvasser at a door (the walk list, the map's door card) taps "Ask the
// office" under More, picks what it's about — Call them back · Wants to
// volunteer · Has a question · Something else — and types what they said.
// It goes through the phone's outbox, so it works with no signal and sends
// once. The office works through them on Requests from the doors (Today's
// "Needs you" counts the open ones) and marks each done, with a note.
//
// Kept apart from ladders' follow-ups (staff tasks automations make): these
// are what the field asks for.
//
//   sql.js      the door_requests table
//   actions.js  request.ask (every role) · request.done · request.reopen (desk)
//   api.js      /requests and /requests/count (desk) · /persons/:id/requests
//
// Volunteers read only their own side of it: a person's requests carry the
// kind and when, never what was said, who asked, or what the office did.
export { sql } from './sql.js';
export { actions } from './actions.js';
export { api } from './api.js';

// The kinds in words (mirrored in web/src/components/RequestAsk.jsx).
export const KIND_WORDS = {
  call_back: 'Call them back',
  volunteer: 'Wants to volunteer',
  question: 'Has a question',
  other: 'Something else',
  ride: 'Needs a ride to vote',
};

// In the full export.
export const exportTables = ['door_requests'];

// GET /persons/:id/requests stays open to every role (narrowed in api.js).
export const deskOnlyReads = ['/requests', '/requests/count'];
