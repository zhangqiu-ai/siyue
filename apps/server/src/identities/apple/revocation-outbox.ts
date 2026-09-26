import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {RecoveryCipher} from '../../adapters/crypto/auth-crypto.js';
import type {AppleRevocationOutcome} from './revocation.js';

/** The only thing a queued revocation keeps about the account: the credential exactly as the
 * identity store already sealed it, plus the two identifiers its AAD is derived from. No plaintext
 * provider token, no email, no display name and no subject profile (design 13.3). */
export const appleRevocationJobSchema=z.object({identityId:z.uuid(),
 providerNamespace:z.string().min(1).max(255).regex(/^[A-Za-z0-9._-]+$/),
 refreshCiphertext:z.string().min(1).max(32_768)}).strict();
export type AppleRevocationJob=z.infer<typeof appleRevocationJobSchema>;
/** The decrypted provider credential, with the bounds the identity store seals it under. */
const credentialSchema=z.object({refreshToken:z.string().min(1).max(8192)}).strict();
/** Mirrors the AAD the Apple identity store seals a credential with. Revocation must open exactly
 * that context, so it is derived from the job's own identifiers instead of stored beside them. */
export const appleCredentialContext=(identityId:string,providerNamespace:string)=>'apple-identity:'+identityId+':'+providerNamespace;
/** The subject's live Apple credentials, read under their own rows inside the caller's transaction. */
const credentialsSql="SELECT i.id AS identity_id,i.provider_namespace,c.refresh_ciphertext FROM siyue.external_identities i JOIN siyue.apple_provider_credentials c ON c.identity_id=i.id WHERE i.subject_id=$1 AND i.provider='apple' AND i.status='active' ORDER BY i.id FOR UPDATE OF i,c LIMIT 33";

export type AppleRevocationClaim={jobId:string;job:AppleRevocationJob;attempt:number;leaseId:string;expiresAt:Date};
/** One attempt's outcome. 'retry' carries the next allowed time. 'revoked', 'needs_attention' and
 * 'expired' are terminal for the queue; the last two are deliberately NOT named success, so a
 * deletion status can stay provider_revocation_pending instead of pretending Apple was told. */
export type AppleRevocationSettlement=
 |{state:'revoked'}
 |{state:'retry';availableAt:Date;errorCode:string}
 |{state:'needs_attention';errorCode:string}
 |{state:'expired';errorCode:string};
/** Two error-code families share these fields: 'apple_*' describes what the provider refused or
 * failed to answer, and queue-local codes (revocation_not_attempted, revocation_window_expired,
 * credential_unreadable) describe the outbox's own bounded decision. Both are lowercase snake_case
 * and bounded, so they can be stored as a client-visible account_deletion_jobs.last_error_code. */
export type AppleRevocationAlert='apple_revocation_expired'|'apple_revocation_needs_attention';

/** Persistence contract of the outbox. A durable implementation needs the additive
 * siyue.apple_revocation_outbox table, or the equivalent third kind in siyue.outbox_jobs whose
 * current CHECK allows only the two mail kinds. That migration is reported, not written here, so
 * this module owns the contract and the state machine instead of unverified SQL. */
export interface AppleRevocationStore {
 /** Must join the caller's transaction: an accepted deletion and its queued revocation commit
  * together or not at all. Idempotent per job.identityId, so a repeated call cannot open a second
  * job for the same Apple identity. */
 enqueue(client:PoolClient,input:{job:AppleRevocationJob;availableAt:Date;expiresAt:Date}):Promise<void>;
 /** At most one job whose availableAt has passed, leased to this caller so two workers never run the
  * same attempt. Terminal jobs are never returned again. */
 claim(now:Date,leaseUntil:Date):Promise<AppleRevocationClaim|undefined>;
 /** Applies one attempt's outcome; a lost or mismatched lease is a no-op. 'revoked' and 'expired'
  * must destroy the sealed payload, which has no further use after either settlement. */
 settle(claim:AppleRevocationClaim,settlement:AppleRevocationSettlement,now:Date):Promise<void>;
}
interface MemoryJob {jobId:string;job:AppleRevocationJob|null;status:'pending'|'sending'|'revoked'|'needs_attention'|'expired';
 attempts:number;availableAt:Date;expiresAt:Date;leaseId:string|null;leaseUntil:Date|null;lastErrorCode:string|null;}
