import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {appleRevocationJobSchema,type AppleRevocationClaim,type AppleRevocationJob,
 type AppleRevocationSettlement,type AppleRevocationStore} from './revocation-outbox.js';

/** Retention of a terminal row is bounded by construction: a caller may narrow it, and the ceiling is
 * the longest revocation window the outbox itself can be configured with (30 days), so no settled
 * row -- including a `needs_attention` seal an operator may still act on -- lives in the main
 * database indefinitely. */
const minRetentionMs=60_000,maxRetentionMs=30*86_400_000;
const errorCodeSchema=z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
interface ClaimRow {
 id:string;identity_id:string;provider_namespace:string;refresh_ciphertext:string;
 attempts:number;lease_id:string;expires_at:Date;
}
/** A timestamp column accepts only a real instant; a NaN date would be stored as NULL or fail
 * opaquely, so callers get one named error instead. */
const instant=(value:Date,label:string)=>{
 if(!(value instanceof Date)||!Number.isFinite(+value))throw new Error('invalid_apple_revocation_'+label);
 return new Date(+value);
};
/** Idempotent by identity: a repeated enqueue inside another transaction never opens a second job, so
 * the accepted deletion and its queued revocation commit together or not at all. */
const enqueueSql=`INSERT INTO siyue.apple_revocation_outbox
    (id,identity_id,provider_namespace,refresh_ciphertext,status,attempts,available_at,expires_at,created_at)
  VALUES($1,$2,$3,$4,'pending',0,$5,$6,$7)
  ON CONFLICT(identity_id) DO NOTHING`;
/** One statement claims at most one job, so two workers can never run the same attempt: rows another
 * transaction holds are skipped instead of waited for, and a lease that was abandoned is claimable
 * again with a NEW lease id. The candidate MUST stay materialized: the planner otherwise re-executes
 * the locking subquery once per scanned target row, and one call would then lease (and silently
 * strand) several jobs instead of exactly one. The predicate is repeated in the outer UPDATE so a row
 * that changed while the candidate was locked cannot be claimed on a stale condition. A job whose
 * authorization retry window has not opened yet is skipped the same way a held row is, WITHOUT waiting
 * for it: that is what keeps one unauthorized queue head from starving the rows behind it, and a
 * successful claim clears the deferral in the same statement so the leased attempt carries none.
 * Terminal rows and a job whose revocation window already closed are deliberately not filtered here:
 * the outbox settles a closed window as `expired` without a provider call, and that decision needs the
 * row -- which is also why an unauthorized row past its window is skipped rather than settled here. */
const claimSql=`WITH candidate AS MATERIALIZED (
   SELECT id FROM siyue.apple_revocation_outbox
    WHERE ((status='pending' AND available_at<=$1) OR (status='sending' AND lease_until<=$1))
      AND (authorization_retry_at IS NULL OR authorization_retry_at<=$1)
    ORDER BY available_at,id
    FOR UPDATE SKIP LOCKED LIMIT 1)
UPDATE siyue.apple_revocation_outbox AS target
   SET status='sending',attempts=target.attempts+1,lease_id=$2,lease_until=$3,authorization_retry_at=NULL
  FROM candidate
 WHERE target.id=candidate.id
   AND ((target.status='pending' AND target.available_at<=$1) OR (target.status='sending' AND target.lease_until<=$1))
   AND (target.authorization_retry_at IS NULL OR target.authorization_retry_at<=$1)
RETURNING target.id,target.identity_id,target.provider_namespace,target.refresh_ciphertext,
  target.attempts,target.lease_id,target.expires_at`;
/** Matching the claimed lease is the whole fence: a lost, replaced or already-settled lease changes
 * no row, and a terminal settlement destroys the sealed payload in the same statement. */
