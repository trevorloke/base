-- People sign in with email + password. Sessions, invites and password resets store only sha256 hashes of their tokens.
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,                                  -- sha256(token); the token lives only in the cookie
  user_id text NOT NULL REFERENCES users(id),
  current_workspace_id text REFERENCES workspaces(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,                      -- sliding: pushed out 30 days on use
  revoked_at timestamptz,
  user_agent text,
  ip text
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id, last_seen_at);

CREATE TABLE IF NOT EXISTS invites (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  email text NOT NULL,
  role text NOT NULL,
  invited_by text NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invites_ws ON invites(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS password_resets (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id);
