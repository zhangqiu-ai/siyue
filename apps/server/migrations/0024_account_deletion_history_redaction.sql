-- Account-deletion history redaction: the schema half of the layered historical rule the maintainer
-- accepted on 2026-09-24 (design draft "注销流程补全草案", option 2). A deleted adult's own invalidated
-- credentials and temporary material are removed outright; another member's valid relationship and
-- original work are never deleted with them; and an ended historical row keeps its place in the other
-- member's record while the deleted adult's own link is cleared from it. Only the last of those three
-- actions needs schema support, because until now these three tables had no way to express "the party
-- this row was written with is gone".
--
-- In place and deliberately narrow: three existing tables gain exactly the relaxation that lets the
-- cleanup kernel clear one deleted party, and every live-state protection keeps refusing the partial
-- states it refused before. No table, column or row is dropped, no historical row is rewritten by the
-- migration itself, and no retention window is introduced -- the accepted rule says a new retention
-- period must be decided separately, never invented by a migration or a cleanup pass.
--
-- The migration inherits the schema default privileges (SELECT, INSERT, UPDATE, DELETE to siyue_app)
-- declared in provision/independent-database.sql; it issues no GRANT and nothing here grants TRUNCATE.
-- PUBLIC has no USAGE on schema siyue.

-- `family_invitations` keeps an accepted invitation as the family's record of how a member was
-- admitted. Deleting the inviter's or the acceptor's account must not delete that record, so the two
-- subject links become clearable -- but only where the row can no longer authorize anything.
--
-- The old inline acceptance check tied `accepted` to *both* the acceptor and the instant, which made a
-- redaction impossible. It is replaced by two checks that keep the acceptance exactly as provable: an
-- accepted row always carries the instant it was accepted at, an acceptor link only ever appears on an
-- accepted row, and a still-pending invitation always names the inviter whose authority acceptance
-- re-reads. A pending row therefore cannot be redacted, which is the state the live dependency scan
-- already refuses to clean up.
ALTER TABLE siyue.family_invitations DROP CONSTRAINT family_invitations_check2;
ALTER TABLE siyue.family_invitations ALTER COLUMN inviter_id DROP NOT NULL;
ALTER TABLE siyue.family_invitations ADD CONSTRAINT family_invitations_accepted_at_check
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL));
ALTER TABLE siyue.family_invitations ADD CONSTRAINT family_invitations_accepted_by_check
  CHECK (accepted_by IS NULL OR status = 'accepted');
ALTER TABLE siyue.family_invitations ADD CONSTRAINT family_invitations_inviter_present_check
  CHECK (status <> 'pending' OR inviter_id IS NOT NULL);

-- A revoked or expired child-device grant is the child's own history of what was authorized on which
-- installation. It must survive the guardian's deletion, and its `guardian_id` is the only column that
-- names that adult. `guardian_redacted_at` is what makes the removal expressible without losing the
-- row's invariant: a grant always records either the approver or the instant that approver's account
-- deletion cleared the link, never both and never neither. The live grant a child session re-reads is
-- untouched -- the cleanup kernel refuses to run at all while any grant of the deleting adult is still
-- live, and only a settled (revoked or expired) grant is ever redacted.
--
-- An anonymous grant is only ever the settled history this redaction leaves behind, so the second check
-- refuses one that is not revoked. Without it a row the pass cleared on its own expiry would keep
-- `revoked_at` NULL, and a later write that moved `expires_at` forward would turn a grant nobody is
-- named on into a live one -- an authorization with no approver left to hold it. The cleanup therefore
-- revokes the grant it clears as well as clearing the link, and this check is the database backstop
-- that makes an anonymous live grant impossible even if some other writer tried it.
ALTER TABLE siyue.device_grants ALTER COLUMN guardian_id DROP NOT NULL;
ALTER TABLE siyue.device_grants ADD COLUMN guardian_redacted_at timestamptz;
ALTER TABLE siyue.device_grants ADD CONSTRAINT device_grants_guardian_recorded_check
  CHECK ((guardian_id IS NULL) = (guardian_redacted_at IS NOT NULL));
ALTER TABLE siyue.device_grants ADD CONSTRAINT device_grants_anonymous_revoked_check
  CHECK (guardian_id IS NOT NULL OR revoked_at IS NOT NULL);

-- A room invitation is the record of an authorization between two members of one family. The table
-- keeps its closed rows readable as history, so a deleted member's side of a closed invitation is
-- cleared instead of the row being deleted -- while a still-pending invitation must keep naming both
-- parties, because acceptance and the join verdict re-read the inviter's standing and the invitee's
-- membership from those columns.
ALTER TABLE siyue.room_invitations ALTER COLUMN inviter_subject_id DROP NOT NULL;
ALTER TABLE siyue.room_invitations ALTER COLUMN invitee_subject_id DROP NOT NULL;
ALTER TABLE siyue.room_invitations ADD CONSTRAINT room_invitations_parties_present_check
  CHECK (status <> 'pending' OR (inviter_subject_id IS NOT NULL AND invitee_subject_id IS NOT NULL));
