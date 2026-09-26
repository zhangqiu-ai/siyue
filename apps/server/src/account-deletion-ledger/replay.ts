import type { Pool } from 'pg';
import { z } from 'zod';
import { transaction } from '../adapters/postgres/database.js';
import { DeletionLedgerError, type DeletionLedgerStore, type LedgerEntry } from './ledger-store.js';

/**
 * Main-database restore replay kernel (design 13.4) for the independent deletion anti-revival ledger.
 *
 * Design 13.4: 每次数据库恢复先重放独立保管的删除防复活账本，再开启登录和对外查询. Restoring an older
 * main-database backup also brings back accounts that were deleted afterwards, so the replay is the step
 * that pushes the ledger's terminal markers back into the restored database before login reopens.
 *
 * What it does, and only this:
 *   * An `accepted` marker is replayed. The subject is moved to the terminal `deleted` state, its
 *     credential version is stepped, and every session, refresh token, reauth grant and pending email
 *     challenge of that subject is invalidated -- the same reach the acceptance transaction had
 *     (account-deletion-accept.ts), so a restored session or refresh token cannot outlive its subject.
 *   * A `prepared` marker is reported as a blocked subject and is NOT replayed. A prepared intent only
 *     proves that an intent was persisted before the main transaction; its outcome is unknown, so this
 *     kernel deletes nothing and revokes nothing on that basis. The subject stays refused at login by
 *     the per-login ledger decision, which must keep running.
 *   * A `cancelled` row is not replay state at all and never appears in the store's replay list.
 *
 * Deliberately not here: destroying personal data (addresses, password credential, provider
 * identities, consents, display name), creating an `account_deletion_jobs` row, Apple revocation,
 * receipt handling, HTTP, scheduling and the family/child disposition procedure. Those belong to the
 * cleanup kernel (account-deletion-cleanup.ts) and the revocation coordinator, and they need a job row
 * the restored database may not have. The replay only stops a deleted account from coming back; it is
 * not a substitute for finishing the deletion.
 *
 * Conservative by construction:
 *   * Every write is one transaction per subject, so a subject is either fully replayed or untouched.
 *   * Every write is guarded so a second replay changes no column and no timestamp: the instant it
 *     writes comes from the ledger's own `acceptedAt`, never from a fresh clock reading.
 *   * Anything the restored database cannot prove is left unresolved instead of guessed at, and any
 *     unresolved accepted marker keeps login closed. The boundaries are named in the reason schema.
 */

/** Bounded, self-describing reason why one accepted marker could not be safely replayed. */
export const deletionReplayUnresolvedReasonSchema = z.enum([
  // Startup coordinator uses these when replay stopped account revival but the restored main
  // database cannot prove that cleanup work and its receipt still exist for this accepted intent.
  'job_missing',
  'job_intent_mismatch',
  // 缺数据: the ledger attests a committed acceptance for a subject the restored database cannot show.
  // The row cannot be reconstructed from the ledger, and nothing can distinguish "this backup predates
  // the account" from "wrong database", "the tombstone was purged" or "another environment's ledger",
  // so nothing is claimed and login stays closed for a human to resolve.
  'subject_missing',
  // 不一致: the acceptance kernel only ever accepts an adult, so an accepted child subject cannot have
  // been accepted by this service. Refusing is safer than writing a state nobody can explain.
  'subject_not_adult',
  // 不一致: a deletion job exists, but the subject row contradicts what the accept and cleanup
  // transactions commit. The accept transaction never commits in `active`/`blocked`, and
  // `local_data_deleted` is only ever stamped after the subject row became `deleted` in the same
  // transaction, so either pairing can be read as corruption rather than as a deletion to apply.
  'job_inconsistent',
  // 缺数据: the ledger answered `accepted` without the acceptance instant the row's own CHECK requires.
  // The store normalises such a row to unusable, and this kernel refuses rather than inventing a time.
  'marker_incomplete',
  // The main-database write failed (permissions, contention, connectivity): nothing was committed for
  // that subject, and login stays closed instead of a partial replay being reported as done.
  'replay_failed',
]);
export type DeletionReplayUnresolvedReason = z.infer<typeof deletionReplayUnresolvedReasonSchema>;

export const deletionReplayChangesSchema = z.object({
  subject: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  refreshTokens: z.number().int().nonnegative(),
  reauthGrants: z.number().int().nonnegative(),
  challenges: z.number().int().nonnegative(),
  mailJobs: z.number().int().nonnegative(),
}).strict();
export type DeletionReplayChanges = z.infer<typeof deletionReplayChangesSchema>;

