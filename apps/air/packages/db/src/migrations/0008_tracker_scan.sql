-- Public search for tracked names: on by default, with the last scan time per search source.
ALTER TABLE tracked_entities ADD COLUMN IF NOT EXISTS scan_public boolean NOT NULL DEFAULT true;
ALTER TABLE tracked_entities ADD COLUMN IF NOT EXISTS scan_state jsonb NOT NULL DEFAULT '{}'::jsonb;
