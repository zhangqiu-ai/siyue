import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  appleRevocationProgressCodes, createAccountDeletionRevocationWorker,
  type AccountDeletionRevocationWorker, type AppleRevocationJobProgress,
  type AppleRevocationWorkerOptions,
} from './account-deletion-revocation.js';

// Bounded runtime orchestration of the durable Apple revocation queue (design 13.3).
//
// `account-deletion-revocation.ts` already owns both halves: the outbox settles one provider attempt
// and the coordinator decides one deletion job's provider dimension, and its worker ties exactly those
// two together for one subject. What no module owned yet is the schedule around them -- how much work
// one runtime step may take and what it reports back. This file is that smallest composition: one
// bounded batch of queue attempts driven through the existing worker, then one bounded coordination
// pass over the jobs that still wait. Neither half is re-implemented here.
//
// This file opens no route, starts no timer, reads no signal and calls no provider on its own. The only
// provider call is the outbox's injected `revoke`, so a host or a test supplies it and nothing here can
// reach appleid.apple.com. It also decides nothing about local cleanup, families or child disposition,
// and it writes no column of `siyue.account_deletion_jobs` that migration 0015 does not already own.
//
// Four properties are load-bearing:
//
// 1. BOUNDED AND NON-LOOPING. One sweep examines at most `limit` queue claims and then exactly one
//    coordination pass of at most `limit` jobs, both under the coordinator's own limit schema. The
//    attempt loop stops the moment the queue has nothing due, and it never re-selects a job it just
//    settled: a retry pushes its own `available_at` forward, and a terminal row is never claimable
//    again. There is deliberately no per-process hold-back map either -- the outbox's window and
//    backoff are the only retry cadence, so this module cannot invent a second one.
// 2. TWO INDEPENDENT FACTS, JOINED ONLY BY THE SUBJECT. `revoked`/`retry`/`needsAttention`/`expired`
//    describe what the *queue* answered for one attempt; `checked`/`cleared`/`jobs` describe the
//    deletion job's provider *dimension* through the coordinator, which is the fact a receipt reads.
//    An attempt that settled `revoked` is not by itself proof that any job moved -- a settlement whose
//    lease was taken over changes no row -- so the authoritative half of this report is always the
//    coordination one. A dimension is cleared only while every Apple identity of the subject carries a
//    `revoked` row, and that rule stays in the coordinator instead of being restated here.
// 3. SILENCE IS NEVER A CONFIRMED REVOCATION. An identity that never carried a usable credential
//    produces no claim and therefore no attempt, so the coordination pass is the only thing that can
//    answer for it. That job keeps `provider_revocation_pending` with the bounded code
//    `apple_credential_missing` -- the same code the acceptance kernel writes for the same fact -- and
//    a sweep never reports an account as provider-revoked merely because its queue was quiet.
// 4. SAFE CONCURRENCY, NOT EXCLUSIVE OWNERSHIP. A second sweep of the *same* instance is refused with
//    `busy` instead of run, because two calls in one process would race the worker's claim handoff.
//    Across processes the store's lease is what makes one *attempt* single-owner and the coordinator's
//    `FOR UPDATE SKIP LOCKED` plus its repeated predicate is what makes one *decision* single-owner; a
//    sweep adds no lock of its own. A repeated sweep with nothing due is cheap by construction: it
//    re-stores the value the waiting rows already carry and can never re-open a cleared dimension.

/** The bounded code vocabulary a sweep re-validates its own job entries with: the same four values
 * `account-deletion-revocation.ts` decides with. The report below is a checked contract in this
 * module's own right, not a repackaged coordinator result. */
const progressCodeSchema = z.enum([
  appleRevocationProgressCodes.credentialMissing, appleRevocationProgressCodes.queued,
  appleRevocationProgressCodes.expired, appleRevocationProgressCodes.needsAttention,
]);
/** One deletion job as the sweep finalised it: the evidence the decision used, so an operator reads
 * why a job still waits instead of trusting a code alone. */
