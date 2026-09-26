import type { Pool } from 'pg';
import { z } from 'zod';
import { transaction } from '../adapters/postgres/database.js';
import { DeletionLedgerError, type DeletionLedgerStore, type LedgerEntry } from './ledger-store.js';

/**
 * Bounded, fail-closed reconciler for `prepared` deletion markers (design 13.4).
 *
 * The ledger protocol has one crash window. `prepare` persists the intent BEFORE the main-database
 * transaction, and `markAccepted` persists AFTER that transaction committed, so a process that dies
 * between the two leaves a `prepared` row whose main-database outcome nobody recorded. The ledger
 * cannot answer that question by itself: a prepared row is written before any main-database work, so
 * its existence proves neither a commit nor a rollback. The answer has to come from the main database,
 * and this kernel reads exactly one place for it -- `siyue.account_deletion_jobs`, the durable row the
 * acceptance transaction creates atomically with the subject state change.
 *
 * The one contract it relies on: the acceptance transaction commits the deletion job with
 * `id = intent_id` (the intent the ledger prepared) and `subject_id` of the same subject. A job whose
 * `id` is the prepared intent and whose `subject_id` matches, together with a subject that is
 * `deletion_pending` or `deleted`, is therefore proof that the transaction committed, and the only
 * write this kernel makes is `ledger.markAccepted` for that marker.
 *
 * What it never does:
 *   * It never cancels. `cancel` is the compensation for a transaction that DEFINITELY rolled back,
 *     and a restorable main database cannot prove a rollback: a missing job is equally consistent with
 *     "the transaction rolled back", "the backup predates the transaction", "this is another
 *     environment's database" and "the row was purged". The acceptance receipt's own
 *     `security_events` row cannot prove it either -- its absence proves nothing, because a
 *     transaction that never started leaves no trace. So a prepared marker without a matching
 *     committed job stays prepared and stays unresolved.
 *   * It never writes to the main database: no subject state, no session revocation, no cleanup. That
 *     belongs to the accept kernel, the cleanup kernel and the replay kernel.
 *   * It never replays `accepted` markers. Those are already terminal; `replay.ts` is the kernel that
 *     pushes them into a restored database. This one only counts them so the caller can tell the two
 *     apart.
 *   * It never tries to repair anything by guessing: every read failure, every contradiction between
 *     the ledger and the main database, and every ledger write failure is reported as a bounded
 *     `unresolved` reason instead.
 *
 * Fail closed, in the same sense as the rest of this directory: an unreadable or unreachable ledger
 * returns no decision at all (never an empty one), and a marker this kernel cannot certify stays
 * `prepared`, which keeps blocking that subject's login through `loginDecision`.
 *
 * The API calls this at startup and again after the ledger watermark advances. The caller must
 * refuse a replaced or regressed ledger before calling it, and must not run it while the main
 * database is being restored.
 */

/** Cleanup states the acceptance transaction may leave behind. The table's CHECK allows exactly these,
 *  so an unknown value means schema drift and is refused rather than mapped onto a known state. */
export const preparedReconcileJobStateSchema = z.enum(['accepted', 'processing', 'needs_attention', 'completed']);
export type PreparedReconcileJobState = z.infer<typeof preparedReconcileJobStateSchema>;

/** Bounded, self-describing reason why one prepared marker could not be reconciled. */
export const preparedReconcileUnresolvedReasonSchema = z.enum([
  // 缺数据: no job row carries this intent, and a restorable database cannot distinguish a rolled-back
  // transaction from a backup that predates it. Nothing is cancelled and nothing is accepted.
  'job_absent_no_rollback_proof',
  // 不一致: a job row for this subject exists, but its id is not the intent the ledger prepared, so the
  // committed deletion belongs to a different intent than the one the marker would certify.
  'job_intent_mismatch',
  // 不一致: a job row carries the prepared intent id but belongs to another subject. Two subjects
  // cannot share one committed deletion, so nothing is certified for either of them here.
  'job_subject_mismatch',
  // 不一致: the committed job's state is outside the vocabulary the schema declares.
  'job_state_invalid',
  // 不一致: a committed job for this subject exists while the subject is neither `deletion_pending` nor
  // `deleted`. The acceptance transaction commits the first and the cleanup transaction the second, so
  // an `active` or `blocked` subject cannot have a job that came from either.
  'subject_status_contradicts_job',
  // 不一致: the subject is still `deletion_pending` while the committed job already carries
  // `local_data_deleted`. The cleanup transaction writes that flag together with the terminal
  // `deleted` state, so the pairing is corruption rather than a deletion to certify.
  'job_inconsistent',
  // 缺数据: the ledger attests an intent for a subject the main database cannot show at all.
  'subject_missing',
  // 不一致: the acceptance kernel only ever accepts an adult, so a child subject cannot be explained.
  'subject_not_adult',
  // The main-database read failed for this subject, so nothing was certified and nothing was written.
  'main_read_failed',
  // The ledger refused or failed the acceptance write (permissions, contention, connectivity). The
  // marker is left exactly as it was, which keeps it blocking.
  'ledger_write_failed',
  // 缺数据: the ledger answered with a row this kernel cannot certify as a completed acceptance -- a
  // state or an instant its own constraints do not allow. Defensive: the ledger's CHECK ties
  // `accepted` to a non-null instant, so this reason exists for schema drift.
  'ledger_marker_incomplete',
]);
export type PreparedReconcileUnresolvedReason = z.infer<typeof preparedReconcileUnresolvedReasonSchema>;

