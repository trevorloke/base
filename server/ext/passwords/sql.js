// Forgot password (reset.js): one-time links to choose a new password.
//   password_resets   only the token's SHA-256 is kept; made_by is the
//                     manager who made the link (null: asked for by email).
//                     Never exported, never on the log (the reset itself is).
//   users.support     an account with no password (base.win support,
//                     ext/operator): never sent a link and never given one.
//                     Added here too so a reset can always ask about it;
//                     the same statement in ext/operator does nothing.
export const sql = `
create table if not exists password_resets (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  made_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create index if not exists password_resets_user_idx on password_resets (user_id);
alter table users add column if not exists support boolean not null default false;
`;
