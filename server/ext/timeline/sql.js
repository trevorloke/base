// One person's rows, found through an index in every table History reads.
// These five tables had none that starts with the person (a profile read
// them by campaign, or by shift or send): added here, each idempotent and
// built once at boot. The others already have theirs (contacts, texts,
// website forms, yes and no to email and texts, memberships, voted marks,
// survey answers, ladders, the event log by what an event is about).
//
// An email to the newsletter's list keeps no person, only the address it
// went to: brecip_ws_email_idx finds those by the person's email.
export const sql = `
create index if not exists gifts_ws_person_idx on gifts (workspace_id, person_id);
create index if not exists signs_ws_person_idx on signs (workspace_id, person_id) where person_id is not null;
create index if not exists sassign_ws_person_idx on shift_assignments (workspace_id, person_id);
create index if not exists brecip_ws_person_idx on blast_recipients (workspace_id, person_id) where person_id is not null;
create index if not exists brecip_ws_email_idx on blast_recipients (workspace_id, lower(email)) where person_id is null;
create index if not exists stripe_payments_person_idx on stripe_payments (workspace_id, person_id) where person_id is not null;
`;
