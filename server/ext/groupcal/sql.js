// The group calendar's own items: what a manager puts on the campaign's
// calendar and who sees it. A timed item keeps its moments (starts_at,
// ends_at — typed on the campaign's clock); an all-day item keeps its days
// (first_day, last_day, the last one included). Removing one sets
// removed_at, so the log and a backup keep what it was.
//   who  everyone · candidates (every candidate) · candidate (one seat:
//        candidate_id) · managers · team (team_id)
// Additive only: a new table and its index, made if missing.
export const sql = `
create table if not exists calendar_items (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  title text not null,
  all_day boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  first_day date,
  last_day date,
  place text,
  details text,
  who text not null default 'everyone' check (who in ('everyone', 'candidates', 'candidate', 'managers', 'team')),
  team_id uuid,
  candidate_id uuid,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  removed_at timestamptz
);
create index if not exists calendar_items_ws_idx on calendar_items (workspace_id) where removed_at is null;
`;
