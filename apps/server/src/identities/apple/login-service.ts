import type {PoolClient} from 'pg';
import {appleLoginStartRequestSchema,appleReauthActionSchema} from '@siyue/contracts';
import {AppleFlowError,type AppleSessionProof} from './flow-storage.js';
import type {createAppleLoginPreparation} from './prepare-login.js';
import type {createAppleFlowStorage} from './flow-storage.js';
import type {createAppleIdentityStorage} from './identity-storage.js';
import type {SessionService} from '../../modules/auth/sessions.js';

/** Server login orchestration. HTTP limits/audit and trusted provider configuration
 * remain the host's responsibility. Only Siyue session tokens leave this boundary.
 */
export function createAppleLoginService(options:{preparation:ReturnType<typeof createAppleLoginPreparation>;
 storage:ReturnType<typeof createAppleFlowStorage>;identities:ReturnType<typeof createAppleIdentityStorage>;sessions:SessionService}){
 /** The flow row, not the request, decides whether a session proof is required. The bearer
  * is verified inside the flow's own transaction so revocation cannot race the decision. */
 const sessionProof=(bearer:string|undefined):AppleSessionProof|undefined=>bearer===undefined?undefined:{bearer,
  verify:async(client,value)=>{const verified=await options.sessions.verifyForMutation(client,value);
   return {sessionId:verified.sessionId,subjectId:verified.subjectId};}};
 return {
  async start(value:unknown,bearer?:string){
   const input=appleLoginStartRequestSchema.parse(value);
   // login stays session-free; reauth binds the caller's verified current session.
   if(input.purpose==='login'){if(bearer!==undefined)throw new AppleFlowError('invalid_request');return options.storage.start(input);}
   if(bearer===undefined)throw new AppleFlowError('invalid_request');
   const verified=await options.sessions.verify(bearer);
   return options.storage.start(input,{sessionId:verified.sessionId});
  },
  async complete(value:unknown,key:string,bearer?:string,onCompleted?:(client:PoolClient,completion:{subjectId:string;sessionId:string})=>Promise<void>){
   const {input,proof,requestHash}=options.preparation.request(value,key),session=sessionProof(bearer);
   const cached=await options.storage.recover(proof,requestHash,session);if(cached)return cached;
   try{await options.preparation.prepare(value,key);}catch(error){
    // Another request can commit after our initial recovery read, including while
    // we verify the client token. Recover that result without another exchange.
    const concurrent=await options.storage.recover(proof,requestHash,session);if(concurrent)return concurrent;
    throw error;
   }
   return options.storage.complete(proof,requestHash,async(client,result,flow,binding)=>{
    if(flow.purpose==='reauth'){
     // The flow row owned the action the caller chose at start; completion can neither add
     // nor widen it, and the issued grant is usable for exactly that action only.
     const action=appleReauthActionSchema.safeParse(flow.action);
     if(!action.success)throw new AppleFlowError('invalid_request');
     // The Apple identity must already be active and bound to the same subject; this path
     // never creates an identity or session, and issues one session-bound action grant.
     const linked=await options.identities.requireLinked(client,result,binding!.subjectId);
     const grant=await options.sessions.issueReauth(client,binding!.sessionId,action.data);
     await onCompleted?.(client,{subjectId:linked.subjectId,sessionId:binding!.sessionId});
     return grant;
    }
    const name=input.fullName?[input.fullName.givenName,input.fullName.middleName,input.fullName.familyName].filter(Boolean).join(' ').trim().slice(0,200):undefined;
    const identity=await options.identities.resolve(client,result,name||undefined);
    const tokens=await options.sessions.issue(client,identity.subjectId,flow.installationId,'apple');
    await client.query("UPDATE siyue.auth_sessions SET platform='ios',device_label=$2 WHERE id=$1",[tokens.session.sessionId,flow.deviceLabel??null]);
    await onCompleted?.(client,{subjectId:tokens.session.subjectId,sessionId:tokens.session.sessionId});
    return tokens;
   },session);
  },
 };
}
