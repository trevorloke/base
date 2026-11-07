-- Monitoring across languages and chat apps: where a message was said, what language it is in, and its translation
-- into the team's language. Translations are derived data (re-creatable), so they live on the row.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS conversation_id text;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS conversation_name text;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS conversation_type text;   -- group | channel | direct
ALTER TABLE activities ADD COLUMN IF NOT EXISTS lang text;                -- ISO 639-1 (or BCP-47 from the platform); null = unknown
ALTER TABLE activities ADD COLUMN IF NOT EXISTS translation text;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS translation_lang text;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS translated_at timestamptz;
CREATE INDEX IF NOT EXISTS activities_ws_lang ON activities(workspace_id, lang, occurred_at);
CREATE INDEX IF NOT EXISTS activities_ws_conv ON activities(workspace_id, conversation_id, occurred_at);
-- The translation queue: items in another language with no translation yet.
CREATE INDEX IF NOT EXISTS activities_untranslated ON activities(workspace_id, ingested_at) WHERE translated_at IS NULL AND lang IS NOT NULL;
