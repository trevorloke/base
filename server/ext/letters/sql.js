// Letters to the editor and op-eds: a volunteer's own writing, worked on with
// the campaign, sent by the writer from their own email. Idempotent; run at
// boot after the core schema.
//
//   letters          one piece of writing: its kind, who wrote it, where they'd
//                    like it (outlet_ids, ≤3, in their order), where it stands,
//                    the agreed draft, and the sign-off fields the writer
//                    changed for this letter only (null: read from their
//                    person record when served — nothing copied).
//   letter_versions  its drafts, both sides. The writer's text is their
//                    newest draft; a campaign draft is a suggestion.
//   letter_notes     the notes back and forth
//   letter_sends     each time it went to a paper, and what came of it
//
// writer_user is null only on the sample's letter (no one signed in wrote
// it). letter_sends.outlet_id names a media_outlets row with no foreign key:
// features load in name order, so ext/media's table is made after this one,
// and an outlet is only ever soft-deleted. client_id is the phone's outbox
// key: a replay is the same row, never two.
export const sql = `
create table if not exists letters (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('letter','op_ed')),
  writer_user uuid references users(id),
  person_id uuid references persons(id) on delete set null,
  title text check (title is null or length(title) <= 200),
  status text not null default 'new' check (status in ('new','working','ready','sent','published','declined','withdrawn')),
  outlet_ids jsonb not null default '[]'::jsonb,
  sign_name text check (sign_name is null or length(sign_name) <= 120),
  sign_city text check (sign_city is null or length(sign_city) <= 80),
  sign_address text check (sign_address is null or length(sign_address) <= 300),
  sign_phone text check (sign_phone is null or length(sign_phone) <= 40),
  disclose_line boolean not null default false,
  agreed_version uuid,
  agreed_hash text,
  agreed_at timestamptz,
  agreed_campaign_share real check (agreed_campaign_share is null or agreed_campaign_share between 0 and 1),
  assigned_to uuid references users(id),
  declined_note text check (declined_note is null or length(declined_note) <= 500),
  email_me boolean not null default true,
  writer_seen_at timestamptz,
  desk_seen_at timestamptz,
  last_side text check (last_side is null or last_side in ('writer','campaign')),
  last_at timestamptz,
  emailed_at timestamptz,
  closed_at timestamptz,
  client_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Papers the writer picked that were dropped when the letter landed or was
-- re-picked (gone, or not taking this kind): named on the letter until the
-- writer picks again, however it's opened.
alter table letters add column if not exists dropped_ids jsonb not null default '[]'::jsonb;
create unique index if not exists letters_client_idx on letters (workspace_id, client_id) where client_id is not null;
create index if not exists letters_status_idx on letters (workspace_id, status, last_at);
create index if not exists letters_writer_idx on letters (workspace_id, writer_user);

create table if not exists letter_versions (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  letter_id uuid not null references letters(id) on delete cascade,
  n int not null,
  side text not null check (side in ('writer','campaign')),
  by_user uuid references users(id),
  body text not null check (length(body) between 1 and 20000),
  from_version uuid,
  client_id uuid,
  created_at timestamptz not null default now(),
  unique (letter_id, n)
);
create unique index if not exists letter_versions_client_idx on letter_versions (workspace_id, client_id) where client_id is not null;

create table if not exists letter_notes (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  letter_id uuid not null references letters(id) on delete cascade,
  side text not null check (side in ('writer','campaign')),
  by_user uuid references users(id),
  body text not null check (length(body) between 1 and 2000),
  client_id uuid,
  created_at timestamptz not null default now()
);
create unique index if not exists letter_notes_client_idx on letter_notes (workspace_id, client_id) where client_id is not null;
create index if not exists letter_notes_letter_idx on letter_notes (letter_id, created_at);

create table if not exists letter_sends (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  letter_id uuid not null references letters(id) on delete cascade,
  outlet_id uuid,
  how text not null check (how in ('email','form','told_desk')),
  by_user uuid references users(id),
  sent_at timestamptz not null default now(),
  while_out_at uuid references letter_sends(id) on delete set null,
  outcome text check (outcome is null or outcome in ('published','not_published')),
  url text check (url is null or length(url) <= 500),
  published_on date,
  outcome_by uuid references users(id),
  outcome_at timestamptz,
  client_id uuid
);
create unique index if not exists letter_sends_client_idx on letter_sends (workspace_id, client_id) where client_id is not null;
create index if not exists letter_sends_letter_idx on letter_sends (letter_id, sent_at);
`;