/** Non-durable reference store. It implements the port's semantics (idempotent enqueue, single-owner
 * claim, payload destruction on terminal settlement) and survives nothing; production needs the
 * reported table. The job map stays exposed so a host or test reads state without a second API. */
export function createAppleRevocationMemoryStore(){
 const jobs=new Map<string,MemoryJob>();let sequence=0;
 return {
  jobs,
  async enqueue(_client:PoolClient,input:{job:AppleRevocationJob;availableAt:Date;expiresAt:Date}){
   const job=appleRevocationJobSchema.parse(input.job);
   if(!Number.isFinite(+input.availableAt)||!(+input.availableAt<+input.expiresAt))throw new Error('invalid_apple_revocation_window');
   if(jobs.has(job.identityId))return;
   jobs.set(job.identityId,{jobId:'00000000-0000-4000-8000-'+String(++sequence).padStart(12,'0'),job,status:'pending',
    attempts:0,availableAt:input.availableAt,expiresAt:input.expiresAt,leaseId:null,leaseUntil:null,lastErrorCode:null});
  },
  async claim(now:Date,leaseUntil:Date){
   const row=[...jobs.values()].filter(candidate=>candidate.status==='pending'&&+candidate.availableAt<=+now)
    .sort((left,right)=>+left.availableAt-+right.availableAt||left.jobId.localeCompare(right.jobId))[0];
   if(!row?.job)return undefined;
   row.status='sending';row.attempts+=1;row.leaseId=randomUUID();row.leaseUntil=leaseUntil;
   return {jobId:row.jobId,job:row.job,attempt:row.attempts,leaseId:row.leaseId,expiresAt:row.expiresAt};
  },
  async settle(claim:AppleRevocationClaim,settlement:AppleRevocationSettlement,now:Date){
   const row=[...jobs.values()].find(candidate=>candidate.jobId===claim.jobId);
   if(!row||row.status!=='sending'||row.leaseId!==claim.leaseId)return;
   row.leaseId=null;row.leaseUntil=null;row.availableAt=now;
   if(settlement.state==='retry'){row.status='pending';row.availableAt=settlement.availableAt;row.lastErrorCode=settlement.errorCode;return;}
   row.status=settlement.state;
   row.lastErrorCode=settlement.state==='revoked'?null:settlement.errorCode;
   // A revoked or expired credential is destroyed. A needs_attention job keeps its bounded seal so an
   // operator who fixes the client configuration can still revoke inside the window.
   if(settlement.state!=='needs_attention')row.job=null;
  },
 };
}
export type AppleRevocationMemoryStore=ReturnType<typeof createAppleRevocationMemoryStore>;

/** Account-deletion-facing boundary plus its worker half. enqueueForSubject is called inside the
 * deletion acceptance transaction; tick performs at most one provider attempt outside any
 * transaction, because a slow Apple call must not hold a database row lock. */
