import {appleLoginCompleteRequestSchema,deletionDependencyDispositionSchema,type AppleLoginCompleteRequest,type AppleReauthAction,
  type DeletionDependencyDisposition,type DeletionReceipt,type EmailChallengeResponse} from '@siyue/contracts';
import {AuthClientError,type AuthApiClient} from './auth-api-client.js';
import type {AppleAuthorize} from './apple-sign-in.js';
import {createAccountDeletionAttempt,type AccountDeletionAttempt} from './account-deletion-attempt.js';

/** Transport failures that leave the server outcome unknown or safely replayable under the
 * same idempotency keys. Any other code ends the attempt. */
const retryable=new Set(['network','timeout','unavailable','busy','rate_limited','invalid_response']);
/** Caller-supplied link request: the new address and the single idempotency key the whole
 * operation is retried with. */
export interface AppleReauthOptions {
  api:AuthApiClient;newId:()=>string;now:()=>number;authorize:AppleAuthorize;
  email:string;locale:'zh-CN'|'en-US';key:string;
}
/** `access` returns a currently usable token for the session the flow was started against and
 * throws when that session or account generation is gone. */
export interface AppleReauthRun {access:()=>Promise<string>;installationId:string;signal:AbortSignal;}

/** One staged Apple re-authentication for an already approved action. The one-time action grant is
 * issued and held inside this closure: it is never persisted, never returned to a caller and never
 * published in client state. Stages stay in memory so a lost `complete` response is replayed under
 * the same completion key instead of repeating native authorization or spending a second grant. */
interface AppleGrantStage {
  clear:()=>void;canRetry:()=>boolean;
  ensure:(run:AppleReauthRun)=>Promise<{grant:string;expiresAt:number}>;
}
function createAppleGrantStage({api,newId,now,authorize,action}:
  {api:AuthApiClient;newId:()=>string;now:()=>number;authorize:AppleAuthorize;action:AppleReauthAction}):AppleGrantStage {
 let pending:{input:AppleLoginCompleteRequest;key:string;until:number}|undefined;
 let grant:{value:string;expiresAt:number}|undefined;
 let started=false;
 let expiryTimer:ReturnType<typeof setTimeout>|undefined;
 const clear=()=>{pending=undefined;grant=undefined;if(expiryTimer!==undefined)clearTimeout(expiryTimer);expiryTimer=undefined;};
 return {
  clear,
  canRetry:()=>{if(pending&&pending.until<=now())clear();if(grant&&grant.expiresAt<=now())clear();return !!(pending||grant);},
  async ensure({access,installationId,signal}) {
   if(signal.aborted)throw new AuthClientError('cancelled');
   if(!pending&&!grant){
    // A resumed instance without staged state would silently skip provider authorization,
    // so a finished attempt refuses to restart instead of reusing the caller's key.
    if(started)throw new AuthClientError('apple_restart_required');
    started=true;
    const flow=await api.startAppleReauth(await access(),{action,platform:'ios',installationId},signal);
    if(Date.parse(flow.expiresAt)<=now())throw new AuthClientError('apple_restart_required');
    const result=await authorize({nonce:flow.nonce,state:flow.state,signal});
    if(signal.aborted)throw new AuthClientError('cancelled');
    if(result.state!==flow.state||Date.parse(flow.expiresAt)<=now())throw new AuthClientError('apple_restart_required');
    let input:AppleLoginCompleteRequest;
    try{input=appleLoginCompleteRequestSchema.parse({flowId:flow.flowId,transactionSecret:flow.transactionSecret,state:result.state,identityToken:result.identityToken,authorizationCode:result.authorizationCode,...result.fullName?{fullName:result.fullName}:{}});}catch{throw new AuthClientError('apple_restart_required');}
    pending={input,key:newId(),until:Math.min(Date.parse(flow.expiresAt)+60_000,now()+360_000)};
    expiryTimer=setTimeout(clear,Math.max(0,pending.until-now()));
   }
   if(!grant){
    if(!pending||pending.until<=now())throw new AuthClientError('apple_restart_required');
    if(signal.aborted)throw new AuthClientError('cancelled');
    // The completion has its own bounded deadline; abandoning it mid-transport would discard
    // an already issued grant the caller can still recover with the same key.
    const issued=await api.completeAppleReauth(await access(),pending.input,pending.key);
    if(Date.parse(issued.expiresAt)<=now())throw new AuthClientError('apple_restart_required');
    grant={value:issued.reauthGrant,expiresAt:Date.parse(issued.expiresAt)};
   }
   // A grant that lapsed before its action is spent; the caller must authorize again.
   if(grant.expiresAt<=now())throw new AuthClientError('apple_restart_required');
   return {grant:grant.value,expiresAt:grant.expiresAt};
  },
 };
}

