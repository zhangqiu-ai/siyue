import {appleLoginCompleteRequestSchema,type AppleFullName,type AppleLoginCompleteRequest,type SessionTokens} from '@siyue/contracts';
import {AuthClientError,type AuthApiClient} from './auth-api-client.js';
export type AppleAuthorize=(input:{nonce:string;state:string;signal:AbortSignal})=>Promise<{identityToken:string;authorizationCode:string;state:string;fullName?:AppleFullName}>;
const retryable=new Set(['network','timeout','unavailable','busy','rate_limited','invalid_response']);
/** One native authorization attempt. Secrets live only in this short-lived closure;
 * the controller owns account-generation fences and secure session persistence.
 */
export function createAppleSignInAttempt(api:AuthApiClient,newId:()=>string,authorize:AppleAuthorize,now=Date.now){
 let pending:{input:AppleLoginCompleteRequest;key:string;until:number}|undefined;
 let active=false,started=false;
 let expiryTimer:ReturnType<typeof setTimeout>|undefined;
 const clear=()=>{pending=undefined;if(expiryTimer!==undefined)clearTimeout(expiryTimer);expiryTimer=undefined;};
 return {
  canRetry:()=>{if(pending&&pending.until<=now())clear();return !!pending;},
  clear,
  async run(installationId:string,signal:AbortSignal):Promise<SessionTokens>{
   if(active)throw new AuthClientError('busy');
   if(signal.aborted)throw new AuthClientError('cancelled');
   active=true;
   const check=()=>{if(signal.aborted)throw new AuthClientError('cancelled');};
   try{
    if(!pending){
     if(started)throw new AuthClientError('apple_restart_required');started=true;
     const flow=await api.startApple({purpose:'login',platform:'ios',installationId},signal);check();
     if(Date.parse(flow.expiresAt)<=now())throw new AuthClientError('apple_restart_required');
     const result=await authorize({nonce:flow.nonce,state:flow.state,signal});check();
     if(result.state!==flow.state||Date.parse(flow.expiresAt)<=now())throw new AuthClientError('apple_restart_required');
     let input:AppleLoginCompleteRequest;
     try{input=appleLoginCompleteRequestSchema.parse({flowId:flow.flowId,transactionSecret:flow.transactionSecret,state:result.state,identityToken:result.identityToken,authorizationCode:result.authorizationCode,...result.fullName?{fullName:result.fullName}:{}});}catch{throw new AuthClientError('apple_restart_required');}
     pending={input,key:newId(),until:Math.min(Date.parse(flow.expiresAt)+60000,now()+360000)};
     expiryTimer=setTimeout(clear,Math.max(0,pending.until-now()));
    }
    if(pending.until<=now())throw new AuthClientError('apple_restart_required');
    check();
    // The API has its own bounded deadline. Do not abort a sent completion:
    // Return issued tokens even if the host aborts while this transport finishes:
    // the controller must see them to revoke a late, abandoned session.
    const tokens=await api.completeApple(pending.input,pending.key);clear();return tokens;
   }catch(error){
    if(!(error instanceof AuthClientError)||!retryable.has(error.code)||signal.aborted)clear();
    throw error;
   }finally{active=false;}
  },
 };
}
