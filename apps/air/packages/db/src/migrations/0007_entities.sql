-- The tracker: named organisations (parties, brands, companies) and people (candidates, spokespeople, creators,
-- individual brands), with every way they are written, and every message that mentions them or that they wrote.
CREATE TABLE IF NOT EXISTS tracked_entities (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  kind text NOT NULL,                         -- organization | person
  name text NOT NULL,
  role text,                                  -- party, brand, candidate, spokesperson, creator, ... (free text)
  parent_id text REFERENCES tracked_entities(id),   -- a candidate's party, an individual's brand
  relation text NOT NULL DEFAULT 'watch',     -- own | client | prospect | competitor | opponent | watch
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb,  -- other spellings, scripts and languages, nicknames, abbreviations
  handles jsonb NOT NULL DEFAULT '{}'::jsonb,  -- network -> handles
  context jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ambiguous names count only near one of these words
  exclude jsonb NOT NULL DEFAULT '[]'::jsonb,  -- never count a match when one of these appears
  wikipedia jsonb NOT NULL DEFAULT '[]'::jsonb,
  trend_topic_id text,
  notes text,
  created_by jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX IF NOT EXISTS tracked_entities_ws ON tracked_entities(workspace_id, archived_at);
CREATE INDEX IF NOT EXISTS tracked_entities_parent ON tracked_entities(parent_id);

CREATE TABLE IF NOT EXISTS entity_mentions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  entity_id text NOT NULL REFERENCES tracked_entities(id),
  activity_id text NOT NULL REFERENCES activities(id),
  how text NOT NULL,                          -- name | handle | author
  term text,                                  -- what matched
  network text NOT NULL,
  lang text,
  author_handle text,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS entity_mentions_once ON entity_mentions(entity_id, activity_id);
CREATE INDEX IF NOT EXISTS entity_mentions_entity_time ON entity_mentions(entity_id, occurred_at);
CREATE INDEX IF NOT EXISTS entity_mentions_ws_time ON entity_mentions(workspace_id, occurred_at);