/** One Apple re-authentication for the first email link on an already authenticated subject.
 * The action grant never leaves this closure and never reaches the caller, a renderer or the
 * vault. Stages are kept in memory so a lost response is replayed with the same keys instead of
 * repeating native authorization or spending a second grant: start+authorize+complete, then the
 * email link request. The controller owns account/session fences and the current session.
 */
export function createAppleReauthAttempt({api,newId,now,authorize,email,locale,key:linkKey}:AppleReauthOptions){
 const stage=createAppleGrantStage({api,newId,now,authorize,action:'link-identity'});
 let active=false;
 return {
  canRetry:stage.canRetry,
  clear:stage.clear,
  async run({access,installationId,signal}:AppleReauthRun):Promise<EmailChallengeResponse>{
   if(active)throw new AuthClientError('busy');
   if(signal.aborted)throw new AuthClientError('cancelled');
   active=true;
   const check=()=>{if(signal.aborted)throw new AuthClientError('cancelled');};
   try{
    const {grant}=await stage.ensure({access,installationId,signal});check();
    // Same reasoning as the completion: a committed link request is recovered by replaying this
    // exact key, so the transport is never aborted after it was sent.
    const challenge=await api.requestEmailLink(await access(),{email,locale,reauthGrant:grant},linkKey);check();
    stage.clear();
    return challenge;
   }catch(error){
    if(!(error instanceof AuthClientError)||!retryable.has(error.code)||signal.aborted)stage.clear();
    throw error;
   }finally{active=false;}
  },
 };
}
export type AppleReauthAttempt=ReturnType<typeof createAppleReauthAttempt>;

/** One Apple re-authentication for a device revocation on an Apple-only account. The action is
 * fixed per attempt, so a `revoke-session` grant can never be presented to the revoke-all route or
 * the other way round. The controller tracks the caller's operation key; a lost `complete`
 * response is the one step this closure replays, under the same completion key it staged. */
export interface AppleRevokeOptions {
  api:AuthApiClient;newId:()=>string;now:()=>number;authorize:AppleAuthorize;
  action:'revoke-session'|'revoke-all-sessions';
}
/** `spend` receives the action grant and performs the single action it authorizes. It runs at most
 * once per granted stage, and a failure is never reported as a completed action. */
export type AppleGrantSpend=(input:{grant:string;access:()=>Promise<string>;signal:AbortSignal})=>Promise<void>;
export interface AppleRevokeRun extends AppleReauthRun {spend:AppleGrantSpend;}

/** Shared body of the staged attempts that spend one action grant on a single action.
 * `createAppleGrantStage` owns nonce/state binding, the same-session access and the same-key
 * `complete` recovery; this closure owns "dispatch at most once, then report the unknown
 * outcome". A dispatched action is never replayed, so the caller re-reads the affected state
 * instead of a repeat being reported as a success. */
function createAppleSpendAttempt({api,newId,now,authorize,action}:
  {api:AuthApiClient;newId:()=>string;now:()=>number;authorize:AppleAuthorize;action:AppleReauthAction}){
 const stage=createAppleGrantStage({api,newId,now,authorize,action});
 let active=false;
 return {
  canRetry:stage.canRetry,
  clear:stage.clear,
  async run({access,installationId,signal,spend}:AppleReauthRun&{spend:AppleGrantSpend}):Promise<void>{
   if(active)throw new AuthClientError('busy');
   if(signal.aborted)throw new AuthClientError('cancelled');
   active=true;
   const check=()=>{if(signal.aborted)throw new AuthClientError('cancelled');};
   // Only the staged completion is replayable. Once the action is dispatched, a lost response
   // leaves its outcome unknown, so the flow ends and the caller re-reads the state.
   let replayable=true;
   try{
    const {grant}=await stage.ensure({access,installationId,signal});check();
    replayable=false;
    await spend({grant,access,signal});check();
    stage.clear();
   }catch(error){
    if(!replayable||!(error instanceof AuthClientError)||!retryable.has(error.code)||signal.aborted)stage.clear();
    throw error;
   }finally{active=false;}
  },
 };
}
export function createAppleRevokeAttempt({api,newId,now,authorize,action}:AppleRevokeOptions){
 return createAppleSpendAttempt({api,newId,now,authorize,action});
}
export type AppleRevokeAttempt=ReturnType<typeof createAppleRevokeAttempt>;

