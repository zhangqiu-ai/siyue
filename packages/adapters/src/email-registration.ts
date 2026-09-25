import {emailAddressSchema,accountPasswordSchema,registrationPolicySchema,
  type AuthClientErrorCode,type EmailChallengeResponse,type EmailChallengeRequest,type EmailRegisterConfirm,type RegistrationPolicy} from '@siyue/contracts';
import {AuthClientError} from './auth-api-client.js';

/** What a registration screen may call. The shared session controller owns the secure recovery
 *  record, the single refresh chain and the account generation, so this adapter only ever asks it
 *  to `register()`: no vault, no token and no storage path is reachable from here. */
export interface EmailRegistrationActions {
  registrationPolicy(signal?:AbortSignal):Promise<RegistrationPolicy>;
  requestRegistration(input:EmailChallengeRequest,key:string,signal?:AbortSignal):Promise<EmailChallengeResponse>;
  register(input:Omit<EmailRegisterConfirm,'installationId'|'platform'>,key:string,signal?:AbortSignal):Promise<unknown>;
}
/** The shared session controller as this host exposes it. Only the platform is host specific, and a
 *  screen never chooses it. */
export interface EmailRegistrationHost {
  registrationPolicy(signal?:AbortSignal):Promise<RegistrationPolicy>;
  requestRegistration(input:EmailChallengeRequest,key:string):Promise<EmailChallengeResponse>;
  register(input:Omit<EmailRegisterConfirm,'installationId'>,key:string):Promise<unknown>;
}
/** Binds one installation's platform once, so every host hands the session controller the same strict
 *  confirmation payload and a screen cannot claim another platform. */
export function emailRegistrationActions(host:EmailRegistrationHost,platform:'ios'|'android'|'desktop'):EmailRegistrationActions {
  return {registrationPolicy:signal=>host.registrationPolicy(signal),
    requestRegistration:(input,key)=>host.requestRegistration(input,key),
    register:(input,key)=>host.register({...input,platform},key)};
}
type Fields={email:string;code:string;password:string;repeatPassword:string;displayName:string};
/** Server outcomes plus the refusals this screen settles locally before anything is sent: an
 *  unaccepted consent and a registration policy that is not released are never network calls. */
export type EmailRegistrationError=AuthClientErrorCode|'email_invalid'|'password_policy'|'password_mismatch'|'code_invalid'|'consent_required'|'policy_unavailable';
export type EmailRegistrationState=Fields&{step:'email'|'verify'|'complete';accepted:boolean;
  policy:RegistrationPolicy|null;policyError:AuthClientErrorCode|null;loadingPolicy:boolean;
  busy:boolean;retryPending:boolean;error:EmailRegistrationError|null;retryAt:number;resendAt:number;expiresAt:number|null;};
type Pending={kind:'request';key:string;input:EmailChallengeRequest}|
  {kind:'confirm';key:string;input:Omit<EmailRegisterConfirm,'installationId'|'platform'>};
/** A lost, timed out or still-running operation keeps its own request key, because the server may
 *  already have accepted it; a refusal the caller must correct does not. */
const retryable=new Set<AuthClientErrorCode>(['network','timeout','unavailable','busy']);
/** A decided refusal this screen must act on rather than repeat: the released pair changed under the
 *  attempt, or the deployment closed sign-up. Neither can be retried into success with the same key and
 *  versions, so the cached policy and the consent given for it are dropped and read again. */
const settled=new Set<AuthClientErrorCode>(['policy_changed','registration_closed']);
const fieldLimits={email:254,code:6,password:256,repeatPassword:256,displayName:100} as const;

/**
 * In-memory registration intent for one screen: request a code, prove control of the address, then
 * confirm with the versions the server itself published. Nothing here is persisted or logged — the
 * code, the password and the challenge proof live in this closure, and `dispose()` clears them. The
 * confirmed terms and privacy versions are assembled from the fetched policy, so a screen cannot
 * substitute a remembered or hard-coded version.
 */
