import type { Pool } from 'pg';
import { z } from 'zod';
import type { DeletionLedgerStore, LedgerStatus } from '../../account-deletion-ledger/ledger-store.js';
import {
  AccountDeletionCleanupError, accountDeletionCleanupInputSchema, createAccountDeletionCleanupKernel,
  type AccountDeletionCleanupKernel,
  type AccountDeletionCleanupResult,
} from './account-deletion-cleanup.js';
import {
  createAccountDeletionCleanupRunner, type AccountDeletionCleanupRunner,
  type AccountDeletionCleanupRunnerOptions,
} from './account-deletion-cleanup-runner.js';

// Ledger-authorized cleanup: the bounded sweep runner behind the independent anti-revival ledger
// (design 13.4).
//
// The cleanup kernel deletes a subject's server-side data on the strength of one row in the main
// database -- `siyue.account_deletion_jobs` -- and that database is the one whose backups get restored.
// A restored backup can therefore carry a job whose deletion the independent ledger never accepted,
// and the kernel alone cannot tell that job apart from an authorized one. This module puts the ledger
// in front of the sweep: one job is cleaned only while the ledger attests an `accepted` marker whose
// intent is exactly the committed job id the main database holds for that subject.
//
// Four properties are load-bearing:
//
// 1. THE LEDGER IS READ, NEVER WRITTEN. The guard only calls `lookup` -- it never prepares, accepts or
//    cancels, so a sweep cannot mint the authorization it checks. Both reads (the committed job id
//    and the ledger marker) happen before the kernel is called, and the kernel's own single
//    transaction remains the only place this path writes the main database. The two databases share
//    no transaction, so the check and the write cannot be one atomic step; property 2 is what makes
//    that acceptable.
// 2. THE CHECK CANNOT GO STALE. `accepted` is terminal by ledger database privilege. The main job id
//    read here is passed into the cleanup kernel, which checks it again under the job row lock before
//    changing anything. A replacement job in that gap is refused even if the main database role or an
//    operator changed the id. The two databases share no transaction, so this locked check is essential.
// 3. A REFUSAL IS BOUNDED AND NEVER A SUCCESS. A subject whose ledger says `prepared`, `cancelled`,
//    nothing at all or a different intent -- and a subject with no committed job -- is refused with a
//    bounded reason, which the sweep reports as one `failed` job that removed nothing, exactly like the
//    kernel's own refusals. Nothing about the subject is repaired here: promoting a `prepared` marker
//    is `prepared-reconciler.ts`'s decision, not a sweep's.
// 4. AN UNUSABLE LEDGER IS AN INFRASTRUCTURE FAULT, NOT A JOB FACT. `LEDGER_UNAVAILABLE` and
//    `LEDGER_UNREADABLE` are deliberately not translated: the sweep rejects after the jobs it already
//    attempted have committed, instead of reporting a batch it was never able to authorize.
//
// It opens no HTTP route, starts no timer, makes no provider call and decides no family or child
// disposition. One extra main-database read per attempted job is the whole cost of the check.

/** Bounded reason the guard refused one job. It is what the sweep reports as that job's `errorCode`
 * and what a direct caller reads from `AccountDeletionLedgerGuardRefusal.reason` -- a code, never a
 * message, row or secret. */
export const accountDeletionLedgerGuardReasonSchema = z.enum([
  // 缺数据: the main database holds no committed deletion job for the subject, so there is nothing the
  // ledger's intent could be compared with. The sweep selects its candidates from that very table, so
  // it only reaches this reason through a direct guard call -- and it refuses there instead of letting
  // an earlier acceptance shape be assumed.
  'deletion_job_missing',
  // 缺数据: the ledger holds no marker for the subject. "No marker" is exactly what a restored older
  // backup looks like, so it is an absence of authorization, not authorization.
  'ledger_entry_missing',
  // 未受理: the marker is `prepared` -- acceptance may have committed without its marker ever being
  // recorded. Only reconciliation may resolve that, and it must prove the commit from the main job.
  'ledger_entry_prepared',
  // 未受理: the marker is `cancelled` -- the request was withdrawn. `cancel` refuses an accepted row, so
  // this is a real withdrawal rather than a downgrade of an accepted deletion.
  'ledger_entry_cancelled',
  // 不一致: the marker is `accepted`, but its intent is not this subject's committed job id, so the
  // ledger authorized a different transaction than the one that would be cleaned.
  'ledger_intent_mismatch',
  // Defensive: the ledger's vocabulary is exactly `prepared`/`accepted`/`cancelled` and the store
  // validates it before returning, so this reason exists for schema drift rather than for a reachable
  // state.
  'ledger_entry_not_accepted',
]);
export type AccountDeletionLedgerGuardReason = z.infer<typeof accountDeletionLedgerGuardReasonSchema>;

