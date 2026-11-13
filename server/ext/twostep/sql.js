// Two-step sign-in (lib/twostep.js). Sign-in secrets: never in the export
// or the event log.
//   two_step          one row per account with it on, or being set up:
//                     the authenticator key, sealed; when it was turned on
//                     (null while setting up); the unused recovery codes'
//                     hashes and their salt; the last code's time step (a
//                     code works once); wrong codes in a row (fails) and,
//                     past LOCK_AFTER of them, when the app's codes locked
//   two_step_pending  a sign-in whose password was right, waiting for the
//                     code: the ticket's hash, wrong tries, ten minutes
//   app_secrets       base.win's own keys, when the environment gives none
//                     (the two-step key: STARBASE_TWO_STEP_KEY, else here)
export const sql = `
create table if not exists two_step (
  user_id uuid primary key references users(id) on delete cascade,
  secret text,
  on_since timestamptz,
  recovery jsonb not null default '[]',
  recovery_salt text,
  last_step bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists two_step_pending (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  tries int not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists two_step_pending_user_idx on two_step_pending (user_id);
-- How the sign-in got this far: 'password', or 'google' (ext/google) — the
-- code step then notes the Google sign-in as used.
alter table two_step_pending add column if not exists via text not null default 'password';
alter table two_step add column if not exists fails int not null default 0;
alter table two_step add column if not exists locked_at timestamptz;

create table if not exists app_secrets (
  name text primary key,
  value text not null,
  created_at timestamptz not null default now()
);
`;
