import type { Pool } from 'pg';
import { z } from 'zod';
import {
  AccountDeletionCleanupError, accountDeletionCleanupBlockerSchema, accountDeletionCleanupRemovedSchema,
  createAccountDeletionCleanupKernel, type AccountDeletionCleanupKernel,
} from './account-deletion-cleanup.js';

// Bounded cleanup-fleet runner for accepted account deletions (design 13.1/13.3).
//
// One call takes a bounded slice of the deletion jobs that are not finished and runs the existing
// cleanup kernel on them one job at a time; each job keeps the kernel's own single transaction, so a
// sweep never holds a transaction of its own across jobs. This file opens no route, starts no timer and
// makes no provider call: a host decides when to sweep. It also decides no family or child disposition
// (design 13.2) and touches no anti-revival ledger -- a job that reaches `needs_attention` because of a
// dependency is reported, not resolved here.
//
// Four properties are load-bearing:
//
// 1. THE WORK IS BOUNDED AND ADDRESSED IN A DEFINED ORDER. Candidates are read with `LIMIT`, new
//    accepted jobs precede provider-waiting jobs, dependency-blocked jobs are last, and `completed` is
//    never a candidate, so an operator's blocked backlog can never crowd out a freshly accepted
//    deletion and a finished job is never reopened. A sweep also never loops: it examines the one batch
//    it selected and returns.
// 2. SAFE CONCURRENCY, NOT EXCLUSIVE OWNERSHIP. `FOR UPDATE SKIP LOCKED` makes one instance step over a
//    job another instance is holding right now instead of queueing behind it, but that lock ends with
//    the read -- the real mutual exclusion is the kernel's subject-then-job lock inside its own
//    transaction. Two instances may therefore take the same job; the loser then sees `completed` and
//    removes nothing. "Safe" here means at-most-once *effect*, never at-most-once *attempt*, so a
//    caller must read the two reports together rather than adding their removal counts.
// 3. A FAILURE IS NEVER A SUCCESS. Only the kernel's own bounded refusal is a fact about one job; it is
//    reported as `failed` with that code and is never counted as cleaned. Any other error is an
//    infrastructure fault and rejects the sweep after the jobs already attempted have committed, so a
//    broken database cannot be reported as a finished batch.
// 4. AN UNFINISHED JOB IS RETRIED, JUST NOT TIGHTLY. A job still waiting on its provider, blocked or failed is remembered by
//    this instance and left alone until its own delay has elapsed, which is what stops a scheduler that
//    ticks every second from hammering a job it cannot yet finish. That memory is per process: the
//    table carries no attempt timestamp and this slice adds no column, so the cross-instance cadence
//    remains the deployment's schedule and a blocked job is still attempted at most once per sweep.

const boundedCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const defaultLimit = 50, maxLimit = 200;
const limitSchema = z.number().int().min(1).max(maxLimit);
/** Initial value for the per-instance hold-back of a job that cannot be finished yet. */
const defaultRetryDelayMs = 15 * 60_000;
const retryDelaySchema = z.number().int().min(0).max(7 * 86_400_000);
const defaultProcessingRetryDelayMs = 30_000;

/** A sweep takes at most one bounded batch; every other input is a caller defect, not a schedule. */
export const accountDeletionCleanupRunRequestSchema = z.object({ limit: limitSchema.optional() }).strict();

/** The four shapes one attempted job can end in. `completed` is the only one that claims both cleanup
 * dimensions finished; `cleaned` removed the server-side data while an external revocation still
 * waits, and `needs_attention` and `failed` removed nothing this pass. */
export const accountDeletionCleanupRunStatusSchema = z.enum([
  'completed', 'cleaned', 'needs_attention', 'failed',
]);

/**
 * One job as this sweep evaluated it. `blockers` and `removed` carry the kernel's own bounded answer,
 * so an operator can tell a first pass from an idempotent replay without reading the tables; a job the
 * kernel refused has no removal count (`null`) and no blocker inventory, because nothing was decided
 * about it, and its two dimension flags are the ones its row already carried.
 */
