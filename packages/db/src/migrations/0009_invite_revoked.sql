-- A revoked invite is told apart from an expired one.
ALTER TABLE invites ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
