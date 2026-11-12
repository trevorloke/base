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
`;
