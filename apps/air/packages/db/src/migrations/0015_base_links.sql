-- Signing in with Base by link, not by email (SUITE.md, "The hand-off", step 6). A Base Ground manager can make a
-- ground login for any email address, so the email Base Ground sends is never enough on its own: the first time,
-- the person proves the Base Air account is theirs with its own password, and from then on (client, sub) points at it.
CREATE TABLE IF NOT EXISTS base_links (
  id text PRIMARY KEY,
  client text NOT NULL,                 -- the client's slug, as Base Ground's answer names it
  sub text NOT NULL,                    -- Base Ground's stable, opaque id for the person
  user_id text NOT NULL REFERENCES users(id),
  ground_email text,                    -- what Base Ground called them when the link was made (for owners; never matched on)
  linked_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS base_links_client_sub ON base_links(client, sub);
CREATE UNIQUE INDEX IF NOT EXISTS base_links_user ON base_links(user_id);

-- A verified hand-off waiting for the account's password. Short-lived and single use; the token lives only in an
-- HttpOnly cookie and only its sha256 is stored here, so the identity never travels in a URL.
CREATE TABLE IF NOT EXISTS base_link_pending (
  id text PRIMARY KEY,                  -- sha256(token)
  client text NOT NULL,
  sub text NOT NULL,
  ground_email text NOT NULL,
  user_id text NOT NULL REFERENCES users(id),
  next text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS base_link_pending_expires ON base_link_pending(expires_at);
