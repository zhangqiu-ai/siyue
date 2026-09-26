import {frozenFamilyReviewScopeSchema,frozenFamilyReviewAcceptanceReceiptSchema,type FrozenFamilyReviewScope} from '@siyue/contracts';
import {createAppleSignInAttempt,type AppleAuthorize} from './apple-sign-in.js';
import {createAppleChildApprovalAttempt,createAppleDeletionAttempt,createAppleReauthAttempt,createAppleRevokeAttempt} from './apple-reauth.js';
import {createAccountDeletionAttempt} from './account-deletion-attempt.js';
import { authVaultRecordSchema,authRecoverySchema,authClientStateSchema,accountReferenceSchema,accountPasswordSchema,newAccountPasswordSchema,
  accountDeletionImpactSchema,deletionDependencyDispositionSchema,deletionReceiptSchema,deletionStatusSchema,
  emailLinkRequestSchema,emailLinkConfirmSchema,
  devicePairingCreateRequestSchema,
  devicePairingPreviewRequestSchema,
  parseEmailLoginMethodId,
  type AuthVaultRecord,type AuthRecovery,type AuthClientState,type SessionTokens,type VerifiedAccountSession,
  type AuthClientErrorCode,type ChildDevicePlatform,type DevicePairingStatusResponse,
  type AccountDeletionImpact,type DeletionDependencyDisposition,type DeletionReceipt,type DeletionStatus,
  type ChildSummary,type DevicePairingPreviewResponse,
  type EmailLogin,type EmailRegisterConfirm,type EmailChallengeRequest,type EmailPasswordResetConfirm,
  type EmailLinkRequest,type EmailLinkConfirm,type EmailChallengeResponse,
  type RegistrationPolicy,
  familyManagementAcceptancePreviewSchema,familyManagementAcceptanceRequestSchema,familyManagementAcceptanceReceiptSchema,
  type FamilyManagementAcceptancePreview,type FamilyManagementAcceptanceRequest,type FamilyManagementAcceptanceReceipt } from '@siyue/contracts';
import { AuthClientError,type AuthApiClient,type AuthEndpoint } from './auth-api-client.js';
import {adultAccessToken,type ChildDevicePairingClient,type ChildDevicePairingTicket,type GuardianChildDeviceClient} from './child-device-api-client.js';

const idempotencyKey=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const sessionIdPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
/** A refused completion proves the request can no longer be consumed, so its pairing is retired. */
const terminalPairingOutcome=new Set<AuthClientErrorCode>(['challenge_invalid','invalid_request']);
/** Deletion failures the caller corrects or repeats deliberately. None of them is a lost session, so
 *  the current account state is reported rather than replaced by a fault. */
const deletionReported=new Set<AuthClientErrorCode>(['invalid_credentials','rate_limited','network','timeout','unavailable','busy','invalid_response',
  'deletion_dependencies','deletion_outcome_unknown','deletion_receipt_unrecoverable','deletion_request_conflict','challenge_invalid','adult_required','invalid_request']);

/** The one pairing request this signed-in guardian has actually previewed, and — for the Apple method —
 *  the attempt that may still hold its one-time `approve-child-device` grant. It lives only inside the
 *  controller closure, bound to the account generation, the session that previewed the request and the
 *  pairing's own deadline. Nothing here is persisted, published or restored after a restart, and a
 *  later preview replaces it. */
interface PreviewedChildApproval {generation:number;sessionId:string;pairingId:string;requestToken:string;childSubjectId:string;
  expiresAt:number;running:boolean;attempt?:ReturnType<typeof createAppleChildApprovalAttempt>;}

/** The family management duty one signed-in adult was shown in one family: the exact scope, child
 *  count and versions the server computed for this recipient. It lives only inside this closure, bound
 *  to the account generation, the session that read the preview and the family it belongs to. Nothing
 *  is persisted, published or restored after a restart, a later preview replaces it, and the single
 *  submission retires it as it is dispatched. */
interface PreviewedFamilyManagement {generation:number;sessionId:string;familyId:string;
  preview:FamilyManagementAcceptancePreview;running:boolean;}

/** One accepted deletion's receipt in its own protected record: the session vault must be able to hold
 *  an anonymous device while this stays readable, and the store holds one receipt at a time. */
interface StoredDeletionReceipt {subjectId:string;receipt:DeletionReceipt;}
/** The non-secret progress of one receipt: no receipt secret and no subject travel back to a caller. */
export interface DeletionProgress {deletionId:string;expiresAt:string;status:DeletionStatus;}
/** A submission settles only the preview read by its own generation, session and subject. */
interface DeletionPreview {generation:number;sessionId:string;subjectId:string;impact:AccountDeletionImpact;}
/** One submission in memory only. The bearer and the single-use `delete-account` grant stay inside the
 *  attempt, which is kept for an explicit retry; a returned receipt is cached so a failed secure write
 *  never repeats the destructive request. */
interface PendingDeletion {generation:number;sessionId:string;subjectId:string;key:string;
  disposition:DeletionDependencyDisposition;signal:AbortSignal;attempt?:DeletionAttempt;
  receipt?:DeletionReceipt;running:boolean;}
/** The one attempt surface every deletion path shares, so the password and Apple submissions keep
 *  the same claim, retry and credential lifetime. */
interface DeletionAttempt {run:(signal:AbortSignal)=>Promise<DeletionReceipt>;clear:()=>void;canRetry:()=>boolean;}

/** A platform-protected, atomic single record; implementations must never fall back to plain storage. */
export interface AuthVault {read():Promise<string|null>;write(value:string):Promise<void>;}
export interface AuthControllerOptions {api:AuthApiClient;vault:AuthVault;newId:()=>string;now?:()=>number;storageTimeoutMs?:number;
  /** Anonymous child-device pairing is opt-in: without a factory this device cannot start a request. */
  createChildPairingClient?:(endpoint:AuthEndpoint)=>ChildDevicePairingClient;
  /** The signed-in guardian reads are opt-in as well: without a factory this client cannot read a family. */
  createGuardianClient?:(endpoint:AuthEndpoint)=>GuardianChildDeviceClient;
  /** Account deletion is opt-in: without this separate protected record this device neither submits a
   *  deletion nor reads one back, because a receipt that cannot be kept is a lost proof. */
  deletionReceiptVault?:AuthVault;}
