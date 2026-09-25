import type { FastifyInstance,FastifyReply,FastifyRequest } from 'fastify';
import { z } from 'zod';
import { familyManagementAcceptanceRequestSchema } from '@siyue/contracts';
import { AuthError } from './sessions.js';
import type { createFamilyManagementAcceptanceService } from './family-management-acceptance.js';

type Service=ReturnType<typeof createFamilyManagementAcceptanceService>;
function bearer(request:FastifyRequest):string|null {
  const count=request.raw.rawHeaders.filter((value,index)=>index%2===0 && value.toLowerCase()==='authorization').length;
  const value=request.headers.authorization;
  return count===1 && value && /^Bearer [A-Za-z0-9._-]{1,4096}$/.test(value)?value.slice(7):null;
}

/** The recipient acts under their own adult session. This route records a bounded, scope-bound
 * declaration; it never transfers ownership by itself. */
export function registerFamilyManagementAcceptanceRoutes(app:FastifyInstance,service:Service) {
  let active=0;
  const fail=(reply:FastifyReply,id:string,code:string,status:number)=>reply.code(status).send({
    error:{code,messageKey:`family.errors.${code}`,retryable:status===429||status>=500},meta:{requestId:id}});
  const run=async(request:FastifyRequest,reply:FastifyReply,write:boolean)=>{
    if(request.raw.url?.includes('?') || (!write && request.body!==undefined))
      return fail(reply,request.id,'FAMILY_INVALID_REQUEST',400);
    const family=z.uuid().safeParse((request.params as {familyId?:unknown}).familyId);
    const token=bearer(request);
    if(!family.success || !token)return fail(reply,request.id,'FAMILY_INVALID_REQUEST',400);
    const input=write?familyManagementAcceptanceRequestSchema.safeParse(request.body):null;
    if(write && !input?.success)return fail(reply,request.id,'FAMILY_INVALID_REQUEST',400);
    if(active>=4)return fail(reply.header('Retry-After','1'),request.id,'FAMILY_BUSY',429);
    active++;
    try {
      const data=write?await service.accept(token,family.data,input!.data)
        :await service.preview(token,family.data);
      return reply.code(write?201:200).send({data,meta:{requestId:request.id}});
    } catch(error) {
      return error instanceof AuthError?fail(reply,request.id,error.code,error.status)
        :fail(reply,request.id,'FAMILY_TEMPORARILY_UNAVAILABLE',503);
    } finally {active--;}
  };
  app.get('/v1/families/:familyId/management-acceptance/preview',
    (request,reply)=>run(request,reply,false));
  app.post('/v1/families/:familyId/management-acceptance',{bodyLimit:8192},
    (request,reply)=>run(request,reply,true));
}
