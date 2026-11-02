// Requests from the doors: "she wants to volunteer", "call them back after
// 6" — one row per thing a canvasser asked the office to do about a person.
// Idempotent; run at boot after the core schema.
//
//   door_requests   who it's about, what kind, what they said (note), who
//                   asked and when; done_at / done_by / done_note once the
//                   office has dealt with it. client_id is the phone's
//                   outbox key, so a replay is the same request, never two.
export const sql = `
create table if not exists door_requests (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  kind text not null check (kind in ('call_back','volunteer','question','other')),
  note text,
  asked_by uuid references users(id),
  created_at timestamptz not null default now(),
  done_at timestamptz,
  done_by uuid references users(id),
  done_note text,
  client_id uuid
);
create unique index if not exists door_requests_client_idx on door_requests (workspace_id, client_id) where client_id is not null;
create index if not exists door_requests_open_idx on door_requests (workspace_id, created_at) where done_at is null;
create index if not exists door_requests_person_idx on door_requests (workspace_id, person_id);
`;