/** One prepared marker whose committed job was found: the marker is now `accepted` in the ledger. */
export const preparedReconciledSchema = z.object({
  subjectId: z.uuid(),
  intentId: z.uuid(),
  preparedAt: z.string(),
  // The ledger's own acceptance instant, never one this kernel minted.
  acceptedAt: z.string(),
  // The committed job's state, so an operator can tell "accepted, waiting on cleanup" from "cleaned up".
  jobState: preparedReconcileJobStateSchema,
}).strict();
export type PreparedReconciled = z.infer<typeof preparedReconciledSchema>;

export const preparedReconcileUnresolvedSchema = z.object({
  subjectId: z.uuid(),
  intentId: z.uuid(),
  preparedAt: z.string(),
  reason: preparedReconcileUnresolvedReasonSchema,
}).strict();
export type PreparedReconcileUnresolved = z.infer<typeof preparedReconcileUnresolvedSchema>;

/** Ledger-level failure observed during the run. `ledger_unavailable` covers an unreachable database,
 *  a lost privilege or a failed write; `ledger_unreadable` means the ledger answered but could not
 *  prove it was complete (missing format marker, watermark disagreement). Both mean the run is not a
 *  statement about the whole ledger. */
export const preparedReconcileLedgerErrorSchema = z.enum(['ledger_unavailable', 'ledger_unreadable']);

export const preparedReconcileResultSchema = z.object({
  ledgerError: preparedReconcileLedgerErrorSchema.nullable(),
  reconciled: z.array(preparedReconciledSchema),
  unresolved: z.array(preparedReconcileUnresolvedSchema),
  // `accepted` markers seen in the replay set and deliberately left to the replay kernel.
  alreadyAccepted: z.number().int().nonnegative(),
}).strict();
export type PreparedReconcileResult = z.infer<typeof preparedReconcileResultSchema>;

interface SubjectRow { id: string; kind: 'adult' | 'child'; status: string }
interface JobRow { id: string; subject_id: string; state: string; local_data_deleted: boolean }

type LedgerErrorCode = z.infer<typeof preparedReconcileLedgerErrorSchema>;

/** An unreachable ledger and an incomplete one are different operations problems, so they get
 *  different codes; anything the store did not type is conservatively unreachable. */
const listErrorCode = (error: unknown): LedgerErrorCode =>
  error instanceof DeletionLedgerError && error.code === 'LEDGER_UNREADABLE' ? 'ledger_unreadable' : 'ledger_unavailable';

/** A write the store refused on policy grounds (`not_prepared`/`intent_conflict`) proves the ledger is
 *  reachable and simply no longer holds the prepared row this run read: not an infrastructure error. */
const writeErrorCode = (error: unknown): LedgerErrorCode | null => {
  if (error instanceof DeletionLedgerError) {
    if (error.code === 'LEDGER_NOT_PREPARED' || error.code === 'LEDGER_INTENT_CONFLICT') return null;
    if (error.code === 'LEDGER_UNREADABLE') return 'ledger_unreadable';
  }
  return 'ledger_unavailable';
};

/**
 * Builds the reconciler over the main database and the independent ledger store.
 *
 * `pool` must be the main database (the one holding `siyue.subjects` and `siyue.account_deletion_jobs`)
 * and `ledger` the store for the ledger database. Both are read-only here except for the single
 * `markAccepted` call per certified marker.
 */
