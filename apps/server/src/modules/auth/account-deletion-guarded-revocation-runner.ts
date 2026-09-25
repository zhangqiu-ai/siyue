import type { Pool } from 'pg';
import { z } from 'zod';
import type { DeletionLedgerStore, LedgerStatus } from '../../account-deletion-ledger/ledger-store.js';
import type { AppleRevocationClaim, AppleRevocationStore } from '../../identities/apple/revocation-outbox.js';
import {
  createAccountDeletionRevocationWorker, type AccountDeletionRevocationWorker,
  type AppleRevocationJobProgress, type AppleRevocationReconcileReport,
} from './account-deletion-revocation.js';
import {
  AccountDeletionRevocationAuthorizationRefusal, createAccountDeletionRevocationRunner,
  type AccountDeletionRevocationRunner,
  type AccountDeletionRevocationRunnerOptions,
} from './account-deletion-revocation-runner.js';

// Ledger-authorized Apple revocation: the durable revocation queue behind the independent anti-revival
// ledger (design 13.3/13.4).
//
// `account-deletion-revocation-runner.ts` drains `siyue.apple_revocation_outbox` and hands each claimed
// credential to an injected provider call, and which subject an attempt belongs to is decided by a row in
// the main database -- the one whose backups get restored. A restored backup can therefore carry both a
// queued revocation and a deletion job whose deletion the independent ledger never accepted, and the queue
// alone cannot tell that pair apart from an authorized one: it would send a live credential to Apple for a
// subject nobody authorized to delete. This module puts the ledger in front of BOTH halves of a sweep, not
// just the provider call:
//
//   1. THE CLAIM GATE wraps `store.claim`, so no credential leaves the queue for a subject without an
//      accepted marker whose intent is that subject's committed job id.
//   2. THE COORDINATION GATE wraps the bounded `reconcile` pass. That half does not call a provider, but it
//      DOES write `siyue.account_deletion_jobs` -- it stamps `last_error_code` and can close
//      `provider_revocation_pending`. Left unguarded it would move an unauthorized, restored job on the
//      strength of the restored backup itself, which is exactly the resurrection design 13.4 forbids.
//
// Five properties are load-bearing:
//
// 1. THE CLAIM GATE SITS BETWEEN THE LEASE AND THE OUTBOX. The guard wraps `store.claim` and nothing else:
//    the real store leases the row, the authorization is read, and only then is the claim handed back. A
//    refused identity is therefore never decrypted (the outbox opens the seal on the returned claim), never
//    handed to the provider, and never settled, so no code path this module guards reaches Apple.
// 2. THE COORDINATION GATE ONLY EVER DECIDES AUTHORIZED JOBS. It takes the same bounded candidate slice
//    the coordinator takes, asks the ledger about each candidate, and delegates ONLY the authorized ones to
//    the coordinator's own subject-scoped statement. An unauthorized job is left completely untouched: no
//    flag, no code, no row. The two gates also compose -- a job whose queue row was just attempted was
//    authorized by gate 1, so the tick's own subject-scoped decision needs no second read.
// 3. THE LEDGER IS READ, NEVER WRITTEN. The guard only calls `lookup`, so it cannot mint the authorization
//    it checks, and the ledger's own watermark proves a pass moved nothing.
// 4. A REFUSED CLAIM IS NOT A PROVIDER ATTEMPT. A bounded refusal defers the leased row without
//    destroying its seal; the sweep counts it separately and continues to the next due claim. An
//    unusable ledger (`LEDGER_UNAVAILABLE`, `LEDGER_UNREADABLE`) remains an infrastructure fault and
//    propagates instead of becoming a bounded job code.
// 5. THE AUTHORIZATION CANNOT BE WITHDRAWN UNDERNEATH AN ATTEMPT. The two databases share no transaction,
//    so this check and the later provider call are not atomic. What makes that acceptable is the ledger's
//    own protocol: `accepted` is terminal by ledger database privilege, and the main job's
//    `provider_revocation_pending` cannot close while this very row is in flight, because the coordinator
//    clears that flag only once every Apple identity of the subject carries a `revoked` row -- and the row
//    this claim holds is `sending`, not `revoked`.
//
// WHAT THE SWEEP REPORT NOW MEANS, AND THE POST-CLAIM LEASE:
//
//   * `checked`/`cleared`/`jobs` describe the jobs this sweep DECIDED, and every decided job is ledger-
//     authorized. An unauthorized waiting job is neither decided nor written, so it is absent from the
//     report instead of appearing as a failure: this module reports what it may act on, and reading the
//     authorization of the rest is a separate, read-only audit this module does not pretend to be.
//   * `claim` is a lease: it moves the row to `sending` and increments `attempts`. A bounded refusal
//     returns it to `pending` with a durable five-minute authorization retry time. The sealed credential,
//     provider error code and revocation window are preserved, including when the window has expired.
//     An unavailable ledger instead leaves the 60-second lease in place and rejects the whole sweep.
//   * A bounded refusal consumes one of the sweep's claim slots, appears in `refused`, and lets the next
//     due row proceed. The bulk coordinator uses a moving cursor so unauthorized jobs without claimable
//     queue rows cannot occupy the same first page forever. Neither mechanism treats a refusal as a
//     confirmed revocation or writes an unauthorized deletion job.
//   * A coordination pass costs one extra main-database read plus one ledger read per candidate, and one
//     scoped statement per authorized job, all bounded by the same `limit` the coordinator already respects.
//     An unauthorized job still consumes a candidate slot, so a slice is a bound on work rather than a
//     queue position.
//
// It opens no HTTP route, starts no timer, reads no signal and calls no provider of its own: the only
// provider call remains the outbox's injected `revoke`, so a host or a test supplies it and nothing here can
// reach appleid.apple.com. The enqueue path is deliberately not guarded here: the acceptance kernel
// prepares the ledger marker before it commits the job and queues the revocation in the same transaction.

