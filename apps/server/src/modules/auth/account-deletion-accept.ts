import type { Pool, PoolClient } from 'pg';
import { deletionDependencyDispositionSchema, type DeletionDependencyDisposition,
  type DeletionReceipt } from '@siyue/contracts';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuthError, type SessionService } from './sessions.js';
import type { DeletionLedgerStore } from '../../account-deletion-ledger/ledger-store.js';
import type { AccountDeletionImpactService } from './account-deletion-impact.js';
import type { AccountDeletionJobStore } from './account-deletion-jobs.js';
import type { createAppleRevocationOutbox } from '../../identities/apple/revocation-outbox.js';
import { inspectAccountDeletionBlockers } from './account-deletion-cleanup.js';
import { resolveAccountDeletionDisposition } from './account-deletion-disposition.js';
import { freezeOwnedFamilyForDeletion, transferOwnedFamilyForDeletion } from './account-deletion-family.js';
import { endOwnFamilyAccessForDeletion } from './account-deletion-member-exit.js';
import { dissolveEmptyOwnedFamilyForDeletion } from './account-deletion-empty-family.js';
import type { AccountDeletionIdempotencyStore } from './account-deletion-idempotency.js';

/**
 * Internal acceptance kernel for an adult with resolved transfers or frozen family review cases. The ledger intent commits
 * before the main transaction commits, and the accepted marker follows that commit. No HTTP route:
 * complete review resolution and formal route validation are still required.
 */
