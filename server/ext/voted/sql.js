// Voted — the election-day mark.
//   persons.voted_at   THE fact every screen reads: when this person was
//                      last marked as having voted (null: not marked, or
//                      marked and then taken back).
//   voted_marks        the append-only history: every mark and un-mark, who
//                      set it and from where (the door, a call, the desk, a
//                      file from the campaign's website). client_id is the
//                      phone's own id for a mark saved with no signal, so a
//                      replay after a lost answer is the same mark.
//   voted_settings     whether Election day is on (the screens offer the
//                      button only then) and the date.
export const sql = `
alter table persons add column if not exists voted_at timestamptz;
create table if not exists voted_marks (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  person_id uuid not null references persons(id) on delete cascade,
  voted boolean not null default true,
  source text not null check (source in ('door','phone','desk','file')),
  marked_by uuid references users(id),
  client_id uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists voted_marks_client_idx on voted_marks (workspace_id, client_id) where client_id is not null;
create index if not exists voted_marks_person_idx on voted_marks (workspace_id, person_id);
create table if not exists voted_settings (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  on_day boolean not null default false,
  election_day date,
  updated_at timestamptz not null default now()
);
-- GOTV mode: the advance-voting days (dates, in the campaign's day) and
-- whether the mode turns itself on for them and for election day.
alter table voted_settings add column if not exists advance_days jsonb not null default '[]';
alter table voted_settings add column if not exists auto boolean not null default true;
`;
