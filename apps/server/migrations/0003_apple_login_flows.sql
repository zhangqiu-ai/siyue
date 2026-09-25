CREATE TABLE siyue.apple_login_flows (
  id uuid PRIMARY KEY,
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 255),
  installation_id text NOT NULL CHECK (length(installation_id) BETWEEN 1 AND 200),
  device_label text CHECK (device_label IS NULL OR length(device_label) <= 100),
  secret_hash text NOT NULL CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  state_hash text NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  nonce_hash text NOT NULL CHECK (nonce_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','exchanging','verified','failed','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  request_hash text CHECK (request_hash IS NULL OR request_hash ~ '^[0-9a-f]{64}$'),
  expected_subject text CHECK (expected_subject IS NULL OR length(expected_subject) BETWEEN 1 AND 255),
  lease_id uuid,
  lease_expires_at timestamptz,
  verified_ciphertext text CHECK (verified_ciphertext IS NULL OR length(verified_ciphertext) BETWEEN 1 AND 32768),
  CHECK (expires_at > created_at),
  CHECK (lease_expires_at IS NULL OR (lease_expires_at > created_at AND lease_expires_at <= expires_at)),
  CHECK (
    (status='pending' AND request_hash IS NULL AND expected_subject IS NULL AND lease_id IS NULL AND lease_expires_at IS NULL AND verified_ciphertext IS NULL)
    OR (status='exchanging' AND request_hash IS NOT NULL AND expected_subject IS NOT NULL AND lease_id IS NOT NULL AND lease_expires_at IS NOT NULL AND verified_ciphertext IS NULL)
    OR (status='verified' AND request_hash IS NOT NULL AND expected_subject IS NOT NULL AND verified_ciphertext IS NOT NULL AND lease_id IS NULL AND lease_expires_at IS NULL)
    OR (status IN ('failed','expired') AND lease_id IS NULL AND lease_expires_at IS NULL AND verified_ciphertext IS NULL)
  )
);
CREATE INDEX apple_login_flows_expires_at ON siyue.apple_login_flows(expires_at);
CREATE INDEX apple_login_flows_exchanging_lease ON siyue.apple_login_flows(lease_expires_at) WHERE status='exchanging';
