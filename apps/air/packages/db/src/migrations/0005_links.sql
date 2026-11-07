-- Owned measurement: every link Starsign publishes goes through a short link it controls, so clicks and
-- conversions are first-party data that no network API change can take away.
CREATE TABLE IF NOT EXISTS tracked_links (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  slug text NOT NULL UNIQUE,
  destination text NOT NULL,                 -- the URL as the author wrote it
  target text NOT NULL,                      -- destination plus UTM tags: where the redirect goes
  post_id text REFERENCES posts(id),
  variant_id text REFERENCES post_variants(id),
  network text,
  placement text NOT NULL DEFAULT 'text',    -- text | thread | link | first_comment | manual
  utm jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz
);
CREATE INDEX IF NOT EXISTS tracked_links_ws ON tracked_links(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS tracked_links_variant ON tracked_links(variant_id);
-- A publish retry reuses the same short link instead of minting a new one.
CREATE UNIQUE INDEX IF NOT EXISTS tracked_links_variant_dest ON tracked_links(variant_id, placement, destination) WHERE variant_id IS NOT NULL;

-- One row per redirect. No raw IP is stored: visitor_hash is sha256(daily salt, ip, user agent), so unique
-- visitors can be counted within a day without keeping anything that identifies a person.
CREATE TABLE IF NOT EXISTS link_clicks (
  id text PRIMARY KEY,                       -- also the click id handed to the destination as ssclid
  link_id text NOT NULL REFERENCES tracked_links(id),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  variant_id text,
  network text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  visitor_hash text NOT NULL,
  is_bot boolean NOT NULL DEFAULT false,     -- link-preview crawlers and other bots: redirected, never counted
  device text,                               -- mobile | desktop | bot | unknown
  referrer_host text,
  country text
);
CREATE INDEX IF NOT EXISTS link_clicks_link ON link_clicks(link_id, occurred_at);
CREATE INDEX IF NOT EXISTS link_clicks_ws ON link_clicks(workspace_id, occurred_at);
DROP TRIGGER IF EXISTS link_clicks_append_only ON link_clicks;
CREATE TRIGGER link_clicks_append_only BEFORE UPDATE OR DELETE ON link_clicks
  FOR EACH ROW EXECUTE FUNCTION starsign_append_only();

-- Downstream outcomes reported by the customer's site or backend. Attributed through the click id when present.
CREATE TABLE IF NOT EXISTS conversions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  click_id text REFERENCES link_clicks(id),
  link_id text REFERENCES tracked_links(id),
  variant_id text,
  network text,
  name text NOT NULL,
  value double precision,
  currency text,
  external_id text,                          -- the reporter's own id; makes reporting idempotent
  source text NOT NULL,                      -- api | browser
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversions_ws ON conversions(workspace_id, occurred_at);
CREATE INDEX IF NOT EXISTS conversions_variant ON conversions(variant_id);
CREATE UNIQUE INDEX IF NOT EXISTS conversions_external ON conversions(workspace_id, external_id) WHERE external_id IS NOT NULL;
-- From a browser, one conversion of each name per click: a leaked click id cannot be replayed into a total.
CREATE UNIQUE INDEX IF NOT EXISTS conversions_browser_once ON conversions(click_id, name) WHERE source = 'browser';
DROP TRIGGER IF EXISTS conversions_append_only ON conversions;
CREATE TRIGGER conversions_append_only BEFORE UPDATE OR DELETE ON conversions
  FOR EACH ROW EXECUTE FUNCTION starsign_append_only();
