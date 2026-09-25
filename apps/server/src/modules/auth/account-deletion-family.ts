import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { AuthError } from './sessions.js';
import { consumeFamilyManagementAcceptance } from './family-management-acceptance.js';

/** Transfer only after the recipient's own current, explicit acceptance has been consumed. The
 * caller owns the same transaction as deletion acceptance, so a failed deletion rolls the whole
 * transfer and every consent/device change back. Shared works and other members are untouched. */
export async function transferOwnedFamilyForDeletion(client:PoolClient,ownerId:string,
  familyId:string,recipientId:string,now:Date):Promise<void> {
  const scope=await consumeFamilyManagementAcceptance(client,familyId,ownerId,recipientId,now);
  const children=(await client.query<{child_subject_id:string;policy_version:string}>(`
    SELECT r.child_subject_id,c.policy_version FROM siyue.guardian_relationships r
      JOIN siyue.consent_records c ON c.id=r.consent_record_id
        AND c.actor_subject_id=r.guardian_subject_id AND c.subject_id=r.child_subject_id
        AND c.purpose='child-guardianship' AND c.withdrawn_at IS NULL
      JOIN siyue.family_memberships cm ON cm.family_id=r.family_id
        AND cm.subject_id=r.child_subject_id AND cm.active
      JOIN siyue.subjects child ON child.id=r.child_subject_id
        AND child.kind='child' AND child.status='active'
    WHERE r.family_id=$1 AND r.guardian_subject_id=$2 AND r.active
    ORDER BY r.child_subject_id FOR UPDATE OF r,c,cm`,[familyId,ownerId])).rows;
  if(children.length!==scope.childCount)throw new AuthError('AUTH_DELETION_DEPENDENCIES',409);
  for(const child of children) {
    const existing=(await client.query<{active:boolean;withdrawn_at:Date|null}>(`
      SELECT r.active,c.withdrawn_at FROM siyue.guardian_relationships r
      JOIN siyue.consent_records c ON c.id=r.consent_record_id
        AND c.actor_subject_id=r.guardian_subject_id AND c.subject_id=r.child_subject_id
        AND c.purpose='child-guardianship'
      WHERE r.family_id=$1 AND r.guardian_subject_id=$2 AND r.child_subject_id=$3 FOR UPDATE OF r,c`,
    [familyId,recipientId,child.child_subject_id])).rows[0];
    if(existing?.active && existing.withdrawn_at===null)continue;
    if(existing)throw new AuthError('AUTH_DELETION_DEPENDENCIES',409);
    const consentId=randomUUID();
    await client.query(`INSERT INTO siyue.consent_records
      (id,actor_subject_id,subject_id,purpose,policy_version,recorded_at)
      VALUES($1,$2,$3,'child-guardianship',$4,$5)`,
    [consentId,recipientId,child.child_subject_id,child.policy_version,now]);
    await client.query(`INSERT INTO siyue.guardian_relationships
      (family_id,guardian_subject_id,child_subject_id,consent_record_id)
      VALUES($1,$2,$3,$4)`,[familyId,recipientId,child.child_subject_id,consentId]);
  }
  const oldMembership=await client.query(`UPDATE siyue.family_memberships
    SET active=false,role='member',version=version+1
    WHERE family_id=$1 AND subject_id=$2 AND active AND role='owner'`,[familyId,ownerId]);
  if(oldMembership.rowCount!==1)throw new AuthError('AUTH_DELETION_DEPENDENCIES',409);
  const nextMembership=await client.query(`UPDATE siyue.family_memberships
    SET role='owner',version=version+1
    WHERE family_id=$1 AND subject_id=$2 AND active AND role<>'owner'`,[familyId,recipientId]);
  if(nextMembership.rowCount!==1)throw new AuthError('AUTH_DELETION_DEPENDENCIES',409);
  const family=await client.query(`UPDATE siyue.families
    SET owner_subject_id=$3,version=version+1
    WHERE id=$1 AND owner_subject_id=$2 AND status='active'`,[familyId,ownerId,recipientId]);
  if(family.rowCount!==1)throw new AuthError('AUTH_DELETION_DEPENDENCIES',409);
  await client.query(`UPDATE siyue.guardian_relationships SET active=false,version=version+1
    WHERE family_id=$1 AND guardian_subject_id=$2 AND active`,[familyId,ownerId]);
  // Only this owner's own declaration is withdrawn, and only while no relationship of theirs in another
  // family still cites it: a consent shared that way belongs to that family's own disposition.
  await client.query(`UPDATE siyue.consent_records SET withdrawn_at=GREATEST($2,recorded_at)
    WHERE id IN (SELECT consent_record_id FROM siyue.guardian_relationships
      WHERE family_id=$1 AND guardian_subject_id=$3) AND withdrawn_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM siyue.guardian_relationships other
        WHERE other.consent_record_id=siyue.consent_records.id
          AND NOT (other.family_id=$1 AND other.guardian_subject_id=$3))`,[familyId,now,ownerId]);
  await client.query(`UPDATE siyue.device_grants
    SET revoked_at=GREATEST($3,created_at),version=version+1
    WHERE family_id=$1 AND guardian_id=$2 AND revoked_at IS NULL`,[familyId,ownerId,now]);
  await client.query(`UPDATE siyue.auth_sessions
    SET revoked_at=COALESCE(revoked_at,$3),revoke_reason=COALESCE(revoke_reason,'guardian_transferred')
    WHERE device_grant_id IN (SELECT id FROM siyue.device_grants WHERE family_id=$1 AND guardian_id=$2)`,
  [familyId,ownerId,now]);
  await client.query(`UPDATE siyue.refresh_tokens
    SET revoked_at=COALESCE(revoked_at,$3),retry_ciphertext=NULL,retry_expires_at=NULL
    WHERE session_id IN (SELECT s.id FROM siyue.auth_sessions s JOIN siyue.device_grants g
      ON g.id=s.device_grant_id WHERE g.family_id=$1 AND g.guardian_id=$2)`,[familyId,ownerId,now]);
  await client.query(`UPDATE siyue.device_pairing_requests SET status='expired'
    WHERE family_id=$1 AND approved_by=$2 AND status='approved'`,[familyId,ownerId]);
  await client.query(`UPDATE siyue.family_invitations
    SET status='revoked',token_ciphertext=NULL,token_ciphertext_expires_at=NULL
    WHERE family_id=$1 AND inviter_id=$2 AND status='pending'`,[familyId,ownerId]);
  await client.query(`UPDATE siyue.rooms SET status='ended',ended_at=GREATEST($3,created_at),version=version+1
    WHERE family_id=$1 AND created_by_subject_id=$2 AND status='open'`,[familyId,ownerId,now]);
  // Every pending room invitation was pinned to the family's previous version. Even invitations
  // issued by the new owner cannot be accepted after transfer, so close them explicitly rather than
  // leaving an unusable row displayed as pending. Other families are untouched.
  await client.query(`UPDATE siyue.room_invitations i
    SET status='revoked',revoked_at=GREATEST($2,i.created_at)
    FROM siyue.rooms r WHERE i.room_id=r.id AND r.family_id=$1 AND i.status='pending'`,
  [familyId,now]);
  await client.query(`UPDATE siyue.room_seats SET released_at=GREATEST($3,claimed_at)
    WHERE subject_id=$2 AND room_id IN (SELECT id FROM siyue.rooms WHERE family_id=$1)
      AND released_at IS NULL`,[familyId,ownerId,now]);
  await client.query(`UPDATE siyue.room_seats SET released_at=GREATEST($2,claimed_at)
    WHERE room_id IN (SELECT id FROM siyue.rooms WHERE family_id=$1 AND status='ended')
      AND released_at IS NULL`,[familyId,now]);
}

