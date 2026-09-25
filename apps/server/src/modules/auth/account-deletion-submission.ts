import type { Pool } from 'pg';
import type { DeletionDependencyDisposition, DeletionReceipt } from '@siyue/contracts';
import type { DeletionLedgerStore } from '../../account-deletion-ledger/ledger-store.js';
import { AuthError } from './sessions.js';
import type { AccountDeletionIdempotencyStore } from './account-deletion-idempotency.js';
import type { createAccountDeletionAcceptKernel } from './account-deletion-accept.js';

type Submission = {key:string;accessToken:string;reauthGrant:string;confirmation:true;
  dependencyDisposition:DeletionDependencyDisposition};

/** A retry may use the original bearer after that bearer was revoked by the committed deletion.
 * The sealed short-lived response is bound to every original credential and request field. The
 * independent ledger still has to attest that exact committed job before the receipt is returned.
 */
export function createAccountDeletionSubmission(pool:Pool,
  accept:ReturnType<typeof createAccountDeletionAcceptKernel>,
  idempotency:Pick<AccountDeletionIdempotencyStore,'lookup'>,
  ledger:Pick<DeletionLedgerStore,'lookup'>) {
  async function recovered(input:Submission):Promise<DeletionReceipt|null> {
    const previous=await idempotency.lookup(input);
    if(previous.kind==='conflict')throw new AuthError('AUTH_IDEMPOTENCY_CONFLICT',409);
    if(previous.kind==='absent')return null;
    const job=(await pool.query<{subject_id:string}>(
      'SELECT subject_id FROM siyue.account_deletion_jobs WHERE id=$1',[previous.deletionId])).rows[0];
    if(!job)throw new AuthError('AUTH_TEMPORARILY_UNAVAILABLE',503);
    const marker=await ledger.lookup(job.subject_id);
    if(marker?.status!=='accepted'||marker.intentId!==previous.deletionId)
      throw new AuthError('AUTH_TEMPORARILY_UNAVAILABLE',503);
    if(previous.kind==='expired')throw new AuthError('AUTH_DELETION_RECEIPT_UNRECOVERABLE',409);
    return previous.receipt;
  }
  return {
    async submit(input:Submission):Promise<DeletionReceipt> {
      const cached=await recovered(input);
      if(cached)return cached;
      try {
        return await accept.acceptUnattached({accessToken:input.accessToken,reauthGrant:input.reauthGrant,
          confirmation:true,dependencyDisposition:input.dependencyDisposition,idempotencyKey:input.key});
      } catch(error) {
        // A concurrent identical request can enter before the first main transaction commits.
        // The first commit revokes its session. Recheck the durable response before returning its
        // authentication failure; a prepared marker still refuses the receipt.
        const committed=await recovered(input);
        if(committed)return committed;
        // After the 24-hour metadata window, an original bearer is already revoked or expired.
        // With no key record we cannot prove whether this request was committed. Do not direct a
        // possibly deleted account back to sign-in, and never assert that deletion succeeded.
        if(error instanceof AuthError && error.status===401)
          throw new AuthError('AUTH_DELETION_OUTCOME_UNKNOWN',409);
        throw error;
      }
    },
  };
}