export const accountDeletionCleanupRunJobSchema = z.object({
  deletionId: z.uuid(), subjectId: z.uuid(), status: accountDeletionCleanupRunStatusSchema,
  errorCode: boundedCode.nullable(),
  serverDataDeleted: z.boolean(), providerRevocationPending: z.boolean(),
  blockers: z.array(accountDeletionCleanupBlockerSchema),
  removed: accountDeletionCleanupRemovedSchema.nullable(),
}).strict();
export type AccountDeletionCleanupRunJob = z.infer<typeof accountDeletionCleanupRunJobSchema>;

/**
 * One sweep's whole result. `outcome` is `busy` exactly when a sweep of this same instance was still
 * in flight, in which case this call took no job and ran nothing -- it is a refusal, never a claim that
 * the batch is empty. `deferred` counts the jobs this instance deliberately left alone inside its own
 * hold-back window, so provider waits and blocked backlogs remain visible instead of looking idle.
 */
export const accountDeletionCleanupRunReportSchema = z.object({
  outcome: z.enum(['ran', 'busy']),
  taken: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  cleaned: z.number().int().nonnegative(),
  needsAttention: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  deferred: z.number().int().nonnegative(),
  jobs: z.array(accountDeletionCleanupRunJobSchema),
}).strict();
export type AccountDeletionCleanupRunReport = z.infer<typeof accountDeletionCleanupRunReportSchema>;

export interface AccountDeletionCleanupRunnerOptions {
  /** The cleanup kernel this runner sweeps. Defaults to the real kernel over the same pool and clock. */
  kernel?: AccountDeletionCleanupKernel;
  clock?: () => Date;
  /** Default batch size for a sweep that does not pass its own; bounded by `maxLimit` either way. */
  limit?: number;
  /** How long this instance holds back a job that ended blocked or failed. */
  needsAttentionRetryDelayMs?: number;
  /** Polling interval for a job whose own data is gone but provider revocation is still open. */
  processingRetryDelayMs?: number;
}

interface JobRow {
  id: string; subject_id: string;
  local_data_deleted: boolean; provider_revocation_pending: boolean;
}

// Pending work first, blocked work last, so one operator queue cannot starve a new deletion. The two
// dimension flags are read with the selection because a refused job reports the state its row really
// has instead of a guessed one. `SKIP LOCKED` steps over a job another instance holds right now.
const candidateSql = `SELECT id,subject_id,local_data_deleted,provider_revocation_pending
  FROM siyue.account_deletion_jobs
  WHERE state<>'completed' AND NOT (id=ANY($2::uuid[]))
  ORDER BY CASE state WHEN 'accepted' THEN 0 WHEN 'processing' THEN 1 ELSE 2 END,requested_at,id
  LIMIT $1
  FOR UPDATE SKIP LOCKED`;

// Only asked when this instance is holding something back: how many of those jobs are still unfinished,
// so the report counts real deferred work rather than remembered ids that may have moved on.
const deferredSql = `SELECT count(*)::int AS n FROM siyue.account_deletion_jobs
  WHERE state<>'completed' AND id=ANY($1::uuid[])`;

/**
 * Builds the sweep runner over one database pool. The kernel is injectable so a test or a host can
 * supply its own, and it defaults to the real cleanup kernel over the same pool and clock.
 *
 * A concluded sweep is idempotent by construction: a completed job is never selected again and every
 * surviving write the kernel makes is guarded, so a repeated sweep changes no row and no timestamp.
 */
