-- The look a workspace chose on the Brand page (SUITE.md, "Look and brand"). One row per workspace; no row means the
-- deployment's default (BASE_AIR_BRAND_* settings, else the Air preset). Every save is also in the ledger
-- (brand.updated), so this table is a derivation that can be rebuilt.
CREATE TABLE IF NOT EXISTS workspace_brand (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id),
  preset text NOT NULL,
  settings jsonb NOT NULL,          -- name, logoUrl, palettes {light, dark}, font, corners, mode (validated by @base-air/look)
  updated_by jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
