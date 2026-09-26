import { emailAddressSchema,accountPasswordSchema,newAccountPasswordSchema,type AuthClientErrorCode,type EmailChallengeResponse,type EmailChallengeRequest,type EmailPasswordResetConfirm } from '@siyue/contracts';
import { AuthClientError } from './auth-api-client.js';

export interface EmailEntryActions {
  login(input:{email:string;password:string}):Promise<void>;
  requestReset(input:EmailChallengeRequest,key:string):Promise<EmailChallengeResponse>;
  confirmReset(input:EmailPasswordResetConfirm,key:string):Promise<unknown>;
}
type Fields={email:string;password:string;repeatPassword:string;code:string};
export type EmailEntryState=Fields&{mode:'login'|'reset-request'|'reset-confirm'|'reset-complete';busy:boolean;retryPending:boolean;
  error:AuthClientErrorCode|'email_invalid'|'password_mismatch'|'code_invalid'|null;retryAt:number;resendAt:number;expiresAt:number|null;};
type Pending={kind:'request';key:string;input:EmailChallengeRequest}|{kind:'confirm';key:string;input:EmailPasswordResetConfirm};
/** In-memory form intent. Never persist challenges, OTPs or passwords in a UI store. */
export function createEmailEntry(actions:EmailEntryActions,newId:()=>string,now=Date.now) {
  let state:EmailEntryState={mode:'login',email:'',password:'',repeatPassword:'',code:'',busy:false,retryPending:false,error:null,retryAt:0,resendAt:0,expiresAt:null};
  let proof:EmailChallengeResponse|null=null,pending:Pending|null=null,disposed=false;
  const listeners=new Set<()=>void>();
  function update(patch:Partial<EmailEntryState>){if(disposed)return;state={...state,...patch};for(const listener of listeners)listener();}
  function clearSecrets(){proof=null;pending=null;update({password:'',repeatPassword:'',code:'',retryPending:false,expiresAt:null});}
  async function execute(locale:'zh-CN'|'en-US',resend=false) {
    if(disposed||state.busy||now()<state.retryAt||resend&&now()<state.resendAt)return;
    if(!pending) {
      if(!emailAddressSchema.safeParse(state.email).success){update({error:'email_invalid'});return;}
      if(state.mode==='login'||state.mode==='reset-confirm'&&!resend) {
        if(!(state.mode==='login'?accountPasswordSchema:newAccountPasswordSchema).safeParse(state.password).success){update({error:'password_policy'});return;}
      }
      if(state.mode==='reset-confirm'&&!resend) {
        if(state.password!==state.repeatPassword){update({error:'password_mismatch'});return;}
        if(!/^\d{6}$/.test(state.code)){update({error:'code_invalid'});return;}
        if(!proof||Date.parse(proof.expiresAt)<=now()){update({error:'challenge_invalid'});return;}
        pending={kind:'confirm',key:newId(),input:{challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:state.code,newPassword:state.password}};
      }else if(state.mode==='reset-request'||resend)pending={kind:'request',key:newId(),input:{email:state.email,locale}};
      else if(state.mode!=='login')return;
    }
    const own=pending;update({busy:true,error:null});
    try {
      if(!own)await actions.login({email:state.email,password:state.password});
      else if(own.kind==='request') {
        const response=await actions.requestReset(own.input,own.key);if(disposed)return;
        proof=response;pending=null;
        update({mode:'reset-confirm',code:'',error:null,retryPending:false,expiresAt:Date.parse(response.expiresAt),resendAt:now()+response.resendAfterSeconds*1000});
      }else {
        await actions.confirmReset(own.input,own.key);if(disposed)return;
        clearSecrets();update({mode:'reset-complete'});
      }
      if(!own)clearSecrets();
    }catch(error) {
      if(disposed)return;
      const safe=error instanceof AuthClientError?error:new AuthClientError('unavailable');
      const uncertain=!!own&&['network','timeout','unavailable'].includes(safe.code);
      if(!uncertain)pending=null;
      update({error:safe.code,retryPending:uncertain,retryAt:safe.code==='rate_limited'?now()+Math.max(1,safe.retryAfterSeconds)*1000:0});
    }finally{update({busy:false});}
  }
  return {
    getState:()=>state,
    subscribe(fn:()=>void){listeners.add(fn);return()=>{listeners.delete(fn);};},
    set(field:keyof Fields,value:string){if(!disposed&&!state.busy&&!state.retryPending)update({[field]:value.slice(0,field==='email'?254:field==='code'?6:256),error:null});},
    navigate(mode:'login'|'reset-request'){if(disposed||state.busy)return false;clearSecrets();update({mode,error:null,retryAt:0,resendAt:0});return true;},
    submit:(locale:'zh-CN'|'en-US')=>execute(locale),
    resend:(locale:'zh-CN'|'en-US')=>execute(locale,true),
    dispose(){disposed=true;proof=null;pending=null;state={...state,email:'',password:'',repeatPassword:'',code:''};listeners.clear();},
  };
}