const settleSql=`UPDATE siyue.apple_revocation_outbox
   SET status=$3,available_at=$4,lease_id=NULL,lease_until=NULL,
     refresh_ciphertext=CASE WHEN $3 IN ('revoked','expired') THEN NULL ELSE refresh_ciphertext END,
     last_error_code=$5,settled_at=$6,retain_until=$7
 WHERE id=$1 AND status='sending' AND lease_id=$2`;
/** A deferral is fenced exactly like a settlement: it matches the claimed lease and nothing else, so an
 * abandoned, replaced or already-settled attempt changes no row and a stale owner can neither settle
 * nor defer the newer attempt. The row returns to `pending` with its lease cleared and one new fact --
 * the instant an authorization may be retried. available_at, expires_at, attempts, the bounded error
 * code and the sealed credential are all left exactly as they were, so a deferral never revives a
 * destroyed seal, never shortens or extends the window the job belongs to and never writes a settlement
 * stamp: a job still waiting for an authorization is not a decided job. */
const deferAuthorizationSql=`UPDATE siyue.apple_revocation_outbox
   SET status='pending',lease_id=NULL,lease_until=NULL,authorization_retry_at=$3
 WHERE id=$1 AND status='sending' AND lease_id=$2`;
/** Only a terminal row that reached its bound is removed; a live queue row and a seal inside its
 * revocation window are never touched. */
const purgeSql='DELETE FROM siyue.apple_revocation_outbox WHERE retain_until IS NOT NULL AND retain_until<=$1';

/**
 * Durable implementation of the Apple revocation outbox port (migrations 0016 and 0019). It stores only
 * the credential the identity store already sealed plus the two identifiers its AAD is derived from, and
 * it opens no route, calls no provider and starts no worker by itself.
 *
 * `enqueue` joins the caller's transaction, so an accepted deletion that rolls back leaves no queued
 * revocation, and a committed one cannot lose it; `claim` leases exactly one due job with
 * `FOR UPDATE SKIP LOCKED`; `settle` only applies to the lease the caller still holds, so an
 * abandoned attempt that was re-claimed cannot overwrite the newer outcome.
 *
 * `deferAuthorization` is how a refused attempt is put back without being decided: the row returns to the
 * queue with its seal, its availability and its window untouched, behind a persisted retry instant, so the
 * next `claim` skips it instead of leasing it again and a later, authorized job can still be drained. It is
 * deliberately outside the port: it exists only where the column migration 0019 adds exists.
 */