export function createAuthController({api,vault,newId,now=Date.now,storageTimeoutMs=5000,createChildPairingClient,createGuardianClient,deletionReceiptVault}:AuthControllerOptions) {
  if(!Number.isInteger(storageTimeoutMs)||storageTimeoutMs<1||storageTimeoutMs>30_000)throw new AuthClientError('invalid_config');
  let pendingApple:{attempt:ReturnType<typeof createAppleSignInAttempt>;generation:number}|null=null;
  // One in-flight first-email link per account generation; the Apple grant lives only inside it.
  let pendingEmailLink:{attempt:ReturnType<typeof createAppleReauthAttempt>;generation:number;sessionId:string;key:string;
    email:string;locale:'zh-CN'|'en-US';running:boolean}|null=null;
  // One in-flight Apple-only revocation per account generation; the action grant lives only inside it.
  let pendingRevocation:{attempt:ReturnType<typeof createAppleRevokeAttempt>;generation:number;sessionId:string;key:string;
    action:'revoke-session'|'revoke-all-sessions';target:string|null;running:boolean}|null=null;
  // One in-flight anonymous child-device pairing per account generation. The poll secret is created and
  // kept inside the injected client; the controller holds the client, its own ticket and nothing else.
  let pendingChildPairing:{client:ChildDevicePairingClient;generation:number;ticket:ChildDevicePairingTicket}|null=null;
  // The pairing whose claim has entered the sign-in path. `begin()` drops the pending record as the
  // claim starts, so this separate fence is what keeps that run visible: while it is set the claim can
  // still publish a signed-in child device, and a cancel that only looked at the pending record would
  // report a success it cannot deliver.
  let childClaim:{client:ChildDevicePairingClient;generation:number;ticket:ChildDevicePairingTicket}|null=null;
  // The pairing request this guardian previewed and may still approve; see PreviewedChildApproval.
  let pendingChildApproval:PreviewedChildApproval|null=null;
  // The family management duty this adult previewed and may still accept; see PreviewedFamilyManagement.
  let previewedFamilyManagement:PreviewedFamilyManagement|null=null;
  let readingFamilyManagement:number|null=null;
  let frozenPreview:{generation:number;scope:FrozenFamilyReviewScope}|null=null;
  let frozenBusy:number|null=null;
  // The deletion preview this device may act on and the one submission it already started. Both live
  // only inside this closure: a generation change (a switch, a sign-out, a dispose) drops them, so no
  // later account can settle or resume a request that belonged to another one.
  let deletionPreview:DeletionPreview|null=null;
  let pendingDeletion:PendingDeletion|null=null;
  let generation=0;let record:AuthVaultRecord|undefined;let access:SessionTokens|null=null;
  let controller=new AbortController();let disposed=false;
  const lifetime=new AbortController();
  let tail:Promise<unknown>=Promise.resolve();
  let refreshFlight:{generation:number;promise:Promise<SessionTokens>}|null=null;
  let sessionFlight:{generation:number;promise:Promise<VerifiedAccountSession>}|null=null;
  let bootstrapFlight:Promise<void>|null=null;
  let revocationFlight:Promise<void>|null=null;
  let pendingPasswordChange:{generation:number;accessToken:string;currentPassword:string;newPassword:string;reauthGrant:string;key:string}|null=null;
  let state:AuthClientState={status:'bootstrapping',generation,session:null,account:null,error:null,pendingRevocations:0};
  const listeners=new Set<()=>void>();
  const current=(own:number)=>!disposed&&own===generation;
  const check=(own:number)=>{if(!current(own))throw new AuthClientError('cancelled');};
  const serialize=<T>(work:()=>Promise<T>):Promise<T>=>{
    const promise=tail.then(work);tail=promise.catch(()=>{});
    // A timeout ends the visible wait, not ownership of a native write that cannot be cancelled.
    // Keep the real tail so no newer write races a late completion.
    let timer:ReturnType<typeof setTimeout>;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new AuthClientError('storage_unavailable')),storageTimeoutMs);});
    return Promise.race([promise,timeout]).finally(()=>clearTimeout(timer));
  };
  function emit(status:AuthClientState['status'],error:AuthClientState['error']=null) {
    const active=record?.active;
    const account=active?accountReferenceSchema.parse({subjectId:active.subjectId,subjectKind:active.subjectKind,sessionId:active.sessionId}):null;
    state=authClientStateSchema.parse({status,generation,session:status==='authenticated'?access?.session??null:null,
      account:['anonymous','logging-out','authenticating','bootstrapping'].includes(status)?null:account,error,pendingRevocations:record?.revocations.length??0,
      passwordChangePending:pendingPasswordChange?.generation===generation,deletionPending:pendingDeletion?.generation===generation});
    for(const listener of listeners) {try{listener();}catch{/* An observer cannot alter credential persistence. */}}
  }
  function begin(status:AuthClientState['status']) {
    if(disposed)throw new AuthClientError('cancelled');
    pendingApple?.attempt.clear();pendingApple=null;
    pendingEmailLink?.attempt.clear();pendingEmailLink=null;
    pendingRevocation?.attempt.clear();pendingRevocation=null;
    pendingChildPairing=null;
    forgetChildApproval();
    forgetFamilyManagementPreview();
    forgetPendingDeletion();
    deletionPreview=null;
    generation++;pendingPasswordChange=null;controller.abort();controller=new AbortController();access=null;emit(status);return generation;
  }
  async function save(next:AuthVaultRecord) {
    const value=authVaultRecordSchema.parse(next);const serialized=JSON.stringify(value);
    if(new TextEncoder().encode(serialized).length>2048)throw new AuthClientError('storage_unavailable');
    try {await vault.write(serialized);}catch{throw new AuthClientError('storage_unavailable');}
    record=value;
  }
  async function load(own:number) {
    await serialize(async()=>{
      check(own);let raw:string|null;
      try {raw=await vault.read();}catch(error){throw new AuthClientError(error instanceof AuthClientError&&error.code==='storage_corrupt'?'storage_corrupt':'storage_unavailable');}
      check(own);
      if(raw===null) {
        await save({schemaVersion:1,...api.endpoint,installationId:newId(),active:null,revocations:[]});check(own);return;
      }
      try {
        if(new TextEncoder().encode(raw).length>2048)throw new Error();
        const parsed=authVaultRecordSchema.parse(JSON.parse(raw));
        if(parsed.environment!==api.endpoint.environment||parsed.apiBaseUrl!==api.endpoint.apiBaseUrl)throw new Error();
        record=parsed;
      } catch {throw new AuthClientError('storage_corrupt');}
    });
  }
  const ready=()=>{if(!record)throw new AuthClientError('storage_unavailable');return record;};
  function fault(error:unknown,own:number) {
    const safe=error instanceof AuthClientError?error:new AuthClientError('unavailable');
    if(current(own)) {
      access=null;
      const status=safe.code==='storage_unavailable'||safe.code==='storage_corrupt'?'secure-storage-unavailable':safe.code==='reauth_required'||safe.code==='operation_completed'?'reauth-required':
        record?.active?(safe.code==='network'?'offline-available':'service-unavailable'):'anonymous';
      emit(status,safe.code);
    }
    return safe;
  }
  /** Without this separate protected record a deletion is neither submitted nor read back: a receipt
   *  this device cannot keep is a proof it cannot offer. */
  function deletionStore() {
    if(!deletionReceiptVault)throw new AuthClientError('invalid_config');
    return deletionReceiptVault;
  }
  /** Drops the submission with the bearer and grant its attempt holds. The receipt record is untouched. */
  function forgetPendingDeletion() {pendingDeletion?.attempt?.clear();pendingDeletion=null;}
  /** A private copy of a strict answer: the schema builds fresh objects, so a caller editing the impact
   *  it was shown cannot change the preview a later submission settles. */
  const copyImpact=(value:AccountDeletionImpact)=>accountDeletionImpactSchema.parse(value);
  /** The bearer an Apple deletion dispatch may use: re-read for this flow and compared with the session
   *  that previewed it, so a replaced or signed-out account can never spend its grant. */
  const deletionAccess=(own:number,sessionId:string)=>async()=>{
    const usable=await usableAccess(own);
    if(usable.session.sessionId!==sessionId)throw new AuthClientError('cancelled');
    return usable.accessToken;
  };
  /** What both deletion paths settle before they dispatch: the preview still belongs to this generation
   *  and session, the declaration settles exactly the affected families, and the one submission slot is
   *  claimed. Kept synchronous so two overlapping calls cannot both pass it. */
  function claimDeletion(own:number,dependencyDisposition:DeletionDependencyDisposition,signal:AbortSignal):PendingDeletion {
    deletionStore();
    if(state.status!=='authenticated'||!record?.active)throw new AuthClientError('reauth_required');
    if(record.active.subjectKind!=='adult')throw new AuthClientError('adult_required');
    const preview=deletionPreview?.generation===own&&deletionPreview.sessionId===record.active.sessionId&&
      deletionPreview.subjectId===record.active.subjectId?deletionPreview:null;
    if(!preview)throw new AuthClientError('invalid_request');
    const disposition=deletionDependencyDispositionSchema.safeParse(dependencyDisposition);
    if(!disposition.success)throw new AuthClientError('invalid_request');
    // Exactly what the server compares: the de-duplicated union of member and guardianship families.
    const affected=new Set([...preview.impact.families.map(family=>family.familyId),
      ...preview.impact.guardianships.map(guardianship=>guardianship.familyId)]);
    if(disposition.data.kind==='none'){if(affected.size>0)throw new AuthClientError('invalid_request');}
    else {
      const settled=disposition.data.families.map(family=>family.familyId);
      if(settled.length!==affected.size||settled.some(familyId=>!affected.has(familyId)))throw new AuthClientError('invalid_request');
    }
    if(pendingDeletion?.generation===own)throw new AuthClientError('busy');
    const key=newId();
    if(!uuidPattern.test(key))throw new AuthClientError('invalid_config');
    const pending:PendingDeletion={generation:own,sessionId:preview.sessionId,subjectId:preview.subjectId,key,
      disposition:disposition.data,signal,running:true};
    pendingDeletion=pending;emit(state.status,state.error);
    return pending;
  }
  /** Runs the one attempt the claim built and persists what it returned. Only a repeatable failure keeps
   *  the claim, so retryDeletion() is the single way to finish it. */
  async function runDeletion(own:number,pending:PendingDeletion,connect:()=>Promise<DeletionAttempt>):Promise<void> {
    let attempt:DeletionAttempt|undefined;
    try {
      await ensureDeletionSlot(own);
      attempt=await connect();
      // The attempt belongs to the generation that claimed it: a switch that landed while connect() ran
      // must not let it dispatch under a later generation's signal.
      check(own);
      pending.attempt=attempt;
      const receipt=await attempt.run(pending.signal);
      check(own);
      pending.receipt=receipt;
      await finishDeletion(own,pending);
    } catch(error) {
      pending.running=false;
      const safe=error instanceof AuthClientError?error:new AuthClientError('unavailable');
      // A stale generation keeps nothing, not even a dropped record's attempt, which still holds a
      // bearer and a grant; a live one keeps only a submission it can still repeat.
      if(!current(own))attempt?.clear();
      else if(pendingDeletion===pending&&pending.attempt?.canRetry()!==true)forgetPendingDeletion();
      if(current(own)){if(deletionReported.has(safe.code))emit(state.status,safe.code);else fault(safe,own);}
      throw safe;
    }
  }
  /** One strict shape, and anything else — another endpoint, an unknown field, a malformed receipt or
   *  an unreadable size — is corrupt rather than silently overwritten or read as another account's. */
  function parseDeletionRecord(raw:string):StoredDeletionReceipt {
    let value:unknown;
    try {if(new TextEncoder().encode(raw).length>2048)throw new Error();value=JSON.parse(raw);}
    catch{throw new AuthClientError('storage_corrupt');}
    if(value===null||typeof value!=='object'||Array.isArray(value))throw new AuthClientError('storage_corrupt');
    const candidate=value as Record<string,unknown>;
    if(Object.keys(candidate).sort().join(',')!=='apiBaseUrl,environment,receipt,schemaVersion,subjectId')throw new AuthClientError('storage_corrupt');
    if(candidate.schemaVersion!==1||candidate.environment!==api.endpoint.environment||candidate.apiBaseUrl!==api.endpoint.apiBaseUrl)
      throw new AuthClientError('storage_corrupt');
    if(typeof candidate.subjectId!=='string'||!uuidPattern.test(candidate.subjectId))throw new AuthClientError('storage_corrupt');
    const receipt=deletionReceiptSchema.safeParse(candidate.receipt);
    if(!receipt.success)throw new AuthClientError('storage_corrupt');
    return {subjectId:candidate.subjectId,receipt:receipt.data};
  }
  async function readDeletionRecord():Promise<StoredDeletionReceipt|null> {
    const store=deletionStore();
    // A native read shares the one protected-store queue and its timeout: a read that never settles
    // cannot hang the caller, and it cannot overlap a write that is still committing a receipt.
    return await serialize(async()=>{
      let raw:string|null;
      try {raw=await store.read();}
      catch(error){throw new AuthClientError(error instanceof AuthClientError&&error.code==='storage_corrupt'?'storage_corrupt':'storage_unavailable');}
      return raw===null?null:parseDeletionRecord(raw);
    });
  }
  /** One local receipt slot: another job's unexpired receipt is never replaced silently, this job may
   *  rewrite its own outcome, and an elapsed record may be replaced. */
  async function ensureDeletionSlot(own:number,deletionId?:string) {
    const stored=await readDeletionRecord();check(own);
    if(!stored)return;
    const expiresAt=Date.parse(stored.receipt.expiresAt);
    if(!Number.isFinite(expiresAt))throw new AuthClientError('storage_corrupt');
    if(expiresAt<=now())return;
    if(deletionId!==undefined&&stored.receipt.deletionId===deletionId)return;
    throw new AuthClientError('busy');
  }
  /** The receipt shares the session vault's write queue and is durable before the session is dropped,
   *  so a write that outlives its timeout cannot land after a newer record and a crash between the two
   *  writes cannot lose an accepted deletion's proof. */
  async function writeDeletionReceipt(own:number,subjectId:string,receipt:DeletionReceipt) {
    const store=deletionStore();
    const value=JSON.stringify({schemaVersion:1,...api.endpoint,subjectId,receipt});
    if(new TextEncoder().encode(value).length>2048)throw new AuthClientError('storage_unavailable');
    await ensureDeletionSlot(own,receipt.deletionId);
    await serialize(async()=>{
      check(own);
      try {await store.write(value);}catch{throw new AuthClientError('storage_unavailable');}
      check(own);
    });
  }
  /** The durable receipt comes first and the local session is cleared second, so a failed clear can be
   *  retried from the same submission; only a confirmed clear starts the anonymous generation. Nothing
   *  is queued for server revocation, because the accepted deletion already invalidated this session. */
  async function finishDeletion(own:number,pending:PendingDeletion) {
    await writeDeletionReceipt(own,pending.subjectId,pending.receipt!);
    try {await serialize(async()=>{check(own);await save({...ready(),active:null});check(own);});}
    catch(error){throw fault(error,own);}
    begin('anonymous');
  }
  const recovery=(tokens:SessionTokens):AuthRecovery=>authRecoverySchema.parse({...accountReferenceSchema.parse({subjectId:tokens.session.subjectId,subjectKind:tokens.session.subjectKind,sessionId:tokens.session.sessionId}),
    refreshToken:tokens.refreshToken,refreshExpiresAt:tokens.refreshExpiresAt,absoluteExpiresAt:tokens.sessionAbsoluteExpiresAt,pendingRotationId:null,pendingSince:null});
  function validateTokens(tokens:SessionTokens,expected?:AuthRecovery) {
    if(Date.parse(tokens.accessExpiresAt)<=now()||tokens.accessExpiresAt!==tokens.session.expiresAt||Date.parse(tokens.refreshExpiresAt)>Date.parse(tokens.sessionAbsoluteExpiresAt)||
      (expected&&(tokens.session.subjectId!==expected.subjectId||tokens.session.sessionId!==expected.sessionId||tokens.session.subjectKind!==expected.subjectKind||tokens.sessionAbsoluteExpiresAt!==expected.absoluteExpiresAt))) throw new AuthClientError('invalid_response');
    try {return recovery(tokens);}catch{throw new AuthClientError('invalid_response');}
  }
  async function queueRevocation(tokens:{refreshToken:string;sessionId:string;expiresAt:string},detach:boolean,own?:number) {
    await serialize(async()=>{
      if(disposed)throw new AuthClientError('cancelled');
      if(own!==undefined)check(own);
      const value=ready();const queue=value.revocations.filter(item=>Date.parse(item.expiresAt)>now());
      if(!queue.some(item=>item.sessionId===tokens.sessionId)) {
        if(queue.length>=4)throw new AuthClientError('revocation_queue_full');queue.push(tokens);
      }
      await save({...value,active:detach?null:value.active,revocations:queue});
      if(own!==undefined)check(own);
    });
  }
  async function drainRevocations() {
    if(revocationFlight)return revocationFlight;
    const run=(async()=>{
      for(const item of [...(record?.revocations??[])]) {
        if(disposed)return;
        let remove=Date.parse(item.expiresAt)<=now();
        if(!remove) {
          try {await api.logout(item.refreshToken,lifetime.signal);remove=true;}
          catch(error) {remove=error instanceof AuthClientError&&error.code==='reauth_required';}
        }
        if(remove)await serialize(async()=>{if(!disposed&&record)await save({...record,revocations:record.revocations.filter(value=>value.refreshToken!==item.refreshToken)});});
      }
      if(!disposed)emit(state.status,state.error);
    })();
    revocationFlight=run;
    try {await run;}finally{if(revocationFlight===run)revocationFlight=null;}
  }
  async function detach(own:number) {
    check(own);await tail;check(own);
    const old=ready().active;
    if(old)await queueRevocation({refreshToken:old.refreshToken,sessionId:old.sessionId,expiresAt:old.absoluteExpiresAt},true,own);
    else await serialize(async()=>{check(own);await save({...ready(),active:null});check(own);});
  }
  async function compensate(tokens:SessionTokens) {
    // An abandoned login can only revoke its own session, never replace the active record.
    try {await api.logout(tokens.refreshToken);return;}catch{}
    try {await queueRevocation({refreshToken:tokens.refreshToken,sessionId:tokens.session.sessionId,expiresAt:tokens.sessionAbsoluteExpiresAt},false);}catch{/* State remains unavailable; no false guarantee of server revocation. */}
  }
  async function refresh(own=generation):Promise<SessionTokens> {
    check(own);
    if(refreshFlight?.generation===own)return refreshFlight.promise;
    const run=(async()=>{
      try {
        emit('refreshing');
        const pending=await serialize(async()=>{
          check(own);const value=ready();let active=value.active;
          if(!active||Date.parse(active.refreshExpiresAt)<=now()||Date.parse(active.absoluteExpiresAt)<=now())throw new AuthClientError('reauth_required');
          if(!active.pendingRotationId) {
            active={...active,pendingRotationId:newId(),pendingSince:new Date(now()).toISOString()};
            await save({...value,active});
          }
          check(own);return active;
        });
        const tokens=await api.refresh(pending.refreshToken,pending.pendingRotationId!,controller.signal);check(own);
        const next=validateTokens(tokens,pending);
        await serialize(async()=>{check(own);const value=ready();if(value.active?.refreshToken!==pending.refreshToken)throw new AuthClientError('cancelled');await save({...value,active:next});check(own);});
        access=tokens;emit('authenticated');return tokens;
      }catch(error){throw fault(error,own);}
    })();
    refreshFlight={generation:own,promise:run};
    try{return await run;}finally{if(refreshFlight?.promise===run)refreshFlight=null;}
  }
  async function signIn(work:(installationId:string,signal:AbortSignal)=>Promise<SessionTokens>) {
    const own=begin('authenticating');let issued:SessionTokens|undefined;
    try {
      if(!record)await load(own);
      if(ready().revocations.length>=4)await drainRevocations();
      await detach(own);
      issued=await work(ready().installationId,controller.signal);check(own);
      const next=validateTokens(issued);
      await serialize(async()=>{check(own);await save({...ready(),active:next});check(own);});
      access=issued;emit('authenticated');
      void drainRevocations().catch(()=>{});
    }catch(error){if(issued)await compensate(issued);throw fault(error,own);}
  }
  async function usableAccess(own:number) {
    check(own);
    if(state.status!=='authenticated'||!record?.active)throw new AuthClientError('reauth_required');
    let tokens=access;
    if(!tokens||Date.parse(tokens.accessExpiresAt)<=now()+30_000)tokens=await refresh(own);
    check(own);return tokens;
  }
  /** The guardian reads are adult-only and local-first: a restricted child device is refused before a
   *  bearer or a request is spent, and the refusal is not `reauth_required` because re-verifying this
   *  device cannot make it a guardian — the family surface is simply not visible to a `child` subject. */
  function adultGuardian() {
    if(state.status!=='authenticated'||!record?.active)throw new AuthClientError('reauth_required');
    if(record.active.subjectKind!=='adult')throw new AuthClientError('identity_not_found');
  }
  /** Built per read from the endpoint the API client already uses. The guardian client is stateless
   *  (it holds no poll secret and no session), so nothing about it crosses an account generation. */
  function guardianSurface() {
    if(!createGuardianClient)throw new AuthClientError('invalid_config');
    return createGuardianClient(api.endpoint);
  }
  /** Forgets the previewed request and any grant staged inside it. Only the Apple attempt can hold one,
   *  and that value is never handed out: dropping the record is all a replaced preview, a sign-out, a
   *  cancelled generation or an elapsed pairing window leaves behind. */
  function forgetChildApproval() {pendingChildApproval?.attempt?.clear();pendingChildApproval=null;}
  /** The request a caller may approve is exactly the one previewed for the current session. A missing,
   *  elapsed or replaced preview is refused, so the caller previews that request again instead of this
   *  device approving something the guardian never saw. An approval already in flight is refused as
   *  busy, so two overlapping calls cannot spend two grants on one preview. */
  function previewedRequest(own:number,input:{pairingId:string;requestToken:string;childSubjectId:string}) {
    const pending=pendingChildApproval?.generation===own?pendingChildApproval:null;
    if(!pending||pending.expiresAt<=now()){forgetChildApproval();throw new AuthClientError('challenge_invalid');}
    if(pending.running)throw new AuthClientError('busy');
    if(pending.pairingId!==input.pairingId||pending.requestToken!==input.requestToken||pending.childSubjectId!==input.childSubjectId)
      throw new AuthClientError('invalid_request');
    pending.running=true;
    return pending;
  }
  /** The pair fields of an approval are exactly the preview request contract, so a poll secret, an
   *  unknown field or a malformed token is refused before anything is read or spent. The family stays
   *  with the guardian client's own uuid check, exactly as every other family read does. */
  function approvalTarget(input:{pairingId:string;requestToken:string;childSubjectId:string;familyId:string}) {
    if(input===null||typeof input!=='object'||Object.keys(input).sort().join(',')!=='childSubjectId,familyId,pairingId,requestToken')
      throw new AuthClientError('invalid_request');
    const request=devicePairingPreviewRequestSchema.safeParse({requestToken:input?.requestToken,childSubjectId:input?.childSubjectId});
    if(!request.success||!sessionIdPattern.test(input.pairingId)||!sessionIdPattern.test(input.familyId))
      throw new AuthClientError('invalid_request');
    return {pairingId:input.pairingId,requestToken:request.data.requestToken,childSubjectId:request.data.childSubjectId,familyId:input.familyId};
  }
  /** The relationship version this guardian reads now, taken from the same live list the preview screen
   *  shows. An unknown child is refused here rather than spent on a request the server would reject; the
   *  version itself is re-checked by the server inside the approval transaction, so a relationship that
   *  moved while the guardian was deciding is answered by the server instead of being trusted here. */
  async function currentGuardianVersion(client:GuardianChildDeviceClient,own:number,access:SessionTokens,input:{familyId:string;childSubjectId:string}) {
    const children=await client.listChildren(adultAccessToken(access.accessToken),input.familyId,{signal:controller.signal});
    check(own);
    const child=children.find(item=>item.childSubjectId===input.childSubjectId);
    if(!child)throw new AuthClientError('identity_not_found');
    return child.relationshipVersion;
  }
  /** The bearer of the current adult session, re-read for the approval request and compared with the
   *  session that previewed it: a switched, replaced or signed-out account can never spend this flow's
   *  grant, and cannot approve a pairing into a family it does not guard. */
  const approvalAccess=(own:number,sessionId:string)=>async()=>{
    const usable=await usableAccess(own);
    if(usable.session.sessionId!==sessionId)throw new AuthClientError('cancelled');
    return usable.accessToken;
  };
  /** The single request that spends an `approve-child-device` grant, shared by both re-verification
   *  methods: the grant travels from the flow's closure into this call and nowhere else. The preview is
   *  retired as the request is dispatched, so a lost answer is reconciled by previewing the request
   *  again — a repeat never re-sends an approval whose outcome this device cannot prove, and a second
   *  grant is never reported as the first one's result. */
  async function spendChildApproval(client:GuardianChildDeviceClient,flow:PreviewedChildApproval,expectedGuardianVersion:number,
    access:()=>Promise<string>,grant:string,signal:AbortSignal):Promise<DevicePairingStatusResponse> {
    const token=await access();
    if(pendingChildApproval===flow)pendingChildApproval=null;
    return client.approvePairing(adultAccessToken(token),flow.pairingId,
      {requestToken:flow.requestToken,childSubjectId:flow.childSubjectId,reauthGrant:grant,expectedGuardianVersion},{signal});
  }
  /** Forgets the previewed duty. The record holds no credential, so dropping it is all a replaced
   *  preview, a sign-out, a cancelled generation or a disposed controller leaves behind. */
  function forgetFamilyManagementPreview() {frozenPreview=null;frozenBusy=null;previewedFamilyManagement=null;readingFamilyManagement=null;}
  /** A private copy of a strict preview: the schema builds a fresh object, so a caller editing the
   *  duty it was shown cannot change the state a later acceptance has to match. */
  const copyFamilyManagementPreview=(value:FamilyManagementAcceptancePreview)=>familyManagementAcceptancePreviewSchema.parse(value);
  /** What a submission settles before it is dispatched: the duty is exactly the preview of this
   *  generation and session, the family is the one that was shown, the request is the strict
   *  acceptance body, and every version together with the child scope digest is what this device
   *  displayed. A missing or replaced preview is refused, and a submission already in flight is
   *  refused as busy, so two overlapping calls cannot accept one duty twice or interleave with a new
   *  preview. The server still recomputes the scope inside its own transaction and decides. */
  function claimedFamilyManagementAcceptance(own:number,familyId:string,value:FamilyManagementAcceptanceRequest) {
    if(readingFamilyManagement===own)throw new AuthClientError('busy');
    const pending=previewedFamilyManagement?.generation===own?previewedFamilyManagement:null;
    if(!pending||pending.sessionId!==record?.active?.sessionId)throw new AuthClientError('challenge_invalid');
    if(pending.running)throw new AuthClientError('busy');
    if(pending.familyId!==familyId)throw new AuthClientError('invalid_request');
    const parsed=familyManagementAcceptanceRequestSchema.safeParse(value);
    if(!parsed.success)throw new AuthClientError('invalid_request');
    const request=parsed.data;
    if(request.expectedFamilyVersion!==pending.preview.familyVersion||
       request.expectedMembershipVersion!==pending.preview.membershipVersion||
       request.expectedOwnerMembershipVersion!==pending.preview.ownerMembershipVersion||
       request.expectedChildScopeDigest!==pending.preview.childScopeDigest)
      throw new AuthClientError('invalid_request');
    pending.running=true;
    return {preview:pending,request};
  }
  async function clearLocallyAfterRevocation(own:number) {
    check(own);const next=begin('logging-out');
    try {await serialize(async()=>{check(next);await save({...ready(),active:null});check(next);});}
    catch(error){throw fault(error,next);}
    access=null;emit('anonymous');
  }
  async function reconcileDeviceFailure(error:unknown,own:number) {
    const safe=error instanceof AuthClientError?error:new AuthClientError('unavailable');
    if((safe.code==='storage_unavailable'||safe.code==='storage_corrupt')&&state.status==='secure-storage-unavailable')return safe;
    if(!current(own))return new AuthClientError('cancelled');
    if(!['reauth_required','network','timeout','unavailable'].includes(safe.code))return safe;
    try {await refresh(own);return safe;}
    catch(probe) {
      const checked=probe instanceof AuthClientError?probe:new AuthClientError('unavailable');
      if(checked.code==='reauth_required') {
        await clearLocallyAfterRevocation(own);
        return new AuthClientError('reauth_required');
      }
      if(['storage_unavailable','storage_corrupt','cancelled'].includes(checked.code))return checked;
      return safe;
    }
  }
  /** Shared Apple-only revocation flow for the two device-revocation actions. The caller's key
   *  fences a mismatched or concurrent replay and lets a lost Apple completion resume inside the
   *  attempt. An unknown revocation outcome ends the flow and is reported as a failure, so the
   *  caller re-reads the device list instead of assuming the device is gone.
   */
  async function runAppleRevocation(action:'revoke-session'|'revoke-all-sessions',target:string|null,authorize:AppleAuthorize,key:string,own:number):Promise<void> {
    let pending=pendingRevocation?.generation===own?pendingRevocation:null;
    if(pending) {
      if(pending.action!==action||pending.key!==key||pending.target!==target||pending.running)throw new AuthClientError('busy');
    } else {
      pending={attempt:createAppleRevokeAttempt({api,newId,now,authorize,action}),generation:own,
        sessionId:record!.active!.sessionId,key,action,target,running:false};
      pendingRevocation=pending;emit(state.status,state.error);
    }
    const flow=pending;flow.running=true;
    try {
      const tokens=await usableAccess(own);
      // The server binds the flow to the session that started it, so a replaced session cannot resume it.
      if(tokens.session.sessionId!==flow.sessionId)throw new AuthClientError('cancelled');
      await flow.attempt.run({
        installationId:ready().installationId,signal:controller.signal,
        access:async()=>{const usable=await usableAccess(own);if(usable.session.sessionId!==flow.sessionId)throw new AuthClientError('cancelled');return usable.accessToken;},
        spend:async({grant,access,signal})=>{
          const token=await access();check(own);
          if(flow.action==='revoke-all-sessions')await api.revokeAllDeviceSessions(token,grant,signal);
          else await api.revokeDeviceSession(token,flow.target!,grant,signal);
          // Re-fence after the request, so a generation change during it is never reported as success.
          check(own);
        },
      });
      flow.running=false;check(own);
      // The local session is dropped only for a revocation the server confirmed: this device or
      // every device. Nothing is queued for the server, which already invalidated it; revoking
      // another device leaves the current session and its recovery record untouched.
      if(flow.action==='revoke-all-sessions'){pendingRevocation=null;await clearLocallyAfterRevocation(own);}
      else if(pendingRevocation===flow){pendingRevocation=null;emit(state.status,state.error);}
    } catch(error) {
      flow.running=false;
      if(current(own)&&pendingRevocation===flow&&!flow.attempt.canRetry()){pendingRevocation=null;emit(state.status,state.error);}
      throw await reconcileDeviceFailure(error,own);
    }
  }
  async function scoped<T>(work:(signal:AbortSignal)=>Promise<T>) {
    const own=generation;check(own);const response=await work(controller.signal);check(own);return response;
  }
  const instance={
    getState:()=>state,
    subscribe(listener:()=>void){listeners.add(listener);return ()=>{listeners.delete(listener);};},
    bootstrap():Promise<void> {
      if(bootstrapFlight)return bootstrapFlight;
      const own=begin('bootstrapping');
      const run=(async()=>{
        try {await load(own);check(own);if(record?.active)await refresh(own);else emit('anonymous');await drainRevocations();check(own);}
        catch(error){throw fault(error,own);}
      })();
      bootstrapFlight=run;
      void run.finally(()=>{if(bootstrapFlight===run)bootstrapFlight=null;}).catch(()=>{});
      return run;
    },
    canRetryApple:()=>pendingApple?.generation===generation&&pendingApple.attempt.canRetry(),
    async loginApple(authorize:AppleAuthorize){
      if(state.status!=='anonymous'||record?.active)throw new AuthClientError('busy');
      const attempt=createAppleSignInAttempt(api,newId,authorize,now);
      let own:number|undefined;
      try{await signIn((installationId,signal)=>{own=generation;return attempt.run(installationId,signal);});}
      catch(error){if(own!==undefined&&current(own)&&attempt.canRetry()){pendingApple={attempt,generation:own};emit(state.status,state.error);}else attempt.clear();throw error;}
    },
    async retryApple(){
      const saved=pendingApple;
      if(!saved||saved.generation!==generation||!saved.attempt.canRetry()||record?.active)throw new AuthClientError('apple_restart_required');
      // Remove ownership before begin() clears the previous generation's attempt.
      pendingApple=null;let own:number|undefined;
      try{await signIn((installationId,signal)=>{own=generation;return saved.attempt.run(installationId,signal);});}
      catch(error){if(own!==undefined&&current(own)&&saved.attempt.canRetry()){pendingApple={attempt:saved.attempt,generation:own};emit(state.status,state.error);}else saved.attempt.clear();throw error;}
    },
    /** Anonymous child-device pairing (SA-08 9.3b). A device with no adult session starts exactly one
     *  request from this installation's own persisted installationId and receives only the ticket a QR
     *  code may carry. The poll secret is created and held inside the injected client, so it never
     *  reaches the controller, the vault, the caller or the published state.
     */
    async startChildPairing(input:{platform:ChildDevicePlatform;deviceLabel?:string}):Promise<ChildDevicePairingTicket> {
      const own=generation;check(own);
      // A pairing request never replaces an adult session; the guardian approves from the device that
      // is already signed in, and this device only becomes the restricted child device.
      if(state.status!=='anonymous'||record?.active)throw new AuthClientError('busy');
      if(!createChildPairingClient)throw new AuthClientError('invalid_config');
      const request=devicePairingCreateRequestSchema.omit({installationId:true}).safeParse({platform:input?.platform,
        ...(input?.deviceLabel===undefined?{}:{deviceLabel:input.deviceLabel})});
      if(!request.success)throw new AuthClientError('invalid_request');
      if(childClaim||pendingChildPairing?.generation===own)throw new AuthClientError('busy');
      try {
        if(!record)await load(own);
        check(own);
        const client=createChildPairingClient(api.endpoint);
        const ticket=await client.start({installationId:ready().installationId,platform:request.data.platform,
          ...(request.data.deviceLabel===undefined?{}:{deviceLabel:request.data.deviceLabel})},{signal:controller.signal});
        check(own);
        pendingChildPairing={client,generation:own,ticket};
        return {...ticket};
      } catch(error){throw fault(error,own);}
    },
    /** Polls that one request for its lifecycle only. No secret, adult identity, guardian or family
     *  material can travel here: the answer is the status contract and the request's own deadline. An
     *  elapsed window is reported but never retires the pairing, because a completion that was already
     *  dispatched keeps its own recovery window; only the client's refusal ends it. */
    async childPairingStatus():Promise<DevicePairingStatusResponse> {
      const own=generation;check(own);
      const pending=pendingChildPairing?.generation===own?pendingChildPairing:null;
      if(!pending)throw new AuthClientError('challenge_invalid');
      try {
        const status=await pending.client.status({signal:controller.signal});
        check(own);
        return status;
      } catch(error){throw error instanceof AuthClientError?error:new AuthClientError('unavailable');}
    },
    /** Claims the approved request once and persists the restricted child session through the ordinary
     *  sign-in path, so a secure-storage failure revokes the issued grant instead of showing a signed-in
     *  device, and a generation change never adopts a late result. A response lost after the completion
     *  was dispatched keeps the same client and its poll secret, so the client's own recovery window can
     *  still deliver the sealed result; tokens already handed out can never be replayed, so that run ends.
     */
    async claimChildPairing():Promise<void> {
      const entry=generation;check(entry);
      const saved=pendingChildPairing?.generation===entry?pendingChildPairing:null;
      if(!saved)throw new AuthClientError('challenge_invalid');
      let own:number|undefined,dispatched=false,claimed=false;
      // Fence the whole run before the sign-in drops the pending record, so cancellation and a second
      // start can only be refused while this claim is still able to publish an authenticated device.
      childClaim=saved;
      try {
        await signIn(async(_installationId,signal)=>{own=generation;dispatched=true;const session=await saved.client.claim({signal});claimed=true;return session.tokens;});
      } catch(error) {
        // The sign-in's own begin() is the only generation change that keeps this pairing alive: any
        // later one, a claim that already answered with tokens, or a request the server refuses for
        // good retires it. Only an unknown or waiting outcome keeps the same client and its secret.
        const resume=dispatched?own:entry+1;
        const resumable=!claimed&&error instanceof AuthClientError&&!terminalPairingOutcome.has(error.code);
        pendingChildPairing=resumable&&resume!==undefined&&current(resume)?{client:saved.client,generation:resume,ticket:saved.ticket}:null;
        throw error;
      } finally {childClaim=null;}
    },
    /** True while a request is pending or the claim of one is still running. */
    hasPendingChildPairing:()=>childClaim!==null||pendingChildPairing?.generation===generation,
    /** The ticket of the pairing still in flight, so a remounted screen can show the same QR code. */
    childPairingTicket(){const paired=childClaim??(pendingChildPairing?.generation===generation?pendingChildPairing:null);return paired?{...paired.ticket}:null;},
    /** Retires an unanswered request. A claim that already entered the sign-in path cannot be undone by
     *  forgetting the request: it may still publish the issued child session, so it is refused as busy
     *  until it settles, and the caller then signs out or starts a fresh pairing. */
    cancelChildPairing(){if(childClaim)throw new AuthClientError('busy');pendingChildPairing=null;},
    /** The guardian's own children in one family, read with the bearer of the current adult session.
     *  Only the minimal summaries the server publishes as live guardianships come back: the list is
     *  fenced by the generation that asked, so a session switch during the read is cancelled instead of
     *  returning one account's children to the next account. */
    async guardianChildren(familyId:string):Promise<ChildSummary[]> {
      const own=generation;check(own);
      adultGuardian();
      const client=guardianSurface();
      try {
        const tokens=await usableAccess(own);
        const children=await client.listChildren(adultAccessToken(tokens.accessToken),familyId,{signal:controller.signal});
        check(own);
        return children;
      } catch(error){throw await reconcileDeviceFailure(error,own);}
    },
    /** The device one pending pairing request would bind, previewed from the durable server record
     *  before any child or grant is touched. The input is the identifier, the request token the
     *  initiating device published and the proposed child; the answer carries the stored device
     *  description and that one child, never the polling secret of the request. The request this call
     *  showed becomes the only one the current adult session may approve, so every approval is preceded
     *  by a successful preview of exactly these three identifiers. */
    async guardianPairingPreview(pairingId:string,requestToken:string,childSubjectId:string):Promise<DevicePairingPreviewResponse> {
      const own=generation;check(own);
      adultGuardian();
      // Approving and previewing at once could land an answer on a record the guardian no longer sees,
      // so an approval in flight is refused here instead of being interleaved with a new preview.
      if(pendingChildApproval?.generation===own&&pendingChildApproval.running)throw new AuthClientError('busy');
      const client=guardianSurface();
      try {
        const tokens=await usableAccess(own);
        const preview=await client.previewPairing(adultAccessToken(tokens.accessToken),pairingId,{requestToken,childSubjectId},{signal:controller.signal});
        check(own);
        const expiresAt=Date.parse(preview.expiresAt);
        if(!Number.isFinite(expiresAt))throw new AuthClientError('invalid_response');
        // The request just shown to this guardian is the only one this session may approve. A later
        // preview replaces it, and a generation change or a restart leaves nothing behind.
        forgetChildApproval();
        pendingChildApproval={generation:own,sessionId:tokens.session.sessionId,pairingId,requestToken,childSubjectId,expiresAt,running:false};
        return preview;
      } catch(error){throw await reconcileDeviceFailure(error,own);}
    },
    /** Password re-verification for the request this guardian just previewed: the current relationship
     *  version is re-read from the guardian's own live list, the server issues one single-use
     *  `approve-child-device` grant and this call spends it on that one request. The grant never reaches
     *  the caller, the vault or the published state, the bearer is re-read and re-compared with the
     *  previewing session before the request is sent, and a dispatched approval is never replayed. */
    async approveChildPairingWithPassword(input:{pairingId:string;requestToken:string;childSubjectId:string;familyId:string},
      currentPassword:string):Promise<DevicePairingStatusResponse> {
      const own=generation;check(own);
      adultGuardian();
      const target=approvalTarget(input);
      if(!accountPasswordSchema.safeParse(currentPassword).success)throw new AuthClientError('invalid_request');
      const flow=previewedRequest(own,target);
      const client=guardianSurface();
      try {
        const tokens=await usableAccess(own);
        if(tokens.session.sessionId!==flow.sessionId)throw new AuthClientError('cancelled');
        const expectedGuardianVersion=await currentGuardianVersion(client,own,tokens,target);
        const issued=await api.reauthPassword(tokens.accessToken,currentPassword,controller.signal,'approve-child-device');
        check(own);
        // The server is authoritative for the grant TTL; the client only rejects an already-expired grant.
        if(Date.parse(issued.expiresAt)<=now())throw new AuthClientError('invalid_response');
        const approved=await spendChildApproval(client,flow,expectedGuardianVersion,approvalAccess(own,flow.sessionId),issued.reauthGrant,controller.signal);
        check(own);
        return approved;
      } catch(error) {
        // A flow that stopped before the request was dispatched keeps its preview, so a wrong password, an
        // unknown child or a refused re-verification can be retried deliberately. A dispatched request has
        // already retired it, and a refused generation was never this flow's to answer.
        flow.running=false;
        throw await reconcileDeviceFailure(error,own);
      }
    },
    /** Apple-only re-verification for the same previewed request, for an account with no password to
     *  prove. The native authorization and the one-time `approve-child-device` grant live only inside
     *  this attempt: a lost completion is replayed under its own staged key without a second native
     *  prompt, while a dispatched approval ends the flow and is reconciled by previewing again. */
    async approveChildPairingWithApple(input:{pairingId:string;requestToken:string;childSubjectId:string;familyId:string},
      authorize:AppleAuthorize):Promise<DevicePairingStatusResponse> {
      const own=generation;check(own);
      adultGuardian();
      const target=approvalTarget(input);
      if(typeof authorize!=='function')throw new AuthClientError('invalid_request');
      const flow=previewedRequest(own,target);
      const client=guardianSurface();
      let approved:DevicePairingStatusResponse|undefined;
      try {
        const tokens=await usableAccess(own);
        if(tokens.session.sessionId!==flow.sessionId)throw new AuthClientError('cancelled');
        const expectedGuardianVersion=await currentGuardianVersion(client,own,tokens,target);
        // One attempt per previewed request, kept in memory so a lost completion resumes inside it
        // instead of asking the guardian to authorize the same pairing twice.
        flow.attempt??=createAppleChildApprovalAttempt({api,newId,now,authorize});
        await flow.attempt.run({installationId:ready().installationId,signal:controller.signal,
          access:approvalAccess(own,flow.sessionId),
          spend:async({grant,access,signal})=>{approved=await spendChildApproval(client,flow,expectedGuardianVersion,access,grant,signal);}});
        check(own);
        if(!approved)throw new AuthClientError('invalid_response');
        return approved;
      } catch(error) {
        flow.running=false;
        // A refused identity or state, an elapsed staging window, a cancelled generation or a dispatched
        // approval can no longer be resumed: the preview is retired here so the caller previews again
        // instead of retrying a flow whose outcome it cannot prove.
        if(current(own)&&pendingChildApproval===flow&&flow.attempt&&!flow.attempt.canRetry())forgetChildApproval();
        throw await reconcileDeviceFailure(error,own);
      }
    },
    /** The family management duty this adult would accept, read from the server before anything is
     *  confirmed. Only the recipient's own authenticated adult session may ask; a restricted child
     *  device is refused before a bearer or a request is spent, and the family id is checked here as
     *  well. The answer must describe exactly this family and this recipient under the contract's strict
     *  shape, so a preview of another family, another subject or anything the contract does not
     *  describe is refused as a corrupt answer instead of being shown as this device's duty. The
     *  preview becomes the only duty this session may accept, bound to its generation and session, and
     *  a generation change, a sign-out or a dispose leaves nothing behind. */
    async deletionRecipients(familyId:string){
      const own=generation;check(own);
      if(!uuidPattern.test(familyId))throw new AuthClientError('invalid_request');
      const tokens=await usableAccess(own);
      if(tokens.session.subjectKind!=='adult')throw new AuthClientError('adult_required');
      const result=await api.deletionRecipients(tokens.accessToken,familyId,controller.signal);check(own);return result;
    },
    async familyResponsibilities(){
      const own=generation;check(own);const tokens=await usableAccess(own);
      if(tokens.session.subjectKind!=='adult')throw new AuthClientError('adult_required');
      const result=await api.familyResponsibilities(tokens.accessToken,controller.signal);check(own);return result;
    },
    async frozenFamilyPreview(familyId:string){
      const own=generation;check(own);
      if(!uuidPattern.test(familyId))throw new AuthClientError('invalid_request');
      if(frozenBusy===own)throw new AuthClientError('busy');
      frozenBusy=own;frozenPreview=null;
      try{
        const tokens=await usableAccess(own);
        if(tokens.session.subjectKind!=='adult')throw new AuthClientError('adult_required');
        const result=frozenFamilyReviewScopeSchema.parse(await api.frozenFamilyPreview(tokens.accessToken,familyId,controller.signal));check(own);
        if(result.familyId!==familyId||result.recipientSubjectId!==tokens.session.subjectId)throw new AuthClientError('invalid_response');
        frozenPreview={generation:own,scope:frozenFamilyReviewScopeSchema.parse(result)};return result;
      }finally{if(frozenBusy===own)frozenBusy=null;}
    },
    async acceptFrozenFamily(familyId:string,input:FamilyManagementAcceptanceRequest){
      const own=generation;check(own);
      if(frozenBusy===own)throw new AuthClientError('busy');
      const scope=frozenPreview?.generation===own?frozenPreview.scope:null;
      if(!scope)throw new AuthClientError('challenge_invalid');
      const parsed=familyManagementAcceptanceRequestSchema.safeParse(input);
      if(!parsed.success||scope.familyId!==familyId||parsed.data.expectedFamilyVersion!==scope.familyVersion||
        parsed.data.expectedMembershipVersion!==scope.membershipVersion||parsed.data.expectedOwnerMembershipVersion!==scope.ownerMembershipVersion||
        parsed.data.expectedChildScopeDigest!==scope.childScopeDigest)throw new AuthClientError('invalid_request');
      frozenBusy=own;frozenPreview=null;
      try{
        const tokens=await usableAccess(own);
        if(tokens.session.subjectId!==scope.recipientSubjectId)throw new AuthClientError('cancelled');
        const receipt=frozenFamilyReviewAcceptanceReceiptSchema.parse(await api.acceptFrozenFamily(tokens.accessToken,familyId,parsed.data,controller.signal));check(own);
        for(const key of Object.keys(scope) as (keyof FrozenFamilyReviewScope)[])
          if(receipt[key]!==scope[key])throw new AuthClientError('invalid_response');
        return receipt;
      }finally{if(frozenBusy===own)frozenBusy=null;}
    },
    async familyManagementPreview(familyId:string):Promise<FamilyManagementAcceptancePreview> {
      const own=generation;check(own);
      if(state.status!=='authenticated'||!record?.active)throw new AuthClientError('reauth_required');
      if(record.active.subjectKind!=='adult')throw new AuthClientError('adult_required');
      if(!uuidPattern.test(familyId))throw new AuthClientError('invalid_request');
      // A duty already claimed by a submission in flight is never replaced.
      if(readingFamilyManagement===own||(previewedFamilyManagement?.generation===own&&previewedFamilyManagement.running))throw new AuthClientError('busy');
      readingFamilyManagement=own;previewedFamilyManagement=null;
      try {
        const tokens=await usableAccess(own);
        const answer=await api.familyManagementPreview(tokens.accessToken,familyId,controller.signal);
        check(own);
        const preview=familyManagementAcceptancePreviewSchema.safeParse(answer);
        if(!preview.success||preview.data.familyId!==familyId||preview.data.recipientSubjectId!==tokens.session.subjectId)
          throw new AuthClientError('invalid_response');
        const cached=copyFamilyManagementPreview(preview.data);
        previewedFamilyManagement={generation:own,sessionId:tokens.session.sessionId,familyId,preview:cached,running:false};
        return copyFamilyManagementPreview(cached);
      } catch(error) {
        const safe=error instanceof AuthClientError?error:new AuthClientError('unavailable');
        if(safe.code==='reauth_required')fault(safe,own);
        throw safe;
      } finally {if(readingFamilyManagement===own)readingFamilyManagement=null;}
    },
    /** Accepts exactly the duty this device just previewed, in the one request shape the server
     *  accepts: the family, the membership versions, the owner's membership version and the child scope
     *  digest that were displayed, plus both explicit duty confirmations. The contract carries no
     *  subject, session, role, guardian flag or family inside the body and an unknown field is refused
     *  here, so this call can neither accept on someone else's behalf nor widen the scope it was shown,
     *  and no token or grant travels anywhere but the bearer header. The request is dispatched once,
     *  under this generation's own signal, and no retry is attempted: a server version conflict retires
     *  the preview, an unknown outcome is reported as a failure rather than as an acceptance, and the
     *  caller recovers by reading the family again. */
    async acceptFamilyManagement(familyId:string,input:FamilyManagementAcceptanceRequest):Promise<FamilyManagementAcceptanceReceipt> {
      const own=generation;check(own);
      if(state.status!=='authenticated'||!record?.active)throw new AuthClientError('reauth_required');
      if(record.active.subjectKind!=='adult')throw new AuthClientError('adult_required');
      if(!uuidPattern.test(familyId))throw new AuthClientError('invalid_request');
      const claimed=claimedFamilyManagementAcceptance(own,familyId,input);
      const signal=controller.signal;let dispatched=false;
      try {
        const tokens=await usableAccess(own);
        if(tokens.session.sessionId!==claimed.preview.sessionId)throw new AuthClientError('cancelled');
        // The one dispatch. The claim keeps the preview while this call is outstanding, so the duty is
        // accepted at most once and no second preview can be interleaved with an open answer; it is
        // retired as this call settles, and a new read of the family is the only way back in.
        dispatched=true;
        const answer=await api.acceptFamilyManagement(tokens.accessToken,familyId,claimed.request,signal);
        check(own);
        const receipt=familyManagementAcceptanceReceiptSchema.safeParse(answer);
        if(!receipt.success)throw new AuthClientError('invalid_response');
        const accepted=receipt.data;
        // The receipt must describe the duty that was accepted: this family, this recipient, the owner
        // that was shown and the displayed child scope. Anything else is a foreign or corrupt record,
        // never a proof this device may present.
        if(accepted.familyId!==familyId||accepted.recipientSubjectId!==tokens.session.subjectId||
           accepted.ownerSubjectId!==claimed.preview.preview.ownerSubjectId||
           accepted.childScopeDigest!==claimed.preview.preview.childScopeDigest||
           accepted.familyVersion!==claimed.preview.preview.familyVersion||
           accepted.membershipVersion!==claimed.preview.preview.membershipVersion||
           accepted.ownerMembershipVersion!==claimed.preview.preview.ownerMembershipVersion)
          throw new AuthClientError('invalid_response');
        if(previewedFamilyManagement===claimed.preview)previewedFamilyManagement=null;
        return familyManagementAcceptanceReceiptSchema.parse(accepted);
      } catch(error) {
        claimed.preview.running=false;
        const safe=error instanceof AuthClientError?error:new AuthClientError('unavailable');
        // A refusal or a lost answer that followed the one dispatch leaves no preview behind, so the
        // caller's next step is a fresh read of the family; a failure before the request left — a
        // refused bearer, a replaced session — keeps the preview for a deliberate repeat.
        if(dispatched&&previewedFamilyManagement===claimed.preview)previewedFamilyManagement=null;
        if(safe.code==='reauth_required')fault(safe,own);
        throw safe;
      }
    },
    /** First login email for an already authenticated Apple-only account. The one-time Apple
     *  reauth grant is spent inside this call: it is never persisted, returned to the caller or
     *  published in client state, and the active session, its record and its generation are left
     *  untouched. Calling again with the same key and address replays a lost completion or link
     *  request instead of repeating native authorization; another key or address waits. Login and
     *  this path cannot overlap: login needs an anonymous client and begin() discards the flow.
     */
    async requestEmailLinkWithApple(input:Omit<EmailLinkRequest,'reauthGrant'>,authorize:AppleAuthorize,key:string):Promise<EmailChallengeResponse> {
      const own=generation;check(own);
      const request=emailLinkRequestSchema.omit({reauthGrant:true}).safeParse(input);
      if(!request.success||!idempotencyKey.test(key))throw new AuthClientError('invalid_request');
      if(state.status!=='authenticated'||!record?.active)throw new AuthClientError('reauth_required');
      let pending=pendingEmailLink?.generation===own?pendingEmailLink:null;
      if(pending) {
        if(pending.key!==key||pending.email!==request.data.email||pending.locale!==request.data.locale||pending.running)throw new AuthClientError('busy');
      } else {
        pending={attempt:createAppleReauthAttempt({api,newId,now,authorize,email:request.data.email,locale:request.data.locale,key}),
          generation:own,sessionId:record.active.sessionId,key,email:request.data.email,locale:request.data.locale,running:false};
        pendingEmailLink=pending;emit(state.status,state.error);
      }
      const flow=pending;pending.running=true;
      try {
        const tokens=await usableAccess(own);
        // The server binds the flow to the session that started it, so a replaced session cannot resume it.
        if(tokens.session.sessionId!==flow.sessionId)throw new AuthClientError('cancelled');
        const challenge=await flow.attempt.run({access:async()=>{
          const usable=await usableAccess(own);
          if(usable.session.sessionId!==flow.sessionId)throw new AuthClientError('cancelled');
          return usable.accessToken;
        },installationId:ready().installationId,signal:controller.signal});
        flow.running=false;check(own);
        if(pendingEmailLink===flow){pendingEmailLink=null;emit(state.status,state.error);}
        return challenge;
      } catch(error) {
        flow.running=false;
        // A retryable loss keeps the staged flow so the same key can finish it; anything else ends it.
        if(current(own)&&pendingEmailLink===flow&&!flow.attempt.canRetry()){pendingEmailLink=null;emit(state.status,state.error);}
        throw await reconcileDeviceFailure(error,own);
      }
    },
    /** Second half of the same operation on the current session: proves the address and sets the
     *  first password. No session, token, vault record or account identity is replaced or issued.
     */
    async confirmEmailLink(input:EmailLinkConfirm,key:string):Promise<void> {
      const own=generation;check(own);
      const confirm=emailLinkConfirmSchema.safeParse(input);
      if(!confirm.success||!idempotencyKey.test(key))throw new AuthClientError('invalid_request');
      if(state.status!=='authenticated'||!record?.active)throw new AuthClientError('reauth_required');
      try {
        const tokens=await usableAccess(own);
        await api.confirmEmailLink(tokens.accessToken,confirm.data,key,controller.signal);check(own);
      } catch(error){throw await reconcileDeviceFailure(error,own);}
    },
    login:(input:Omit<EmailLogin,'installationId'>)=>signIn((installationId,signal)=>api.login({...input,installationId},signal)),
    register:(input:Omit<EmailRegisterConfirm,'installationId'>,key:string)=>signIn((installationId,signal)=>api.register({...input,installationId},key,signal)),
    requestRegistration:(input:EmailChallengeRequest,key:string)=>scoped(signal=>api.requestRegistration(input,key,signal)),
    requestReset:(input:EmailChallengeRequest,key:string)=>scoped(signal=>api.requestReset(input,key,signal)),
    confirmReset:(input:EmailPasswordResetConfirm,key:string)=>scoped(signal=>api.confirmReset(input,key,signal)),
    async changePassword(currentPassword:string,newPassword:string,key:string) {
      const own=generation;check(own);
      if(!record?.active)throw new AuthClientError('reauth_required');
      const current=accountPasswordSchema.safeParse(currentPassword),next=newAccountPasswordSchema.safeParse(newPassword);
      if(!current.success||!next.success||!/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(key))throw new AuthClientError('invalid_request');
      let pending=pendingPasswordChange;
      if(pending&&pending.generation===own) {
        if(pending.currentPassword!==currentPassword||pending.newPassword!==newPassword||pending.key!==key)throw new AuthClientError('busy');
      } else {
        if(state.status!=='authenticated'||!access)throw new AuthClientError('reauth_required');
        let tokens=access;
        try {
          if(Date.parse(tokens.accessExpiresAt)<=now()+30_000)tokens=await refresh(own);
          const grant=await api.reauthPassword(tokens.accessToken,currentPassword,controller.signal);check(own);
          // The server is authoritative for the grant TTL; the client only rejects an already-expired grant.
          if(Date.parse(grant.expiresAt)<=now())throw new AuthClientError('invalid_response');
          pending={generation:own,accessToken:tokens.accessToken,currentPassword,newPassword,reauthGrant:grant.reauthGrant,key};pendingPasswordChange=pending;
          emit(state.status,state.error);
        } catch(error) {
          const safe=error instanceof AuthClientError?error:new AuthClientError('unavailable');
          if(['invalid_credentials','rate_limited','network','timeout','unavailable'].includes(safe.code))emit(state.status,safe.code);
          else fault(error,own);
          throw safe;
        }
      }
      try {
        await api.changePassword(pending.accessToken,{newPassword:pending.newPassword,reauthGrant:pending.reauthGrant},pending.key,controller.signal);check(own);
        await serialize(async()=>{check(own);await save({...ready(),active:null});check(own);});
        pendingPasswordChange=null;access=null;emit('anonymous');
      } catch(error) {
        if(!pendingPasswordChange||pendingPasswordChange!==pending)throw new AuthClientError('cancelled');
        const safe=error instanceof AuthClientError?error:new AuthClientError('unavailable');
        if(safe.code==='storage_unavailable'||safe.code==='storage_corrupt')fault(error,own);
        else emit(state.status,safe.code);
        throw safe;
      }
    },
    async retryPasswordChange() {
      const pending=pendingPasswordChange;
      if(!pending||pending.generation!==generation)throw new AuthClientError('operation_completed');
      return instance.changePassword(pending.currentPassword,pending.newPassword,pending.key);
    },
    hasPendingPasswordChange:()=>pendingPasswordChange?.generation===generation,
    async deviceSessions(cursor?:string) {
      const own=generation;check(own);
      try {const tokens=await usableAccess(own);const page=await api.deviceSessions(tokens.accessToken,cursor,controller.signal);check(own);return page;}
      catch(error){const safe=error instanceof AuthClientError?error:new AuthClientError('unavailable');if(safe.code==='reauth_required')fault(safe,own);throw safe;}
    },
    async loginMethods() {
      const own=generation;check(own);
      try {const tokens=await usableAccess(own);const methods=await api.loginMethods(tokens.accessToken,controller.signal);check(own);return methods;}
      catch(error){const safe=error instanceof AuthClientError?error:new AuthClientError('unavailable');if(safe.code==='reauth_required')fault(safe,own);throw safe;}
    },
    async revokeDeviceSession(sessionId:string,currentPassword?:string) {
      const own=generation;check(own);
      if(!/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(sessionId))throw new AuthClientError('invalid_request');
      try {
        const tokens=await usableAccess(own),isCurrent=tokens.session.sessionId===sessionId;
        let grant:string|undefined;
        if(!isCurrent){if(!accountPasswordSchema.safeParse(currentPassword).success)throw new AuthClientError('invalid_request');
          const issued=await api.reauthPassword(tokens.accessToken,currentPassword!,controller.signal,'revoke-session');check(own);
          if(Date.parse(issued.expiresAt)<=now())throw new AuthClientError('invalid_response');grant=issued.reauthGrant;}
        await api.revokeDeviceSession(tokens.accessToken,sessionId,grant,controller.signal);check(own);
        if(isCurrent)await clearLocallyAfterRevocation(own);
      } catch(error){throw await reconcileDeviceFailure(error,own);}
    },
    async revokeAllDeviceSessions(currentPassword:string) {
      const own=generation;check(own);
      if(!accountPasswordSchema.safeParse(currentPassword).success)throw new AuthClientError('invalid_request');
      try {
        const tokens=await usableAccess(own),issued=await api.reauthPassword(tokens.accessToken,currentPassword,controller.signal,'revoke-all-sessions');check(own);
        if(Date.parse(issued.expiresAt)<=now())throw new AuthClientError('invalid_response');
        await api.revokeAllDeviceSessions(tokens.accessToken,issued.reauthGrant,controller.signal);check(own);
        await clearLocallyAfterRevocation(own);
      } catch(error){throw await reconcileDeviceFailure(error,own);}
    },
    /** Removes one login method by the strict `email:` handle `loginMethods()` returned, after a
     *  password re-verification that issues one `unlink-identity` grant. The grant and the bearer
     *  both belong to the session that asked for them, so the local recovery record is cleared only
     *  for a removal the server confirmed — which also revokes every session of the subject. An
     *  unknown DELETE outcome is never repeated: the refresh credential decides whether the method
     *  is gone, so a session that still works is reported as a failure instead of a success.
     */
    async unlinkIdentity(identityId:string,currentPassword:string):Promise<void> {
      const own=generation;check(own);
      if(parseEmailLoginMethodId(identityId)===null||!accountPasswordSchema.safeParse(currentPassword).success)throw new AuthClientError('invalid_request');
      try {
        const tokens=await usableAccess(own),sessionId=tokens.session.sessionId;
        const issued=await api.reauthPassword(tokens.accessToken,currentPassword,controller.signal,'unlink-identity');check(own);
        // The server is authoritative for the grant TTL; the client only rejects an already-expired grant.
        if(Date.parse(issued.expiresAt)<=now())throw new AuthClientError('invalid_response');
        // The grant is spent with the current bearer of the session that asked for it, or not at all.
        const usable=await usableAccess(own);check(own);
        if(usable.session.sessionId!==sessionId)throw new AuthClientError('cancelled');
        await api.unlinkIdentity(usable.accessToken,identityId,issued.reauthGrant,controller.signal);check(own);
        await clearLocallyAfterRevocation(own);
      } catch(error){throw await reconcileDeviceFailure(error,own);}
    },
    /** The caller's own dependencies, read before anything is confirmed. Only an adult session may ask,
     *  and the preview is bound to this generation, session and subject. */
    async deletionImpact():Promise<AccountDeletionImpact> {
      const own=generation;check(own);
      if(state.status!=='authenticated'||!record?.active)throw new AuthClientError('reauth_required');
      if(record.active.subjectKind!=='adult')throw new AuthClientError('adult_required');
      // A preview already owned by a submission in flight is never replaced.
      if(pendingDeletion?.generation===own)throw new AuthClientError('busy');
      try {
        const tokens=await usableAccess(own);
        const impact=accountDeletionImpactSchema.safeParse(await api.deletionImpact(tokens.accessToken,controller.signal));
        check(own);
        if(!impact.success||impact.data.subjectId!==tokens.session.subjectId)throw new AuthClientError('invalid_response');
        if(pendingDeletion?.generation===own)throw new AuthClientError('busy');
        const cached=copyImpact(impact.data);
        deletionPreview={generation:own,sessionId:tokens.session.sessionId,subjectId:cached.subjectId,impact:cached};
        return copyImpact(cached);
      } catch(error) {
        const safe=error instanceof AuthClientError?error:new AuthClientError('unavailable');
        if(safe.code==='reauth_required')fault(safe,own);
        throw safe;
      }
    },
    /** Submits the previewed deletion with one password re-verification bound to `delete-account`. The
     *  confirmation is this method's own constant, the declared handling must settle exactly the
     *  affected families, and the slot is claimed before the grant is spent. */
    async submitDeletionWithPassword(password:string,dependencyDisposition:DeletionDependencyDisposition):Promise<void> {
      const own=generation;check(own);
      // The signal of this flow's own generation travels with the submission, so a later generation's
      // controller can never be the one that carries the request.
      const signal=controller.signal;
      if(!accountPasswordSchema.safeParse(password).success)throw new AuthClientError('invalid_request');
      const pending=claimDeletion(own,dependencyDisposition,signal);
      await runDeletion(own,pending,async()=>{
        const tokens=await usableAccess(own);
        const issued=await api.reauthPassword(tokens.accessToken,password,signal,'delete-account');
        check(own);
        // The server is authoritative for the grant TTL; the client rejects an unreadable or already
        // elapsed deadline, so a malformed value can never pass the check as NaN.
        const grantExpiry=Date.parse(issued.expiresAt);
        if(!Number.isFinite(grantExpiry)||grantExpiry<=now())throw new AuthClientError('invalid_response');
        return createAccountDeletionAttempt({api,accessToken:tokens.accessToken,key:pending.key,
          input:{reauthGrant:issued.reauthGrant,confirmation:true,dependencyDisposition:pending.disposition}});
      });
    },
    /** The same submission for an account that proves itself with Apple instead of a password. The
     *  provider flow and its one-time grant stay inside the injected attempt; this method supplies only
     *  the session-bound bearer those steps read, and every shared step stays identical. */
    async submitDeletionWithApple(authorize:AppleAuthorize,dependencyDisposition:DeletionDependencyDisposition):Promise<void> {
      const own=generation;check(own);
      const signal=controller.signal;
      if(typeof authorize!=='function')throw new AuthClientError('invalid_request');
      const pending=claimDeletion(own,dependencyDisposition,signal);
      await runDeletion(own,pending,async()=>{
        const attempt=createAppleDeletionAttempt({api,newId,now,authorize,dependencyDisposition:pending.disposition,key:pending.key});
        return {clear:()=>attempt.clear(),canRetry:()=>attempt.canRetry(),
          run:signal=>attempt.run({access:deletionAccess(own,pending.sessionId),installationId:ready().installationId,signal})};
      });
    },
    /** Repeats the one submission already started with its own bearer, grant and key: no refresh, no
     *  second re-verification, no new key, and no second destructive request for a cached receipt. */
    async retryDeletion():Promise<void> {
      const own=generation;check(own);
      deletionStore();
      const pending=pendingDeletion?.generation===own?pendingDeletion:null;
      if(!pending||!pending.attempt)throw new AuthClientError('operation_completed');
      if(pending.running)throw new AuthClientError('busy');
      // Nothing cached and nothing repeatable means this submission cannot be resumed, so the record is
      // retired here instead of blocking the next one forever.
      if(!pending.receipt&&!pending.attempt.canRetry()){
        forgetPendingDeletion();emit(state.status,state.error);throw new AuthClientError('operation_completed');
      }
      pending.running=true;
      try {
        let receipt=pending.receipt;
        if(!receipt) {
          receipt=await pending.attempt.run(pending.signal);check(own);
          pending.receipt=receipt;
        }
        await finishDeletion(own,pending);
      } catch(error) {
        pending.running=false;
        const safe=error instanceof AuthClientError?error:new AuthClientError('unavailable');
        // A stored receipt that still needs persisting keeps the record; a dead attempt without one does
        // not, and a stale generation's attempt is cleared rather than left holding its credentials.
        if(!current(own))pending.attempt.clear();
        else if(pendingDeletion===pending&&!pending.receipt&&pending.attempt.canRetry()!==true)forgetPendingDeletion();
        if(current(own)){if(deletionReported.has(safe.code))emit(state.status,safe.code);else fault(safe,own);}
        throw safe;
      }
    },
    /** The progress the stored receipt can read. The secret is the whole proof, so this also answers
     *  while anonymous; a signed-in account never reads another subject's receipt. Neither the secret
     *  nor the subject is returned, and no stored or unexpired receipt reads as null. */
    async deletionStatus():Promise<DeletionProgress|null> {
      const own=generation;check(own);
      deletionStore();
      const stored=await readDeletionRecord();
      check(own);
      if(!stored)return null;
      if(record?.active&&record.active.subjectId!==stored.subjectId)throw new AuthClientError('busy');
      const expiresAt=Date.parse(stored.receipt.expiresAt);
      if(!Number.isFinite(expiresAt))throw new AuthClientError('storage_corrupt');
      if(expiresAt<=now())return null;
      let answer:unknown;
      try {answer=await api.deletionStatus({deletionId:stored.receipt.deletionId,receiptSecret:stored.receipt.receiptSecret},controller.signal);}
      catch(error){throw error instanceof AuthClientError?error:new AuthClientError('unavailable');}
      check(own);
      const status=deletionStatusSchema.safeParse(answer);
      if(!status.success)throw new AuthClientError('invalid_response');
      return {deletionId:stored.receipt.deletionId,expiresAt:stored.receipt.expiresAt,status:status.data};
    },
    /** True while this generation owns a submission it can repeat or finish. */
    hasPendingDeletion:()=>pendingDeletion?.generation===generation,
    /** Apple-only revocation of another device. The account proves its already bound Apple identity
     *  again, so the server issues one action-bound `revoke-session` grant that this call spends
     *  inside its own closure: the grant is never persisted, returned to the caller or published in
     *  client state. A lost Apple completion resumes under the same operation key; a lost revocation
     *  is reported as a failure, so the caller re-reads deviceSessions() instead of assuming the
     *  device is gone. Revoking this device needs no fresh grant and clears the local session once
     *  the server confirms it.
     */
    async revokeDeviceSessionWithApple(sessionId:string,authorize:AppleAuthorize,key:string):Promise<void> {
      const own=generation;check(own);
      if(!sessionIdPattern.test(sessionId)||!idempotencyKey.test(key))throw new AuthClientError('invalid_request');
      if(state.status!=='authenticated'||!record?.active)throw new AuthClientError('reauth_required');
      if(record.active.sessionId===sessionId)return instance.revokeDeviceSession(sessionId);
      return runAppleRevocation('revoke-session',sessionId,authorize,key,own);
    },
    /** Apple-only revocation of every session of this subject, including this device. The fresh
     *  `revoke-all-sessions` grant is spent inside this call, and the local session is cleared only
     *  after the server confirms the revocation.
     */
    async revokeAllDeviceSessionsWithApple(authorize:AppleAuthorize,key:string):Promise<void> {
      const own=generation;check(own);
      if(!idempotencyKey.test(key))throw new AuthClientError('invalid_request');
      if(state.status!=='authenticated'||!record?.active)throw new AuthClientError('reauth_required');
      return runAppleRevocation('revoke-all-sessions',null,authorize,key,own);
    },
    providers:()=>scoped(signal=>api.providers(signal)),
    /** The released terms/privacy versions for registration. A public read bound to the current
     *  generation like `providers()`: it stores nothing, changes no session state, and a failure is
     *  reported to the caller instead of being turned into a fault on the account. */
    registrationPolicy:():Promise<RegistrationPolicy>=>scoped(signal=>api.registrationPolicy(signal)),
    async session():Promise<VerifiedAccountSession> {
      const own=generation;check(own);
      if(sessionFlight?.generation===own)return sessionFlight.promise;
      const run=(async()=>{
      try {
        let tokens=access;
        if(!tokens||Date.parse(tokens.accessExpiresAt)<=now()+30_000)tokens=await refresh(own);
        let session:VerifiedAccountSession;
        try {session=await api.session(tokens.accessToken,controller.signal);}
        catch(error) {
          check(own);
          if(!(error instanceof AuthClientError)||error.code!=='reauth_required')throw error;
          tokens=access&&access.accessToken!==tokens.accessToken?access:await refresh(own);
          session=await api.session(tokens.accessToken,controller.signal);
        }
        check(own);
        if(session.subjectId!==tokens.session.subjectId||session.sessionId!==tokens.session.sessionId||session.subjectKind!==tokens.session.subjectKind||Date.parse(session.expiresAt)<=now())throw new AuthClientError('invalid_response');
        return session;
      }catch(error){throw fault(error,own);}
      })();
      sessionFlight={generation:own,promise:run};
      try{return await run;}finally{if(sessionFlight?.promise===run)sessionFlight=null;}
    },
    async logout() {
      const own=begin('logging-out');
      try {if(!record)await load(own);if(ready().revocations.length>=4)await drainRevocations();await detach(own);check(own);emit('anonymous');await drainRevocations();check(own);}
      catch(error){throw fault(error,own);}
      return {local:true as const,server:record?.revocations.length?'pending' as const:'confirmed' as const};
    },
    drainRevocations,
    async dispose() {pendingApple?.attempt.clear();pendingApple=null;pendingEmailLink?.attempt.clear();pendingEmailLink=null;pendingRevocation?.attempt.clear();pendingRevocation=null;pendingChildPairing=null;childClaim=null;forgetChildApproval();forgetFamilyManagementPreview();forgetPendingDeletion();deletionPreview=null;pendingPasswordChange=null;disposed=true;generation++;controller.abort();lifetime.abort();access=null;listeners.clear();await Promise.allSettled([tail,revocationFlight]);},
  };
  return instance;
}
export type AuthController=ReturnType<typeof createAuthController>;
