-- Starsign is now base air. Earlier migrations keep the old names (they are history and already applied); this one
-- moves what the database itself still carries under the old name.

-- The append-only guard: same rule, new name. The triggers are re-pointed in the same transaction, so the logs are
-- never unguarded.
CREATE OR REPLACE FUNCTION base_air_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (base air event store)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS raw_events_append_only ON raw_events;
CREATE TRIGGER raw_events_append_only BEFORE UPDATE OR DELETE ON raw_events
  FOR EACH ROW EXECUTE FUNCTION base_air_append_only();
DROP TRIGGER IF EXISTS ledger_events_append_only ON ledger_events;
CREATE TRIGGER ledger_events_append_only BEFORE UPDATE OR DELETE ON ledger_events
  FOR EACH ROW EXECUTE FUNCTION base_air_append_only();
DROP TRIGGER IF EXISTS link_clicks_append_only ON link_clicks;
CREATE TRIGGER link_clicks_append_only BEFORE UPDATE OR DELETE ON link_clicks
  FOR EACH ROW EXECUTE FUNCTION base_air_append_only();
DROP TRIGGER IF EXISTS conversions_append_only ON conversions;
CREATE TRIGGER conversions_append_only BEFORE UPDATE OR DELETE ON conversions
  FOR EACH ROW EXECUTE FUNCTION base_air_append_only();

DROP FUNCTION IF EXISTS starsign_append_only();

-- Metrics base air computes itself (tracked clicks, conversions) were recorded with source 'starsign'.
-- metrics is a derivation, not an append-only log, so the old rows take the new name and series stay continuous.
UPDATE metrics SET source = 'base-air' WHERE source = 'starsign';
