// The voter guide's tables (VG). Voting places are the existing places rows
// (ext/schedule) with kind 'voting'; the guide's own facts about a place sit
// in vote_place_info beside it. Nothing here states a fact: every default
// is empty or "not said yet" (vote_anywhere null), and the guide starts
// "not out" until a manager publishes what the elections office released.
//   vote_guide       one row per campaign: its state, the office's link, the
//                    campaign's own words (rules, ballot note), the checks,
//                    rev (+1 on every guide write: the field's "anything new?")
//   vote_days        the voting days, with opening and closing as 'HH:MM'
//                    (text, so they reach the browser unchanged)
//   vote_place_info  a voting place's days, hours, area, access and
//                    closed_on — the one campaign day it is closed
//   vote_contests    the ballot: each office and its names in ballot order
export const sql = `
alter table places add column if not exists kind text;
create index if not exists places_ws_voting_idx on places (workspace_id) where kind = 'voting' and deleted_at is null;

create table if not exists vote_guide (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  status text not null default 'not_out' check (status in ('not_out','draft','published')),
  title text not null default '',
  official_url text not null default '',
  official_label text not null default '',
  vote_anywhere boolean,
  ballot_note text not null default '',
  rules jsonb not null default '{}',
  mail jsonb not null default '{}',
  ride_phone text not null default '',
  wait_url text not null default '',
  banner boolean not null default true,
  embed_origins jsonb not null default '[]',
  checked jsonb not null default '{}',
  rev int not null default 0,
  published_at timestamptz,
  published_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table if not exists vote_days (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  day date not null,
  kind text not null check (kind in ('advance','general')),
  opens text not null check (opens ~ '^\\d\\d:\\d\\d$'),
  closes text not null check (closes ~ '^\\d\\d:\\d\\d$'),
  check (closes > opens),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists vote_days_ws_day_idx on vote_days (workspace_id, day) where deleted_at is null;

create table if not exists vote_place_info (
  place_id uuid primary key references places(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  city text not null default '',
  pin text check (pin in ('lookup','hand')),
  area text not null default '',
  days jsonb not null default '[]',
  accessible boolean,
  curbside boolean,
  note text not null default '',
  closed_on date,
  closed_note text not null default '',
  external_id text,
  position int not null default 0,
  changed_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index if not exists vote_place_info_ext_idx on vote_place_info (workspace_id, external_id) where external_id is not null;
create index if not exists vote_place_info_ws_idx on vote_place_info (workspace_id, position);

create table if not exists vote_contests (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  office text not null,
  vote_for int not null check (vote_for between 1 and 20),
  names jsonb not null default '[]',
  position int not null default 0,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists vote_contests_ws_idx on vote_contests (workspace_id, position) where deleted_at is null;
`;
