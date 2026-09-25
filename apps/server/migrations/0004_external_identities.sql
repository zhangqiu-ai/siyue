CREATE TABLE siyue.external_identities (
  id uuid PRIMARY KEY,
  subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  provider text NOT NULL CHECK (provider='apple'),
  provider_namespace text NOT NULL CHECK (length(provider_namespace) BETWEEN 1 AND 255),
  provider_subject text NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 255),
  client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 255),
  issuer text NOT NULL CHECK (issuer='https://appleid.apple.com'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','unlinked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,provider_namespace,provider_subject)
);
CREATE INDEX external_identities_subject ON siyue.external_identities(subject_id);
CREATE TABLE siyue.apple_provider_credentials (
  identity_id uuid PRIMARY KEY REFERENCES siyue.external_identities(id),
  refresh_ciphertext text NOT NULL CHECK (length(refresh_ciphertext) BETWEEN 1 AND 32768),
  updated_at timestamptz NOT NULL DEFAULT now()
);
