// Find people I know: a desk member's exported contacts file, matched
// against the list in the browser's slices — only the people already on the
// list come back, and only the ones they tick join their My people. Nothing
// from the file is kept, logged or put on the event log; nobody is added.
// (The file is read in the browser: shared/contactsfile.js.)
//
//   api.js      POST /api/addressbook/check   matches only
//   actions.js  addressbook.link               links the ticked people
export { api } from './api.js';
export { actions } from './actions.js';