export function createEmailRegistration(actions:EmailRegistrationActions,newId:()=>string,now=Date.now) {
  let state:EmailRegistrationState={step:'email',email:'',code:'',password:'',repeatPassword:'',displayName:'',accepted:false,
    policy:null,policyError:null,loadingPolicy:false,busy:false,retryPending:false,error:null,retryAt:0,resendAt:0,expiresAt:null};
  let proof:EmailChallengeResponse|null=null,pending:Pending|null=null,disposed=false;
  const listeners=new Set<()=>void>();
  function update(patch:Partial<EmailRegistrationState>){if(disposed)return;state={...state,...patch};for(const listener of listeners)listener();}
  /** The two released versions, or nothing: a half published policy can never be confirmed. */
  function versions(){const policy=state.policy;
    return policy?.enabled&&policy.terms&&policy.privacy?{termsVersion:policy.terms.version,privacyVersion:policy.privacy.version}:null;}
  function clearSecrets(){proof=null;pending=null;update({code:'',password:'',repeatPassword:'',displayName:'',accepted:false,retryPending:false,expiresAt:null});}
  async function loadPolicy():Promise<RegistrationPolicy|null> {
    if(disposed)return null;
    update({loadingPolicy:true});
    try {
      const policy=registrationPolicySchema.safeParse(await actions.registrationPolicy());
      if(disposed)return null;
      if(!policy.success){update({policy:null,policyError:'invalid_response'});return null;}
      update({policy:policy.data,policyError:null});
      return policy.data;
    } catch(error) {
      if(disposed)return null;
      const safe=error instanceof AuthClientError?error:new AuthClientError('unavailable');
      update({policy:null,policyError:safe.code});
      return null;
    } finally {update({loadingPolicy:false});}
  }
  /** Reads the released policy when it is still unknown, so a screen that forgot to load it cannot
   *  register against an unpublished or unreachable policy. */
  async function agreedVersions(){if(!versions())await loadPolicy();return disposed?null:versions();}
  async function confirmIntent():Promise<Pending|null> {
    // Consent is checked before any read or write: without it no policy is fetched and no request
    // is made, exactly as the released documents require.
    if(state.accepted!==true){update({error:'consent_required'});return null;}
    const agreed=await agreedVersions();
    if(!agreed){update({error:'policy_unavailable'});return null;}
    if(!accountPasswordSchema.safeParse(state.password).success){update({error:'password_policy'});return null;}
    if(state.password!==state.repeatPassword){update({error:'password_mismatch'});return null;}
    if(!/^\d{6}$/.test(state.code)){update({error:'code_invalid'});return null;}
    if(!proof||Date.parse(proof.expiresAt)<=now()){update({error:'challenge_invalid'});return null;}
    const displayName=state.displayName.trim();
    return {kind:'confirm',key:newId(),input:{challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:state.code,
      password:state.password,...(displayName.length>0?{displayName}:{}),...agreed}};
  }
  async function dispatch(own:Pending):Promise<void> {
    update({busy:true,error:null});
    try {
      if(own.kind==='request') {
        const response=await actions.requestRegistration(own.input,own.key);
        if(disposed)return;
        proof=response;pending=null;
        update({step:'verify',code:'',error:null,retryPending:false,expiresAt:Date.parse(response.expiresAt),
          resendAt:now()+Math.max(0,response.resendAfterSeconds)*1000});
      } else {
        await actions.register(own.input,own.key);
        if(disposed)return;
        clearSecrets();update({step:'complete',error:null});
      }
    } catch(error) {
      if(disposed)return;
      const safe=error instanceof AuthClientError?error:new AuthClientError('unavailable');
      const keep=retryable.has(safe.code);
      if(!keep)pending=null;
      // The versions this payload carried belong to documents that are no longer current, so the screen
      // has to read the released pair again and ask for consent before any further attempt.
      update({error:safe.code,retryPending:keep,
        retryAt:safe.code==='rate_limited'?now()+Math.max(1,safe.retryAfterSeconds)*1000:0,
        ...(settled.has(safe.code)?{policy:null,policyError:null,accepted:false}:{})});
    } finally {update({busy:false});}
  }
  async function request(locale:'zh-CN'|'en-US',resend=false):Promise<void> {
    if(disposed||state.busy||pending||state.step==='complete')return;
    if(now()<state.retryAt||(resend&&now()<state.resendAt))return;
    if(resend&&state.step!=='verify')return;
    if(!emailAddressSchema.safeParse(state.email).success){update({error:'email_invalid'});return;}
    if(!await agreedVersions()){update({error:'policy_unavailable'});return;}
    pending={kind:'request',key:newId(),input:{email:state.email,locale}};
    await dispatch(pending);
  }
  async function confirm():Promise<void> {
    if(disposed||state.busy||pending||state.step!=='verify'||now()<state.retryAt)return;
    const intent=await confirmIntent();
    if(!intent)return;
    pending=intent;
    await dispatch(pending);
  }
  return {
    getState:()=>state,
    subscribe(listener:()=>void){listeners.add(listener);return ()=>{listeners.delete(listener);};},
    /** A locked form cannot drift from the payload its pending key already covers. */
    set(field:keyof Fields,value:string){if(disposed||state.busy||state.retryPending)return;
      update({[field]:value.slice(0,fieldLimits[field]),error:null});},
    setConsent(accepted:boolean){if(disposed||state.busy||state.retryPending)return;update({accepted:accepted===true,error:null});},
    loadPolicy,
    sendCode:(locale:'zh-CN'|'en-US')=>request(locale),
    resend:(locale:'zh-CN'|'en-US')=>request(locale,true),
    confirm,
    /** Repeats the one operation already started with its own key and payload, so a lost answer, a
     *  timeout or a switch of screens cannot create a second account. */
    async retry():Promise<void> {
      const own=pending;
      if(disposed||state.busy||!state.retryPending||!own||now()<state.retryAt)return;
      await dispatch(own);
    },
    hasPendingRetry:()=>pending!==null&&state.retryPending,
    back(){if(disposed||state.busy||pending)return false;
      proof=null;update({step:'email',code:'',error:null,expiresAt:null,resendAt:0});return true;},
    dispose(){disposed=true;proof=null;pending=null;
      state={...state,code:'',password:'',repeatPassword:'',displayName:'',accepted:false,retryPending:false};listeners.clear();},
  };
}
export type EmailRegistrationController=ReturnType<typeof createEmailRegistration>;