export function createAccountDeletionAcceptKernel(pool: Pool, sessions: SessionService,
  impact: AccountDeletionImpactService, jobs: AccountDeletionJobStore,
  revocations: Pick<ReturnType<typeof createAppleRevocationOutbox>,'enqueueForSubject'>,
  ledger: Pick<DeletionLedgerStore,'prepare'|'markAccepted'|'cancel'>,
  clock: () => Date = () => new Date(),
  idempotency?: Pick<AccountDeletionIdempotencyStore,'insert'>) {
  return {
    async acceptUnattached(input: {accessToken:string;reauthGrant:string;confirmation:true;
      dependencyDisposition:DeletionDependencyDisposition;idempotencyKey?:string}):Promise<DeletionReceipt> {
      if (!z.object({accessToken:z.string().min(1),reauthGrant:z.string().min(1),confirmation:z.literal(true),
        dependencyDisposition:deletionDependencyDispositionSchema,
        idempotencyKey:z.string().min(1).optional()})
        .strict().safeParse(input).success || (idempotency && !input.idempotencyKey))
        throw new AuthError('AUTH_INVALID_REQUEST',400);
      // Resolve the subject, then verify it under the main transaction lock before preparing. The
      // ordinary session gate must see a clear ledger for that verification; the new prepared marker
      // intentionally blocks later session operations while this transaction is in flight.
      const preliminary=await sessions.verify(input.accessToken);
      if(preliminary.subjectKind!=='adult')throw new AuthError('AUTH_ADULT_REQUIRED',403);
      const deletionId=randomUUID();
      let client: PoolClient|undefined;
      let commitStarted=false,definitelyRolledBack=false,broken=false,intentPrepared=false;
      let receipt: DeletionReceipt|undefined;
      try {
        client=await pool.connect();
        await client.query('BEGIN');
        receipt=await (async(client:PoolClient)=>{
        const session = await sessions.verifyForMutation(client,input.accessToken);
        if(session.subjectId!==preliminary.subjectId)throw new AuthError('AUTH_ACCESS_INVALID',401);
        if (session.subjectKind !== 'adult') throw new AuthError('AUTH_ADULT_REQUIRED',403);
        const now = clock();
        const dependencies = await impact.inspectLocked(client,session.subjectId,now);
        const disposition=resolveAccountDeletionDisposition(dependencies,input.dependencyDisposition);
        const frozenForReview:string[]=[];
        for(const familyId of disposition.familyIds) {
          const choice=disposition.familyChoices.get(familyId);
          if(choice?.kind==='transfer')
            await transferOwnedFamilyForDeletion(client,session.subjectId,familyId,
              choice.recipientSubjectId,now);
          else if(choice?.kind==='end-family-access'){
            const family=dependencies.families.find(entry=>entry.familyId===familyId);
            if(!family)throw new AuthError('AUTH_DELETION_DEPENDENCIES',409);
            if(family.role==='owner'){
              if(family.otherActiveAdultCount+family.otherActiveChildCount===0)
                await dissolveEmptyOwnedFamilyForDeletion(client,session.subjectId,familyId);
              else{
                await freezeOwnedFamilyForDeletion(client,session.subjectId,familyId,now);
                frozenForReview.push(familyId);
              }
            }else await endOwnFamilyAccessForDeletion(client,session.subjectId,familyId,now);
          } else throw new AuthError('AUTH_DELETION_DEPENDENCIES',409);
        }
        // Only this transaction's explicitly frozen families may retain ownership, membership and
        // guardianship for review. Orphaned consent, another family or live device/room authority
        // still blocks the whole request. The cleanup worker uses the same scan without exemptions.
        if ((await inspectAccountDeletionBlockers(client,session.subjectId,now,frozenForReview)).length)
          throw new AuthError('AUTH_DELETION_DEPENDENCIES',409);
        const provider = await client.query(`SELECT 1 FROM siyue.external_identities
          WHERE subject_id=$1 AND provider='apple' AND status='active' LIMIT 1`,[session.subjectId]);
        await sessions.consumeReauth(client,session.sessionId,input.reauthGrant,'delete-account');
        const prepared=await ledger.prepare({subjectId:session.subjectId,intentId:deletionId});
        if(prepared.status!=='prepared'||prepared.intentId!==deletionId)
          throw new AuthError('AUTH_ACCESS_INVALID',401);
        intentPrepared=true;
        const queued=await revocations.enqueueForSubject(client,{subjectId:session.subjectId});
        await client.query(`UPDATE siyue.subjects SET status='deletion_pending',
          credential_version=credential_version+1,updated_at=$2 WHERE id=$1`,[session.subjectId,now]);
        await client.query(`UPDATE siyue.auth_sessions SET revoked_at=COALESCE(revoked_at,$2),
          revoke_reason=COALESCE(revoke_reason,'account_deletion') WHERE subject_id=$1`,[session.subjectId,now]);
        await client.query(`UPDATE siyue.refresh_tokens SET revoked_at=COALESCE(revoked_at,$2),
          retry_ciphertext=NULL,retry_expires_at=NULL WHERE session_id IN
          (SELECT id FROM siyue.auth_sessions WHERE subject_id=$1)`,[session.subjectId,now]);
        await client.query(`UPDATE siyue.reauth_grants SET consumed_at=COALESCE(consumed_at,$2)
          WHERE subject_id=$1`,[session.subjectId,now]);
        await client.query(`UPDATE siyue.outbox_jobs SET status='cancelled',payload_ciphertext=NULL,completed_at=$2
          WHERE status='pending' AND aggregate_id IN
          (SELECT id FROM siyue.email_challenges WHERE subject_id=$1 AND status='pending')`,
          [session.subjectId,now]);
        await client.query(`UPDATE siyue.email_challenges SET status='superseded'
          WHERE subject_id=$1 AND status='pending'`,[session.subjectId]);
        const receipt = await jobs.insertPending(client,{subjectId:session.subjectId,deletionId,
          receiptExpiresAt:new Date(+now+30*86_400_000),providerRevocationPending:Boolean(provider.rowCount)});
        for(const familyId of frozenForReview)
          await client.query(`INSERT INTO siyue.account_deletion_family_reviews
            (id,deletion_id,family_id,deleting_subject_id,state,opened_at)
            VALUES($1,$2,$3,$4,'pending',$5)`,
          [randomUUID(),receipt.deletionId,familyId,session.subjectId,now]);
        if(idempotency)await idempotency.insert(client,{key:input.idempotencyKey!,accessToken:input.accessToken,
          reauthGrant:input.reauthGrant,confirmation:true,dependencyDisposition:input.dependencyDisposition},{receipt});
        // A previously linked Apple identity may have lost its provider credential. Apple says
        // that absence must not prevent Siyue account deletion; keep the external dimension open
        // for a manual revocation instruction rather than claiming provider success.
        if (provider.rowCount && queued.identities===0)
          await client.query(`UPDATE siyue.account_deletion_jobs SET last_error_code='apple_credential_missing'
            WHERE id=$1`,[receipt.deletionId]);
        await client.query(`INSERT INTO siyue.security_events
          (id,event_type,subject_id,session_id,request_id,outcome,occurred_at,expires_at)
          VALUES($1,'account.deletion.accept',$2,$3,$4,'success',$5,$6)`,
          [randomUUID(),session.subjectId,session.sessionId,receipt.deletionId,now,
            new Date(+now+30*86_400_000)]);
        return receipt;
        })(client);
        commitStarted=true;
        await client.query('COMMIT');
      } catch(error) {
        if(!commitStarted){
          if(!client)definitelyRolledBack=true;
          else try{await client.query('ROLLBACK');definitelyRolledBack=true;}catch{broken=true;/* uncertain: leave prepared */}
        }
        else broken=true;
        if(definitelyRolledBack&&intentPrepared)
          await ledger.cancel({subjectId:preliminary.subjectId,intentId:deletionId});
        throw error;
      } finally {client?.release(broken);}
      // If this write is unavailable, reconciliation will find the committed job and promote its
      // prepared marker; never cancel after the main commit or return a successful receipt early.
      const accepted=await ledger.markAccepted({subjectId:preliminary.subjectId,intentId:deletionId});
      if(accepted.status!=='accepted'||accepted.intentId!==deletionId||
        accepted.subjectId!==preliminary.subjectId)
        throw new AuthError('AUTH_TEMPORARILY_UNAVAILABLE',503);
      if(!receipt)throw new Error('account_deletion_receipt_missing');
      return receipt;
    },
  };
}
