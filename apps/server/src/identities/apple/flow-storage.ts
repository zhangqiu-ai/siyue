import {randomBytes,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {sessionTokensSchema,appleReauthGrantSchema,appleReauthActionSchema,type AppleReauthGrant,type SessionTokens,appleLoginStartRequestSchema,appleLoginStartResponseSchema,type AppleLoginStartRequest} from '@siyue/contracts';
import {transaction} from '../../adapters/postgres/database.js';
import {digest,matchesDigest,parseOpaque,type RecoveryCipher} from '../../adapters/crypto/auth-crypto.js';

const proofSchema=z.object({flowId:z.uuid(),transactionSecret:z.string().regex(/^[A-Za-z0-9_-]{43}$/),state:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict();
type Proof=z.infer<typeof proofSchema>;
const requestHashSchema=z.string().regex(/^[0-9a-f]{64}$/);
const verifiedSchema=z.object({identity:z.object({provider:z.literal('apple'),subject:z.string().min(1).max(255),clientId:z.string().min(1).max(255)}).strict(),refreshToken:z.string().min(1).max(8192)}).strict();
type Verified=z.infer<typeof verifiedSchema>;
/** Verified session binding for a reauth flow. The caller verifies the bearer inside our
 * transaction (signature + row state); this store only enforces purpose/session binding. */
export type AppleSessionProof={bearer:string;verify:(client:PoolClient,bearer:string)=>Promise<{sessionId:string;subjectId:string}>};
const sessionBindingSchema=z.object({sessionId:z.uuid(),subjectId:z.uuid()}).strict();
type SessionBinding=z.infer<typeof sessionBindingSchema>;
type AppleFlowFinish=(connection:PoolClient,result:Verified,flow:AppleFlowContext,binding:SessionBinding|undefined)=>Promise<SessionTokens|AppleReauthGrant>;
type Flow={id:string;client_id:string;installation_id:string;device_label:string|null;purpose:'login'|'reauth';action:string|null;session_id:string|null;secret_hash:string;state_hash:string;nonce_hash:string;
 status:'pending'|'exchanging'|'verified'|'failed'|'expired'|'completed';completed_at:Date|null;completed_session_id:string|null;response_ciphertext:string|null;response_expires_at:Date|null;expires_at:Date;request_hash:string|null;expected_subject:string|null;lease_id:string|null;lease_expires_at:Date|null;verified_ciphertext:string|null};
export class AppleFlowError extends Error {
 constructor(readonly code:'invalid_flow'|'restart_required'|'in_progress'|'request_conflict'|'stale_exchange'|'recovery_expired'|'invalid_request'|'session_invalid'|'session_mismatch'){super(code);}
}
const context=(row:Flow)=>({flowId:row.id,clientId:row.client_id,nonceHash:row.nonce_hash,installationId:row.installation_id,purpose:row.purpose,
 ...row.action!==null?{action:row.action}:{},...row.session_id!==null?{sessionId:row.session_id}:{},...row.device_label!==null?{deviceLabel:row.device_label}:{}});
export type AppleFlowContext=ReturnType<typeof context>;
const aad=(row:Flow)=>`apple-flow:${row.id}:${row.client_id}`;
const responseAad=(row:Flow)=>`apple-response:${row.id}:${row.client_id}`;
/** Private repository. No external I/O runs inside these short row-lock transactions.
 * A lost exchange lease is terminal: it must never authorize another token-endpoint call.
 */
export function createAppleFlowStorage(pool:Pool,cipher:RecoveryCipher,clientId:string,clock:()=>Date=()=>new Date()){
 if(!/^[A-Za-z0-9.-]{1,255}$/.test(clientId))throw new Error('invalid_apple_client');
 function checkProof(row:Flow|undefined,proof:Proof):asserts row is Flow{
  if(!row||row.client_id!==clientId||!matchesDigest(proof.transactionSecret,row.secret_hash)||!matchesDigest(proof.state,row.state_hash))throw new AppleFlowError('invalid_flow');
 }
 const expired=(row:Flow,now:Date)=>+row.expires_at<=+now;
 const abortStatus=async(connection:{query:Pool['query']},id:string,status:'failed'|'expired')=>{
  await connection.query('UPDATE siyue.apple_login_flows SET status=$2,lease_id=NULL,lease_expires_at=NULL,verified_ciphertext=NULL WHERE id=$1',[id,status]);
 };
 /** A reauth flow only authorizes the session bound at start. The bearer is verified inside
  * this row-lock transaction, so a cross-session or revoked session cannot consume the flow.
  * login flows keep their original contract: no session proof is accepted at all.
  */
 async function bindSession(connection:PoolClient,row:Flow,session:AppleSessionProof|undefined){
  if(row.purpose==='login'){if(session)throw new AppleFlowError('invalid_request');return undefined;}
  if(!session||row.session_id===null)throw new AppleFlowError('invalid_request');
  let binding:SessionBinding;
  try{binding=sessionBindingSchema.parse(await session.verify(connection,session.bearer));}
  catch{throw new AppleFlowError('session_invalid');}
  if(binding.sessionId!==row.session_id)throw new AppleFlowError('session_mismatch');
  return binding;
 }
 async function recoverRow(connection:PoolClient,row:Flow,requestHash:string,binding:SessionBinding|undefined){
  if(row.request_hash!==requestHash)throw new AppleFlowError('request_conflict');
  const now=clock();
  if(!row.response_ciphertext||!row.response_expires_at||+row.response_expires_at<=+now)throw new AppleFlowError('recovery_expired');
  return row.purpose==='login'?recoverSession(connection,row,now):recoverGrant(connection,row,binding!,now);
}
 async function recoverSession(connection:PoolClient,row:Flow,now:Date){
  let tokens:SessionTokens;
  try{tokens=sessionTokensSchema.parse(cipher.open(row.response_ciphertext!,responseAad(row)));}
  catch{throw new AppleFlowError('recovery_expired');}
  if(tokens.session.sessionId!==row.completed_session_id)throw new AppleFlowError('recovery_expired');
  // Follow the same subject -> session -> refresh lock order as refresh/revocation.
  const subject=(await connection.query('SELECT kind,status,credential_version FROM siyue.subjects WHERE id=$1 FOR UPDATE',[tokens.session.subjectId])).rows[0];
  const session=(await connection.query('SELECT * FROM siyue.auth_sessions WHERE id=$1 FOR UPDATE',[row.completed_session_id])).rows[0];
  const refresh=(await connection.query('SELECT * FROM siyue.refresh_tokens WHERE id=$1 AND session_id=$2 FOR UPDATE',[tokens.refreshToken.split('.')[0],row.completed_session_id])).rows[0];
  const checkedAt=clock();
  if(+row.response_expires_at!<=+checkedAt||!subject||subject.kind!=='adult'||subject.status!=='active'||!session||session.subject_id!==tokens.session.subjectId||session.revoked_at||session.credential_version!==subject.credential_version||+session.idle_expires_at<=+checkedAt||+session.absolute_expires_at<=+checkedAt||(session.grant_expires_at&&+session.grant_expires_at<=+checkedAt)||!refresh||refresh.used_at||refresh.revoked_at||+refresh.expires_at<=+checkedAt||!matchesDigest(tokens.refreshToken.split('.')[1]!,refresh.secret_hash))throw new AppleFlowError('recovery_expired');
  return tokens;
 }
 /** Reauth recovery returns the same grant only while it is still usable: unconsumed,
  * unexpired, bound to the verified session that owns the flow and issued for exactly the
  * action the flow row bound at start. */
 async function recoverGrant(connection:PoolClient,row:Flow,binding:SessionBinding,now:Date){
  let grant:AppleReauthGrant,opaque:{id:string;secret:string};
  try{grant=appleReauthGrantSchema.parse(cipher.open(row.response_ciphertext!,responseAad(row)));opaque=parseOpaque(grant.reauthGrant);}
  catch{throw new AppleFlowError('recovery_expired');}
  const action=appleReauthActionSchema.safeParse(row.action);
  const stored=(await connection.query('SELECT * FROM siyue.reauth_grants WHERE id=$1 FOR UPDATE',[opaque.id])).rows[0];
  const checkedAt=clock();
  if(!action.success||+row.response_expires_at!<=+checkedAt||!stored||stored.session_id!==row.session_id||stored.subject_id!==binding.subjectId||
    stored.action!==action.data||stored.consumed_at!==null||+stored.expires_at<=+checkedAt||!matchesDigest(opaque.secret,stored.secret_hash))throw new AppleFlowError('recovery_expired');
  return grant;
 }
 /** Reauth completion publishes the grant the caller's finish callback persisted in this
  * same transaction; no new identity or session is created for a reauth flow. The published
  * grant must carry exactly the action and session this flow row bound at start, so a
  * mis-wired caller cannot commit a wider or differently scoped credential. */
 async function completeGrant(connection:PoolClient,row:Flow,result:Verified,binding:SessionBinding,finish:AppleFlowFinish){
  const grant=appleReauthGrantSchema.parse(await finish(connection,result,context(row),binding)),now=clock(),action=appleReauthActionSchema.safeParse(row.action);
  let opaque:{id:string;secret:string};
  try{opaque=parseOpaque(grant.reauthGrant);}catch{throw new AppleFlowError('invalid_request');}
  const stored=(await connection.query('SELECT subject_id,session_id,action FROM siyue.reauth_grants WHERE id=$1',[opaque.id])).rows[0];
  if(!action.success||!stored||stored.subject_id!==binding.subjectId||stored.session_id!==row.session_id||stored.action!==action.data)throw new AppleFlowError('invalid_request');
  // Long lock waits or a slow provider may cross the flow deadline: rollback all writes.
  if(expired(row,now))throw new AppleFlowError('restart_required');
  await connection.query(`UPDATE siyue.apple_login_flows SET status='completed',verified_ciphertext=NULL,completed_at=$2,completed_session_id=$3,response_ciphertext=$4,response_expires_at=$5 WHERE id=$1`,
   [row.id,now,row.session_id,cipher.seal(grant,responseAad(row)),new Date(+now+60_000)]);
  return grant;
 }
 return {
  async recover(value:Proof,requestHash:string,session?:AppleSessionProof){
   const proof=proofSchema.parse(value);requestHashSchema.parse(requestHash);
   return transaction(pool,async connection=>{
    const row=(await connection.query<Flow>('SELECT * FROM siyue.apple_login_flows WHERE id=$1 FOR UPDATE',[proof.flowId])).rows[0];checkProof(row,proof);
    // Purpose/session binding is checked before any provider work, so a cross-session or
    // session-free caller cannot claim, exchange or consume another flow.
    const binding=await bindSession(connection,row,session);
    return row.status==='completed'?recoverRow(connection,row,requestHash,binding):null;
   });
  },
  async complete(value:Proof,requestHash:string,finish:AppleFlowFinish,session?:AppleSessionProof){
   const proof=proofSchema.parse(value);requestHashSchema.parse(requestHash);
   return transaction(pool,async connection=>{
    const row=(await connection.query<Flow>('SELECT * FROM siyue.apple_login_flows WHERE id=$1 FOR UPDATE',[proof.flowId])).rows[0];checkProof(row,proof);
    const binding=await bindSession(connection,row,session);
    if(row.status==='completed')return recoverRow(connection,row,requestHash,binding);
    if(expired(row,clock())||row.status!=='verified')throw new AppleFlowError('restart_required');
    if(row.request_hash!==requestHash)throw new AppleFlowError('request_conflict');
    let result:Verified;
    try{result=verifiedSchema.parse(cipher.open(row.verified_ciphertext!,aad(row)));}catch{throw new AppleFlowError('restart_required');}
    if(result.identity.subject!==row.expected_subject||result.identity.clientId!==clientId)throw new AppleFlowError('restart_required');
    if(row.purpose==='reauth')return completeGrant(connection,row,result,binding!,finish);
    const tokens=sessionTokensSchema.parse(await finish(connection,result,context(row),binding)),now=clock();
    // Long lock waits or a slow signer may cross the flow deadline: rollback all writes.
    if(expired(row,now))throw new AppleFlowError('restart_required');
    await connection.query(`UPDATE siyue.apple_login_flows SET status='completed',verified_ciphertext=NULL,completed_at=$2,completed_session_id=$3,response_ciphertext=$4,response_expires_at=$5 WHERE id=$1`,
     [row.id,now,tokens.session.sessionId,cipher.seal(tokens,`apple-response:${row.id}:${row.client_id}`),new Date(+now+60_000)]);
    return tokens;
   });
  },
  async start(value:AppleLoginStartRequest,session?:{sessionId:string}){
   const input=appleLoginStartRequestSchema.parse(value),now=clock(),expiresAt=new Date(+now+300_000),flowId=randomUUID();
   // The purpose decides whether a verified Siyue session is required; a caller cannot
   // smuggle a session into a login flow or start a reauth flow without one.
   if(input.purpose==='reauth'){if(!session)throw new AppleFlowError('invalid_request');}
   else if(session)throw new AppleFlowError('invalid_request');
   const sessionId=input.purpose==='reauth'?z.uuid().parse(session!.sessionId):null;
   const transactionSecret=randomBytes(32).toString('base64url'),state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url');
   await pool.query(`INSERT INTO siyue.apple_login_flows(id,client_id,installation_id,device_label,secret_hash,state_hash,nonce_hash,created_at,expires_at,purpose,action,session_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[flowId,clientId,input.installationId,input.deviceLabel??null,digest(transactionSecret),digest(state),digest(nonce),now,expiresAt,
    input.purpose,input.purpose==='reauth'?input.action:null,sessionId]);
   return appleLoginStartResponseSchema.parse({flowId,transactionSecret,state,nonce,expiresAt:expiresAt.toISOString()});
  },
  async inspect(value:Proof){
   const proof=proofSchema.parse(value),row=(await pool.query<Flow>('SELECT * FROM siyue.apple_login_flows WHERE id=$1',[proof.flowId])).rows[0];checkProof(row,proof);
   if(expired(row,clock())||['failed','expired'].includes(row.status))throw new AppleFlowError('restart_required');
   return context(row);
  },
  async claim(value:Proof,subject:string,requestHash:string){
   const proof=proofSchema.parse(value);z.string().min(1).max(255).parse(subject);z.string().regex(/^[0-9a-f]{64}$/).parse(requestHash);
   const outcome=await transaction(pool,async connection=>{
    const row=(await connection.query<Flow>('SELECT * FROM siyue.apple_login_flows WHERE id=$1 FOR UPDATE',[proof.flowId])).rows[0];checkProof(row,proof);const now=clock();
    if(row.status==='completed')return {error:'recovery_expired' as const};
    if(expired(row,now)){await abortStatus(connection,row.id,'expired');return {error:'restart_required' as const};}
    if(row.status==='failed'||row.status==='expired')return {error:'restart_required' as const};
    if(row.status==='exchanging'&&+row.lease_expires_at!<=+now){await abortStatus(connection,row.id,'failed');return {error:'restart_required' as const};}
    if(row.status!=='pending'&&(row.request_hash!==requestHash||row.expected_subject!==subject))return {error:'request_conflict' as const};
    if(row.status==='exchanging')return {error:'in_progress' as const};
    if(row.status==='verified'){
     try{const result=verifiedSchema.parse(cipher.open(row.verified_ciphertext!,aad(row)));
      if(result.identity.subject!==row.expected_subject||result.identity.clientId!==row.client_id)return {error:'restart_required' as const};
      return {kind:'verified' as const,flow:context(row),result};
     }catch{return {error:'restart_required' as const};}
    }
    const leaseId=randomUUID();await connection.query(`UPDATE siyue.apple_login_flows SET status='exchanging',request_hash=$2,expected_subject=$3,lease_id=$4,lease_expires_at=$5 WHERE id=$1`,[row.id,requestHash,subject,leaseId,new Date(Math.min(+now+30_000,+row.expires_at))]);
    return {kind:'claimed' as const,flow:context(row),leaseId};
   });
   if('error' in outcome)throw new AppleFlowError(outcome.error);return outcome;
  },
  async recordVerified(flowId:string,leaseId:string,value:Verified){
   z.uuid().parse(flowId);z.uuid().parse(leaseId);const result=verifiedSchema.parse(value);
   const error=await transaction(pool,async connection=>{
    const row=(await connection.query<Flow>('SELECT * FROM siyue.apple_login_flows WHERE id=$1 FOR UPDATE',[flowId])).rows[0];
    if(!row||row.client_id!==clientId||row.status!=='exchanging'||row.lease_id!==leaseId)return 'stale_exchange' as const;
    const now=clock();if(expired(row,now)||+row.lease_expires_at!<=+now){await abortStatus(connection,row.id,expired(row,now)?'expired':'failed');return 'restart_required' as const;}
    if(result.identity.subject!==row.expected_subject||result.identity.clientId!==row.client_id){await abortStatus(connection,row.id,'failed');return 'stale_exchange' as const;}
    await connection.query(`UPDATE siyue.apple_login_flows SET status='verified',verified_ciphertext=$2,lease_id=NULL,lease_expires_at=NULL WHERE id=$1`,[row.id,cipher.seal(result,aad(row))]);return null;
   });if(error)throw new AppleFlowError(error);
  },
  async fail(flowId:string,leaseId:string){
   z.uuid().parse(flowId);z.uuid().parse(leaseId);
   return (await pool.query(`UPDATE siyue.apple_login_flows SET status='failed',lease_id=NULL,lease_expires_at=NULL,verified_ciphertext=NULL WHERE id=$1 AND client_id=$2 AND status='exchanging' AND lease_id=$3`,[flowId,clientId,leaseId])).rowCount===1;
  },
  async cleanup(){
   await transaction(pool,async connection=>{
    const now=clock();await connection.query(`UPDATE siyue.apple_login_flows SET status='expired',lease_id=NULL,lease_expires_at=NULL,verified_ciphertext=NULL WHERE expires_at<=$1 AND status NOT IN ('failed','expired','completed')`,[now]);
    await connection.query(`UPDATE siyue.apple_login_flows SET status='failed',lease_id=NULL,lease_expires_at=NULL WHERE status='exchanging' AND lease_expires_at<=$1`,[now]);
    await connection.query("UPDATE siyue.apple_login_flows SET response_ciphertext=NULL,response_expires_at=NULL WHERE status='completed' AND response_expires_at<=$1",[now]);
    await connection.query('DELETE FROM siyue.apple_login_flows WHERE COALESCE(completed_at,expires_at)<=$1',[new Date(+now-86_400_000)]);
   });
  },
 };
}
