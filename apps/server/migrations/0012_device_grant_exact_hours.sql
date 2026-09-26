-- Keep the already-applied 0011 checksum stable. `timestamptz + interval '30 days'`
-- uses calendar days in the database session timezone; spring DST can make that
-- limit 719 hours, while the service issues an exact 30 * 24 hour grant.
ALTER TABLE siyue.device_grants DROP CONSTRAINT device_grants_check;
ALTER TABLE siyue.device_grants ADD CONSTRAINT device_grants_lifetime_check
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '720 hours');
