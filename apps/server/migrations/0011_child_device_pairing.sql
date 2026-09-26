-- Guardian consent, restricted child-device pairing and child device grants: design 8.2B tables
-- `consent_records`, `guardian_relationships`, `device_pairing_requests`, `device_grants` plus the
-- nullable `auth_sessions.device_grant_id` link from 8.1. Additive only: no HTTP surface, no seed
-- data, no change to existing rows, and deliberately no child/auth_method CHECK on `auth_sessions`,
-- so synthetic fixtures and sessions written before this migration stay valid. The tables and the new
-- column are created while the migrator runs as siyue_owner, so they inherit the schema default
-- privileges (SELECT, INSERT, UPDATE, DELETE to siyue_app) declared in
-- provision/independent-database.sql; no extra GRANT is issued here, and nothing grants TRUNCATE.
-- PUBLIC has no USAGE on schema siyue.

-- Consent is its own record, referenced by the relationship it authorizes, so withdrawal is an
-- update instead of a silent delete. It records that an adult made a declaration; it is not evidence
-- that legal guardian status or age was verified.
CREATE TABLE siyue.consent_records (
  id uuid PRIMARY KEY,
  -- The adult who actually recorded the decision; never inferred from a family role.
  actor_subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  -- The subject the decision is about. Nullable on purpose: an account-level consent is not about one
  -- child, while a guardian consent always names the child it covers.
  subject_id uuid REFERENCES siyue.subjects(id),
  purpose text NOT NULL CHECK (purpose ~ '^[a-z0-9._-]{1,40}$'),
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-z0-9._-]{1,40}$'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  -- Withdrawal can only follow the record it withdraws; the withdrawn row stays readable.
  CHECK (withdrawn_at IS NULL OR withdrawn_at >= recorded_at)
);
CREATE INDEX consent_records_subject ON siyue.consent_records(subject_id, purpose, recorded_at) WHERE subject_id IS NOT NULL;

