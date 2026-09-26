import { z } from 'zod';
import type { PoolClient } from 'pg';
import { createAppleRevocationOutbox, type AppleRevocationStore } from '../../identities/apple/revocation-outbox.js';

/**
 * Service-side handling and job-progress coordination for the durable Apple revocation queue
 * (design 13.3, migrations 0015/0016). This module opens no HTTP route and starts no timer: a host
 * calls `tick`/`reconcile`, so a paused deployment or a crashed process cannot silently stop
 * revoking. Nothing here talks to Apple directly or deletes account data.
 *
 * Two independent facts meet in this file and nowhere else:
 *
 * - `siyue.apple_revocation_outbox` owns the *provider* question. Migration 0016 defines exactly one
 *   status as Apple having confirmed: `revoked`. `needs_attention` and `expired` are deliberately
 *   not named success, so a deletion must keep waiting on them instead of claiming otherwise.
 * - `siyue.account_deletion_jobs.provider_revocation_pending` owns the *receipt* question: whether
 *   this deletion still waits on an external revocation. Design 13.3 forbids merging that dimension
 *   with the local cleanup one, so this module never writes `local_data_deleted`, `completed_at`,
 *   `state`, the subject, its identities or its sessions. A false flag says only that no provider
 *   revocation is outstanding; it is not a provider success result.
 *
 * The dimension is cleared only when the subject has at least one Apple identity and every one of
 * them carries a `revoked` queue row. Both halves of that rule are load-bearing:
 *
 * - A subject whose Apple identities are gone, or whose identity never carried a usable credential,
 *   has no evidence that Apple was told anything, so a missing identity is never read as a success.
 *   Design 13.3 states that absence of a provider credential must not trap the user in an active
 *   account, and the acceptance kernel already keeps that dimension open with
 *   `apple_credential_missing`; the same fact must not be turned into `false` here.
 * - One identity still queued, expired or waiting for attention keeps the whole dimension pending,
 *   because Apple authorizes each linked identity separately.
 */

/**
 * Bounded lowercase snake_case codes, the same client-visible shape the deletion job and the outbox
 * already store. `apple_credential_missing` is the code the acceptance kernel writes for the same
 * fact, so a receipt reads one vocabulary instead of two. Only codes for a *blocked* dimension
 * exist: a job that still waits never carries a message, a stack or a provider body.
 */
export const appleRevocationProgressCodes = {
  credentialMissing: 'apple_credential_missing',
  queued: 'apple_revocation_pending',
  expired: 'apple_revocation_expired',
  needsAttention: 'apple_revocation_needs_attention',
} as const;
const progressCodeSchema = z.enum([
  appleRevocationProgressCodes.credentialMissing, appleRevocationProgressCodes.queued,
  appleRevocationProgressCodes.expired, appleRevocationProgressCodes.needsAttention,
] as const);
export type AppleRevocationProgressCode = z.infer<typeof progressCodeSchema>;

const defaultLimit = 50, maxLimit = 200;
const limitSchema = z.number().int().min(1).max(maxLimit);

/**
 * One deletion job as this call re-evaluated it. `identities`/`confirmed` are the evidence the
 * decision used, so an operator can see why a job is still waiting instead of trusting a code
 * alone. `errorCode` is non-null exactly while `cleared` is false.
 */
export interface AppleRevocationJobProgress {
  deletionId: string;
  subjectId: string;
  cleared: boolean;
  errorCode: AppleRevocationProgressCode | null;
  identities: number;
  confirmed: number;
}
export interface AppleRevocationReconcileReport {
  /** Deletion jobs this call took and wrote: a bounded, indexed slice, never the whole table. */
  checked: number;
  /** Jobs whose provider dimension this call finished. */
  cleared: number;
  jobs: AppleRevocationJobProgress[];
}

interface DecisionRow {
  deletion_id: string;
  subject_id: string;
  satisfied: boolean;
  code: string | null;
  identities: number;
  confirmed: number;
}