/** Internal step of a future deletion acceptance transaction. Caller holds the deleting adult's
 * subject lock and supplies a family from the server-checked per-family disposition. This step
 * commits nothing by itself: a failed deletion must roll back the freeze and every revocation. */
export async function freezeOwnedFamilyForDeletion(client: PoolClient, subjectId: string,
  familyId: string, now: Date): Promise<void> {
  const family = (await client.query<{owner_subject_id:string;status:string}>(
    'SELECT owner_subject_id,status FROM siyue.families WHERE id=$1 FOR UPDATE', [familyId])).rows[0];
  if (!family || family.status !== 'active' || family.owner_subject_id !== subjectId)
    throw new AuthError('AUTH_DELETION_DEPENDENCIES', 409);
  const owner = (await client.query<{role:string}>(`SELECT role FROM siyue.family_memberships
    WHERE family_id=$1 AND subject_id=$2 AND active FOR UPDATE`, [familyId, subjectId])).rows[0];
  if (owner?.role !== 'owner') throw new AuthError('AUTH_DELETION_DEPENDENCIES', 409);
  const remaining = (await client.query<{subject_id:string}>(`SELECT m.subject_id
    FROM siyue.family_memberships m JOIN siyue.subjects s ON s.id=m.subject_id
    WHERE m.family_id=$1 AND m.subject_id<>$2 AND m.active AND s.status='active'
    FOR UPDATE OF m`, [familyId, subjectId])).rows;
  if (remaining.length === 0) throw new AuthError('AUTH_DELETION_DEPENDENCIES', 409);

  await client.query("UPDATE siyue.families SET status='frozen',version=version+1 WHERE id=$1", [familyId]);
  await client.query(`UPDATE siyue.device_grants
    SET revoked_at=GREATEST($2,created_at),version=version+1
    WHERE family_id=$1 AND revoked_at IS NULL`, [familyId, now]);
  await client.query(`UPDATE siyue.auth_sessions
    SET revoked_at=COALESCE(revoked_at,$2),revoke_reason=COALESCE(revoke_reason,'family_frozen')
    WHERE device_grant_id IN (SELECT id FROM siyue.device_grants WHERE family_id=$1)`, [familyId, now]);
  await client.query(`UPDATE siyue.refresh_tokens
    SET revoked_at=COALESCE(revoked_at,$2),retry_ciphertext=NULL,retry_expires_at=NULL
    WHERE session_id IN (SELECT s.id FROM siyue.auth_sessions s
      JOIN siyue.device_grants g ON g.id=s.device_grant_id WHERE g.family_id=$1)`, [familyId, now]);
  await client.query(`UPDATE siyue.device_pairing_requests SET status='expired'
    WHERE family_id=$1 AND status='approved'`, [familyId]);
  await client.query(`UPDATE siyue.family_invitations
    SET status='revoked',token_ciphertext=NULL,token_ciphertext_expires_at=NULL
    WHERE family_id=$1 AND status='pending'`, [familyId]);
  await client.query(`UPDATE siyue.rooms
    SET status='ended',ended_at=GREATEST($2,created_at),version=version+1
    WHERE family_id=$1 AND status='open'`, [familyId, now]);
  // Freezing ends every room in this family. Close pending room invitations in the same transaction,
  // so a later review cannot turn a previously pending invitation back into a live authorization.
  await client.query(`UPDATE siyue.room_invitations
    SET status='revoked',revoked_at=GREATEST($2,created_at)
    WHERE status='pending' AND room_id IN (SELECT id FROM siyue.rooms WHERE family_id=$1)`,
  [familyId, now]);
  await client.query(`UPDATE siyue.room_seats
    SET released_at=GREATEST($2,claimed_at)
    WHERE room_id IN (SELECT id FROM siyue.rooms WHERE family_id=$1) AND released_at IS NULL`,
  [familyId, now]);
}
