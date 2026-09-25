-- The recipient's explicit acceptance of a family management handover (design 13.2). A deleting sole
-- owner may hand a family to another adult of that family, but naming the recipient in the deletion
-- request is not consent: the recipient must first accept the management duty and the applicable
-- guardianship duty, and that acceptance has to cover the family and child scope the deletion is later
-- accepted against. This migration stores the acceptance, so the acceptance transaction can re-read and
-- consume one still-valid record instead of trusting a value the caller sends along with the deletion.
--
-- Additive only: one new table, no HTTP surface, no seed data, no change to existing rows or tables, and
-- no edit to the already-applied 0001..0020 files, so their recorded checksums stay byte-identical. The
-- table is created while the migrator runs as siyue_owner, so it inherits the schema default privileges
-- (SELECT, INSERT, UPDATE, DELETE to siyue_app) declared in provision/independent-database.sql; no extra
-- GRANT is issued here, and nothing grants TRUNCATE. PUBLIC has no USAGE on schema siyue.
--
-- Deliberately absent from this table: any email, display name, child identifier, device label, guardian
-- flag or policy text. It stores only ids, versions, an opaque scope digest and instants, so a record can
-- be read, logged or audited without exposing a profile or a child's identity.
CREATE TABLE siyue.family_management_acceptances (
  id uuid PRIMARY KEY,
  -- The family being handed over. An acceptance is scoped to one family, so a deletion that touches
  -- several families settles each of them with its own record rather than one acceptance per subject.
  family_id uuid NOT NULL REFERENCES siyue.families(id),
  -- The owner at acceptance time, read by the service from the family row. Never taken from the request,
  -- so a caller cannot declare who is handing the family over; consumption re-checks that the family
  -- still has this owner before any handover happens.
  owner_subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  -- The accepting adult, bound by the service to the verified session that accepted. Also never taken
  -- from the request, so accepting cannot name someone else and an ineligible caller cannot become
  -- eligible by asserting an id.
  recipient_subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  -- The family and both membership versions are the state the recipient accepted. Consumption compares
  -- them against the then-current rows and refuses a changed family or membership, which is what forces
  -- re-acceptance instead of silently widening a record made for a different state.
  family_version integer NOT NULL CHECK (family_version > 0),
  recipient_membership_version integer NOT NULL CHECK (recipient_membership_version > 0),
  owner_membership_version integer NOT NULL CHECK (owner_membership_version > 0),
  -- Lowercase SHA-256 digest of the server-computed child scope this acceptance covers. Only the digest
  -- is stored: no child is named here, and consumption recomputes the digest from the current
  -- guardianships and compares, so a child added or removed after acceptance invalidates the record.
  child_scope_digest text NOT NULL CHECK (child_scope_digest ~ '^[0-9a-f]{64}$'),
  accepted_at timestamptz NOT NULL,
  -- The service applies a bounded lifetime after acceptance and the design fixes no number, so only the
  -- interval's shape is enforced here: an expired record grants nothing and can never be consumed.
  expires_at timestamptz NOT NULL CHECK (expires_at > accepted_at),
  -- Set once, by the deletion acceptance transaction that consumes this record. A consumed record stays
  -- readable as history, and no record is ever consumed twice.
  consumed_at timestamptz,
  -- Re-acceptance after a family or child-scope change preserves the old declaration as history.
  -- A superseded record cannot be used for a transfer.
  superseded_at timestamptz,
  -- Bounded operational proof; guardianship consent has its own durable record after transfer.
  retain_until timestamptz NOT NULL CHECK (retain_until >= expires_at),
  -- An adult is never their own recipient, and a consumption can never predate the acceptance it stamps.
  CHECK (recipient_subject_id <> owner_subject_id),
  CHECK (consumed_at IS NULL OR consumed_at >= accepted_at),
  CHECK (superseded_at IS NULL OR superseded_at >= accepted_at),
  CHECK (consumed_at IS NULL OR superseded_at IS NULL)
);
-- At most one current acceptance per family and recipient. Re-acceptance supersedes the old row
-- before insertion in the same family-locked transaction; both declarations remain as history.
CREATE UNIQUE INDEX family_management_acceptances_live ON siyue.family_management_acceptances(family_id, recipient_subject_id)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;
-- Expiry scans and consumption lookup stay bounded to current rows; consumed history has a
-- separately defined retention policy before any production endpoint can be enabled.
CREATE INDEX family_management_acceptances_expiry ON siyue.family_management_acceptances(expires_at)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;
-- One recipient's own live acceptances, read per subject instead of scanning the table.
CREATE INDEX family_management_acceptances_recipient ON siyue.family_management_acceptances(recipient_subject_id, accepted_at)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;
CREATE INDEX family_management_acceptances_retention ON siyue.family_management_acceptances(retain_until,id);
