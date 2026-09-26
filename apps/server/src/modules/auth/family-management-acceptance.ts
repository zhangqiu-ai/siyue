import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { familyManagementAcceptanceRequestSchema,familyManagementAcceptancePreviewSchema,
  familyManagementAcceptanceReceiptSchema, type FamilyManagementAcceptanceReceipt } from '@siyue/contracts';
import { transaction } from '../../adapters/postgres/database.js';
import { AuthError, type SessionService } from './sessions.js';

const id = z.uuid();
const lifetimeMs = 24 * 60 * 60 * 1000;
type FamilyRow = {owner_subject_id:string;status:string;version:number};
type MemberRow = {subject_id:string;role:string;active:boolean;version:number;kind:string;status:string};
type ChildRow = {child_subject_id:string;relationship_version:number;consent_record_id:string;
  child_membership_version:number;policy_version:string};
type AcceptanceRow = {id:string;owner_subject_id:string;family_version:number;recipient_membership_version:number;
  owner_membership_version:number;child_scope_digest:string;accepted_at:Date;expires_at:Date};

/** The server-computed scope the recipient saw and explicitly accepted. Called under one caller-owned
 * transaction; the family and membership rows are locked so deletion cannot consume an acceptance
 * while the recipient's membership or owner is being changed. No client-provided subject or child set
 * participates in this digest. */
export async function readFamilyManagementScope(client:PoolClient, familyId:string,
  recipientId:string) {
  const family=(await client.query<FamilyRow>(`SELECT owner_subject_id,status,version
    FROM siyue.families WHERE id=$1 FOR UPDATE`,[familyId])).rows[0];
  if(!family || family.status!=='active' || family.owner_subject_id===recipientId)
    throw new AuthError('FAMILY_NOT_FOUND',404);
  const members=(await client.query<MemberRow>(`SELECT m.subject_id,m.role,m.active,m.version,s.kind,s.status
    FROM siyue.family_memberships m JOIN siyue.subjects s ON s.id=m.subject_id
    WHERE m.family_id=$1 AND m.subject_id=ANY($2::uuid[]) ORDER BY m.subject_id FOR UPDATE OF m,s`,
  [familyId,[family.owner_subject_id,recipientId]])).rows;
  const owner=members.find(row=>row.subject_id===family.owner_subject_id);
  const recipient=members.find(row=>row.subject_id===recipientId);
  if(!owner?.active || owner.role!=='owner' || owner.kind!=='adult' || owner.status!=='active' ||
     !recipient?.active || recipient.kind!=='adult' || recipient.status!=='active')
    throw new AuthError('FAMILY_NOT_FOUND',404);
  const children=(await client.query<ChildRow>(`SELECT r.child_subject_id,r.version AS relationship_version,
      r.consent_record_id,cm.version AS child_membership_version,c.policy_version
    FROM siyue.guardian_relationships r
      JOIN siyue.consent_records c ON c.id=r.consent_record_id
        AND c.actor_subject_id=r.guardian_subject_id AND c.subject_id=r.child_subject_id
        AND c.purpose='child-guardianship' AND c.withdrawn_at IS NULL
      JOIN siyue.family_memberships cm ON cm.family_id=r.family_id
        AND cm.subject_id=r.child_subject_id AND cm.active
      JOIN siyue.subjects child ON child.id=r.child_subject_id
        AND child.kind='child' AND child.status='active'
    WHERE r.family_id=$1 AND r.guardian_subject_id=$2 AND r.active
    ORDER BY r.child_subject_id FOR UPDATE OF r,c,cm,child`,
  [familyId,family.owner_subject_id])).rows;
  const childScopeDigest=createHash('sha256').update(JSON.stringify({familyId,
    ownerSubjectId:family.owner_subject_id,
    children:children.map(row=>[row.child_subject_id,row.relationship_version,
      row.consent_record_id,row.child_membership_version,row.policy_version])})).digest('hex');
  return {familyId,ownerSubjectId:family.owner_subject_id,recipientSubjectId:recipientId,
    familyVersion:family.version,ownerMembershipVersion:owner.version,
    membershipVersion:recipient.version,childScopeDigest,childCount:children.length};
}

/** The recipient acts in their own verified adult session. This records intent only; it does not
 * change ownership or guardianship. A later deletion transaction recomputes the same scope before
 * consuming the record. */