/**
 * Bounded refusal from the guard, never an infrastructure fault. It extends
 * `AccountDeletionCleanupError` so the existing sweep runner classifies it exactly like a kernel
 * refusal -- one `failed` job carrying this code, never a cleaned one, and never a rejected sweep.
 * The guard's reason is passed through the cleanup error channel and also exposed under `reason`.
 */
export class AccountDeletionLedgerGuardRefusal extends AccountDeletionCleanupError {
  readonly reason: AccountDeletionLedgerGuardReason;
  constructor(reason: AccountDeletionLedgerGuardReason) {
    super(reason);
    this.reason = reason;
  }
}

const markerRefusal = (status: LedgerStatus): AccountDeletionLedgerGuardReason =>
  status === 'prepared' ? 'ledger_entry_prepared'
    : status === 'cancelled' ? 'ledger_entry_cancelled' : 'ledger_entry_not_accepted';

export interface AccountDeletionGuardedCleanupKernelOptions {
  /** The independent anti-revival ledger, read-only: the guard calls `lookup` and nothing else. */
  ledger: Pick<DeletionLedgerStore, 'lookup'>;
  /** The kernel an authorized job is delegated to. Defaults to the real kernel over the same pool. */
  kernel?: AccountDeletionCleanupKernel;
  clock?: () => Date;
}

/**
 * Wraps one cleanup kernel in the ledger check described at the top of this file. The guard is the
 * whole change: an authorized job is handed to `kernel.cleanupSubject` with its expected id, so the
 * kernel checks that id under its own subject-then-job lock before any write.
 *
 * The committed job id is read here rather than accepted from the caller, because the guard has to
 * compare the ledger against the row the cleanup would actually act on and no caller may supply it.
 */
export function createAccountDeletionGuardedCleanupKernel(pool: Pool,
  options: AccountDeletionGuardedCleanupKernelOptions) {
  const kernel = options.kernel ?? createAccountDeletionCleanupKernel(pool, options.clock);
  return {
    async cleanupSubject(input: unknown): Promise<AccountDeletionCleanupResult> {
      const parsed = accountDeletionCleanupInputSchema.safeParse(input);
      // An input this guard cannot even name a subject for stays the kernel's own bounded refusal, and
      // is raised here so that nothing is read -- and nothing is written -- on its behalf.
      if (!parsed.success) throw new AccountDeletionCleanupError('cleanup_invalid_request');
      const { subjectId } = parsed.data;
      const job = (await pool.query<{ id: string }>(
        'SELECT id FROM siyue.account_deletion_jobs WHERE subject_id=$1', [subjectId])).rows[0];
      if (!job) throw new AccountDeletionLedgerGuardRefusal('deletion_job_missing');
      // A ledger read failure is not caught here. `LEDGER_UNAVAILABLE` and `LEDGER_UNREADABLE` mean the
      // ledger could not answer for this subject, and every other `DeletionLedgerError` is a caller
      // defect the store already refuses; all of them leave the sweep to reject rather than report a
      // clean batch.
      const marker = await options.ledger.lookup(subjectId);
      if (!marker) throw new AccountDeletionLedgerGuardRefusal('ledger_entry_missing');
      if (marker.status !== 'accepted')
        throw new AccountDeletionLedgerGuardRefusal(markerRefusal(marker.status));
      if (marker.intentId !== job.id)
        throw new AccountDeletionLedgerGuardRefusal('ledger_intent_mismatch');
      return kernel.cleanupSubject({ subjectId, expectedDeletionId: job.id });
    },
  };
}
export type AccountDeletionGuardedCleanupKernel = ReturnType<typeof createAccountDeletionGuardedCleanupKernel>;

export interface AccountDeletionGuardedCleanupRunnerOptions extends AccountDeletionCleanupRunnerOptions {
  /**
   * The independent anti-revival ledger every candidate is checked against. Required rather than
   * optional: a sweep with no ledger to read is not a sweep this module is willing to build.
   */
  ledger: Pick<DeletionLedgerStore, 'lookup'>;
}

/**
 * The existing sweep runner over the guarded kernel, with every other option -- limit, clock, retry
 * delays, an explicit kernel -- passed through unchanged. An accepted, matching job sweeps exactly as
 * before; a refused job is one bounded `failed` entry in the report, held back this instance's retry
 * delay like any other failure, and the rest of the batch is still evaluated.
 */
export function createAccountDeletionGuardedCleanupRunner(pool: Pool,
  options: AccountDeletionGuardedCleanupRunnerOptions): AccountDeletionCleanupRunner {
  return createAccountDeletionCleanupRunner(pool, {
    ...options, kernel: createAccountDeletionGuardedCleanupKernel(pool, options),
  });
}
