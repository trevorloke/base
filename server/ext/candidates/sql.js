// A candidate's seat: who they are on the slate, and (once they sign in) the
// volunteer account that sits in it. One seat per account per campaign.
export const sql = `
create table if not exists candidates (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  office text,
  race text,
  email text,
  user_id uuid references users(id) on delete set null,
  position int not null default 0,
  created_at timestamptz default now(),
  removed_at timestamptz
);
create unique index if not exists candidates_user_idx on candidates (workspace_id, user_id)
  where user_id is not null and removed_at is null;
create index if not exists candidates_ws_idx on candidates (workspace_id) where removed_at is null;
alter table invites add column if not exists candidate_id uuid;

-- Call time: each answer a candidate logs (calltime.js). A pledge is what a
-- donor said, never a gift: the treasurer sees it until a gift comes in, it
-- is dropped, or 60 days pass. The note is read by Donations (the pledge
-- list) and Data (the export) only — never put on the event log.
create table if not exists calltime_results (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  bank_id uuid not null,
  person_id uuid not null references persons(id) on delete cascade,
  candidate_id uuid not null,
  result text not null check (result in ('pledged', 'no', 'no_answer', 'left_message')),
  amount_cents int,
  slate text not null,
  said_on date not null,
  note text,
  client_id uuid,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  dropped_at timestamptz,
  dropped_by uuid references users(id) on delete set null
);
create unique index if not exists calltime_results_client_idx on calltime_results (workspace_id, client_id) where client_id is not null;
create index if not exists calltime_results_bank_idx on calltime_results (bank_id, created_by);
create index if not exists calltime_results_open_idx on calltime_results (workspace_id, person_id)
  where result = 'pledged' and dropped_at is null;
`;