/**
 * One statement decides and applies the whole reconciliation, so no read can be separated from its
 * write by a crash, a retry or another instance.
 *
 * - `candidate` takes at most `$2` deletion jobs that still wait on Apple. `FOR UPDATE SKIP LOCKED`
 *   makes concurrent instances work on disjoint jobs instead of blocking each other or deciding one
 *   job twice, and it never waits on a job another worker holds.
 * - `scoped`/`decision` read the evidence inside the same snapshot as the write: how many Apple
 *   identities the subject has, how many carry a `revoked` row, and which blocked shape applies. The
 *   outbox rows are deliberately not locked: a job that is still moving stays pending and the next
 *   call picks it up.
 * - The `UPDATE` repeats the `provider_revocation_pending`/`completed_at` predicate, so a job another
 *   instance already cleared -- or a completed job -- can never be re-decided from a stale read.
 * - Clearing the dimension also drops the job's bounded error, so a finished dimension cannot keep
 *   showing a stale code. A job that still waits always carries the code of its current blocker.
 */
const reconcileSql = `WITH candidate AS (
    SELECT j.id AS job_id,j.subject_id,j.requested_at,j.last_error_code
      FROM siyue.account_deletion_jobs j
     WHERE j.provider_revocation_pending AND j.completed_at IS NULL
       AND ($1::uuid IS NULL OR j.subject_id=$1::uuid)
     ORDER BY j.requested_at,j.id
     LIMIT $2
     FOR UPDATE OF j SKIP LOCKED
  ),scoped AS (
    SELECT c.job_id,c.subject_id,c.last_error_code,
      count(i.id)::int AS identities,
      count(*) FILTER (WHERE o.status='revoked')::int AS confirmed,
      count(*) FILTER (WHERE i.id IS NOT NULL AND o.id IS NULL)::int AS unqueued,
      count(*) FILTER (WHERE o.status='needs_attention')::int AS attention,
      count(*) FILTER (WHERE o.status='expired')::int AS expired
     FROM candidate c
     LEFT JOIN siyue.external_identities i ON i.subject_id=c.subject_id AND i.provider='apple'
     LEFT JOIN siyue.apple_revocation_outbox o ON o.identity_id=i.id
    GROUP BY c.job_id,c.subject_id,c.last_error_code
  ),decision AS (
    SELECT s.*,(s.identities>0 AND s.confirmed=s.identities) AS satisfied,
      CASE WHEN s.identities=0 AND s.last_error_code IN
             ('${appleRevocationProgressCodes.expired}','${appleRevocationProgressCodes.needsAttention}')
             THEN s.last_error_code
           WHEN s.identities=0 OR s.unqueued>0 THEN '${appleRevocationProgressCodes.credentialMissing}'
           WHEN s.attention>0 THEN '${appleRevocationProgressCodes.needsAttention}'
           WHEN s.expired>0 THEN '${appleRevocationProgressCodes.expired}'
           ELSE '${appleRevocationProgressCodes.queued}' END AS code
     FROM scoped s
  )
  UPDATE siyue.account_deletion_jobs AS target
     SET provider_revocation_pending=target.provider_revocation_pending AND NOT decision.satisfied,
         last_error_code=CASE WHEN decision.satisfied THEN NULL ELSE decision.code END
    FROM decision
   WHERE target.id=decision.job_id
     AND target.provider_revocation_pending
     AND target.completed_at IS NULL
  RETURNING target.id AS deletion_id,target.subject_id,decision.satisfied,decision.code,
    decision.identities,decision.confirmed`;

/**
 * Deletion-facing coordination of the Apple revocation queue. The database handle may be a pool
 * (each call is one atomic statement) or a client already inside a transaction, where a rollback of
 * the surrounding work takes this decision with it.
 */
export function createAccountDeletionRevocationCoordinator(
  database: Pick<PoolClient, 'query'>, options: { limit?: number } = {},
) {
  const configured = options.limit === undefined ? undefined : limitSchema.parse(options.limit);
  return {
    /**
     * Re-evaluates the provider dimension for one subject, or for a bounded slice of the jobs that
     * still wait on Apple. Idempotent: a job that is already cleared or completed is never taken
     * again, and a second call for one subject reports no work instead of re-opening the flag. A job
     * that still waits is re-reported on every call so its current blocker stays visible; that write
     * stores the value the row already has and cannot re-open a cleared dimension.
     */
    async reconcile(input: { subjectId?: string; limit?: number } = {}): Promise<AppleRevocationReconcileReport> {
      const subjectId = input.subjectId === undefined ? null : z.uuid().parse(input.subjectId);
      const limit = input.limit === undefined ? configured ?? defaultLimit : limitSchema.parse(input.limit);
      const rows = (await database.query<DecisionRow>(reconcileSql, [subjectId, limit])).rows;
      const jobs = rows.map(row => ({
        deletionId: row.deletion_id, subjectId: row.subject_id, cleared: row.satisfied,
        // A stale snapshot can only ever keep a job pending, never clear it, so the code of a
        // cleared job is defined as null instead of carrying the blocker it just resolved.
        errorCode: row.satisfied ? null : progressCodeSchema.parse(row.code),
        identities: row.identities, confirmed: row.confirmed,
      }));
      return { checked: jobs.length, cleared: jobs.filter(job => job.cleared).length, jobs };
    },
  };
}
export type AccountDeletionRevocationCoordinator = ReturnType<typeof createAccountDeletionRevocationCoordinator>;

