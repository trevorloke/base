// One history per person — a profile's History: everything the campaign and
// the person did with each other, on one list, newest first.
//
//   GET /api/persons/:id/timeline[?group=…][&before=<cursor>][&limit=50]
//     → { entries: [{ id, at, group, kind, label, title, detail, by, link,
//                     day?, rating? }], next, groups }
//
//   at      when it happened (day: true — only the day is known: a gift
//           keyed in later, a membership's last day; `at` is noon that day)
//   group   which chip it is under: field (Doors & calls) · messages ·
//           website · money · shifts · other (a merge: under All only)
//   kind    door · phone · text · in_person · mainstreet (a contact, by its
//           channel) · answers · sign · voted · text_out · text_in · email ·
//           email_open · email_click · email_bounce · email_spam ·
//           email_failed · email_unsure · consent · web · gift · gift_void ·
//           refund · refund_failed · dispute · member · member_end ·
//           shift_booked · shift_came · shift_missed · merge
//   label   what it is, for the chip ("Door", "Email", "Gift") · title: what
//           happened, in the screens' words · detail: a second line (a note,
//           a subject, what they wrote) · by: who on the team did it
//   rating  a contact's rating code (the screen draws its chip)
//   link    where it leads: an app path ("/shifts/<id>", "/inbox/<id>"), or
//           "#gifts" · "#signs" · "#ladders" · "#answers" — that section of
//           the same profile
//   next    the cursor for the page after this one (before=), or null
//   groups  the chips this sign-in has
//
// Read from: contacts (a call an outside dialer logged says which, from
// contacts.source) · texts through the campaign's number · emails sent to
// them with the first open and click (and a bounce or a spam complaint,
// where the email service's columns exist) · a ladder's emails (each run's
// log) · website forms · gifts with their voids and card refunds ·
// memberships · shifts · survey answers · signs · voted marks · yes and no
// to email and texts · a merge. Each through an index on the one person
// (sql.js adds the five that were missing): never a walk over the list.
//
// Who gets what — each source as its own read already has it:
//   anyone who may open the profile   knocks and calls with their notes,
//       signs, shifts and voted marks (GET /persons/:id, /voted/persons/:id;
//       who marked a vote or moved a sign only for the desk)
//   texts   the desk: every thread with them; a volunteer: the threads
//       they started (ext/texting). Not for anyone denied Outreach.
//   the desk only   emails, a ladder's emails, yes and no to email and
//       texts (not for anyone denied Outreach); website forms; survey
//       answers; a merge
//   money roles only, and never one denied Donations   gifts, voids,
//       refunds, memberships, and the website's two money forms
// A volunteer given an area is still a volunteer here (lib/viewer.js).
//
//   sql.js      the indexes
//   sources.js  each source: its read and its words
//   api.js      the route: who may see what, the page, the cursor
export { sql } from './sql.js';
export { api } from './api.js';
