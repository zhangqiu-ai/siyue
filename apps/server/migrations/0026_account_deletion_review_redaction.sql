-- Clearing one deleted adult out of a closed freeze review, without taking the other adult's acceptance
-- or the operator's closure record with them (design 13.2; the layered history rule confirmed on
-- 2026-09-24 says another member's valid relationship and the records the audit trail needs are never
-- deleted to finish someone else's deletion, and a deleting adult's own link is removed from ended
-- history only where that damages nobody).
--
-- Two rows of a closed review name the deleting adult, and both are rows the API's own login may write:
-- the 0022 marker names the frozen-away owner, and the 0025 acceptance names that owner as the adult the
-- family was taken from. Neither row may be deleted. The acceptance is another adult's explicit
-- acceptance, with the family, membership and child-scope versions the handover was made against, and the
-- marker is the parent of the 0025 resolution that carries the operator's reason, scope, shared-work
-- result and idempotency proof. Migration 0025 deliberately made that resolution unwritable for the API
-- login, and it is left exactly as it is here.
--
-- So each of the two writable rows keeps its place and loses only the deleted adult's link, stamped with
-- the instant it was cleared. Both checks that make that safe are in the schema rather than only in the
-- cleanup: a cleared link is always accompanied by its stamp and never by a missing one, and a link may
-- only be cleared on a record that is already closed -- a resolved marker, a consumed or superseded
-- acceptance. A live review can therefore never be blinded by a redaction, and `accepted_at`, the
-- recipient's own id, the versions and the child-scope digest all stay NOT NULL, because they are the
-- other adult's evidence that the closure was made on that state.
--
-- Deliberately unchanged: `family_review_resolutions` (every column, its NOT NULL contract and the 0025
-- REVOKE), `family_review_acceptances.recipient_subject_id`, both `consumed_at`/`superseded_at` and
-- `account_deletion_family_reviews.state`/`resolved_at`. A closure the deleted adult was the *recipient*
-- of still names them in the resolution, and no row this login may write can clear that, so that case is
-- reported by the cleanup instead of being finished. No row is rewritten by this migration, no column or
-- table is dropped, and no retention or expiry number is introduced: the policy question of how long a
-- redacted record is kept is not answered here.
--
-- Additive only, and both tables keep the schema default privileges (SELECT, INSERT, UPDATE, DELETE to
-- siyue_app) declared in provision/independent-database.sql; nothing here grants TRUNCATE.
ALTER TABLE siyue.account_deletion_family_reviews ALTER COLUMN deleting_subject_id DROP NOT NULL;
ALTER TABLE siyue.account_deletion_family_reviews ADD COLUMN deleting_redacted_at timestamptz;
ALTER TABLE siyue.account_deletion_family_reviews
  ADD CONSTRAINT account_deletion_family_reviews_deleting_recorded_check
  CHECK ((deleting_subject_id IS NULL) = (deleting_redacted_at IS NOT NULL));
ALTER TABLE siyue.account_deletion_family_reviews
  ADD CONSTRAINT account_deletion_family_reviews_deleting_redacted_closed_check
  CHECK (deleting_redacted_at IS NULL OR state = 'resolved');

ALTER TABLE siyue.family_review_acceptances ALTER COLUMN deleting_subject_id DROP NOT NULL;
ALTER TABLE siyue.family_review_acceptances ADD COLUMN deleting_redacted_at timestamptz;
ALTER TABLE siyue.family_review_acceptances
  ADD CONSTRAINT family_review_acceptances_deleting_recorded_check
  CHECK ((deleting_subject_id IS NULL) = (deleting_redacted_at IS NOT NULL));
ALTER TABLE siyue.family_review_acceptances
  ADD CONSTRAINT family_review_acceptances_deleting_redacted_settled_check
  CHECK (deleting_redacted_at IS NULL OR consumed_at IS NOT NULL OR superseded_at IS NOT NULL);
