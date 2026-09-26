ALTER TABLE siyue.security_events ADD COLUMN redacted_metadata jsonb;
ALTER TABLE siyue.security_events ADD CONSTRAINT security_event_metadata_object
  CHECK (redacted_metadata IS NULL OR jsonb_typeof(redacted_metadata) = 'object');
