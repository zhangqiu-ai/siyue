import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { familyInvitationAcceptRequestSchema, familyInvitationCreateRequestSchema,
  familyInvitationCreatedSchema, familySummarySchema } from '@siyue/contracts';
import { AuthError } from '../auth/sessions.js';
import type { FamilyInvitationService } from './invitations.js';

function bearer(request:FastifyRequest):string|null {
  const count=request.raw.rawHeaders.filter((name,index)=>index%2===0&&name.toLowerCase()==='authorization').length;
  const value=request.headers.authorization;
  return count===1&&value&&/^Bearer [A-Za-z0-9._-]{1,4096}$/.test(value)?value.slice(7):null;
}
function key(request:FastifyRequest):string|null {
  const count=request.raw.rawHeaders.filter((name,index)=>index%2===0&&name.toLowerCase()==='idempotency-key').length;
  const value=request.headers['idempotency-key'];
  return count===1&&z.uuid().safeParse(value).success?value as string:null;
}

/** Controlled family invitation, never a public room code or a family authority snapshot. */
export function registerFamilyInvitationRoutes(app:FastifyInstance, invitations:FamilyInvitationService) {
  let active=0;
  const error=(reply:FastifyReply,requestId:string,code:string,status:number)=>
    reply.code(status).send({error:{code,messageKey:`family.errors.${code}`,retryable:status===429||status>=500},meta:{requestId}});
  const run=async(request:FastifyRequest,reply:FastifyReply,work:(token:string,requestKey:string)=>Promise<unknown>,status:number)=>{
    if(active>=4)return error(reply.header('Retry-After','1'),request.id,'FAMILY_BUSY',429);
    if(request.raw.url?.includes('?'))return error(reply,request.id,'FAMILY_INVALID_REQUEST',400);
    const token=bearer(request),requestKey=key(request);
    if(!token||!requestKey)return error(reply,request.id,'FAMILY_INVALID_REQUEST',400);
    active++;
    try{return reply.code(status).send({data:await work(token,requestKey),meta:{requestId:request.id}});}
    catch(failure){return failure instanceof AuthError?error(reply,request.id,failure.code,failure.status)
      :error(reply,request.id,'FAMILY_TEMPORARILY_UNAVAILABLE',503);}
    finally{active--;}
  };
  app.post('/v1/families/:familyId/invitations',{bodyLimit:8192},(request,reply)=>run(request,reply,async(token,requestKey)=>{
    const familyId=z.uuid().safeParse((request.params as {familyId?:unknown}).familyId);
    const input=familyInvitationCreateRequestSchema.safeParse(request.body);
    if(!familyId.success||!input.success)throw new AuthError('FAMILY_INVALID_REQUEST',400);
    return familyInvitationCreatedSchema.parse(await invitations.create(token,{familyId:familyId.data,...input.data},requestKey));
  },201));
  app.post('/v1/family-invitations/accept',{bodyLimit:8192},(request,reply)=>run(request,reply,async(token,requestKey)=>{
    const input=familyInvitationAcceptRequestSchema.safeParse(request.body);
    if(!input.success)throw new AuthError('FAMILY_INVALID_REQUEST',400);
    return familySummarySchema.parse(await invitations.accept(token,input.data.token,requestKey));
  },200));
}
