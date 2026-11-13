// Google Calendar: base.win's own calendar in a person's Google account,
// one per person per campaign. Neither table is exported or on the log as
// rows: the calendar's id is the person's own Google data.
//   gcal_links   the calendar and its state; dirty_at: a push is owed
//                (busy_until: a push holds it; wait_until: Calendar's own
//                quotaExceeded, an hour); said: base.win's words only
//   gcal_items   what was copied to Google: the event id base.win chose, its
//                body's hash and its end (a past shift is never deleted)
export const sql = `
create table if not exists gcal_links (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  calendar_id text,
  cal_hash text,
  state text not null default 'ok' check (state in ('ok','gone','reconnect','stopping','left')),
  said text,
  dirty_at timestamptz,
  busy_until timestamptz,
  wait_until timestamptz,
  last_ok_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists gcal_links_dirty on gcal_links (workspace_id, dirty_at) where dirty_at is not null;
create index if not exists gcal_links_user on gcal_links (user_id);

create table if not exists gcal_items (
  workspace_id uuid not null,
  user_id uuid not null,
  event_id text not null,
  kind text not null check (kind in ('shift','vote','filing')),
  ends_at timestamptz not null,
  hash text not null,
  pushed_at timestamptz not null default now(),
  primary key (workspace_id, user_id, event_id),
  foreign key (workspace_id, user_id) references gcal_links (workspace_id, user_id) on delete cascade
);
`;
