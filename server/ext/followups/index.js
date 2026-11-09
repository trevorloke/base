// Speed to lead — every new volunteer, website message and RSVP from someone
// new goes to a named organizer within the same write, with a 24-hour clock
// on their Today.
//
//   Who: route.js — whoever brought them in (the website's referral, "Brought
//     in by"), else a teammate who knows them (My people), else someone on
//     a turf their pin falls in (a captain first), else the managers.
//   What makes one, closes one, moves one: hook.js (the events hook) — a
//     site_action (SITE.md: volunteer, contact, an RSVP from someone new), a
//     "Wants to volunteer" from the door, Mainstreeting or the membership
//     form, the intake API's volunteers and messages; a contact logged
//     closes it; a pin that arrives later hands it to the turf.
//   Where: the follow-ups are ladder_followups rows (ext/ladders sql.js:
//     kind, detail, assigned_to, routed, due_at, contact_*), so the desk's
//     Follow-ups screen, Today's count, a profile and the export already
//     have them. The desk reads them by organizer, with the time to first
//     contact (ext/ladders api.js GET /ladders/followups) and hands one to
//     someone else (ladder.followupAssign).
//   api.js   GET /followups/mine — the signed-in organizer's own (any role).
export { api } from './api.js';
import { onEvents } from './hook.js';

export const hooks = { events: onEvents };
