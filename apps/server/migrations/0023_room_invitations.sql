-- Family-room invitations for the confirmed C11 room rule (design 16.5, spec VWC-02): only a parent
-- opens a family room and invites an existing family member, children may accept, and there is no
-- public room code. This migration persists that invitation so an authorization to join is durable,
-- re-checkable, revocable and idempotent instead of living in a request body, a client flag or a
-- one-time token that the client can replay after the room, the family or the membership changed.
--
-- Additive only: one new table, no HTTP surface, no seed data, no change to existing rows or tables,
-- and no edit to the already-applied 0001..0022 files, so their recorded checksums stay byte-identical.
-- The table is created while the migrator runs as siyue_owner, so it inherits the schema default
-- privileges (SELECT, INSERT, UPDATE, DELETE to siyue_app) declared in
-- provision/independent-database.sql; no extra GRANT is issued here and nothing grants TRUNCATE.
--
-- Deliberately independent of `family_invitations`: that table and its service accept only an adult
-- session, so a child can never be admitted through them. C11 requires children to be invited and to
-- accept, so this table has no foreign key, no shared status vocabulary and no adult-only assumption
-- about the invitee; a child subject is a first-class invitee here.
--
-- Deliberately absent from this table: any room code, token, digest or ciphertext (a client-held join
-- secret is what C11 excludes, so the row itself is the authorization), any role, subject kind or
-- "is parent" column (a family role is not a verified parent mapping, and a request body must never
-- carry that verdict), any `auth_sessions` reference (account deletion removes a subject's sessions
-- and is not allowed to know about this table, so a copied session id would either block that deletion
-- or dangle), and any media, board, recording or message content.
CREATE TABLE siyue.room_invitations (
  id uuid PRIMARY KEY,
  -- The room the invitation opens. The family is read from `rooms.family_id` instead of being copied
  -- here, because a duplicated family column could disagree with the room it authorizes.
  room_id uuid NOT NULL REFERENCES siyue.rooms(id),
  -- The verified adult session's subject that issued the invitation, never a client-supplied identity.
  inviter_subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  -- The invited existing family member, who may be an adult or a child. Recorded by subject so the
  -- invitation is bound to a member of the family rather than to a device, an installation id or a
  -- session that could be replaced.
  invitee_subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  -- `pending` may still be accepted, `accepted` records the member's own verified acceptance (a repeat
  -- acceptance is idempotent and does not move the row), and `revoked` is a closed invitation that is
  -- never reopened. Removal of an already joined member is a separate owner decision (O01), so it is
  -- not modelled as a status here.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
  -- Both membership versions and the family version the invitation was issued under. Acceptance and
  -- joining re-read all three, so an inviter or invitee that exits then rejoins cannot recover a stale
  -- grant merely because their subject id and the family's version stayed the same.
  inviter_membership_version integer NOT NULL CHECK (inviter_membership_version > 0),
  invitee_membership_version integer NOT NULL CHECK (invitee_membership_version > 0),
  family_version integer NOT NULL CHECK (family_version > 0),
  -- The deadline the authorized caller decided on. No default and no invented retention window: the
  -- seat reservation and invitation lifetime are still owner decisions, so the row refuses to guess one.
  expires_at timestamptz NOT NULL,
  -- When the invited member's own verified session accepted. One instant, no session id: see the header.
  accepted_at timestamptz,
  -- When the invitation was closed before acceptance. The row stays readable as history.
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- One invitation per room and invited member: a repeated or concurrent create is refused by the
  -- database instead of adding a second row, so "the invitation for this member" is unambiguous and an
  -- idempotent retry has exactly one row to return.
  UNIQUE (room_id, invitee_subject_id),
  -- An invitation is never issued to its own inviter.
  CHECK (invitee_subject_id <> inviter_subject_id),
  -- A stored invitation is never already over when it is written.
  CHECK (created_at <= expires_at),
  -- Acceptance and revocation each carry exactly their own instant, and no other state carries one, so
  -- a status can never be reported without the evidence of when it changed.
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (accepted_at IS NULL OR accepted_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
-- "Which rooms is this member invited to" stays bounded and indexed, so a later revocation or expiry
-- sweep does not scan the whole table. Room-scoped reads use the unique (room_id, invitee_subject_id)
-- index above.
CREATE INDEX room_invitations_invitee ON siyue.room_invitations(invitee_subject_id);