export const appleRevocationJobProgressSchema = z.object({
  deletionId: z.uuid(), subjectId: z.uuid(), cleared: z.boolean(),
  errorCode: progressCodeSchema.nullable(),
  identities: z.number().int().nonnegative(), confirmed: z.number().int().nonnegative(),
}).strict();

const defaultLimit = 50, maxLimit = 200;
const limitSchema = z.number().int().min(1).max(maxLimit);

/** A sweep takes at most one bounded batch; every other input is a caller defect, not a schedule. */
export const accountDeletionRevocationRunRequestSchema = z.object({ limit: limitSchema.optional() }).strict();

/**
 * Bounded refusal of one sweep. It is raised before any statement runs, so an invalid request can never
 * consume an attempt, a lease or a coordination pass.
 */
export class AccountDeletionRevocationRunError extends Error {
  constructor(readonly code: 'revocation_invalid_request') { super(code); }
}

/** A claim gate may raise this before the provider is reached; the bounded sweep then moves to the
 * next claim without treating the refused row as a provider attempt. */
export class AccountDeletionRevocationAuthorizationRefusal extends Error {}

/**
 * One sweep's whole result. `outcome` is `busy` exactly when a sweep of this same instance was still in
 * flight, in which case this call took no attempt, leased nothing and coordinated nothing -- it is a
 * refusal, never a claim that the queue is empty. Provider attempts plus authorization refusals are
 * bounded by `limit`; the four settlement counters sum to `attempts`. The
 * coordination half is `checked`/`cleared` and the per-job evidence in `jobs`.
 */
export const accountDeletionRevocationRunReportSchema = z.object({
  outcome: z.enum(['ran', 'busy']),
  /** Queue attempts this sweep actually made: at most `limit`. */
  attempts: z.number().int().nonnegative(),
  /** Claimed rows refused by a caller-supplied authorization gate before any provider call. */
  refused: z.number().int().nonnegative(),
  /** What those attempts settled as. A provider answer is a fact about the attempt, not about a row. */
  revoked: z.number().int().nonnegative(), retry: z.number().int().nonnegative(),
  needsAttention: z.number().int().nonnegative(), expired: z.number().int().nonnegative(),
  /** Deletion jobs this sweep decided about: `jobs.length`, at most two bounded batches. */
  checked: z.number().int().nonnegative(),
  /** Jobs whose provider dimension finished: every one of the subject's Apple identities confirmed. */
  cleared: z.number().int().nonnegative(),
  /** One entry per deletion job, in first-decision order, each carrying its latest decision. */
  jobs: z.array(appleRevocationJobProgressSchema),
}).strict();
export type AccountDeletionRevocationRunReport = z.infer<typeof accountDeletionRevocationRunReportSchema>;

/**
 * The existing worker's options plus the one decision this runner makes on its own: how large a single
 * sweep's batch is.
 *
 * `store` is required and never defaulted. Only the caller knows which durable table backs the queue --
 * `identities/apple/revocation-postgres.ts` over the same pool is the production answer -- and a runtime
 * orchestrator that quietly picked one would be claiming durability it cannot verify.
 */
export interface AccountDeletionRevocationRunnerOptions extends AppleRevocationWorkerOptions {
  /** The worker this runner drives. Defaults to the real one over the same pool and options, which is
   * what a host wants; a test or a re-wiring may pass its own instead. */
  worker?: AccountDeletionRevocationWorker;
}

/**
 * Builds the bounded sweep over one database pool. The provider half is the injected `revoke` and the
 * store is the caller's, so a sweep of this module is exactly as durable -- and exactly as free of
 * provider calls of its own -- as the outbox it drives.
 *
 * A sweep is idempotent by construction: a settled queue row is never claimed again, a job that still
 * waits is re-reported with the code it already carries, and every write the coordinator makes is
 * guarded by the predicate that job already satisfies.
 */
