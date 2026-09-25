import {deletionRecipientsSchema,familyResponsibilityListSchema,frozenFamilyReviewScopeSchema,frozenFamilyReviewAcceptanceReceiptSchema} from '@siyue/contracts';
import {appleLoginStartRequestSchema,appleLoginStartResponseSchema,appleLoginCompleteRequestSchema,appleReauthGrantSchema,
  type ReauthAction,type AppleLoginStartRequest,type AppleLoginCompleteRequest,type AppleReauthAction} from '@siyue/contracts';
import { accountDeletionImpactSchema,accountDeletionRequestSchema,deletionReceiptSchema,deletionStatusRequestSchema,deletionStatusSchema,
  type AccountDeletionRequest,type DeletionStatusRequest} from '@siyue/contracts';
import { familyManagementAcceptancePreviewSchema,familyManagementAcceptanceRequestSchema,
  familyManagementAcceptanceReceiptSchema,type FamilyManagementAcceptanceRequest } from '@siyue/contracts';
import { emailChallengeRequestSchema,emailRegisterConfirmSchema,emailLoginSchema,emailPasswordResetConfirmSchema,passwordReauthSchema,passwordReauthResponseSchema,passwordChangeSchema,accountDeviceSessionsPageSchema,
  refreshRequestSchema,refreshTokenSchema,sessionTokensSchema,verifiedAccountSessionSchema,emailChallengeResponseSchema,authProvidersSchema,
  emailLinkRequestSchema,emailLinkConfirmSchema,accountLoginMethodsSchema,
  registrationPolicySchema,
  unlinkIdentityRequestSchema,parseEmailLoginMethodId,
  type AuthEnvironment,type AuthClientErrorCode,type EmailChallengeRequest,type EmailRegisterConfirm,type EmailLogin,type EmailPasswordResetConfirm,type EmailLinkRequest,type EmailLinkConfirm,type RegistrationPolicy } from '@siyue/contracts';

export class AuthClientError extends Error {
  constructor(readonly code:AuthClientErrorCode,readonly retryAfterSeconds=0) {super(code);this.name='AuthClientError';}
}
export interface AuthEndpoint {environment:AuthEnvironment;apiBaseUrl:string;}
export function authEndpoint(input:AuthEndpoint):AuthEndpoint {
  let url:URL;try {url=new URL(input.apiBaseUrl);} catch {throw new AuthClientError('invalid_config');}
  const normalized=url.href.replace(/\/$/,'');
  if(url.username||url.password||url.search||url.hash||normalized.length>200) throw new AuthClientError('invalid_config');
  if(input.environment==='production') {
    if(normalized!=='https://api.qiugeapp.com/api/siyue/v1') throw new AuthClientError('invalid_config');
  } else if(input.environment==='test'||input.environment==='development') {
    if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!['http:','https:'].includes(url.protocol)||url.pathname.replace(/\/$/,'')!=='/v1') throw new AuthClientError('invalid_config');
  } else throw new AuthClientError('invalid_config'); // staging needs an explicitly confirmed host at SA-10.
  return {environment:input.environment,apiBaseUrl:normalized};
}
const serverErrors:Record<string,AuthClientErrorCode>={AUTH_INVALID_REQUEST:'invalid_request',AUTH_INVALID_CREDENTIALS:'invalid_credentials',
  AUTH_CHALLENGE_INVALID:'challenge_invalid',AUTH_EMAIL_ALREADY_EXISTS:'email_exists',AUTH_EMAIL_ALREADY_LINKED:'email_already_linked',AUTH_PASSWORD_POLICY:'password_policy',AUTH_PASSWORD_TOO_COMMON:'password_policy',
  AUTH_RATE_LIMITED:'rate_limited',AUTH_BUSY:'busy',AUTH_OPERATION_COMPLETED_LOGIN_REQUIRED:'operation_completed',AUTH_IDEMPOTENCY_CONFLICT:'invalid_request',
  AUTH_IN_PROGRESS:'busy',AUTH_APPLE_RESTART_REQUIRED:'apple_restart_required',AUTH_IDEMPOTENCY_KEY_REQUIRED:'invalid_request',
  // Removing the last way to sign in and removing a method this subject does not have stay
  // distinct: the first tells the caller to add another method, the second that the handle is
  // not a method of this account (any more).
  AUTH_LAST_METHOD_REQUIRED:'last_method_required',AUTH_IDENTITY_NOT_FOUND:'identity_not_found',
  // Sign-up bound to released documents: a confirm whose versions are no longer current is refused as
  // a decided outcome so the screen re-reads the policy instead of retrying the same payload.
  AUTH_POLICY_CHANGED:'policy_changed',
  AUTH_SESSION_INVALID:'reauth_required',AUTH_ACCESS_INVALID:'reauth_required',AUTH_REFRESH_REPLAYED:'reauth_required',AUTH_REFRESH_RECOVERY_EXPIRED:'reauth_required',
  // A deletion receipt is a one-time proof, not a resource the client can re-derive: unknown, spent
  // and expired receipts agree on the server, so the client reports an unusable proof instead of a
  // retryable outage. The caller needs a fresh re-verification; polling cannot repair it.
  AUTH_DELETION_RECEIPT_INVALID:'challenge_invalid',
  AUTH_DELETION_DEPENDENCIES:'deletion_dependencies',AUTH_DELETION_RECEIPT_UNRECOVERABLE:'deletion_receipt_unrecoverable',
  AUTH_DELETION_OUTCOME_UNKNOWN:'deletion_outcome_unknown',AUTH_ADULT_REQUIRED:'adult_required',
  FAMILY_INVALID_REQUEST:'invalid_request',FAMILY_NOT_FOUND:'identity_not_found',
  FAMILY_ADULT_REQUIRED:'adult_required',FAMILY_STALE_AUTHORIZATION:'busy',FAMILY_BUSY:'busy',
  FAMILY_TEMPORARILY_UNAVAILABLE:'unavailable'};