/** One Apple re-authentication for approving a family child-device pairing from a signed-in
 * guardian. The action is fixed to `approve-child-device`, so a `revoke-session`,
 * `revoke-all-sessions` or `link-identity` grant can never be presented to the approval route,
 * and a grant issued here can only ever approve one pairing. `spend` is the caller's approval
 * request and the only place the grant is ever handed out, so the value never reaches a renderer,
 * a vault record or client state. Once the approval is dispatched a lost response ends the flow
 * with a failure and the caller re-reads the pairing status instead of replaying a spend whose
 * outcome is unknown. */
export interface AppleChildApprovalOptions {api:AuthApiClient;newId:()=>string;now:()=>number;authorize:AppleAuthorize;}
export interface AppleChildApprovalRun extends AppleReauthRun {spend:AppleGrantSpend;}
export function createAppleChildApprovalAttempt({api,newId,now,authorize}:AppleChildApprovalOptions){
 return createAppleSpendAttempt({api,newId,now,authorize,action:'approve-child-device'});
}
export type AppleChildApprovalAttempt=ReturnType<typeof createAppleChildApprovalAttempt>;

/** One Apple re-authentication that spends its grant on the caller's own account deletion. The grant
 * comes from the shared staging state machine, but the submission is the shared account-deletion
 * attempt, so the caller's key, the same bearer/body/key on a repeat, the cached receipt and the
 * cleared-attempt fence behave exactly as they do on the password path. Once the grant is issued the
 * bearer and the body are fixed inside that attempt: a repeat never runs the provider flow again,
 * never re-reads the session and never presents a second grant. */
export interface AppleDeletionOptions {
  api:AuthApiClient;newId:()=>string;now:()=>number;authorize:AppleAuthorize;
  /** The caller's declaration of family/child handling, and its own submission key. */
  dependencyDisposition:DeletionDependencyDisposition;key:string;
}
/** The caller's own deletion key: the same UUID rule the submission itself enforces. */
const deletionKey=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function createAppleDeletionAttempt({api,newId,now,authorize,dependencyDisposition,key}:AppleDeletionOptions){
 // The caller's own part of the submission is validated and snapshotted here: the grant only arrives
 // after the provider round trip, so an unusable declaration has to fail before one is requested, and
 // an edit the caller makes while that round trip runs must not change the choice this attempt submits.
 let declared:DeletionDependencyDisposition;
 try{declared=deletionDependencyDispositionSchema.parse(dependencyDisposition);}catch{throw new AuthClientError('invalid_request');}
 if(!deletionKey.test(key))throw new AuthClientError('invalid_request');
 const stage=createAppleGrantStage({api,newId,now,authorize,action:'delete-account'});
 let submission:AccountDeletionAttempt|undefined;
 let ended=false,active=false;
 // A clear() that lands while the grant is still being obtained must never authorize a DELETE after it.
 let epoch=0;
 const drop=()=>{stage.clear();submission?.clear();};
 return {
  // The fixed submission decides once it exists: a staged transport loss repeats its keyed body and a
  // cached receipt is handed back, while the stage decides only before the grant is issued.
  canRetry:()=>!ended&&(submission?submission.canRetry():stage.canRetry()),
  clear:()=>{ended=true;epoch++;drop();},
  async run({access,installationId,signal}:AppleReauthRun):Promise<DeletionReceipt>{
   if(ended)throw new AuthClientError('cancelled');
   if(active)throw new AuthClientError('busy');
   if(signal.aborted)throw new AuthClientError('cancelled');
   active=true;
   const own=epoch;
   try{
    if(!submission){
     const {grant}=await stage.ensure({access,installationId,signal});
     if(own!==epoch)throw new AuthClientError('cancelled');
     const bearer=await access();
     if(own!==epoch)throw new AuthClientError('cancelled');
     submission=createAccountDeletionAttempt({api,accessToken:bearer,input:{reauthGrant:grant,confirmation:true,dependencyDisposition:declared},key});
     // The grant lives only inside that attempt now, and a resumed run may not stage another one.
     stage.clear();
    }
    return await submission.run(signal);
   }catch(error){
    // Sanitized first: a foreign throw must not carry a message, and a provider or access error that
    // happens to hold a token never travels past this closure.
    const safe=error instanceof AuthClientError?error:new AuthClientError('unavailable');
    // The fixed submission decides once it exists: it keeps its own repeatable losses — including
    // `deletion_outcome_unknown` — and its cached receipt for the caller's storage retry. Only the
    // staging phase falls back to the provider rules, which also drop whatever a late grant rebuilt
    // after this attempt was cleared or its run was aborted.
    if(submission){if(!submission.canRetry())drop();}
    else if(!retryable.has(safe.code)||signal.aborted)drop();
    throw safe;
   }finally{active=false;}
  },
 };
}
export type AppleDeletionAttempt=ReturnType<typeof createAppleDeletionAttempt>;
