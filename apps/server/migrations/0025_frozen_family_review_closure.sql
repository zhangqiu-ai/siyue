-- Closing a frozen family review (design 13.2 and the 2026-09-24 confirmed rules): a sole manager's
-- accepted account deletion freezes a family that still has other members, and an internal review is
-- the only path that makes that family active again. This migration adds the two records closure needs
-- and nothing else: the recipient's own post-freeze acceptance of the management and applicable
-- guardianship duty, and the operator's manual review record that closes the pending marker.
--
-- Additive only: two new tables, no HTTP surface, no seed data, no change to existing rows or tables,
-- and no edit to the already-applied 0001..0024 files, so their recorded checksums stay
-- byte-identical. Both tables are created while the migrator runs as siyue_owner, so they inherit the
-- schema default privileges (SELECT, INSERT, UPDATE, DELETE to siyue_app) declared in
-- provision/independent-database.sql; no extra GRANT is issued here and nothing grants TRUNCATE.
-- The one non-additive statement below removes a write from the runtime role instead: a resolution may
-- only be created by a designated review operator's own login, never by the login the request path uses.
--
-- `siyue.account_deletion_family_reviews` (0022) is deliberately left exactly as it is: it keeps its
-- fixed id/state/instant contract and records that a review was owed and when it closed. Who closed it,
-- on which acceptance and with which shared-work result is recorded here instead, so the marker table
-- gains no assignee, outcome, reason or resolver column.
--
-- Deliberately absent from both tables: any work, message, homework, file, room or archive content, any
-- email, display name or provider credential, and any child identifier or guardian flag. The child
-- scope is stored as a digest that names no child; the operator record carries a bounded result code
-- and a bounded ops reference, never a description of a member. Neither table carries a retention or
-- expiry column: the confirmed rules fix no number, and inventing one here would be a policy decision
-- the design has not made.
CREATE TABLE siyue.family_review_acceptances (
  id uuid PRIMARY KEY,
  -- The frozen family being handed over. An acceptance is scoped to one family, so a review that
  -- settles one family settles it with its own record.
  family_id uuid NOT NULL REFERENCES siyue.families(id),
  -- The deleting sole manager whose accepted deletion froze this family. Read from the family row when
  -- the acceptance is recorded, never taken from the request, so a caller cannot declare who is being
  -- replaced; closure re-reads the frozen family and refuses if this is no longer its owner.
  deleting_subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  -- The accepting adult, bound by the service to the verified session that accepted. Also never taken
  -- from the request, so accepting cannot name someone else.
  recipient_subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  -- The frozen family and both memberships are the state the recipient accepted. Closure compares them
  -- against the then-current rows and refuses a changed family or membership, which is what forces a new
  -- acceptance instead of silently widening a record made for a different state.
  family_version integer NOT NULL CHECK (family_version > 0),
  recipient_membership_version integer NOT NULL CHECK (recipient_membership_version > 0),
  owner_membership_version integer NOT NULL CHECK (owner_membership_version > 0),
  -- Lowercase SHA-256 digest of the server-computed child scope of the frozen family. Only the digest
  -- is stored: no child is named here, and closure recomputes the digest from the current guardianships
  -- and compares, so a child added or removed after acceptance invalidates the record.
  child_scope_digest text NOT NULL CHECK (child_scope_digest ~ '^[0-9a-f]{64}$'),
  accepted_at timestamptz NOT NULL,
  -- Set once, by the closure transaction that consumed this record. A consumed record stays readable as
  -- history, and no record is ever consumed twice.
  consumed_at timestamptz,
  -- Re-acceptance after a family or child-scope change preserves the old declaration as history. A
  -- superseded record can never close a review.
  superseded_at timestamptz,
  -- An adult is never the recipient of their own review, and neither a consumption nor a supersession
  -- can predate the acceptance it stamps.
  CHECK (recipient_subject_id <> deleting_subject_id),
  CHECK (consumed_at IS NULL OR consumed_at >= accepted_at),
  CHECK (superseded_at IS NULL OR superseded_at >= accepted_at),
  CHECK (consumed_at IS NULL OR superseded_at IS NULL)
);
-- How long an acceptance stays current is the live management acceptance's own 24-hour validity window,
-- computed by the closure from `accepted_at` (family-management-acceptance.ts). No expiry column is added
-- here: history is kept, and a declaration that is no longer current simply stops closing reviews. That is
-- a validity period for a consent, not a retention period for the row, and it fixes no retention number.
-- One current acceptance per frozen family and recipient: closure consumes exactly one, while superseded
-- and consumed rows stay per family as history.
CREATE UNIQUE INDEX family_review_acceptances_live
  ON siyue.family_review_acceptances(family_id, recipient_subject_id)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;