/** Bounded reason the guard refused one claim. It is what a caller reads from
 * `AccountDeletionRevocationGuardRefusal.reason` -- a code, never a message, row or secret. The entry
 * reasons match `account-deletion-guarded-runner.ts`, so one refusal vocabulary reads across both guarded
 * paths. */
export const accountDeletionRevocationGuardReasonSchema = z.enum([
  // 缺数据: the claimed identity row no longer resolves, so no subject -- and no authorization -- can be
  // reached from it. Migration 0016's foreign key makes this unreachable through the real store while the
  // queue row exists; it is kept for the drift and direct-port shapes the neighbouring worker also guards.
  'identity_missing',
  // 缺数据: the main database holds no committed deletion job for the subject, so there is nothing the
  // ledger's intent could be compared with. The sweep selects its candidates from that very table, so it
  // only reaches this reason through a restored queue row or a direct call.
  'deletion_job_missing',
  // 未受理: the subject's job is no longer waiting on Apple -- its provider dimension is already closed, or
  // the contradictory row carries a completion stamp -- so there is no open dimension this attempt could
  // belong to.
  'deletion_job_not_pending',
  // 缺数据: the ledger holds no marker for the subject. "No marker" is exactly what a restored older backup
  // looks like, so it is an absence of authorization, not authorization.
  'ledger_entry_missing',
  // 未受理: the marker is `prepared` -- acceptance may have committed without its marker ever being
  // recorded. Only reconciliation may resolve that, and it must prove the commit from the main job.
  'ledger_entry_prepared',
  // 未受理: the marker is `cancelled` -- the request was withdrawn. `cancel` refuses an accepted row, so this
  // is a real withdrawal rather than a downgrade of an accepted deletion.
  'ledger_entry_cancelled',
  // 不一致: the marker is `accepted`, but its intent is not this subject's committed job id, so the ledger
  // authorized a different transaction than the one that would be revoked.
  'ledger_intent_mismatch',
  // Defensive: the ledger's vocabulary is exactly `prepared`/`accepted`/`cancelled` and the store validates
  // it before returning, so this reason exists for schema drift rather than a reachable state.
  'ledger_entry_not_accepted',
]);
export type AccountDeletionRevocationGuardReason = z.infer<typeof accountDeletionRevocationGuardReasonSchema>;