export function createFamilyManagementAcceptanceService(pool:Pool,sessions:SessionService,
  clock:()=>Date=()=>new Date()) {
  async function current(accessToken:string,familyId:string) {
    if(!id.safeParse(familyId).success)throw new AuthError('FAMILY_INVALID_REQUEST',400);
    return transaction(pool,async client=>{
      const session=await sessions.verifyForMutation(client,accessToken);
      if(session.subjectKind!=='adult')throw new AuthError('FAMILY_ADULT_REQUIRED',403);
      return familyManagementAcceptancePreviewSchema.parse(
        await readFamilyManagementScope(client,familyId,session.subjectId));
    });
  }
  return {
    preview:current,
    async accept(accessToken:string,familyId:string,input:unknown):Promise<FamilyManagementAcceptanceReceipt> {
      const parsed=familyManagementAcceptanceRequestSchema.safeParse(input);
      if(!id.safeParse(familyId).success || !parsed.success)
        throw new AuthError('FAMILY_INVALID_REQUEST',400);
      return transaction(pool,async client=>{
        const session=await sessions.verifyForMutation(client,accessToken);
        if(session.subjectKind!=='adult')throw new AuthError('FAMILY_ADULT_REQUIRED',403);
        const scope=await readFamilyManagementScope(client,familyId,session.subjectId);
        const request=parsed.data;
        if(request.expectedFamilyVersion!==scope.familyVersion ||
           request.expectedMembershipVersion!==scope.membershipVersion ||
           request.expectedOwnerMembershipVersion!==scope.ownerMembershipVersion ||
           request.expectedChildScopeDigest!==scope.childScopeDigest)
          throw new AuthError('FAMILY_STALE_AUTHORIZATION',409);
        const now=clock(),acceptanceId=randomUUID(),expiresAt=new Date(+now+lifetimeMs);
        const prior=(await client.query<AcceptanceRow>(`SELECT id,owner_subject_id,family_version,
          recipient_membership_version,owner_membership_version,child_scope_digest,accepted_at,expires_at
          FROM siyue.family_management_acceptances
          WHERE family_id=$1 AND recipient_subject_id=$2 AND consumed_at IS NULL AND superseded_at IS NULL
          FOR UPDATE`,[familyId,session.subjectId])).rows[0];
        if(prior && prior.owner_subject_id===scope.ownerSubjectId &&
           prior.family_version===scope.familyVersion &&
           prior.recipient_membership_version===scope.membershipVersion &&
           prior.owner_membership_version===scope.ownerMembershipVersion &&
           prior.child_scope_digest===scope.childScopeDigest && +prior.expires_at>+now)
          return familyManagementAcceptanceReceiptSchema.parse({acceptanceId:prior.id,familyId,
            recipientSubjectId:session.subjectId,ownerSubjectId:scope.ownerSubjectId,
            familyVersion:scope.familyVersion,membershipVersion:scope.membershipVersion,
            ownerMembershipVersion:scope.ownerMembershipVersion,childScopeDigest:scope.childScopeDigest,
            acceptedAt:prior.accepted_at.toISOString(),expiresAt:prior.expires_at.toISOString(),consumedAt:null});
        await client.query(`UPDATE siyue.family_management_acceptances
          SET superseded_at=GREATEST($3,accepted_at)
          WHERE family_id=$1 AND recipient_subject_id=$2 AND consumed_at IS NULL AND superseded_at IS NULL`,
        [familyId,session.subjectId,now]);
        await client.query(`INSERT INTO siyue.family_management_acceptances
          (id,family_id,owner_subject_id,recipient_subject_id,family_version,
           recipient_membership_version,owner_membership_version,child_scope_digest,accepted_at,expires_at,retain_until)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [acceptanceId,familyId,scope.ownerSubjectId,session.subjectId,scope.familyVersion,
          scope.membershipVersion,scope.ownerMembershipVersion,scope.childScopeDigest,now,expiresAt,
          new Date(+now+30*lifetimeMs)]);
        await client.query(`INSERT INTO siyue.security_events
          (id,event_type,subject_id,session_id,request_id,outcome,redacted_metadata,occurred_at,expires_at)
          VALUES($1,'family.management.accept',$2,$3,$4,'success',
            jsonb_build_object('familyId',$5::uuid),$6,$7)`,
        [randomUUID(),session.subjectId,session.sessionId,acceptanceId,familyId,now,
          new Date(+now+30*lifetimeMs)]);
        return familyManagementAcceptanceReceiptSchema.parse({acceptanceId,familyId,
          recipientSubjectId:session.subjectId,ownerSubjectId:scope.ownerSubjectId,
          familyVersion:scope.familyVersion,membershipVersion:scope.membershipVersion,
          ownerMembershipVersion:scope.ownerMembershipVersion,childScopeDigest:scope.childScopeDigest,
          acceptedAt:now.toISOString(),expiresAt:expiresAt.toISOString(),consumedAt:null});
      });
    },
    /** Bounded retention sweep. Consumed consent has its own guardian record; this temporary
     * management declaration is removed after 30 days rather than accumulating indefinitely. */
    async cleanupExpired():Promise<number> {
      const result=await pool.query(`DELETE FROM siyue.family_management_acceptances
        WHERE id IN (SELECT id FROM siyue.family_management_acceptances
          WHERE retain_until<=$1 ORDER BY retain_until,id LIMIT 100)`,[clock()]);
      return result.rowCount??0;
    },
  };
}

/** Called inside the deleting owner's transaction, after its own action proof is checked. No
 * recipient identifier from the deletion request is trusted until this re-read succeeds. */
export async function consumeFamilyManagementAcceptance(client:PoolClient,familyId:string,
  ownerId:string,recipientId:string,now:Date) {
  let scope:Awaited<ReturnType<typeof readFamilyManagementScope>>;
  try {scope=await readFamilyManagementScope(client,familyId,recipientId);}
  catch(error) {
    if(error instanceof AuthError)throw new AuthError('AUTH_DELETION_DEPENDENCIES',409);
    throw error;
  }
  if(scope.ownerSubjectId!==ownerId)throw new AuthError('AUTH_DELETION_DEPENDENCIES',409);
  const record=(await client.query<AcceptanceRow>(`SELECT id,owner_subject_id,family_version,recipient_membership_version,
      owner_membership_version,child_scope_digest,accepted_at,expires_at
    FROM siyue.family_management_acceptances
    WHERE family_id=$1 AND recipient_subject_id=$2 AND owner_subject_id=$3
      AND consumed_at IS NULL AND superseded_at IS NULL FOR UPDATE`,
  [familyId,recipientId,ownerId])).rows[0];
  if(!record || +record.expires_at<=+now || record.family_version!==scope.familyVersion ||
     record.recipient_membership_version!==scope.membershipVersion ||
     record.owner_membership_version!==scope.ownerMembershipVersion ||
     record.child_scope_digest!==scope.childScopeDigest)
    throw new AuthError('AUTH_DELETION_DEPENDENCIES',409);
  await client.query('UPDATE siyue.family_management_acceptances SET consumed_at=GREATEST($2,accepted_at) WHERE id=$1',
    [record.id,now]);
  return scope;
}
