// drive_exports: each "Send to Google Sheets" — the campaign's own record of
// where its data went (in the full export; a Drive address is not a secret,
// Google decides who opens it). Never a token, never Google's raw words:
// said is plain words or one of the codes pick-folder, reconnect.
// drive_links: files opened to anyone with the link (also in the export).
export const sql = `
create table if not exists drive_exports (
  id uuid primary key,
  workspace_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  client_key uuid not null,
  source text not null check (source in ('list','report','dataset')),
  ref text not null,
  name text not null,
  rows int not null,
  cols int not null,
  land text not null check (land in ('mine','campaign')),
  status text not null check (status in ('waiting','sending','done','failed','stopped')),
  done_rows int not null default 0,
  cursor jsonb,
  file_id text,
  url text,
  said text,
  waits int not null default 0,
  retries int not null default 0,
  created_at timestamptz not null default now(),
  touched_at timestamptz not null default now(),
  done_at timestamptz,
  unique (workspace_id, client_key)
);
create index if not exists drive_exports_ws_idx on drive_exports (workspace_id, created_at desc);
create index if not exists drive_exports_file_idx on drive_exports (workspace_id, file_id);

-- drive_links: a file someone opened to "anyone with the link" (a file too
-- big to attach), so it can be made private again. The row holds the Drive
-- id and link; the event never does.
create table if not exists drive_links (
  id uuid primary key,
  workspace_id uuid not null,
  user_id uuid not null references users(id) on delete cascade,
  file_id text not null,
  permission_id text not null,
  name text not null,
  url text not null,
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid references users(id)
);
create index if not exists drive_links_ws_idx on drive_links (workspace_id, created_at desc);
`;
