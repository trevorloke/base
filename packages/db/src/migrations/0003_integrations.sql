-- Per-variant network options and reply targets; a media library; account-level metrics live in metrics.
ALTER TABLE post_variants ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE post_variants ADD COLUMN IF NOT EXISTS reply_to_external_id text;

CREATE TABLE IF NOT EXISTS media_assets (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  storage_key text NOT NULL UNIQUE,
  url text NOT NULL,
  kind text NOT NULL,
  mime text NOT NULL,
  bytes bigint NOT NULL,
  width integer,
  height integer,
  duration_seconds double precision,
  sha256 text NOT NULL,
  original_name text,
  alt text,
  uploaded_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_assets_ws ON media_assets(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS media_assets_sha ON media_assets(workspace_id, sha256);

-- Webhook deliveries are raw events; this index finds an account by its network id quickly.
CREATE INDEX IF NOT EXISTS social_accounts_net_ext ON social_accounts(network, external_id);

-- Per-start OAuth config (e.g. a Mastodon instance's app credentials), encrypted.
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS config_ciphertext text;
