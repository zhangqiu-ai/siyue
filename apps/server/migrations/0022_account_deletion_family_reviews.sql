-- A sole manager's account deletion freezes a family that still has other members (design 13.2): the
-- deletion may not assign or remove the members' shared work, so the family waits for an internal
-- review instead of being counted as cleaned up. This migration persists the one pending marker per
-- frozen family, so the acceptance transaction can leave durable evidence that the family is still
-- owed a review after the deleting subject's sessions are gone.
--
-- Additive only: one new table, no HTTP surface, no seed data, no change to existing rows or tables,
-- and no edit to the already-applied 0001..0021 files, so their recorded checksums stay
-- byte-identical. The table is created while the migrator runs as siyue_owner, so it inherits the
-- schema default privileges (SELECT, INSERT, UPDATE, DELETE to siyue_app) declared in
-- provision/independent-database.sql; no extra GRANT is issued here and nothing grants TRUNCATE.
--
-- Deliberately absent from this table: any work, message, homework, file, room or archive content,
-- any email, display name or provider credential, and any child identifier, guardian flag or scope
-- text. It stores only ids, one state and two instants, so a marker can be read, logged or audited
-- without exposing a profile, a family's shared work or a child's identity.
--
-- The table records that a review is owed, not who owes it or how it ends: there is no assignee,
-- resolver, outcome or reason column, because the internal process that closes these markers is not
-- defined yet and must not be invented by the schema.
CREATE TABLE siyue.account_deletion_family_reviews (
  id uuid PRIMARY KEY,
  -- The acceptance that froze this family, by the immutable UUID of its deletion job. Bound by
  -- reference, so a marker cannot exist without the deletion that opened it and never depends on a
  -- timestamp or a name.
  deletion_id uuid NOT NULL REFERENCES siyue.account_deletion_jobs(id),
  -- The frozen family that is still owed a review. The marker is scoped to one family, so a deletion
  -- that freezes several families leaves one row per family rather than one row per subject.
  family_id uuid NOT NULL REFERENCES siyue.families(id),
  -- The deleting subject, the sole manager whose acceptance froze the family. Same meaning as
  -- account_deletion_jobs.subject_id: the subject asking to be deleted, never another member of the
  -- family and never a child.
  deleting_subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  -- Open until the internal process closes it. `resolved` means the frozen family was handled by that
  -- process; it makes no claim about the shared work itself, which keeps its own rules.
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','resolved')),
  -- When the acceptance froze the family and owed the review.
  opened_at timestamptz NOT NULL,
  -- Set once, when the internal process resolves the marker. A resolved row stays readable as history
  -- and is never reopened.
  resolved_at timestamptz,
  -- One marker per deletion job and family: the acceptance opens the review once, and a repeated
  -- attempt is rejected by the database instead of adding a second row.
  UNIQUE (deletion_id, family_id),
  -- A row is either waiting or closed, never both and never neither: `resolved` requires the stamp,
  -- and an open marker may not carry one.
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL)),
  -- A review is never closed before it was opened.
  CHECK (resolved_at IS NULL OR resolved_at >= opened_at)
);
-- At most one open review per family across all deletion jobs: a frozen family has exactly one pending
-- marker at a time, while resolved rows stay per family as history. This index is the database
-- backstop, so a second pending insert fails instead of racing a read.
CREATE UNIQUE INDEX account_deletion_family_reviews_pending_family
  ON siyue.account_deletion_family_reviews(family_id) WHERE state = 'pending';
