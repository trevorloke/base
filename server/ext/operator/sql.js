// base.win support (the control centre's way in; see index.js).
//   platform_identity  this server's instance id: made once, never changed,
//                      shown in health. Not a secret. A token names it, so
//                      one meant for another server (or this one before its
//                      database was made again) is refused.
//   operator_entries   each token used (its nonce: a token works once),
//                      kept 8 days for Today's line.
//   operator_links     the account the control centre's operator is here.
//   users.support      an account an entry made: no password, so no sign-in
//                      by password, Google or a reset link.
//   sessions.entry     a sign-in an entry made: its nonce and the key that
//                      opened it (lib/auth.js loadContext ends it when the
//                      switch goes off or the key is no longer held).
// Only token hashes elsewhere; nothing here is exported.
// The instance: 16 random bytes as 22 base64url characters, made by the
// database itself so each database gets its own (not a secret: unique is
// all it needs to be). Only the first ever stored counts.
const FRESH = `translate(rtrim(encode(decode(md5(random()::text || clock_timestamp()::text), 'hex'), 'base64'), '='), '+/', '-_')`;

export const sql = `
create table if not exists platform_identity (
  id int primary key check (id = 1),
  instance text not null,
  created_at timestamptz not null default now()
);
insert into platform_identity (id, instance) values (1, ${FRESH}) on conflict (id) do nothing;

create table if not exists operator_entries (
  nonce text primary key,
  operator_id text not null,
  kid text not null,
  workspace_id uuid references workspaces(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  iat timestamptz not null,
  exp timestamptz not null,
  used_at timestamptz not null default now()
);
create index if not exists operator_entries_used_idx on operator_entries (used_at);
create index if not exists operator_entries_ws_idx on operator_entries (workspace_id, used_at desc);

create table if not exists operator_links (
  operator_id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table users add column if not exists support boolean not null default false;
alter table sessions add column if not exists entry text;
alter table sessions add column if not exists entry_kid text;
`;
