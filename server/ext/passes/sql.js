// Passes: one row per sweep over every turf. Idempotent: run at every boot
// after the core schema (under test:pg every test file boots against the
// same database).
//
//   canvass_passes   name; kind (what for: persuasion · gotv · lit · id);
//                    who (the universe: all · unrated · undecided · support ·
//                    not_opposed); list_id (a sweep of one List, ext/lists:
//                    only the people on it, as it stands — null for none;
//                    no foreign key, lists are a later feature's table);
//                    tries (1–5 not-homes before a door is
//                    given up); started_at / ended_at. One open pass per
//                    campaign (the partial unique index); pass.start ends
//                    the open one first, in the same transaction.
//   contacts.pass_id the pass a door knock was made in (ext/passes/hooks.js
//                    stamps it as the knock is logged; a knock from before
//                    the pass started, a call or a text is never stamped).
//                    The walk list counts a door's tries and reads its last
//                    outcome in the open pass through this column.
export const sql = `
create table if not exists canvass_passes (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('persuasion', 'gotv', 'lit', 'id')),
  who text not null default 'all' check (who in ('all', 'unrated', 'undecided', 'support', 'not_opposed')),
  tries int not null default 2 check (tries between 1 and 5),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create unique index if not exists canvass_passes_open_idx on canvass_passes (workspace_id) where ended_at is null;
alter table contacts add column if not exists pass_id uuid;
create index if not exists contacts_pass_idx on contacts (workspace_id, pass_id) where pass_id is not null;
alter table canvass_passes add column if not exists list_id uuid;
`;