export function createAccountDeletionCleanupRunner(
  pool: Pool, options: AccountDeletionCleanupRunnerOptions = {},
) {
  const clock = options.clock ?? (() => new Date());
  const configuredLimit = options.limit === undefined ? undefined : limitSchema.parse(options.limit);
  const retryDelayMs = options.needsAttentionRetryDelayMs === undefined
    ? defaultRetryDelayMs : retryDelaySchema.parse(options.needsAttentionRetryDelayMs);
  const processingRetryDelayMs = options.processingRetryDelayMs === undefined
    ? defaultProcessingRetryDelayMs : retryDelaySchema.parse(options.processingRetryDelayMs);
  const kernel = options.kernel ?? createAccountDeletionCleanupKernel(pool, clock);
  // One sweep in flight per instance: two calls in one process would race the same batch. Across
  // processes it is the kernel's transaction that makes the effect single-owner.
  let running = false;
  const retryAfter = new Map<string, number>();

  /** One job, with the kernel's answer or its bounded refusal; an infrastructure error is not caught. */
  async function attempt(row: JobRow): Promise<{ job: AccountDeletionCleanupRunJob; holdForMs: number | null }> {
    try {
      const result = await kernel.cleanupSubject({ subjectId: row.subject_id });
      return {
        holdForMs: result.outcome === 'needs_attention' ? retryDelayMs
          : result.outcome === 'cleaned' ? processingRetryDelayMs : null,
        job: {
          deletionId: result.deletionId, subjectId: result.subjectId, status: result.outcome,
          errorCode: null, serverDataDeleted: result.serverDataDeleted,
          providerRevocationPending: result.providerRevocationPending,
          blockers: result.blockers, removed: result.removed,
        },
      };
    } catch (error) {
      if (!(error instanceof AccountDeletionCleanupError)) throw error;
      return {
        holdForMs: retryDelayMs,
        job: {
          deletionId: row.id, subjectId: row.subject_id, status: 'failed', errorCode: error.code,
          serverDataDeleted: row.local_data_deleted,
          providerRevocationPending: row.provider_revocation_pending,
          blockers: [], removed: null,
        },
      };
    }
  }

  return {
    /**
     * Takes one bounded batch of unfinished jobs and runs the cleanup kernel on each in turn. Stops
     * after that batch: there is no loop that re-selects the jobs this sweep could not finish.
     */
    async sweep(input: unknown = {}): Promise<AccountDeletionCleanupRunReport> {
      const request = accountDeletionCleanupRunRequestSchema.safeParse(input);
      if (!request.success) throw new AccountDeletionCleanupError('cleanup_invalid_request');
      const limit = request.data.limit ?? configuredLimit ?? defaultLimit;
      if (running) return accountDeletionCleanupRunReportSchema.parse({
        outcome: 'busy', taken: 0, completed: 0, cleaned: 0, needsAttention: 0, failed: 0,
        deferred: 0, jobs: [],
      });
      running = true;
      try {
        const startedAt = +clock();
        const cooling = [...retryAfter]
          .filter(([, until]) => until > startedAt).map(([deletionId]) => deletionId);
        const candidates = (await pool.query<JobRow>(candidateSql, [limit, cooling])).rows;
        const jobs: AccountDeletionCleanupRunJob[] = [];
        for (const candidate of candidates) {
          const attempted = await attempt(candidate);
          jobs.push(attempted.job);
          if (attempted.holdForMs !== null) retryAfter.set(candidate.id, startedAt + attempted.holdForMs);
          else retryAfter.delete(candidate.id);
        }
        // Forget what is no longer held back, so the map only ever remembers jobs this instance is
        // still postponing and cannot grow with the whole job table.
        for (const [deletionId, until] of retryAfter) if (until <= startedAt) retryAfter.delete(deletionId);
        const deferred = cooling.length === 0 ? 0
          : (await pool.query<{ n: number }>(deferredSql, [cooling])).rows[0]?.n ?? 0;
        return accountDeletionCleanupRunReportSchema.parse({
          outcome: 'ran', taken: jobs.length,
          completed: jobs.filter(job => job.status === 'completed').length,
          cleaned: jobs.filter(job => job.status === 'cleaned').length,
          needsAttention: jobs.filter(job => job.status === 'needs_attention').length,
          failed: jobs.filter(job => job.status === 'failed').length,
          deferred, jobs,
        });
      } finally { running = false; }
    },
  };
}
export type AccountDeletionCleanupRunner = ReturnType<typeof createAccountDeletionCleanupRunner>;