export function createPreparedReconciler(pool: Pool, ledger: DeletionLedgerStore) {
  /**
   * Reads the main database for one prepared marker and decides whether it may be certified. The read
   * is one short transaction, so the job and subject rows come from one connection; it takes no lock,
   * because this kernel must not contend with an acceptance or cleanup transaction it cannot help.
   */
  async function inspect(entry: LedgerEntry): Promise<
    { decision: 'reconcile'; jobState: PreparedReconcileJobState }
    | { decision: 'unresolved'; reason: PreparedReconcileUnresolvedReason }> {
    const unresolved = (reason: PreparedReconcileUnresolvedReason) => ({ decision: 'unresolved' as const, reason });
    let observed: { subject: SubjectRow | undefined; jobs: JobRow[] };
    try {
      observed = await transaction(pool, async client => {
        const subject = (await client.query<SubjectRow>(
          'SELECT id,kind,status FROM siyue.subjects WHERE id=$1', [entry.subjectId])).rows[0];
        // Two bounded lookups in one statement: the job the intent names, and whatever job this subject
        // has (subject_id is UNIQUE, so at most one row per branch). Reading both is what makes an
        // intent mismatch visible instead of looking like an absent job.
        const jobs = (await client.query<JobRow>(
          `SELECT id,subject_id,state,local_data_deleted FROM siyue.account_deletion_jobs
           WHERE id=$1 OR subject_id=$2`, [entry.intentId, entry.subjectId])).rows;
        return { subject, jobs };
      });
    } catch { return unresolved('main_read_failed'); }
    if (!observed.subject) return unresolved('subject_missing');
    if (observed.subject.kind !== 'adult') return unresolved('subject_not_adult');
    const byIntent = observed.jobs.find(job => job.id === entry.intentId);
    if (byIntent && byIntent.subject_id !== entry.subjectId) return unresolved('job_subject_mismatch');
    if (!byIntent) {
      // A committed deletion for this subject under another intent cannot coexist with a prepared
      // marker for this one: the ledger row is only written before its own transaction and never
      // returns to `prepared` once accepted.
      return observed.jobs.some(job => job.subject_id === entry.subjectId)
        ? unresolved('job_intent_mismatch') : unresolved('job_absent_no_rollback_proof');
    }
    const state = preparedReconcileJobStateSchema.safeParse(byIntent.state);
    if (!state.success) return unresolved('job_state_invalid');
    if (observed.subject.status !== 'deletion_pending' && observed.subject.status !== 'deleted')
      return unresolved('subject_status_contradicts_job');
    if (byIntent.local_data_deleted && observed.subject.status !== 'deleted') return unresolved('job_inconsistent');
    return { decision: 'reconcile', jobState: state.data };
  }

  return {
    /**
     * Reconciles every `prepared` marker in one replay-set read. Each marker is decided and written
     * independently and at most once, so one subject's contradiction cannot commit another's marker,
     * and a re-run after a partial failure continues from the ledger's own state.
     */
    async reconcile(): Promise<PreparedReconcileResult> {
      let entries: LedgerEntry[];
      try { entries = await ledger.listReplayable(); }
      catch (error) {
        // An unreadable or unreachable ledger is never "nothing to reconcile", and no marker may be
        // touched on the strength of a read that did not happen.
        return preparedReconcileResultSchema.parse({ ledgerError: listErrorCode(error),
          reconciled: [], unresolved: [], alreadyAccepted: 0 });
      }
      const reconciled: PreparedReconciled[] = [];
      const unresolved: PreparedReconcileUnresolved[] = [];
      let ledgerError: LedgerErrorCode | null = null;
      let alreadyAccepted = 0;
      for (const entry of entries) {
        // The store only ever lists prepared and accepted rows; an accepted one is terminal and belongs
        // to the replay kernel, so it is counted and left exactly as it is.
        if (entry.status !== 'prepared') { alreadyAccepted += 1; continue; }
        const decided = await inspect(entry);
        if (decided.decision === 'unresolved') {
          unresolved.push({ subjectId: entry.subjectId, intentId: entry.intentId, preparedAt: entry.preparedAt,
            reason: decided.reason });
          continue;
        }
        let accepted: LedgerEntry;
        try { accepted = await ledger.markAccepted({ subjectId: entry.subjectId, intentId: entry.intentId }); }
        catch (error) {
          const code = writeErrorCode(error);
          if (code) ledgerError ??= code;
          unresolved.push({ subjectId: entry.subjectId, intentId: entry.intentId, preparedAt: entry.preparedAt,
            reason: 'ledger_write_failed' });
          continue;
        }
        if (accepted.status !== 'accepted' || accepted.intentId !== entry.intentId || accepted.acceptedAt === null) {
          unresolved.push({ subjectId: entry.subjectId, intentId: entry.intentId, preparedAt: entry.preparedAt,
            reason: 'ledger_marker_incomplete' });
          continue;
        }
        reconciled.push({ subjectId: entry.subjectId, intentId: entry.intentId, preparedAt: entry.preparedAt,
          acceptedAt: accepted.acceptedAt, jobState: decided.jobState });
      }
      return preparedReconcileResultSchema.parse({ ledgerError, reconciled, unresolved, alreadyAccepted });
    },
  };
}
export type PreparedReconciler = ReturnType<typeof createPreparedReconciler>;
