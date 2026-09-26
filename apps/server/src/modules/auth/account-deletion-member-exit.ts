import type { PoolClient } from 'pg';
import { AuthError } from './sessions.js';

interface FamilyRow { owner_subject_id: string; status: string; }
interface MemberRow { role: string; active: boolean; kind: string; status: string; }
interface ChildRow { child_subject_id: string; }

/**
 * A child may lose one guardian only while another live guardian remains. This is the same rule the
 * read-only deletion impact inventory already reports to the user as the other-guardian count: the other
 * guardian's relationship is active, its recorded consent is un-withdrawn, and the child, the guardian,
 * the family and both memberships are all still live. It is deliberately not limited to this family, so
 * a child supervised from another family is never treated as unguarded.
 *
 * Every row that decision depends on is locked, not merely read: the other relationship, its consent,
 * both subjects, the other family and both memberships. A plain read would decide on a snapshot that a
 * concurrent freeze, dissolution, membership revocation, subject block or consent withdrawal could
 * invalidate before this transaction commits, leaving the child with no usable guardian while both
 * transactions reported success. Waiting on those locks makes the other family's change commit first and
 * this check observe it, so a refusal replaces a stale success.
 *
 * Two exits of the same child's guardians can therefore wait on each other and PostgreSQL aborts one as
 * a retryable deadlock. That is the intended behavior for a check spanning two families: refusing is
 * always safe, and guessing which guardian is "really" still there is not.
 */
async function requireAnotherGuardian(client: PoolClient, childId: string, subjectId: string): Promise<void> {
  const other = (await client.query<{family_id: string}>(`
    SELECT other.family_id FROM siyue.guardian_relationships other
      JOIN siyue.consent_records other_consent ON other_consent.id=other.consent_record_id
        AND other_consent.actor_subject_id=other.guardian_subject_id
        AND other_consent.subject_id=other.child_subject_id
        AND other_consent.purpose='child-guardianship' AND other_consent.withdrawn_at IS NULL
      JOIN siyue.subjects other_guardian ON other_guardian.id=other.guardian_subject_id
        AND other_guardian.kind='adult' AND other_guardian.status='active'
      JOIN siyue.subjects other_child ON other_child.id=other.child_subject_id
        AND other_child.kind='child' AND other_child.status='active'
      JOIN siyue.families other_family ON other_family.id=other.family_id AND other_family.status='active'
      JOIN siyue.family_memberships other_guardian_member ON other_guardian_member.family_id=other.family_id
        AND other_guardian_member.subject_id=other.guardian_subject_id AND other_guardian_member.active
      JOIN siyue.family_memberships other_child_member ON other_child_member.family_id=other.family_id
        AND other_child_member.subject_id=other.child_subject_id AND other_child_member.active
    WHERE other.child_subject_id=$1 AND other.active AND other.guardian_subject_id<>$2
    ORDER BY other.family_id,other.guardian_subject_id LIMIT 1
    FOR UPDATE OF other,other_consent,other_guardian,other_child,other_family,other_guardian_member,other_child_member`,
  [childId, subjectId])).rows[0];
  if (!other) throw new AuthError('AUTH_DELETION_DEPENDENCIES', 409);
}

/**
 * Internal step of a future deletion acceptance transaction: one current non-owner adult member ends
 * their own access to one still-active family, keeping the family and every other member's data intact.
 * The caller owns the transaction and the deleting subject's row lock, and passes one family from the
 * server-checked per-family disposition. This step commits nothing by itself, so a deletion that fails
 * later rolls back the membership deactivation and every revocation below.
 *
 * Only the caller's own rows change: their family membership is deactivated, their guardianship
 * relationships and the consents behind them are withdrawn, their child device grants and the restricted
 * sessions those authorize are revoked, their pending invitations and approved pairings stop being
 * usable, and their open rooms and seats are closed. Everyone else's membership, guardianship, grants,
 * live rooms and seats are left untouched, and the family stays active for its remaining members.
 *
 * A member who still guards a child is refused unless that child keeps another live guardian, so this
 * step can never strand a supervised child. That refusal is the only reason this step locks rows outside
 * the caller's own; it writes nothing outside them.
 */