/**
 * Bounded refusal of one claimed revocation. It is raised inside `claim`, after the row is deferred
 * and before a claim returns to the outbox, so the provider is never reached for this identity.
 *
 * It is deliberately NOT a `DeletionLedgerError`: a refusal is a fact about the job (this subject is not
 * authorized), while a `DeletionLedgerError` is an infrastructure fault. A caller can tell them apart, and a
 * caller that catches either one still cannot read the refusal as "nothing was due".
 */
export class AccountDeletionRevocationGuardRefusal extends AccountDeletionRevocationAuthorizationRefusal {
  readonly reason: AccountDeletionRevocationGuardReason;
  constructor(reason: AccountDeletionRevocationGuardReason) {
    super(reason);
    this.reason = reason;
  }
}

/** Caller defect at construction: a guarded runner may not be built around a caller-supplied worker,
 * because that worker would drive its own, unguarded `claim` and `reconcile` and this module would be a
 * silent no-op. */
export class AccountDeletionRevocationGuardConfigError extends Error {
  constructor(readonly code: 'guarded_revocation_worker_not_injectable') { super(code); }
}

const markerRefusal = (status: LedgerStatus): AccountDeletionRevocationGuardReason =>
  status === 'prepared' ? 'ledger_entry_prepared'
    : status === 'cancelled' ? 'ledger_entry_cancelled' : 'ledger_entry_not_accepted';

/** The claimed identity's subject. The authorization is about a subject, so this read comes first. */
const subjectSql = 'SELECT subject_id FROM siyue.external_identities WHERE id=$1';
/** The committed deletion job, read with the two columns the guard decides on rather than through an
 * aggregate predicate: a missing job and a closed dimension are different refusals and stay distinct. */
const deletionJobSql = `SELECT id,provider_revocation_pending,completed_at
   FROM siyue.account_deletion_jobs WHERE subject_id=$1`;
/** The bounded candidate slice the coordinator's own pass would take: same predicate, same order, same
 * limit. It is read WITHOUT a lock, because the per-subject statement below repeats the predicate under its
 * own row lock -- a slice another instance took first simply decides nothing here. */
const candidateSql = `SELECT id,subject_id,requested_at FROM siyue.account_deletion_jobs
   WHERE provider_revocation_pending AND completed_at IS NULL
     AND ($1::uuid IS NULL OR subject_id=$1::uuid)
     AND ($3::timestamptz IS NULL OR (requested_at,id)>($3::timestamptz,$4::uuid))
   ORDER BY requested_at,id
   LIMIT $2`;

/** The bounded slice and default the coordinator applies, restated because this pass slices its own
 * candidates. A configured limit is validated where the coordinator is built, so it is never re-checked. */
const defaultLimit = 50, maxLimit = 200;
const limitSchema = z.number().int().min(1).max(maxLimit);

export interface AccountDeletionGuardedRevocationStoreOptions {
  /** The durable store whose `claim` is guarded. Only `claim` is wrapped; `enqueue` and `settle` pass
   * through unchanged, so the deletion transaction and the settlement path keep their own contracts. */
  store: AppleRevocationStore & {deferAuthorization(claim:AppleRevocationClaim,until:Date):Promise<void>};
  /** The independent anti-revival ledger, read-only: the guard calls `lookup` and nothing else. */
  ledger: Pick<DeletionLedgerStore, 'lookup'>;
}

/**
 * Wraps one revocation store so no claim leaves it without the independent ledger's authorization for that
 * subject. The order is the whole module: lease, then identity, then the committed deletion job, then the
 * ledger. A missing identity or job, a closed provider dimension, and every non-accepted or differently
 * intended marker all throw a bounded refusal; a ledger read failure propagates as the ledger's own error.
 */
