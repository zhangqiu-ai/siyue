ALTER TABLE siyue.apple_login_flows
 ADD COLUMN completed_at timestamptz,
 ADD COLUMN completed_session_id uuid REFERENCES siyue.auth_sessions(id),
 ADD COLUMN response_ciphertext text CHECK (response_ciphertext IS NULL OR length(response_ciphertext) BETWEEN 1 AND 32768),
 ADD COLUMN response_expires_at timestamptz;
-- Replace only the two original status checks; other bounds remain unchanged.
DO $$ DECLARE item record; BEGIN
 FOR item IN SELECT conname FROM pg_constraint WHERE conrelid='siyue.apple_login_flows'::regclass
  AND contype='c' AND pg_get_constraintdef(oid) LIKE '%status%' LOOP
  EXECUTE format('ALTER TABLE siyue.apple_login_flows DROP CONSTRAINT %I',item.conname);
 END LOOP;
END $$;
ALTER TABLE siyue.apple_login_flows ADD CONSTRAINT apple_login_flow_status CHECK (status IN ('pending','exchanging','verified','completed','failed','expired'));
ALTER TABLE siyue.apple_login_flows ADD CONSTRAINT apple_login_flow_shape CHECK (
 (status='pending' AND request_hash IS NULL AND expected_subject IS NULL AND lease_id IS NULL AND lease_expires_at IS NULL AND verified_ciphertext IS NULL)
 OR (status='exchanging' AND request_hash IS NOT NULL AND expected_subject IS NOT NULL AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL AND verified_ciphertext IS NULL)
 OR (status='verified' AND request_hash IS NOT NULL AND expected_subject IS NOT NULL AND verified_ciphertext IS NOT NULL AND lease_id IS NULL AND lease_expires_at IS NULL)
 OR (status IN ('completed','failed','expired') AND lease_id IS NULL AND lease_expires_at IS NULL AND verified_ciphertext IS NULL)
);
ALTER TABLE siyue.apple_login_flows ADD CONSTRAINT apple_login_completion_shape CHECK (
 (status='completed' AND completed_at IS NOT NULL AND completed_session_id IS NOT NULL AND request_hash IS NOT NULL AND expected_subject IS NOT NULL
  AND ((response_ciphertext IS NULL AND response_expires_at IS NULL) OR
       (response_ciphertext IS NOT NULL AND response_expires_at IS NOT NULL AND response_expires_at>completed_at AND response_expires_at<=completed_at+interval '60 seconds')))
 OR (status<>'completed' AND completed_at IS NULL AND completed_session_id IS NULL AND response_ciphertext IS NULL AND response_expires_at IS NULL)
);