export function createAppleRevocationOutbox(options:{store:AppleRevocationStore;cipher:RecoveryCipher;
 revoke:(input:{refreshToken:string})=>Promise<AppleRevocationOutcome>;clock?:()=>Date;windowMs?:number;
 retryDelayMs?:number;maxRetryDelayMs?:number;alert?:(code:AppleRevocationAlert)=>void}){
 const clock=options.clock??(()=>new Date()),alert=options.alert??(()=>{});
 const windowMs=options.windowMs??7*86_400_000;
 // The design's operational default: first attempt immediately, bounded exponential retry for at
 // most seven days. A caller may narrow the window, never widen it past 30 days, and a narrowed
 // window also narrows the default retry delays instead of being rejected as a configuration error.
 const retryDelayMs=options.retryDelayMs??Math.min(30_000,windowMs);
 const maxRetryDelayMs=options.maxRetryDelayMs??Math.max(retryDelayMs,Math.min(6*3_600_000,windowMs));
 if(!Number.isInteger(windowMs)||windowMs<60_000||windowMs>30*86_400_000||
   !Number.isInteger(retryDelayMs)||retryDelayMs<1000||retryDelayMs>windowMs||
   !Number.isInteger(maxRetryDelayMs)||maxRetryDelayMs<retryDelayMs||maxRetryDelayMs>windowMs)throw new Error('invalid_apple_revocation_config');
 const backoff=(attempt:number)=>Math.min(retryDelayMs*2**Math.max(0,attempt-1),maxRetryDelayMs);
 return {
  /** Reads the subject's own live Apple credentials and queues one revocation per identity through
  * the SAME client, so a rolled-back deletion leaves no queued revocation and a committed one cannot
  * lose it. Only active identities that still carry a credential qualify; nothing else is copied. */
  async enqueueForSubject(client:PoolClient,input:{subjectId:string}){
   const subjectId=z.uuid().parse(input.subjectId),now=clock(),expiresAt=new Date(+now+windowMs);
   const rows=(await client.query(credentialsSql,[subjectId])).rows as
    Array<{identity_id:string;provider_namespace:string;refresh_ciphertext:string}>;
   // Never silently omit an identity beyond the bounded scan. The caller's transaction rolls
   // back, leaving the account active for investigation instead of pretending every token queued.
   if(rows.length>32)throw new Error('apple_revocation_identity_limit');
   for(const row of rows)await options.store.enqueue(client,{availableAt:now,expiresAt,job:appleRevocationJobSchema.parse(
    {identityId:row.identity_id,providerNamespace:row.provider_namespace,refreshCiphertext:row.refresh_ciphertext})});
   return {identities:rows.length};
  },
  async tick():Promise<'revoked'|'retry'|'needs_attention'|'expired'|undefined>{
   const now=clock(),claim=await options.store.claim(now,new Date(+now+60_000));
   if(!claim)return undefined;
   // A closed window is settled before the credential is decrypted or sent anywhere.
   if(+claim.expiresAt<=+now){await options.store.settle(claim,{state:'expired',errorCode:'revocation_not_attempted'},now);
    alert('apple_revocation_expired');return 'expired';}
   let refreshToken:string;
   try{refreshToken=credentialSchema.parse(options.cipher.open(claim.job.refreshCiphertext,
     appleCredentialContext(claim.job.identityId,claim.job.providerNamespace))).refreshToken;}
   catch{
    // A payload that cannot be opened under this job's own AAD is terminal: sending a credential that
    // may belong to another identity is never an option, and retrying cannot repair the seal.
    await options.store.settle(claim,{state:'needs_attention',errorCode:'credential_unreadable'},now);
    alert('apple_revocation_needs_attention');return 'needs_attention';
   }
   let outcome:AppleRevocationOutcome;
   try{outcome=await options.revoke({refreshToken});}catch{outcome={outcome:'unavailable'};}
   const settledAt=clock();
   // invalid_grant means Apple cannot use this refresh token at all, so nothing remains to revoke and
   // the account must not stay pending on a dead credential. Every other documented rejection is our
   // own request or client authentication failing: repeating the identical call cannot help, so the
   // job stops with an alert and keeps the bounded seal instead of reporting a false success.
   if(outcome.outcome==='revoked'||(outcome.outcome==='rejected'&&outcome.error==='invalid_grant')){
    await options.store.settle(claim,{state:'revoked'},settledAt);return 'revoked';
   }
   if(outcome.outcome==='rejected'){
    await options.store.settle(claim,{state:'needs_attention',errorCode:'apple_'+outcome.error},settledAt);
    alert('apple_revocation_needs_attention');return 'needs_attention';
   }
   const availableAt=new Date(+settledAt+backoff(claim.attempt));
   // Once the next attempt would fall outside the window the job ends here: the sealed credential is
   // destroyed and the caller keeps provider_revocation_pending for manual follow-up (design 13.3).
   if(+availableAt>=+claim.expiresAt){await options.store.settle(claim,{state:'expired',errorCode:'revocation_window_expired'},settledAt);
    alert('apple_revocation_expired');return 'expired';}
   await options.store.settle(claim,{state:'retry',availableAt,errorCode:'apple_provider_unavailable'},settledAt);
   return 'retry';
  },
 };
}
