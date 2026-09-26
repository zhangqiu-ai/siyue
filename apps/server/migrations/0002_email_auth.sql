CREATE TABLE siyue.account_emails (
  id uuid PRIMARY KEY,
  subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  email_original text NOT NULL CHECK (length(email_original) <= 254),
  email_normalized text NOT NULL UNIQUE CHECK (email_normalized = lower(email_normalized) AND length(email_normalized) <= 254),
  verified_at timestamptz NOT NULL,
  login_enabled boolean NOT NULL DEFAULT true,
  is_primary boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX account_emails_primary ON siyue.account_emails(subject_id) WHERE is_primary;
CREATE TABLE siyue.password_credentials (
  subject_id uuid PRIMARY KEY REFERENCES siyue.subjects(id),
  password_hash text NOT NULL,
  hash_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE siyue.auth_sessions ADD COLUMN platform text CHECK (platform IN ('ios','android','desktop'));
ALTER TABLE siyue.auth_sessions ADD COLUMN device_label text CHECK (length(device_label) <= 100);
CREATE TABLE siyue.email_challenges (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('register','password-reset','link-email','change-email')),
  email_original text NOT NULL,
  email_normalized text NOT NULL,
  locale text NOT NULL CHECK (locale IN ('zh-CN','en-US')),
  subject_id uuid REFERENCES siyue.subjects(id),
  initiating_session_id uuid REFERENCES siyue.auth_sessions(id),
  credential_version integer,
  code_mac text NOT NULL,
  request_secret_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','superseded','expired','locked')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_challenges_lookup ON siyue.email_challenges(email_normalized,purpose,created_at);
CREATE UNIQUE INDEX email_challenges_one_pending ON siyue.email_challenges(email_normalized,purpose) WHERE status='pending';
CREATE TABLE siyue.idempotency_records (
  scope text NOT NULL,
  key_hash text NOT NULL,
  request_mac text NOT NULL,
  subject_id uuid REFERENCES siyue.subjects(id),
  resource_id uuid,
  status text NOT NULL CHECK (status IN ('pending','complete')),
  response_ciphertext text,
  response_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(scope,key_hash)
);
CREATE TABLE siyue.rate_limit_buckets (
  bucket_key_hash text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(bucket_key_hash,window_start)
);
CREATE TABLE siyue.outbox_jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('verification-email','security-notice')),
  aggregate_id uuid,
  payload_ciphertext text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','uncertain','expired','cancelled')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL,
  lease_until timestamptz,
  lease_id uuid,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  last_error_code text
);
CREATE INDEX outbox_jobs_available ON siyue.outbox_jobs(available_at) WHERE status='pending';
CREATE TABLE siyue.security_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  subject_id uuid REFERENCES siyue.subjects(id),
  session_id uuid,
  request_id text NOT NULL,
  outcome text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE TABLE siyue.account_consents (
  subject_id uuid PRIMARY KEY REFERENCES siyue.subjects(id),
  terms_version text NOT NULL,
  privacy_version text NOT NULL,
  accepted_at timestamptz NOT NULL
);
