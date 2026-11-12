// Phone banks: a named list of numbers to call, each handed to one caller,
// crossed off as the call is logged.
export const sql = `
create table if not exists call_banks (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  script text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  deleted_at timestamptz
);
create index if not exists call_banks_ws_idx on call_banks (workspace_id) where deleted_at is null;

create table if not exists call_bank_numbers (
  bank_id uuid not null references call_banks(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  position int not null default 0,
  assigned_to uuid references users(id) on delete set null,
  assigned_at timestamptz,
  done_at timestamptz,
  done_by uuid references users(id) on delete set null,
  outcome text,
  primary key (bank_id, person_id)
);
create index if not exists call_bank_numbers_assignee_idx on call_bank_numbers (workspace_id, assigned_to) where done_at is null;
-- Call backs: a No answer brings the number back after retry_hours, up to
-- max_tries calls (retry_hours 0: a No answer crosses it off, as before); a
-- caller's "Call back…" sets next_at. A number shows on a caller's list once
-- next_at has passed.
alter table call_banks add column if not exists retry_hours int not null default 4;
alter table call_banks add column if not exists max_tries int not null default 3;
alter table call_bank_numbers add column if not exists tries int not null default 0;
alter table call_bank_numbers add column if not exists next_at timestamptz;
-- A bank made from a list (ext/lists) keeps which one: someone who leaves
-- the list leaves the calls not yet made (numbers.js). No foreign key: the
-- lists table is a later feature's, and a deleted list is only marked so.
alter table call_banks add column if not exists list_id uuid;
-- Call time (ext/candidates): a bank for one candidate to call, every
-- number theirs, with the ask the desk set. No foreign key: candidates is a
-- later feature's table, and a removed candidate is only marked so.
alter table call_banks add column if not exists candidate_id uuid;
alter table call_banks add column if not exists ask_cents int;
`;
