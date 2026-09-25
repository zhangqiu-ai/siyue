CREATE TABLE siyue.subjects (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('adult','child')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked','deletion_pending','deleted')),
  display_name text NOT NULL DEFAULT '',
  locale text NOT NULL DEFAULT 'zh-CN' CHECK (locale IN ('zh-CN','en-US')),
  credential_version integer NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE siyue.auth_sessions (
  id uuid PRIMARY KEY,
  subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  installation_id text NOT NULL CHECK (length(installation_id) BETWEEN 1 AND 200),
  auth_method text NOT NULL CHECK (auth_method IN ('email','apple','child')),
  credential_version integer NOT NULL CHECK (credential_version > 0),
  authenticated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  grant_expires_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  CHECK (idle_expires_at <= absolute_expires_at)
);
CREATE INDEX auth_sessions_subject ON siyue.auth_sessions(subject_id);
CREATE TABLE siyue.refresh_tokens (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES siyue.auth_sessions(id),
  secret_hash text NOT NULL CHECK (length(secret_hash) = 64),
  issued_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  replaced_by uuid UNIQUE REFERENCES siyue.refresh_tokens(id),
  rotation_request_hash text,
  retry_ciphertext text,
  retry_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX refresh_tokens_session ON siyue.refresh_tokens(session_id);
CREATE INDEX refresh_tokens_retry_expiry ON siyue.refresh_tokens(retry_expires_at) WHERE retry_ciphertext IS NOT NULL;
CREATE TABLE siyue.reauth_grants (
  id uuid PRIMARY KEY,
  subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  session_id uuid NOT NULL REFERENCES siyue.auth_sessions(id),
  action text NOT NULL CHECK (action IN ('link-identity','unlink-identity','change-email','change-password','revoke-session','revoke-all-sessions','delete-account','approve-child-device')),
  credential_version integer NOT NULL,
  secret_hash text NOT NULL CHECK (length(secret_hash) = 64),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz
);
CREATE INDEX reauth_grants_session ON siyue.reauth_grants(session_id);
