import {createHmac} from 'node:crypto';
import {z} from 'zod';
import {appleLoginCompleteRequestSchema} from '@siyue/contracts';
import {AppleFlowError,type createAppleFlowStorage} from './flow-storage.js';
import {AppleIdentityError,type createAppleIdentityVerifier} from './identity.js';
import {AppleExchangeError,type createAppleCodeExchange} from './exchange.js';

export class ApplePreparationError extends Error {
 constructor(readonly code:'invalid_request'|'unavailable'){super(code);}
}
/** Server-internal preparation, NOT an HTTP response or a completed Siyue login.
 * Provider credentials stay in this service boundary until atomic identity/session completion.
 */
export function createAppleLoginPreparation(options:{requestPepper:Buffer;storage:ReturnType<typeof createAppleFlowStorage>;
 verify:ReturnType<typeof createAppleIdentityVerifier>;exchange:Awaited<ReturnType<typeof createAppleCodeExchange>>;clock?:()=>Date}){
 if(options.requestPepper.length!==32)throw new Error('invalid_pepper');
 const pepper=Buffer.from(options.requestPepper);
 const clock=options.clock??(()=>new Date());
 function request(value:unknown,key:string){
  const parsed=appleLoginCompleteRequestSchema.safeParse(value),idempotency=z.uuid().safeParse(key);
  if(!parsed.success||!idempotency.success)throw new ApplePreparationError('invalid_request');
  const input=parsed.data;
  const requestHash=createHmac('sha256',pepper).update(JSON.stringify({purpose:'apple-login',idempotencyKey:idempotency.data.toLowerCase(),request:input})).digest('hex');
  return {input,requestHash,proof:{flowId:input.flowId,transactionSecret:input.transactionSecret,state:input.state}};
 }
 return {
  request,
  start:options.storage.start,
  async prepare(value:unknown,key:string){
   const {input,proof,requestHash}=request(value,key);
   try{
    // Do not fetch provider keys for someone who cannot prove ownership of this flow.
    const context=await options.storage.inspect(proof);
    const identity=await options.verify(input.identityToken,context.nonceHash,clock());
    if(identity.clientId!==context.clientId)throw new AppleIdentityError('invalid_identity');
    const claim=await options.storage.claim(proof,identity.subject,requestHash);
    if(claim.kind==='verified')return {...claim,requestHash,...input.fullName?{fullName:input.fullName}:{}};
    try{
     const result=await options.exchange({authorizationCode:input.authorizationCode,expectedNonceHash:context.nonceHash,expectedSubject:identity.subject});
     await options.storage.recordVerified(input.flowId,claim.leaseId,result);
     // Return only a read-back of the durable, authenticated result; never an uncommitted exchange.
     const durable=await options.storage.claim(proof,identity.subject,requestHash);
     if(durable.kind!=='verified')throw new ApplePreparationError('unavailable');
     return {...durable,requestHash,...input.fullName?{fullName:input.fullName}:{}};
    }catch(error){
     // A committed verified result survives this no-op; a lost DB connection leaves a bounded lease.
     try{await options.storage.fail(input.flowId,claim.leaseId);}catch{/* The expired lease still cannot be reused. */}
     throw error;
    }
   }catch(error){
    if(error instanceof AppleFlowError||error instanceof AppleIdentityError||error instanceof AppleExchangeError||error instanceof ApplePreparationError)throw error;
    throw new ApplePreparationError('unavailable');
   }
  },
 };
}
