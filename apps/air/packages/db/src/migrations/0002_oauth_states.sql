-- Pending OAuth authorizations (PKCE). Short-lived; the verifier is encrypted with the master key.
CREATE TABLE IF NOT EXISTS oauth_states (
  state text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  connector text NOT NULL,
  network text NOT NULL,
  verifier_ciphertext text NOT NULL,
  redirect_uri text NOT NULL,
  actor jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS oauth_states_expires ON oauth_states(expires_at);
