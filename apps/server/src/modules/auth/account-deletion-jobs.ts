import {createHash, randomBytes, timingSafeEqual, randomUUID} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import {z} from 'zod';
import {deletionReceiptSchema, deletionStatusRequestSchema, deletionStatusSchema,
  type DeletionReceipt, type DeletionStatus} from '@siyue/contracts';
import {AuthError} from './sessions.js';

const day=86_400_000;
const hash=(secret:string)=>createHash('sha256').update(secret,'utf8').digest();
const invalidReceipt=()=>new AuthError('AUTH_DELETION_RECEIPT_INVALID',404);

interface JobRow {
  receipt_secret_hash:string;
  receipt_expires_at:Date;
  local_data_deleted:boolean;
  provider_revocation_pending:boolean;
  completed_at:Date|null;
  last_error_code:string|null;
}

/**
 * Internal deletion-job and receipt store. The caller must keep `insertPending` in the main-database
 * transaction that accepts a deletion and invalidates sessions. The caller supplies the ledger
 * intent UUID as `deletionId` when using the cross-database protocol; this store does not operate
 * the ledger. Nothing here opens the deletion endpoint or claims that data is already removed.
 */
export function createAccountDeletionJobStore(pool:Pool,clock:()=>Date=()=>new Date()) {
  return {
    /** Return this one-time receipt to the client only after the caller's transaction has committed. */
    async insertPending(client:PoolClient,input:{subjectId:string;receiptExpiresAt:Date;
      providerRevocationPending:boolean;deletionId?:string}):Promise<DeletionReceipt> {
      const now=clock();
      if(!z.uuid().safeParse(input.subjectId).success||
        !(input.receiptExpiresAt instanceof Date)||!Number.isFinite(+input.receiptExpiresAt)||
        +input.receiptExpiresAt<=+now||+input.receiptExpiresAt>+now+90*day||
        typeof input.providerRevocationPending!=='boolean'||
        (input.deletionId!==undefined&&!z.uuid().safeParse(input.deletionId).success))
        throw new AuthError('AUTH_INVALID_REQUEST',400);
      const subject=(await client.query<{status:string}>(
        'SELECT status FROM siyue.subjects WHERE id=$1 FOR UPDATE',[input.subjectId])).rows[0];
      if(!subject||subject.status!=='deletion_pending')throw new AuthError('AUTH_DELETION_NOT_PENDING',409);
      const deletionId=input.deletionId??randomUUID(),receiptSecret=randomBytes(32).toString('base64url');
      await client.query(`INSERT INTO siyue.account_deletion_jobs
        (id,subject_id,state,requested_at,provider_revocation_pending,receipt_secret_hash,receipt_expires_at)
        VALUES($1,$2,'accepted',$3,$4,$5,$6)`,
      [deletionId,input.subjectId,now,input.providerRevocationPending,hash(receiptSecret).toString('hex'),input.receiptExpiresAt]);
      return deletionReceiptSchema.parse({deletionId,receiptSecret,expiresAt:input.receiptExpiresAt.toISOString()});
    },
    /** Receipt-only, deliberately unauthenticated status read: unknown, wrong and expired proof agree. */
    async status(input:unknown):Promise<DeletionStatus> {
      const request=deletionStatusRequestSchema.safeParse(input);
      if(!request.success)throw new AuthError('AUTH_INVALID_REQUEST',400);
      const row=(await pool.query<JobRow>(`SELECT receipt_secret_hash,receipt_expires_at,local_data_deleted,
        provider_revocation_pending,completed_at,last_error_code FROM siyue.account_deletion_jobs WHERE id=$1`,
      [request.data.deletionId])).rows[0];
      const actual=hash(request.data.receiptSecret);
      const expected=Buffer.from(row?.receipt_secret_hash??'0'.repeat(64),'hex');
      const proofMatches=expected.length===actual.length&&timingSafeEqual(actual,expected);
      if(!row||!proofMatches||+row.receipt_expires_at<=+clock())throw invalidReceipt();
      return deletionStatusSchema.parse({serverDataDeleted:row.local_data_deleted,
        providerRevocationPending:row.provider_revocation_pending,
        completedAt:row.completed_at?.toISOString()??null,lastErrorCode:row.last_error_code});
    },
  };
}
export type AccountDeletionJobStore=ReturnType<typeof createAccountDeletionJobStore>;