-- Explicit guardian relationship. A family owner/admin/member role is not consent and never creates
-- or implies one: only a recorded consent plus an eligible adult does. The `kind` of each side is
-- enforced by the service, where the child subject and this row are created in one transaction.
CREATE TABLE siyue.guardian_relationships (
  family_id uuid NOT NULL REFERENCES siyue.families(id),
  guardian_subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  child_subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  -- Every relationship cites the consent that authorized it, so re-consent bumps this row instead of
  -- rewriting history, and a withdrawn consent stays visible through this link.
  consent_record_id uuid NOT NULL REFERENCES siyue.consent_records(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One relationship per family/guardian/child triple: re-approval is an update, and a concurrent
  -- duplicate insert is refused by the database instead of racing a read.
  PRIMARY KEY (family_id, guardian_subject_id, child_subject_id),
  -- An adult is never their own child.
  CHECK (guardian_subject_id <> child_subject_id)
);
CREATE INDEX guardian_relationships_child ON siyue.guardian_relationships(child_subject_id);
CREATE INDEX guardian_relationships_guardian ON siyue.guardian_relationships(guardian_subject_id);
CREATE INDEX guardian_relationships_consent ON siyue.guardian_relationships(consent_record_id);

-- A pairing request is started by a child device that holds no adult session, and is only ever a
-- pending application. Two independent secrets are stored as keyed digests: `request_token_hash`
-- identifies the request to the approving parent (it may travel in a QR code), while
-- `poll_secret_hash` stays on the initiating device and is the only thing allowed to read or consume
-- the result. Neither digest is a pair code that grants a session by itself.
CREATE TABLE siyue.device_pairing_requests (
  id uuid PRIMARY KEY,
  request_token_hash text NOT NULL UNIQUE CHECK (request_token_hash ~ '^[0-9a-f]{64}$'),
  poll_secret_hash text NOT NULL UNIQUE CHECK (poll_secret_hash ~ '^[0-9a-f]{64}$'),
  -- Design 16.3 requires two *different* secrets: if the request token doubled as the poll secret,
  -- anyone who saw the request (a QR code, a shoulder surf) could collect the child session.
  CHECK (request_token_hash <> poll_secret_hash),
  installation_id text NOT NULL CHECK (length(installation_id) BETWEEN 1 AND 200),
  platform text NOT NULL CHECK (platform IN ('ios','android','desktop')),
  device_label text CHECK (device_label IS NULL OR length(device_label) <= 100),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','consumed','expired')),
  -- Approval always names the approving adult, the target child and its family, or none of them.
  approved_by uuid REFERENCES siyue.subjects(id),
  child_subject_id uuid REFERENCES siyue.subjects(id),
  family_id uuid REFERENCES siyue.families(id),
  approved_guardian_version integer CHECK (approved_guardian_version > 0),
  approved_credential_version integer CHECK (approved_credential_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  consumed_at timestamptz,
  -- The initial pairing window (design 16.3) is bounded here so a defect cannot mint a long-lived
  -- pairing request; the exchange still re-reads the clock when it consumes one.
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '5 minutes'),
  -- State shape: pending carries nothing, approved names all three parties with no consumption,
  -- consumed adds the single-use stamp, and expired is never consumable and is either never approved
  -- or fully approved. Partial approvals are impossible in every state.
  CHECK (
    (status = 'pending' AND approved_by IS NULL AND approved_at IS NULL AND child_subject_id IS NULL AND family_id IS NULL
      AND approved_guardian_version IS NULL AND approved_credential_version IS NULL AND consumed_at IS NULL)
    OR (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND child_subject_id IS NOT NULL AND family_id IS NOT NULL
      AND approved_guardian_version IS NOT NULL AND approved_credential_version IS NOT NULL AND consumed_at IS NULL)
    OR (status = 'consumed' AND approved_by IS NOT NULL AND approved_at IS NOT NULL AND child_subject_id IS NOT NULL AND family_id IS NOT NULL
      AND approved_guardian_version IS NOT NULL AND approved_credential_version IS NOT NULL AND consumed_at IS NOT NULL)
    OR (status = 'expired' AND consumed_at IS NULL AND (
         (approved_by IS NULL AND approved_at IS NULL AND child_subject_id IS NULL AND family_id IS NULL
           AND approved_guardian_version IS NULL AND approved_credential_version IS NULL)
         OR (approved_by IS NOT NULL AND approved_at IS NOT NULL AND child_subject_id IS NOT NULL AND family_id IS NOT NULL
           AND approved_guardian_version IS NOT NULL AND approved_credential_version IS NOT NULL)))
  )
);
-- Expiry sweeps stay bounded and only touch pending rows; approval and consumption history is kept.
CREATE INDEX device_pairing_requests_pending ON siyue.device_pairing_requests(expires_at) WHERE status = 'pending';
CREATE INDEX device_pairing_requests_family ON siyue.device_pairing_requests(family_id) WHERE family_id IS NOT NULL;
CREATE INDEX device_pairing_requests_child ON siyue.device_pairing_requests(child_subject_id) WHERE child_subject_id IS NOT NULL;
CREATE INDEX device_pairing_requests_approver ON siyue.device_pairing_requests(approved_by) WHERE approved_by IS NOT NULL;

-- A device grant is a bounded, revocable capability for one child installation. It is not a copy of
-- the guardian session and carries no refresh token: a restricted child session points back at it.
CREATE TABLE siyue.device_grants (
  id uuid PRIMARY KEY,
  child_subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  -- The approving adult. Named `guardian_id` to match the device-grant contract; the guardian
  -- relationship above is still what makes an approval valid.
  guardian_id uuid NOT NULL REFERENCES siyue.subjects(id),
  family_id uuid NOT NULL REFERENCES siyue.families(id),
  installation_id text NOT NULL CHECK (length(installation_id) BETWEEN 1 AND 200),
  -- Device description copied from the approved pairing request when the grant is created, so the
  -- guardian device list can show what was authorized without re-reading a consumed request.
  -- Platform is mandatory on the pairing request; only the display label may be absent.
  platform text NOT NULL CHECK (platform IN ('ios','android','desktop')),
  device_label text CHECK (device_label IS NULL OR length(device_label) <= 100),
  -- Authority the grant was approved under. A child session re-checks both versions on every request
  -- against the live guardian relationship and the guardian's current credential_version, so a
  -- relationship change or a guardian security reset invalidates outstanding grants immediately
  -- instead of only at `expires_at`.
  guardian_relationship_version integer NOT NULL CHECK (guardian_relationship_version > 0),
  guardian_credential_version integer NOT NULL CHECK (guardian_credential_version > 0),
  -- An empty list is the safe initial grant before room/board authorization is connected. There
  -- is deliberately no implicit "all" value; individual names must never be empty or NULL.
  scopes text[] NOT NULL CHECK (array_position(scopes, NULL) IS NULL AND array_position(scopes, '') IS NULL),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  -- Grant lifetime is bounded (design 16.3): a refresh never outlives the grant.
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  -- A child device is never granted by the child itself.
  CHECK (child_subject_id <> guardian_id)
);
CREATE INDEX device_grants_family ON siyue.device_grants(family_id);
CREATE INDEX device_grants_child ON siyue.device_grants(child_subject_id);
CREATE INDEX device_grants_guardian ON siyue.device_grants(guardian_id);
-- Live-grant lookups for one child installation stay bounded; revoked history is excluded.
CREATE INDEX device_grants_live ON siyue.device_grants(child_subject_id, installation_id) WHERE revoked_at IS NULL;

-- Restricted child sessions point at the grant that authorizes them. Nullable and additive: adult
-- sessions, and any synthetic or legacy row written before this migration, keep working with NULL.
-- No child/auth_method CHECK is added, because older sessions are not guaranteed to carry a grant and
-- a hard check would invalidate them and their fixtures.
ALTER TABLE siyue.auth_sessions ADD COLUMN device_grant_id uuid REFERENCES siyue.device_grants(id);
-- One grant backs at most one restricted child session, so a leaked or replayed completion cannot
-- mint a second live session for the same grant. The index is partial: every pre-existing and adult
-- session keeps its NULL link and is unaffected by the uniqueness.
CREATE UNIQUE INDEX auth_sessions_device_grant ON siyue.auth_sessions(device_grant_id) WHERE device_grant_id IS NOT NULL;