export function createAccountDeletionGuardedRevocationStore(pool: Pool,
  options: AccountDeletionGuardedRevocationStoreOptions): AppleRevocationStore {
  /** One claimed identity's authorization. Throws -- never returns a verdict -- so a caller cannot use the
   * result to mean "nothing to do". */
  async function authorize(identityId: string): Promise<void> {
    const identity = (await pool.query<{ subject_id: string }>(subjectSql, [identityId])).rows[0];
    if (!identity) throw new AccountDeletionRevocationGuardRefusal('identity_missing');
    const { subject_id: subjectId } = identity;
    const job = (await pool.query<{ id: string; provider_revocation_pending: boolean; completed_at: Date | null }>(
      deletionJobSql, [subjectId])).rows[0];
    if (!job) throw new AccountDeletionRevocationGuardRefusal('deletion_job_missing');
    // The flag is the dimension the coordinator owns. `completed_at` is redundant for a consistent row
    // (migration 0015's CHECK ties a completion stamp to a closed flag), which is exactly why it is read
    // too: the contradictory row is refused instead of being trusted.
    if (!job.provider_revocation_pending || job.completed_at !== null)
      throw new AccountDeletionRevocationGuardRefusal('deletion_job_not_pending');
    // A ledger read failure is not caught here. `LEDGER_UNAVAILABLE` and `LEDGER_UNREADABLE` mean the ledger
    // could not answer for this subject, and every other `DeletionLedgerError` is a caller defect the store
    // already refuses; all of them reject the sweep instead of reporting a quiet queue.
    const marker = await options.ledger.lookup(subjectId);
    if (!marker) throw new AccountDeletionRevocationGuardRefusal('ledger_entry_missing');
    if (marker.status !== 'accepted')
      throw new AccountDeletionRevocationGuardRefusal(markerRefusal(marker.status));
    if (marker.intentId !== job.id)
      throw new AccountDeletionRevocationGuardRefusal('ledger_intent_mismatch');
  }
  return {
    enqueue: (client, input) => options.store.enqueue(client, input),
    settle: (claim, settlement, now) => options.store.settle(claim, settlement, now),
    async claim(now, leaseUntil) {
      const claim = await options.store.claim(now, leaseUntil);
      // Nothing was due: the queue's own answer, passed through unchanged. Only a claim that was really
      // leased is checked, and only a checked claim is returned.
      if (!claim) return undefined;
      try { await authorize(claim.job.identityId); }
      catch(error){
        if(error instanceof AccountDeletionRevocationGuardRefusal)
          await options.store.deferAuthorization(claim,new Date(+now+5*60_000));
        throw error;
      }
      return claim;
    },
  };
}

/**
 * The guarded coordination pass: the coordinator's own bounded slice, filtered by the ledger before any job
 * row is written. Every candidate is looked up once; a marker that is missing, not `accepted`, or accepted
 * for another intent is skipped WITHOUT a write, and only an authorized candidate is delegated to the
 * coordinator's subject-scoped statement (the same one a tick uses, so its predicate, its row lock and its
 * bounded code vocabulary are the existing implementation's, not a second one).
 */
