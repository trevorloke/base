// Where a move is kept. Idempotent; run at boot after the core schema.
//
//   persons.address_status  null (an address, or none ever known), or
//                     'unknown': moved, and nobody knows where. 'review' and
//                     'deceased' are held for Passed away (not built yet).
//                     Nullable with no default: adding it rewrites no rows,
//                     and the check is added NOT VALID so nothing is scanned
//                     under a lock (the actions are its only writers).
//   person_moves      one per "they moved": where from (every address part,
//                     the pin, the status before, the door fields taken off,
//                     and from_key — the importer's name + old address key,
//                     lib/matchkeys.js, so the next voters list finds them by
//                     their old address), where to (as settled), the Moved
//                     knock it follows, the phone's own id, and its Undo.
//   contacts_moved_idx       the team's own Moved knocks only (an imported
//                     list's history has source 'import'): "Needs an
//                     address" starts from it, so it costs the knocks, not
//                     the voters list.
export const sql = `
alter table persons add column if not exists address_status text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'persons_address_status_check') then
    alter table persons add constraint persons_address_status_check
      check (address_status in ('unknown', 'review', 'deceased')) not valid;
  end if;
end $$;
create index if not exists persons_address_status_idx on persons (workspace_id, address_status) where address_status is not null;
create index if not exists contacts_moved_idx on contacts (workspace_id, person_id, created_at) where outcome = 'moved' and source is null;

create table if not exists person_moves (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  reason text not null check (reason in ('moved', 'wrong_address', 'deceased')),
  result text not null check (result in ('new', 'unknown', 'review', 'deceased')),
  from_address text, from_house_number text, from_unit text, from_city text, from_postal text,
  from_lat double precision, from_lng double precision,
  from_status text,
  from_key text,
  from_door jsonb not null default '[]',
  to_address text, to_house_number text, to_unit text, to_city text, to_postal text,
  contact_id uuid references contacts(id) on delete set null,
  client_id uuid,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references users(id)
);
create unique index if not exists person_moves_client_idx on person_moves (workspace_id, client_id) where client_id is not null;
create index if not exists person_moves_person_idx on person_moves (workspace_id, person_id, created_at desc);
create index if not exists person_moves_key_idx on person_moves (workspace_id, from_key) where from_key is not null and undone_at is null;
`;
