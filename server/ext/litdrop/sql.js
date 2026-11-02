// Lit drops: contacts.outcome also takes 'left_lit' — literature left at a
// door, a visit and not a conversation (shared/canvass.js). The core table's
// check is widened here, the way relationships/sql.js widens the channel's.
// Idempotent: run at every boot after the core schema (under test:pg every
// test file boots against the same database) — the old check is dropped
// only while it does not know 'left_lit', and the new one added only while
// none is there.
export const sql = `
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'contacts'::regclass and conname = 'contacts_outcome_check'
             and pg_get_constraintdef(oid) not like '%left_lit%') then
    alter table contacts drop constraint contacts_outcome_check;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'contacts'::regclass and conname = 'contacts_outcome_check') then
    alter table contacts add constraint contacts_outcome_check
      check (outcome in ('contacted', 'no_answer', 'refused', 'moved', 'inaccessible', 'left_lit'));
  end if;
end $$;
`;