async function reconcileAuthorized(database: Pool,
  options: { ledger: Pick<DeletionLedgerStore, 'lookup'>; coordinator: Pick<AccountDeletionRevocationWorker, 'reconcile'>;
    configuredLimit: number | undefined;
    cursor: {requestedAt: Date | null; id: string | null}; },
  input: { subjectId?: string; limit?: number } | undefined): Promise<AppleRevocationReconcileReport> {
  // Same bounded request shape the coordinator accepts, re-validated because this pass slices its own
  // candidates before any job row exists to be locked.
  const subjectId = input?.subjectId === undefined ? null : z.uuid().parse(input.subjectId);
  const limit = input?.limit === undefined
    ? options.configuredLimit ?? defaultLimit : limitSchema.parse(input.limit);
  type Candidate = { id: string; subject_id: string; requested_at: Date };
  const readCandidates = (at: Date | null, id: string | null) =>
    database.query<Candidate>(candidateSql,[subjectId,limit,at,id]).then(result=>result.rows);
  let candidates = await readCandidates(subjectId===null?options.cursor.requestedAt:null,
    subjectId===null?options.cursor.id:null);
  if(subjectId===null&&candidates.length===0&&options.cursor.id!==null){
    options.cursor.requestedAt=null;options.cursor.id=null;
    candidates=await readCandidates(null,null);
  }
  if(subjectId===null&&candidates.length){
    const last=candidates[candidates.length-1]!;
    options.cursor.requestedAt=last.requested_at;options.cursor.id=last.id;
  }
  const decisions: AppleRevocationJobProgress[] = [];
  for (const candidate of candidates) {
    // Fail closed on everything that is not this subject's accepted marker: the pass does not act on that
    // job at all, so no column of an unauthorized deletion is written from a restored backup. A ledger read
    // failure is not caught -- the sweep rejects instead of deciding a slice it could not authorize.
    const marker = await options.ledger.lookup(candidate.subject_id);
    if (!marker || marker.status !== 'accepted' || marker.intentId !== candidate.id) continue;
    decisions.push(...(await options.coordinator.reconcile({ subjectId: candidate.subject_id })).jobs);
  }
  return { checked: decisions.length, cleared: decisions.filter(job => job.cleared).length, jobs: decisions };
}

export interface AccountDeletionGuardedRevocationRunnerOptions
  extends Omit<AccountDeletionRevocationRunnerOptions,'store'> {
  store: AccountDeletionGuardedRevocationStoreOptions['store'];
  /**
   * The independent anti-revival ledger every claim is checked against and every decided job is authorized
   * by. Required rather than optional: a queue with no ledger to read is not a queue this module is willing
   * to drain.
   */
  ledger: Pick<DeletionLedgerStore, 'lookup'>;
}

/**
 * The existing bounded sweep runner over the guarded store AND the guarded coordination pass, with every
 * other option -- store, cipher, provider call, clock, window, retry delays, limit, alert -- passed through
 * unchanged. An authorized identity sweeps exactly as before; a bounded refusal is deferred and counted
 * before the provider is reached, and an unauthorized waiting job is left untouched.
 *
 * A caller-supplied `worker` is refused instead of accepted: that worker would drive its own unguarded
 * `claim` and `reconcile`, so the guard would be bypassed in silence. The worker is therefore always the one
 * this factory builds over the guarded store, with only its coordination half replaced.
 */
export function createAccountDeletionGuardedRevocationRunner(pool: Pool,
  options: AccountDeletionGuardedRevocationRunnerOptions): AccountDeletionRevocationRunner {
  const { ledger, worker: injected, ...workerOptions } = options;
  if (injected !== undefined)
    throw new AccountDeletionRevocationGuardConfigError('guarded_revocation_worker_not_injectable');
  const store = createAccountDeletionGuardedRevocationStore(pool, { store: workerOptions.store, ledger });
  const worker = createAccountDeletionRevocationWorker(pool, { ...workerOptions, store });
  const cursor:{requestedAt:Date|null;id:string|null}={requestedAt:null,id:null};
  const guarded: AccountDeletionRevocationWorker = {
    enqueueForSubject: (client, input) => worker.enqueueForSubject(client, input),
    // One attempt only exists because the guarded claim authorized it, so the tick's own subject-scoped
    // decision needs no second read: `accepted` is terminal and cannot be withdrawn in between.
    tick: () => worker.tick(),
    reconcile: input => reconcileAuthorized(pool,
      { ledger, coordinator: worker, configuredLimit: workerOptions.limit, cursor }, input),
  };
  return createAccountDeletionRevocationRunner(pool, { ...workerOptions, store, worker: guarded });
}