export function createAccountDeletionRevocationRunner(
  pool: Pool, options: AccountDeletionRevocationRunnerOptions,
) {
  const { worker: injected, ...workerOptions } = options;
  const configuredLimit = workerOptions.limit === undefined ? undefined : limitSchema.parse(workerOptions.limit);
  const worker = injected ?? createAccountDeletionRevocationWorker(pool, workerOptions);
  // One sweep in flight per instance. Across processes the store's lease and the coordinator's own
  // lock are the fences; this flag only stops one process from racing itself.
  let running = false;
  return {
    /** Same contract as the outbox: queue this subject's live Apple credentials inside the caller's
     * deletion transaction, or queue nothing at all. */
    enqueueForSubject: (client: PoolClient, input: { subjectId: string }) =>
      worker.enqueueForSubject(client, input),
    /** The receipt half on its own, for a host that wants to coordinate without attempting anything. */
    reconcile: (input?: { subjectId?: string; limit?: number }) => worker.reconcile(input),
    /**
     * Takes one bounded batch of due queue attempts and then one bounded coordination pass. Stops after
     * that batch: there is no loop that re-selects a job this sweep could not finish.
     */
    async sweep(input: unknown = {}): Promise<AccountDeletionRevocationRunReport> {
      const request = accountDeletionRevocationRunRequestSchema.safeParse(input);
      if (!request.success) throw new AccountDeletionRevocationRunError('revocation_invalid_request');
      const limit = request.data.limit ?? configuredLimit ?? defaultLimit;
      if (running) return accountDeletionRevocationRunReportSchema.parse({
        outcome: 'busy', attempts: 0, refused: 0, revoked: 0, retry: 0, needsAttention: 0, expired: 0,
        checked: 0, cleared: 0, jobs: [],
      });
      running = true;
      try {
        // Keyed by the queue's own settlement names; the report renames `needs_attention` to camelCase.
        const settled: Record<'revoked' | 'retry' | 'needs_attention' | 'expired', number> =
          { revoked: 0, retry: 0, needs_attention: 0, expired: 0 };
        // First decision keeps its position, last decision wins its content: a job attempted here and
        // re-evaluated by the pass below is reported once, carrying the pass's fresher evidence.
        const decisions = new Map<string, AppleRevocationJobProgress>();
        let attempts = 0, refused = 0;
        while (attempts + refused < limit) {
          let tick: Awaited<ReturnType<AccountDeletionRevocationWorker['tick']>>;
          try { tick = await worker.tick(); }
          catch (error) {
            if (!(error instanceof AccountDeletionRevocationAuthorizationRefusal)) throw error;
            refused += 1;
            continue;
          }
          // Nothing is due for this call: the batch is finished, not deferred. A retry already moved
          // its own availability past this clock, so a settled job cannot reappear inside this sweep.
          if (tick.attempt === undefined) break;
          attempts += 1;
          settled[tick.attempt] += 1;
          for (const job of tick.report?.jobs ?? []) decisions.set(job.deletionId, job);
        }
        // The coordination pass is what answers the subjects the queue cannot reach at all -- an
        // identity with no usable credential never produces a claim -- so it runs even when the
        // attempt batch was already full. It is bounded by the same `limit`.
        for (const job of (await worker.reconcile({ limit })).jobs) decisions.set(job.deletionId, job);
        const jobs = [...decisions.values()];
        return accountDeletionRevocationRunReportSchema.parse({
          outcome: 'ran', attempts, refused, revoked: settled.revoked, retry: settled.retry,
          needsAttention: settled.needs_attention, expired: settled.expired,
          checked: jobs.length, cleared: jobs.filter(job => job.cleared).length, jobs,
        });
      } finally { running = false; }
    },
  };
}
export type AccountDeletionRevocationRunner = ReturnType<typeof createAccountDeletionRevocationRunner>;