export function createAppleRevocationPostgresStore(pool:Pool,options:{clock?:()=>Date;retentionMs?:number}={}) {
 const clock=options.clock??(()=>new Date()),retentionMs=options.retentionMs??maxRetentionMs;
 if(!Number.isInteger(retentionMs)||retentionMs<minRetentionMs||retentionMs>maxRetentionMs)
  throw new Error('invalid_apple_revocation_retention');
 return {
  /** The bound this store writes into retain_until, exposed so a caller does not have to guess it. */
  retentionMs,
  /** Writes one queued revocation through the caller's client. A Pool has no transaction of its own,
   * so it is refused instead of silently committing the row outside the deletion transaction. */
  async enqueue(client:PoolClient,input:{job:AppleRevocationJob;availableAt:Date;expiresAt:Date}):Promise<void> {
   if(typeof (client as {release?:unknown}|undefined)?.release!=='function')
    throw new Error('apple_revocation_enqueue_requires_transaction_client');
   const job=appleRevocationJobSchema.parse(input.job);
   const availableAt=instant(input.availableAt,'availability'),expiresAt=instant(input.expiresAt,'expiry');
   if(+availableAt>=+expiresAt)throw new Error('invalid_apple_revocation_window');
   await client.query(enqueueSql,[randomUUID(),job.identityId,job.providerNamespace,job.refreshCiphertext,
    availableAt,expiresAt,clock()]);
  },
  /** At most one attempt per call. A row that is already leased is not returned before its lease
   * expires, which is what makes an abandoned attempt recoverable instead of lost. */
  async claim(now:Date,leaseUntil:Date):Promise<AppleRevocationClaim|undefined> {
   const at=instant(now,'claim'),until=instant(leaseUntil,'lease');
   if(+until<=+at)throw new Error('invalid_apple_revocation_lease');
   const row=(await pool.query<ClaimRow>(claimSql,[at,randomUUID(),until])).rows[0];
   if(!row)return undefined;
   return {jobId:row.id,attempt:row.attempts,leaseId:row.lease_id,expiresAt:row.expires_at,
    job:{identityId:row.identity_id,providerNamespace:row.provider_namespace,refreshCiphertext:row.refresh_ciphertext}};
  },
  /** Applies one attempt's outcome. `retry` returns the job to the queue inside its own window with
   * the bounded error code kept, `revoked` and `expired` destroy the seal and are terminal, and
   * `needs_attention` is terminal too but keeps the bounded seal so an operator can still finish the
   * revocation inside the window. */
  async settle(claim:AppleRevocationClaim,settlement:AppleRevocationSettlement,now:Date):Promise<void> {
   z.uuid().parse(claim?.jobId);z.uuid().parse(claim?.leaseId);
   const expiresAt=instant(claim.expiresAt,'claim_expiry'),settledAt=settlement.state==='retry'?null:instant(now,'settlement');
   const availableAt=settlement.state==='retry'?instant(settlement.availableAt,'retry'):instant(now,'settlement');
   // A retry that would land outside the window is not a queue state at all: the outbox settles it as
   // expired instead, so the database and the store refuse the impossible combination.
   if(settlement.state==='retry'&&+availableAt>=+expiresAt)throw new Error('invalid_apple_revocation_window');
   const lastErrorCode=settlement.state==='revoked'?null:errorCodeSchema.parse(settlement.errorCode);
   // Retention never truncates the revocation window it belongs to, and never outlives the store's
   // own bound past settlement.
   const retainUntil=settledAt===null?null:new Date(Math.max(+settledAt+retentionMs,+expiresAt));
   await pool.query(settleSql,[claim.jobId,claim.leaseId,settlement.state==='retry'?'pending':settlement.state,
    availableAt,lastErrorCode,settledAt,retainUntil]);
  },
  /** Removes terminal rows that reached their bounded retention, returning how many were dropped. */
  async purge(now:Date=clock()):Promise<number> {
   return (await pool.query(purgeSql,[instant(now,'purge')])).rowCount??0;
  },
  /** Defers the attempt the caller still holds until an authorization may be retried: the row goes back to
   * `pending` inside its own window with its sealed credential, availability and attempt count untouched,
   * and carries the instant from which the queue may lease it again. Like `settle`, a lease this store no
   * longer owns is a no-op rather than an error -- a refusal that arrived too late cannot reopen a row -- so
   * the caller reads the outcome from the row, not from this call. A retry instant that is not a real,
   * strictly future instant is refused instead of written: a value that already passed would leave the row
   * claimable in the same breath, which is the starvation this deferral exists to end, and a NaN timestamp
   * would be stored as NULL and silently mean "due now". */
  async deferAuthorization(claim:AppleRevocationClaim,until:Date):Promise<void> {
   z.uuid().parse(claim?.jobId);z.uuid().parse(claim?.leaseId);
   const retryAt=instant(until,'authorization_retry');
   if(+retryAt<=+clock())throw new Error('invalid_apple_revocation_authorization_retry');
   await pool.query(deferAuthorizationSql,[claim.jobId,claim.leaseId,retryAt]);
  },
 } satisfies AppleRevocationStore & {retentionMs:number;purge(now?:Date):Promise<number>;
  deferAuthorization(claim:AppleRevocationClaim,until:Date):Promise<void>};
}
export type AppleRevocationPostgresStore=ReturnType<typeof createAppleRevocationPostgresStore>;