type OutboxOptions = Parameters<typeof createAppleRevocationOutbox>[0];
/**
 * The outbox's own configuration (store, cipher, injected provider call, clock, window, backoff,
 * alert) plus the bounded slice this worker reconciles in one step.
 */
export type AppleRevocationWorkerOptions = Omit<OutboxOptions, 'store'> & { store: AppleRevocationStore; limit?: number };
export interface AppleRevocationTickReport {
  /** Settlement of the single attempt this call made, or undefined when nothing was due. */
  attempt: 'revoked' | 'retry' | 'needs_attention' | 'expired' | undefined;
  /** The subject whose Apple identity was attempted, when one was leased. */
  subjectId: string | undefined;
  /** Its deletion-job progress, or undefined when no subject could be resolved. */
  report: AppleRevocationReconcileReport | undefined;
}

/**
 * Ties one outbox attempt to the deletion job it belongs to. The outbox settles one job per call and
 * only returns the settlement, so the store's `claim` is wrapped to remember which identity was
 * leased; the subject is then resolved from that identity row and only that deletion job is
 * reconciled. A tick therefore costs one attempt plus one bounded statement, and it is not wired to
 * a timer, a route or a process signal here.
 *
 * Two shapes are deliberately left to the caller's `reconcile` sweep: an identity that never queued
 * a revocation (a missing credential produces no claim and no attempt at all) and a subject whose
 * queue row was already purged. Both must still be re-evaluated so the receipt keeps a bounded code
 * instead of waiting forever on an attempt that will never happen.
 */
export function createAccountDeletionRevocationWorker(
  database: Pick<PoolClient, 'query'>, options: AppleRevocationWorkerOptions,
) {
  const { store, limit, ...outboxOptions } = options;
  const coordinator = createAccountDeletionRevocationCoordinator(database, limit === undefined ? {} : { limit });
  let leasedIdentityId: string | undefined, running = false;
  const outbox = createAppleRevocationOutbox({ ...outboxOptions, store: {
    enqueue: (client, input) => store.enqueue(client, input),
    async claim(now, leaseUntil) {
      const claim = await store.claim(now, leaseUntil);
      if (claim) leasedIdentityId = claim.job.identityId;
      return claim;
    },
    settle: (claim, settlement, now) => store.settle(claim, settlement, now),
  } });
  return {
    /** Same contract as the outbox: queue inside the caller's deletion transaction, or not at all. */
    enqueueForSubject: (client: PoolClient, input: { subjectId: string }) => outbox.enqueueForSubject(client, input),
    reconcile: (input?: { subjectId?: string; limit?: number }) => coordinator.reconcile(input),
    async tick(): Promise<AppleRevocationTickReport> {
      // One in-flight tick per instance: two calls in one process would race the claim handoff. The
      // database lease is what makes the *attempt* single-owner across instances.
      if (running) return { attempt: undefined, subjectId: undefined, report: undefined };
      running = true;
      try {
        const attempt = await outbox.tick(), identityId = leasedIdentityId;
        leasedIdentityId = undefined;
        if (identityId === undefined) return { attempt, subjectId: undefined, report: undefined };
        const subjectId = (await database.query<{ subject_id: string }>(
          'SELECT subject_id FROM siyue.external_identities WHERE id=$1', [identityId])).rows[0]?.subject_id;
        // A claimed identity that no longer resolves leaves the attempt exactly as it settled; the
        // deletion job is then only reachable through the caller's sweep.
        if (subjectId === undefined) return { attempt, subjectId: undefined, report: undefined };
        return { attempt, subjectId, report: await coordinator.reconcile({ subjectId }) };
      } finally { running = false; leasedIdentityId = undefined; }
    },
  };
}
export type AccountDeletionRevocationWorker = ReturnType<typeof createAccountDeletionRevocationWorker>;
