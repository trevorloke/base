// A person's calendar link: one live link per person per campaign, which
// their calendar app checks for their shifts. "Make a new link" stops the
// live one (stopped_at) and makes another; a stopped link answers an empty
// calendar so the app clears what it had.
//
// The token is kept as it is, not hashed: the person needs the link again
// on another device (Copy link on their phone after making it on a
// computer), and there is no server-wide secret to derive it from. So a
// backup carries live links; "Make a new link" is the remedy (README). The
// export leaves the token out (index.js exportTables).
export const sql = `
create table if not exists calendar_feeds (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now(),
  stopped_at timestamptz
);
create unique index if not exists calendar_feeds_live on calendar_feeds (workspace_id, user_id) where stopped_at is null;
`;