export async function endOwnFamilyAccessForDeletion(client: PoolClient, subjectId: string,
  familyId: string, now: Date): Promise<void> {
  // The family lock serializes this exit with every other family mutation, which reads this row first:
  // freeze, transfer, invitation acceptance, room creation and guardianship changes all do.
  const family = (await client.query<FamilyRow>(
    'SELECT owner_subject_id,status FROM siyue.families WHERE id=$1 FOR UPDATE', [familyId])).rows[0];
  if (!family || family.status !== 'active' || family.owner_subject_id === subjectId)
    throw new AuthError('AUTH_DELETION_DEPENDENCIES', 409);
  // The caller already holds the deleting subject's own lock; locking the subject here too makes that
  // precondition harmless to restate and keeps the adult/active read from going stale.
  const member = (await client.query<MemberRow>(`
    SELECT m.role,m.active,s.kind,s.status FROM siyue.family_memberships m
      JOIN siyue.subjects s ON s.id=m.subject_id
    WHERE m.family_id=$1 AND m.subject_id=$2 FOR UPDATE OF m,s`, [familyId, subjectId])).rows[0];
  if (!member?.active || member.role === 'owner' || member.kind !== 'adult' || member.status !== 'active')
    throw new AuthError('AUTH_DELETION_DEPENDENCIES', 409);
  // Only a still-effective guardianship creates a dependency. A relationship already broken by a
  // withdrawn consent, an inactive child or a dead child membership supervises nothing, so it is revoked
  // below without blocking the exit. The relationship, its consent, the child membership and the child
  // subject are locked, so a concurrent change to any of them is either serialized before this read or
  // waits for this transaction to finish.
  const children = (await client.query<ChildRow>(`
    SELECT r.child_subject_id FROM siyue.guardian_relationships r
      JOIN siyue.consent_records c ON c.id=r.consent_record_id
        AND c.actor_subject_id=r.guardian_subject_id AND c.subject_id=r.child_subject_id
        AND c.purpose='child-guardianship' AND c.withdrawn_at IS NULL
      JOIN siyue.subjects child ON child.id=r.child_subject_id
        AND child.kind='child' AND child.status='active'
      JOIN siyue.family_memberships cm ON cm.family_id=r.family_id
        AND cm.subject_id=r.child_subject_id AND cm.active
    WHERE r.family_id=$1 AND r.guardian_subject_id=$2 AND r.active
    ORDER BY r.child_subject_id FOR UPDATE OF r,c,cm,child`, [familyId, subjectId])).rows;
  for (const child of children) await requireAnotherGuardian(client, child.child_subject_id, subjectId);

  await client.query(`UPDATE siyue.guardian_relationships SET active=false,version=version+1
    WHERE family_id=$1 AND guardian_subject_id=$2 AND active`, [familyId, subjectId]);
  // Only this guardian's own declaration is withdrawn, and only while no relationship of theirs in
  // another family still cites it: a consent shared that way belongs to that family's own disposition.
  await client.query(`UPDATE siyue.consent_records c SET withdrawn_at=GREATEST($3,c.recorded_at)
    WHERE c.withdrawn_at IS NULL AND c.actor_subject_id=$2 AND c.subject_id IS NOT NULL
      AND c.purpose='child-guardianship'
      AND EXISTS (SELECT 1 FROM siyue.guardian_relationships own
        WHERE own.consent_record_id=c.id AND own.family_id=$1 AND own.guardian_subject_id=$2)
      AND NOT EXISTS (SELECT 1 FROM siyue.guardian_relationships other
        WHERE other.consent_record_id=c.id AND NOT (other.family_id=$1 AND other.guardian_subject_id=$2))`,
  [familyId, subjectId, now]);
  await client.query(`UPDATE siyue.device_grants SET revoked_at=GREATEST($3,created_at),version=version+1
    WHERE family_id=$1 AND guardian_id=$2 AND revoked_at IS NULL`, [familyId, subjectId, now]);
  await client.query(`UPDATE siyue.auth_sessions
    SET revoked_at=COALESCE(revoked_at,$3),revoke_reason=COALESCE(revoke_reason,'family_member_exited')
    WHERE device_grant_id IN (SELECT id FROM siyue.device_grants WHERE family_id=$1 AND guardian_id=$2)`,
  [familyId, subjectId, now]);
  await client.query(`UPDATE siyue.refresh_tokens
    SET revoked_at=COALESCE(revoked_at,$3),retry_ciphertext=NULL,retry_expires_at=NULL
    WHERE session_id IN (SELECT s.id FROM siyue.auth_sessions s JOIN siyue.device_grants g
      ON g.id=s.device_grant_id WHERE g.family_id=$1 AND g.guardian_id=$2)`, [familyId, subjectId, now]);
  await client.query(`UPDATE siyue.device_pairing_requests SET status='expired'
    WHERE family_id=$1 AND approved_by=$2 AND status='approved'`, [familyId, subjectId]);
  await client.query(`UPDATE siyue.family_invitations
    SET status='revoked',token_ciphertext=NULL,token_ciphertext_expires_at=NULL
    WHERE family_id=$1 AND inviter_id=$2 AND status='pending'`, [familyId, subjectId]);
  await client.query(`UPDATE siyue.rooms SET status='ended',ended_at=GREATEST($3,created_at),version=version+1
    WHERE family_id=$1 AND created_by_subject_id=$2 AND status='open'`, [familyId, subjectId, now]);
  // A pending room invitation cannot remain actionable after its inviter or invitee exits, or after
  // the exiting member's room ends. Keep other members' invitations to their still-open rooms intact.
  await client.query(`UPDATE siyue.room_invitations i
    SET status='revoked',revoked_at=GREATEST($3,i.created_at)
    FROM siyue.rooms r WHERE i.room_id=r.id AND r.family_id=$1 AND i.status='pending'
      AND (i.inviter_subject_id=$2 OR i.invitee_subject_id=$2 OR r.created_by_subject_id=$2)`,
  [familyId, subjectId, now]);
  await client.query(`UPDATE siyue.room_seats SET released_at=GREATEST($2,claimed_at)
    WHERE subject_id=$1 AND room_id IN (SELECT id FROM siyue.rooms WHERE family_id=$3) AND released_at IS NULL`,
  [subjectId, now, familyId]);
  // The room kernel releases a room's seats when it ends that room. The rooms this member just ended
  // must not keep a live seat behind, while every other room keeps its own live seats untouched.
  await client.query(`UPDATE siyue.room_seats SET released_at=GREATEST($3,claimed_at)
    WHERE room_id IN (SELECT id FROM siyue.rooms
      WHERE family_id=$1 AND created_by_subject_id=$2 AND status='ended') AND released_at IS NULL`,
  [familyId, subjectId, now]);
  // Last, so every revocation above still applies if a concurrent change made the membership unusable.
  const membership = await client.query(`UPDATE siyue.family_memberships
    SET active=false,version=version+1
    WHERE family_id=$1 AND subject_id=$2 AND active`, [familyId, subjectId]);
  if (membership.rowCount !== 1) throw new AuthError('AUTH_DELETION_DEPENDENCIES', 409);
}