// The only deployment-level refusal this client treats as decided on a 5xx: sign-up is closed, so a new
// request or a repeat of the original key cannot succeed until the released pair is read again. Every
// other 5xx code, an unknown code and an unreadable body stay a retryable outage.
const serverClosed:Record<string,AuthClientErrorCode>={AUTH_REGISTRATION_UNAVAILABLE:'registration_closed'};
// The server admits exactly this single-bearer shape; rejecting other values locally keeps
// malformed credentials off the network and never echoes or logs the token value.
const accessTokenPattern=/^[A-Za-z0-9._-]{1,4096}$/;
function accessToken(token:string):string {if(!accessTokenPattern.test(token))throw new AuthClientError('invalid_request');return token;}
async function json(response:Response,maximum=16_384):Promise<unknown> {
  if(!response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body || Number(response.headers.get('content-length'))>maximum) throw new AuthClientError('invalid_response');
  const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
  try {
    while(true) {const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maximum)throw new AuthClientError('invalid_response');chunks.push(part.value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  } catch {throw new AuthClientError('invalid_response');}
  finally {void reader.cancel().catch(()=>{});}
}
export function createAuthApiClient(options:AuthEndpoint & {fetcher:(url:string,init:RequestInit)=>Promise<Response>;timeoutMs?:number}) {
  const endpoint=authEndpoint(options);const timeout=options.timeoutMs??8000;
  if(!Number.isInteger(timeout)||timeout<1||timeout>30_000)throw new AuthClientError('invalid_config');
  async function request<T>(path:string,method:'GET'|'POST'|'DELETE',schema:{parse:(value:unknown)=>T}|null,
    input:unknown,signal?:AbortSignal,key?:string,token?:string,expectedStatus?:number):Promise<T> {
    if(signal?.aborted)throw new AuthClientError('cancelled');
    if(key!==undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key))throw new AuthClientError('invalid_request');
    const controller=new AbortController();let timedOut=false;
    const abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{timedOut=true;controller.abort();},timeout);
    const cancelled=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new AuthClientError(timedOut?'timeout':'cancelled')),{once:true}));
    try {
      const work=(async()=>{
        let response:Response;
        try {response=await options.fetcher(endpoint.apiBaseUrl+path,{method,headers:{Accept:'application/json',...(input!==undefined?{'Content-Type':'application/json'}:{}),
          ...(key?{'Idempotency-Key':key}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},...(input!==undefined?{body:JSON.stringify(input)}:{}),
          signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer'});} catch {throw new AuthClientError('network');}
        if(controller.signal.aborted)throw new AuthClientError('cancelled');
        if(response.redirected || (response.url && new URL(response.url).href!==endpoint.apiBaseUrl+path))throw new AuthClientError('invalid_response');
        if(response.status>=500) {
          // A closed sign-up is a decided refusal the screen must act on, so its code is read from the
          // bounded JSON body; an unknown code, an oversized body or a non-JSON body stays an outage.
          let closed:AuthClientErrorCode|undefined;
          try {
            const raw=await json(response) as {error?:{code?:unknown}};
            const value=raw?.error?.code;
            if(typeof value==='string'&&Object.hasOwn(serverClosed,value))closed=serverClosed[value];
          } catch {void 0;}
          throw new AuthClientError(closed??'unavailable');
        }
        if(response.status===429) {
          const seconds=Number(response.headers.get('retry-after'));throw new AuthClientError('rate_limited',Number.isFinite(seconds)?Math.max(1,Math.min(seconds,3600)):60);
        }
        if(!response.ok) {
          let body:unknown;try {body=await json(response);} catch {throw new AuthClientError(response.status===401?'reauth_required':'invalid_response');}
          const raw=body as {error?:{code?:unknown}};
          const code=path==='/me/account'&&raw?.error?.code==='AUTH_IDEMPOTENCY_CONFLICT'
            ? 'deletion_request_conflict'
            : typeof raw?.error?.code==='string'&&Object.hasOwn(serverErrors,raw.error.code)?serverErrors[raw.error.code]:undefined;
          throw new AuthClientError(code??(response.status===401?'reauth_required':response.status===400?'invalid_request':'unavailable'));
        }
        if(schema===null) {if(response.status!==(expectedStatus??204))throw new AuthClientError('invalid_response');return undefined as T;}
        const expected=expectedStatus??(path.endsWith('/request')?202:path==='/auth/email/register/confirm'?201:200);
        if(response.status!==expected)throw new AuthClientError('invalid_response');
        const body=await json(response);
        try {return schema.parse(path==='/account/session'?body:(body as {data?:unknown})?.data);} catch {throw new AuthClientError('invalid_response');}
      })();
      work.catch(()=>{});
      return await Promise.race([work,cancelled]);
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.abort();}
  }
  const parse=<T>(schema:{parse:(input:unknown)=>T},input:unknown)=>{try{return schema.parse(input);}catch{throw new AuthClientError('invalid_request');}};
  return {
    endpoint,
    startApple:(input:AppleLoginStartRequest,signal?:AbortSignal)=>request('/auth/apple/start','POST',appleLoginStartResponseSchema,parse(appleLoginStartRequestSchema,input),signal),
    completeApple:(input:AppleLoginCompleteRequest,key:string,signal?:AbortSignal)=>{
      if(!key)throw new AuthClientError('invalid_request');
      return request('/auth/apple/complete','POST',sessionTokensSchema,parse(appleLoginCompleteRequestSchema,input),signal,key);
    },
    // Apple-only accounts have no password to re-verify with, so reauth runs the same provider
    // flow bound to the caller's current session and returns one action grant instead of a session.
    startAppleReauth:(token:string,input:{action:AppleReauthAction;platform:'ios';installationId:string;deviceLabel?:string},signal?:AbortSignal)=>{
      // purpose is fixed by this method; a caller-supplied purpose is not a supported field and
      // must not be silently replaced, so it is rejected before the strict schema sees it.
      if(input!==null&&typeof input==='object'&&'purpose' in input)throw new AuthClientError('invalid_request');
      return request('/auth/apple/start','POST',appleLoginStartResponseSchema,parse(appleLoginStartRequestSchema,{...input,purpose:'reauth'}),signal,undefined,accessToken(token),200);
    },
    completeAppleReauth:(token:string,input:AppleLoginCompleteRequest,key:string,signal?:AbortSignal)=>{
      if(!key)throw new AuthClientError('invalid_request');
      return request('/auth/apple/complete','POST',appleReauthGrantSchema,parse(appleLoginCompleteRequestSchema,input),signal,key,accessToken(token),200);
    },
    providers:(signal?:AbortSignal)=>request('/auth/providers','GET',authProvidersSchema,undefined,signal),
    // Whether this deployment has released a terms and privacy pair for registration, and which
    // versions they are. It is a public read with no credential and no cache: the caller decides
    // when to refresh, and nothing here holds a secret.
    registrationPolicy:(signal?:AbortSignal):Promise<RegistrationPolicy>=>request('/auth/registration-policy','GET',registrationPolicySchema,undefined,signal),
    requestRegistration:(input:EmailChallengeRequest,key:string,signal?:AbortSignal)=>request('/auth/email/register/request','POST',emailChallengeResponseSchema,parse(emailChallengeRequestSchema,input),signal,key),
    register:(input:EmailRegisterConfirm,key:string,signal?:AbortSignal)=>request('/auth/email/register/confirm','POST',sessionTokensSchema,parse(emailRegisterConfirmSchema,input),signal,key),
    login:(input:EmailLogin,signal?:AbortSignal)=>request('/auth/email/login','POST',sessionTokensSchema,parse(emailLoginSchema,input),signal),
    requestReset:(input:EmailChallengeRequest,key:string,signal?:AbortSignal)=>request('/auth/email/password/reset/request','POST',emailChallengeResponseSchema,parse(emailChallengeRequestSchema,input),signal,key),
    confirmReset:(input:EmailPasswordResetConfirm,key:string,signal?:AbortSignal)=>request<void>('/auth/email/password/reset/confirm','POST',null,parse(emailPasswordResetConfirmSchema,input),signal,key),
    // Adding the first login email to an existing subject keeps the current session bearer and
    // spends a fresh link-identity grant; the confirm sets the first password and returns no body.
    requestEmailLink:(token:string,input:EmailLinkRequest,key:string,signal?:AbortSignal)=>request('/me/email/link/request','POST',emailChallengeResponseSchema,parse(emailLinkRequestSchema,input),signal,key,accessToken(token),202),
    confirmEmailLink:(token:string,input:EmailLinkConfirm,key:string,signal?:AbortSignal)=>request<void>('/me/email/link/confirm','POST',null,parse(emailLinkConfirmSchema,input),signal,key,accessToken(token),204),
    reauthPassword:(token:string,password:string,signal?:AbortSignal,action:ReauthAction='change-password')=>request('/auth/reauth/password','POST',passwordReauthResponseSchema,parse(passwordReauthSchema,{password,action}),signal,undefined,token),
    changePassword:(token:string,input:{newPassword:string;reauthGrant:string},key:string,signal?:AbortSignal)=>request<void>('/me/password/change','POST',null,parse(passwordChangeSchema,input),signal,key,token),
    refresh:(refreshToken:string,rotationId:string,signal?:AbortSignal)=>request('/auth/refresh','POST',sessionTokensSchema,parse(refreshRequestSchema,{refreshToken,rotationId}),signal),
    logout:(refreshToken:string,signal?:AbortSignal)=>request<void>('/auth/logout','POST',null,{refreshToken:parse(refreshTokenSchema,refreshToken)},signal),
    session:(token:string,signal?:AbortSignal)=>{
      if(!/^[A-Za-z0-9._-]{1,4096}$/.test(token))throw new AuthClientError('invalid_request');
      return request('/account/session','GET',verifiedAccountSessionSchema,undefined,signal,undefined,token);
    },
    loginMethods:(token:string,signal?:AbortSignal)=>request('/me/identities','GET',accountLoginMethodsSchema,undefined,signal,undefined,accessToken(token)),
    deviceSessions:(token:string,cursor?:string,signal?:AbortSignal)=>{
      if(cursor!==undefined&&!/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(cursor))throw new AuthClientError('invalid_request');
      return request(`/me/sessions?limit=25${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,'GET',accountDeviceSessionsPageSchema,undefined,signal,undefined,token);
    },
    revokeDeviceSession:(token:string,sessionId:string,reauthGrant?:string,signal?:AbortSignal)=>{
      if(!/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(sessionId))throw new AuthClientError('invalid_request');
      return request(`/me/sessions/${sessionId}`,'DELETE',null,reauthGrant?{reauthGrant}:undefined,signal,undefined,token);
    },
    revokeAllDeviceSessions:(token:string,reauthGrant:string,signal?:AbortSignal)=>request('/me/sessions/revoke-all','POST',null,{reauthGrant:refreshTokenSchema.parse(reauthGrant)},signal,undefined,token),
    // `DELETE /me/identities/{identityId}` removes one login method by the same strict `email:`
    // handle `loginMethods()` returned; an apple handle, a bare row id or a differently cased value
    // is refused here so it can never be routed into the email removal path. The proof is a
    // single-use, action-bound `unlink-identity` grant that the server spends inside the removal
    // transaction, so this call carries it exactly once: there is no idempotency key and no repeat,
    // because an unknown outcome may already have removed the method and revoked every session.
    unlinkIdentity:(token:string,identityId:string,reauthGrant:string,signal?:AbortSignal)=>{
      if(parseEmailLoginMethodId(identityId)===null)throw new AuthClientError('invalid_request');
      return request(`/me/identities/${identityId}`,'DELETE',null,parse(unlinkIdentityRequestSchema,{reauthGrant}),signal,undefined,accessToken(token),204);
    },
    // Account deletion splits into one submission and one progress read, and they carry different
    // credentials on purpose. The progress read holds no bearer at all: the receipt secret is the
    // whole proof, it travels in the body and it reads that one job, so it can never be mistaken for
    // a session or leaked through a URL. The submission spends one action-bound `delete-account`
    // grant together with the explicit confirmation and the caller's declared family/child
    // disposition, and it also requires an explicit UUID `Idempotency-Key` held by the caller. That
    // key is what makes a retry safe: a submission whose response was lost has to be repeated with
    // the key it was sent with, because a freshly generated key cannot recover the first job's
    // receipt. So this method never mints a key, never rotates one and never retries the
    // DELETE by itself; reuse of the caller's key stays the caller's decision. The server
    // deliberately keeps the destructive route closed until family disposition, cleanup and
    // independent recovery are ready, so this method is prepared surface, not a product action a
    // screen may present as available.
    deletionImpact:(token:string,signal?:AbortSignal)=>request('/me/account/deletion/impact','GET',accountDeletionImpactSchema,undefined,signal,undefined,accessToken(token)),
    deletionRecipients:(token:string,familyId:string,signal?:AbortSignal)=>{
      if(!/^[a-f0-9-]{36}$/i.test(familyId))throw new AuthClientError('invalid_request');
      return request(`/families/${familyId}/deletion-recipients`,'GET',deletionRecipientsSchema,undefined,signal,undefined,accessToken(token));
    },
    familyResponsibilities:(token:string,signal?:AbortSignal)=>request('/me/family-responsibilities','GET',familyResponsibilityListSchema,undefined,signal,undefined,accessToken(token)),
    frozenFamilyPreview:(token:string,familyId:string,signal?:AbortSignal)=>{
      if(!/^[a-f0-9-]{36}$/i.test(familyId))throw new AuthClientError('invalid_request');
      return request(`/families/${familyId}/frozen-review/preview`,'GET',frozenFamilyReviewScopeSchema,undefined,signal,undefined,accessToken(token));
    },
    acceptFrozenFamily:(token:string,familyId:string,input:FamilyManagementAcceptanceRequest,signal?:AbortSignal)=>{
      if(!/^[a-f0-9-]{36}$/i.test(familyId))throw new AuthClientError('invalid_request');
      return request(`/families/${familyId}/frozen-review/acceptance`,'POST',frozenFamilyReviewAcceptanceReceiptSchema,parse(familyManagementAcceptanceRequestSchema,input),signal,undefined,accessToken(token),201);
    },
    familyManagementPreview:(token:string,familyId:string,signal?:AbortSignal)=>{
      if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(familyId))
        throw new AuthClientError('invalid_request');
      return request(`/families/${familyId}/management-acceptance/preview`,'GET',
        familyManagementAcceptancePreviewSchema,undefined,signal,undefined,accessToken(token));
    },
    acceptFamilyManagement:(token:string,familyId:string,input:FamilyManagementAcceptanceRequest,signal?:AbortSignal)=>{
      if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(familyId))
        throw new AuthClientError('invalid_request');
      return request(`/families/${familyId}/management-acceptance`,'POST',
        familyManagementAcceptanceReceiptSchema,parse(familyManagementAcceptanceRequestSchema,input),
        signal,undefined,accessToken(token),201);
    },
    deletionStatus:(input:DeletionStatusRequest,signal?:AbortSignal)=>request('/account/deletion/status','POST',deletionStatusSchema,parse(deletionStatusRequestSchema,input),signal),
    submitDeletion:(token:string,input:AccountDeletionRequest,key:string,signal?:AbortSignal)=>{
      if(!key)throw new AuthClientError('invalid_request');
      return request('/me/account','DELETE',deletionReceiptSchema,parse(accountDeletionRequestSchema,input),signal,key,accessToken(token),202);
    },
  };
}
export type AuthApiClient=ReturnType<typeof createAuthApiClient>;