export const deletionReplayAcceptedSchema = z.object({
  subjectId: z.uuid(),
  intentId: z.uuid(),
  acceptedAt: z.string(),
  // True when the restored row was already `deleted`: this marker had been replayed before, or the
  // backup already contained the tombstone. The call stays idempotent either way.
  alreadyDeleted: z.boolean(),
  changes: deletionReplayChangesSchema,
}).strict();
export type DeletionReplayAccepted = z.infer<typeof deletionReplayAcceptedSchema>;

export const deletionReplayBlockedSchema = z.object({
  subjectId: z.uuid(),
  intentId: z.uuid(),
  preparedAt: z.string(),
}).strict();
export type DeletionReplayBlocked = z.infer<typeof deletionReplayBlockedSchema>;

export const deletionReplayUnresolvedSchema = z.object({
  subjectId: z.uuid(),
  intentId: z.uuid(),
  reason: deletionReplayUnresolvedReasonSchema,
}).strict();
export type DeletionReplayUnresolved = z.infer<typeof deletionReplayUnresolvedSchema>;

/** `openLogin` is the only answer this kernel gives about opening the service: it is true only when
 * every accepted marker was replayed and no prepared intent remains unresolved. A later runtime may
 * support other subjects while enforcing per-login ledger checks, but this kernel cannot assume that. */
export const deletionReplayResultSchema = z.object({
  openLogin: z.boolean(),
  ledgerError: z.enum(['ledger_unavailable', 'ledger_unreadable']).nullable(),
  accepted: z.array(deletionReplayAcceptedSchema),
  blocked: z.array(deletionReplayBlockedSchema),
  unresolved: z.array(deletionReplayUnresolvedSchema),
}).strict();
export type DeletionReplayResult = z.infer<typeof deletionReplayResultSchema>;

interface SubjectRow { id: string; kind: 'adult' | 'child'; status: string; }
interface JobRow { id: string; state: string; local_data_deleted: boolean; }

const noChanges = (): DeletionReplayChanges =>
  ({ subject: 0, sessions: 0, refreshTokens: 0, reauthGrants: 0, challenges: 0, mailJobs: 0 });

/** Every statement in the kernel counts what it actually changed through this one shape. */
const changed = (result: { rowCount: number | null }) => result.rowCount ?? 0;

/**
 * Builds the replay kernel over the restored main database and the independent ledger store.
 *
 * `pool` is the restored main database as the runtime role; `ledger` must be the store for the ledger
 * database (its own role and its own database, per provision/deletion-ledger.sql). Nothing here is wired
 * into startup, and nothing here may run while login or external queries are open.
 */