-- One recipient's own current acceptances, read per subject instead of scanning the table.
CREATE INDEX family_review_acceptances_recipient
  ON siyue.family_review_acceptances(recipient_subject_id, accepted_at)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;
-- Review candidates for one deleting adult, so an operator can see which acceptance is still live.
CREATE INDEX family_review_acceptances_deleting
  ON siyue.family_review_acceptances(deleting_subject_id, accepted_at)
  WHERE consumed_at IS NULL AND superseded_at IS NULL;

CREATE TABLE siyue.family_review_resolutions (
  id uuid PRIMARY KEY,
  -- The pending marker this record closes. One resolution per marker: closure sets state='resolved' and
  -- resolved_at on that same row in the same transaction, and a repeated attempt reads this record
  -- instead of writing a second one.
  review_id uuid NOT NULL UNIQUE REFERENCES siyue.account_deletion_family_reviews(id),
  -- The acceptance the closure consumed. At most one resolution per acceptance, so a consumed
  -- declaration cannot close two reviews.
  acceptance_id uuid NOT NULL UNIQUE REFERENCES siyue.family_review_acceptances(id),
  -- The family that was restored and the adult it was handed to.
  family_id uuid NOT NULL REFERENCES siyue.families(id),
  recipient_subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  -- The database login role the closure ran as, read from `session_user` of the connection that ran it.
  -- It is never taken from a request field, and there is no HTTP route that could assert it.
  operator_role text NOT NULL CHECK (operator_role ~ '^[a-z_][a-z0-9_]{0,62}$'),
  -- The operator's manual shared-work review result, as a bounded code rather than free text, so the
  -- record says what was checked without carrying any work title, note or member name.
  -- Only the results that close a review are in the domain: `retained_for_review` means the shared work
  -- was kept for a later check, which refuses the closure, so it can never label a resolution row -- a row
  -- here always says a review was actually closed. The check is what stops a direct write, not only the
  -- kernel, from recording a closure that keeps the shared work retained.
  shared_work_result text NOT NULL CHECK (shared_work_result IN ('no_shared_work','separated')),
  shared_work_checked_at timestamptz NOT NULL,
  -- The operator's own bounded reference for this operation (an ops case or ticket id), never a
  -- description of a member or of their data.
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 120),
  -- SHA-256 of the operator's idempotency key. Only the digest is kept, and it is what a repeated
  -- attempt with the same key is matched against; a different key never re-closes a closed review.
  idempotency_key_hash text NOT NULL UNIQUE CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  -- The versions, digest and scope size the closure consumed, copied from the acceptance it consumed.
  family_version integer NOT NULL CHECK (family_version > 0),
  recipient_membership_version integer NOT NULL CHECK (recipient_membership_version > 0),
  owner_membership_version integer NOT NULL CHECK (owner_membership_version > 0),
  child_scope_digest text NOT NULL CHECK (child_scope_digest ~ '^[0-9a-f]{64}$'),
  child_count integer NOT NULL CHECK (child_count >= 0),
  closed_at timestamptz NOT NULL,
  -- The shared-work review is a precondition of this closure, never a later stamp.
  CHECK (closed_at >= shared_work_checked_at)
);
-- Which role may write a resolution is part of the control and not only what the kernel checks: the
-- login the request path runs as must never be able to create, rewrite or remove one, so this is the one
-- record of the closure that the API's own role cannot touch even if a route ever reached the kernel.
-- The designated operator's own provisioning grants it INSERT and SELECT here, and no login holds DELETE
-- or TRUNCATE on the table. Historical rows stay readable; nothing in this migration drops or rewrites
-- anything, and no row is created for a review that did not close.
CREATE INDEX family_review_resolutions_family ON siyue.family_review_resolutions(family_id, closed_at);
CREATE INDEX family_review_resolutions_operator ON siyue.family_review_resolutions(operator_role, closed_at);
REVOKE INSERT, UPDATE, DELETE ON siyue.family_review_resolutions FROM siyue_app;
