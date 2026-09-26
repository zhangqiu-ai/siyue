import type {FastifyInstance,FastifyReply} from 'fastify';
import {z} from 'zod';
import {appleLoginStartRequestSchema,appleLoginCompleteRequestSchema} from '@siyue/contracts';
import {AppleFlowError} from './flow-storage.js';
import {AppleIdentityError} from './identity.js';
import {AppleIdentityStorageError} from './identity-storage.js';
import {AppleExchangeError} from './exchange.js';
import {ApplePreparationError} from './prepare-login.js';
import {AuthError} from '../../modules/auth/sessions.js';
import type {createAppleLoginService} from './login-service.js';
import type {AppleRequestGate} from './request-gate.js';
export type AppleRoutes={service:ReturnType<typeof createAppleLoginService>;gate:AppleRequestGate};
export function registerAppleRoutes(app:FastifyInstance,{service,gate}:AppleRoutes){
 let active=0;
 const fail=(reply:FastifyReply,requestId:string,code:string,status:number)=>{
  if(status===429)reply.header('Retry-After','60');
  return reply.code(status).send({error:{code,messageKey:`auth.errors.${code}`,retryable:status===429||status>=500||code==='AUTH_IN_PROGRESS'},meta:{requestId}});
 };
 for(const operation of ['start','complete'] as const)app.post(`/v1/auth/apple/${operation}`,{bodyLimit:operation==='start'?8192:65536},async(request,reply)=>{
  if(request.raw.url?.includes('?'))return fail(reply,request.id,'AUTH_INVALID_REQUEST',400);
  // login must not carry a session; reauth must. The flow row owns that decision, so the
  // header is only admitted here in its documented single-bearer shape and forwarded as-is.
  const authorization=request.headers.authorization;
  const authorizationHeaders=request.raw.rawHeaders.filter((value,index)=>index%2===0&&value.toLowerCase()==='authorization').length;
  if(authorizationHeaders>1||(authorization!==undefined&&!/^Bearer [A-Za-z0-9._-]{1,4096}$/.test(authorization)))return fail(reply,request.id,'AUTH_INVALID_REQUEST',400);
  const bearer=authorization?.slice(7);
  const duplicate=request.raw.rawHeaders.filter((value,index)=>index%2===0&&value.toLowerCase()==='idempotency-key').length>1;
  const key=request.headers['idempotency-key'];
  if(duplicate)return fail(reply,request.id,'AUTH_INVALID_REQUEST',400);
  if(operation==='complete'&&!z.uuid().safeParse(key).success)return fail(reply,request.id,'AUTH_IDEMPOTENCY_KEY_REQUIRED',400);
  if(active>=4)return fail(reply,request.id,'AUTH_BUSY',429);
  active++;
  try{
   const flowId=operation==='complete'?z.object({flowId:z.uuid()}).safeParse(request.body):undefined;
   if(!await gate.admit(operation,request.ip,request.id,flowId?.success?flowId.data.flowId:undefined))return fail(reply,request.id,'AUTH_RATE_LIMITED',429);
   const data=operation==='start'?await service.start(appleLoginStartRequestSchema.parse(request.body),bearer):
    await service.complete(appleLoginCompleteRequestSchema.parse(request.body),key as string,bearer,(client,completion)=>gate.completed(client,completion.subjectId,request.id));
   return {data,meta:{requestId:request.id}};
  }catch(error){
   const outcome=error instanceof z.ZodError?'invalid_request':error instanceof AppleFlowError?(error.code==='invalid_request'?'invalid_request':'invalid_flow'):error instanceof AppleIdentityError?(error.code==='provider_unavailable'?'unavailable':'invalid_identity'):error instanceof AppleExchangeError?'exchange_failed':error instanceof AppleIdentityStorageError?(error.code==='identity_not_linked'?'invalid_identity':'identity_unavailable'):'unavailable';
   try{await gate.failed(operation,request.id,outcome);}catch{return fail(reply,request.id,'AUTH_TEMPORARILY_UNAVAILABLE',503);}
   if(error instanceof z.ZodError||(error instanceof ApplePreparationError&&error.code==='invalid_request')||(error instanceof AppleFlowError&&error.code==='invalid_request'))return fail(reply,request.id,'AUTH_INVALID_REQUEST',400);
   if(error instanceof AppleFlowError){
    if(error.code==='in_progress')return fail(reply,request.id,'AUTH_IN_PROGRESS',409);
    if(error.code==='request_conflict')return fail(reply,request.id,'AUTH_IDEMPOTENCY_CONFLICT',409);
    if(error.code==='recovery_expired')return fail(reply,request.id,'AUTH_OPERATION_COMPLETED_LOGIN_REQUIRED',409);
    if(error.code==='session_invalid'||error.code==='session_mismatch')return fail(reply,request.id,'AUTH_SESSION_INVALID',401);
    return fail(reply,request.id,'AUTH_APPLE_RESTART_REQUIRED',401);
   }
   if(error instanceof AppleExchangeError||(error instanceof AppleIdentityError&&error.code==='invalid_identity'))return fail(reply,request.id,'AUTH_APPLE_RESTART_REQUIRED',401);
   if(error instanceof AppleIdentityStorageError)return error.code==='identity_not_linked'?fail(reply,request.id,'AUTH_APPLE_RESTART_REQUIRED',401):fail(reply,request.id,'AUTH_SESSION_INVALID',401);
   if(error instanceof AuthError)return error.status===503
    ?fail(reply,request.id,'AUTH_TEMPORARILY_UNAVAILABLE',503):fail(reply,request.id,'AUTH_SESSION_INVALID',401);
   return fail(reply,request.id,'AUTH_TEMPORARILY_UNAVAILABLE',503);
  }finally{active--;}
 });
}
