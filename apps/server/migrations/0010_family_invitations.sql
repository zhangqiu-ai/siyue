-- Controlled one-time family invitations (design 8.2B table `family_invitations`, API table 16.4).
-- Additive only: no HTTP surface, no seed data and no change to existing rows. The tables are
-- created while the migrator runs as siyue_owner, so they inherit the schema default privileges
-- (SELECT, INSERT, UPDATE, DELETE to siyue_app) declared in provision/independent-database.sql;
-- no extra GRANT is issued here, and nothing grants TRUNCATE. PUBLIC has no USAGE on schema siyue.
CREATE TABLE siyue.family_invitations (
  id uuid PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES siyue.families(id),
  inviter_id uuid NOT NULL REFERENCES siyue.subjects(id),
  -- Normalized login address of the intended recipient, or NULL for a deliberate bearer invite.
  -- It is a hint for acceptance, never an account lookup or an automatic merge key.
  intended_email text CHECK (intended_email IS NULL OR (intended_email = lower(intended_email) AND length(intended_email) BETWEEN 3 AND 254)),
  -- Only the keyed digest of the one-time token is stored. The raw token exists in the sealed
  -- response below for a short recovery window and is never a public room code.
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired','revoked')),
  -- Which invite policy authorized the row, so a later policy change cannot silently reinterpret it.
  policy_version text NOT NULL CHECK (policy_version ~ '^[a-z0-9._-]{1,40}$'),
  -- Authority the invitation was issued under. Acceptance re-checks both values, so a demoted
  -- inviter, an elevated membership or any family change invalidates the pending invitation.
  inviter_membership_version integer NOT NULL CHECK (inviter_membership_version > 0),
  family_version integer NOT NULL CHECK (family_version > 0),
  -- Short-lived sealed response for same-request recovery only; destroyed on acceptance, on expiry
  -- and by the periodic cleanup. Never a durable copy of the token.
  token_ciphertext text,
  token_ciphertext_expires_at timestamptz,
  expires_at timestamptz NOT NULL,
  accepted_by uuid REFERENCES siyue.subjects(id),
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (created_at <= expires_at),
  -- A stored response is always bounded by its own recovery deadline.
  CHECK ((token_ciphertext IS NULL) = (token_ciphertext_expires_at IS NULL)),
  -- Acceptance records exactly one acceptor, and no other state carries one.
  CHECK ((status = 'accepted') = (accepted_by IS NOT NULL AND accepted_at IS NOT NULL))
);
-- Family-scoped reads (pending invitations of one family) stay ordered and indexed.
CREATE INDEX family_invitations_family ON siyue.family_invitations(family_id, created_at, id);
-- Cleanup of expiring invitations and of closed recovery windows stays bounded.
CREATE INDEX family_invitations_expiring ON siyue.family_invitations(expires_at) WHERE status = 'pending';
CREATE INDEX family_invitations_recovery ON siyue.family_invitations(token_ciphertext_expires_at) WHERE token_ciphertext IS NOT NULL;
