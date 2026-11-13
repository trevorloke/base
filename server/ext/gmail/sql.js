// Gmail (one email to one person, from a staff member's own Gmail).
//
//   contacts_channel_check   'email' becomes a way someone was reached
//                            (logged by hand, no Google needed). gmail loads
//                            before mainstreet and relationships (ext.js
//                            sorts the folders); each of those only acts
//                            when its own word is missing, and both are in
//                            this list, so the order is safe.
//   gmail_sends              each send, with what it said: campaign
//                            correspondence, exported as blasts are, never
//                            on the event log (a subject can be private).
//                            kind 'test' is a staff member's Send me a test
//                            (to their own address; never in History).
//
// No reference to any google_* table: gmail loads before google, whose
// tables (the grant this send used) are GSI's alone.
export const sql = `
do $$
begin
  if exists (select 1 from pg_constraint where conrelid = 'contacts'::regclass and conname = 'contacts_channel_check'
             and pg_get_constraintdef(oid) not like '%''email''%') then
    alter table contacts drop constraint contacts_channel_check;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'contacts'::regclass and conname = 'contacts_channel_check') then
    alter table contacts add constraint contacts_channel_check
      check (channel in ('door', 'phone', 'text', 'in_person', 'mainstreet', 'email'));
  end if;
end $$;

create table if not exists gmail_sends (
  id uuid primary key,
  workspace_id uuid not null,
  kind text not null default 'person' check (kind in ('person','test')),
  person_id uuid,
  user_id uuid not null references users(id),
  client_key uuid not null,
  to_email text not null,
  from_email text not null,
  subject text not null,
  body text not null,
  status text not null check (status in ('sending','sent','failed','unsure')),
  gmail_id text,
  said text,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  unique (workspace_id, client_key),
  check ((kind = 'person') = (person_id is not null))
);
create index if not exists gmail_sends_person_idx on gmail_sends (workspace_id, person_id, created_at desc);
create index if not exists gmail_sends_user_idx on gmail_sends (user_id, created_at desc);
`;