export function createDeletionReplayKernel(pool: Pool, ledger: DeletionLedgerStore) {
  /**
   * Replays one accepted marker into the restored database, returning either the applied result or a
   * bounded reason. It never throws for a per-subject problem and never leaves a half-written subject.
   */
  async function applyAccepted(entry: LedgerEntry) {
    const unresolved = (reason: DeletionReplayUnresolvedReason) =>
      ({ unresolved: { subjectId: entry.subjectId, intentId: entry.intentId, reason } });
    const acceptedAt = entry.acceptedAt;
    if (acceptedAt === null) return unresolved('marker_incomplete');
    try {
      return await transaction(pool, async client => {
        // Lock order matches every other auth mutation: the subject row first.
        const subject = (await client.query<SubjectRow>(
          'SELECT id,kind,status FROM siyue.subjects WHERE id=$1 FOR UPDATE', [entry.subjectId])).rows[0];
        if (!subject) return unresolved('subject_missing');
        if (subject.kind !== 'adult') return unresolved('subject_not_adult');
        const job = (await client.query<JobRow>(
          'SELECT id,state,local_data_deleted FROM siyue.account_deletion_jobs WHERE subject_id=$1',
          [entry.subjectId])).rows[0];
        const jobContradicts = job !== undefined && (subject.status === 'active' || subject.status === 'blocked'
          || (job.local_data_deleted && subject.status !== 'deleted'));
        if (jobContradicts) return unresolved('job_inconsistent');

        const alreadyDeleted = subject.status === 'deleted';
        const changes = noChanges();
        // A backup that lost its job needs a terminal tombstone to prevent revival. With a pending
        // cleanup job, preserve the honest deletion_pending state and revoke credentials below.
        // A committed job still awaiting server-data cleanup remains deletion_pending. The ledger
        // proves acceptance, not that data is gone; stamping deleted here would misstate progress.
        // A backup without a job still receives the anti-revival tombstone, while the startup
        // coordinator keeps external access closed until the missing cleanup work is resolved.
        if (!job || job.local_data_deleted) changes.subject = changed(await client.query(
          `UPDATE siyue.subjects SET status='deleted', credential_version=credential_version+1,
             deleted_at=COALESCE(deleted_at,$2::timestamptz), updated_at=$2::timestamptz
           WHERE id=$1 AND status<>'deleted'`, [entry.subjectId, acceptedAt]));
        // Defence in depth behind the version step, mirroring the acceptance transaction: a restored
        // session and its refresh token are revoked and a restored reauth grant is spent. Each statement
        // matches only rows it has not already settled, so a replay reports zero changes the second time.
        changes.sessions = changed(await client.query(
          `UPDATE siyue.auth_sessions SET revoked_at=COALESCE(revoked_at,$2::timestamptz),
             revoke_reason=COALESCE(revoke_reason,'account_deletion')
           WHERE subject_id=$1 AND revoked_at IS NULL`, [entry.subjectId, acceptedAt]));
        changes.refreshTokens = changed(await client.query(
          `UPDATE siyue.refresh_tokens SET revoked_at=COALESCE(revoked_at,$2::timestamptz),
             retry_ciphertext=NULL, retry_expires_at=NULL
           WHERE revoked_at IS NULL AND session_id IN
             (SELECT id FROM siyue.auth_sessions WHERE subject_id=$1)`, [entry.subjectId, acceptedAt]));
        changes.reauthGrants = changed(await client.query(
          `UPDATE siyue.reauth_grants SET consumed_at=COALESCE(consumed_at,$2::timestamptz)
           WHERE subject_id=$1 AND consumed_at IS NULL`, [entry.subjectId, acceptedAt]));
        // A restored challenge still naming this subject, and the queued mail carrying its code, are the
        // two places a deleted subject could still be reached from. The challenge ids are read before
        // either statement writes, so cancelling the outbox row does not depend on the supersede order.
        const challenges = (await client.query<{ id: string }>(
          `SELECT id FROM siyue.email_challenges WHERE subject_id=$1 AND status='pending'`,
          [entry.subjectId])).rows.map(row => row.id);
        if (challenges.length > 0) {
          changes.mailJobs = changed(await client.query(
            `UPDATE siyue.outbox_jobs SET status='cancelled', payload_ciphertext=NULL, completed_at=$2::timestamptz
             WHERE status='pending' AND aggregate_id = ANY($1::uuid[])`, [challenges, acceptedAt]));
          changes.challenges = changed(await client.query(
            `UPDATE siyue.email_challenges SET status='superseded'
             WHERE status='pending' AND id = ANY($1::uuid[])`, [challenges]));
        }
        return { accepted: { subjectId: entry.subjectId, intentId: entry.intentId, acceptedAt,
          alreadyDeleted, changes } };
      });
    } catch {
      // The transaction rolled back, so the subject is exactly as the restore left it. A bounded reason
      // is reported instead of the driver's error, which could carry SQL or connection details.
      return unresolved('replay_failed');
    }
  }

  return {
    /**
     * Replays the ledger's replayable markers into the restored database and reports what that leaves
     * open. The ledger is read once, so the decision describes one consistent replay set: an unreadable
     * or unreachable ledger returns no replay set at all, never an empty one.
     */
    async replay(): Promise<DeletionReplayResult> {
      let entries: LedgerEntry[];
      try { entries = await ledger.listReplayable(); }
      catch (error) {
        return deletionReplayResultSchema.parse({ openLogin: false,
          ledgerError: error instanceof DeletionLedgerError && error.code === 'LEDGER_UNREADABLE'
            ? 'ledger_unreadable' : 'ledger_unavailable',
          accepted: [], blocked: [], unresolved: [] });
      }
      const accepted: DeletionReplayAccepted[] = [];
      const blocked: DeletionReplayBlocked[] = [];
      const unresolved: DeletionReplayUnresolved[] = [];
      for (const entry of entries) {
        // prepared: reported so a caller knows this subject must stay refused, and deliberately not
        // replayed -- the outcome of its main transaction is unknown, so nothing is deleted for it.
        if (entry.status === 'prepared') {
          blocked.push({ subjectId: entry.subjectId, intentId: entry.intentId, preparedAt: entry.preparedAt });
          continue;
        }
        if (entry.status !== 'accepted') continue; // the store only ever lists prepared and accepted
        const result = await applyAccepted(entry);
        if ('accepted' in result) accepted.push(result.accepted);
        else unresolved.push({ subjectId: entry.subjectId, intentId: entry.intentId, reason: result.unresolved.reason });
      }
      return deletionReplayResultSchema.parse({ openLogin: unresolved.length === 0 && blocked.length === 0, ledgerError: null,
        accepted, blocked, unresolved });
    },
  };
}
export type DeletionReplayKernel = ReturnType<typeof createDeletionReplayKernel>;
