import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { emailChallengeRequestSchema, emailRegisterConfirmSchema, emailLoginSchema, emailPasswordResetConfirmSchema, emailLinkRequestSchema, emailLinkConfirmSchema, passwordReauthSchema, passwordChangeSchema } from '@siyue/contracts';
import { AuthError } from './sessions.js';
import type { EmailService } from './email.js';

export function registerEmailRoutes(app:FastifyInstance,email:EmailService) {
  let active=0;
  const error=(reply:FastifyReply,requestId:string,code:string,status:number)=>{
    if(status===429) reply.header('Retry-After','60');
    return reply.code(status).send({error:{code,messageKey:`auth.errors.${code}`,retryable:status===429||status>=500},meta:{requestId}});
  };
  const operations=[
    {name:'register-request',path:'/v1/auth/email/register/request',authenticated:false,idempotent:true},
    {name:'register-confirm',path:'/v1/auth/email/register/confirm',authenticated:false,idempotent:true},
    {name:'login',path:'/v1/auth/email/login',authenticated:false,idempotent:false},
    {name:'reset-request',path:'/v1/auth/email/password/reset/request',authenticated:false,idempotent:true},
    {name:'reset-confirm',path:'/v1/auth/email/password/reset/confirm',authenticated:false,idempotent:true},
    {name:'reauth',path:'/v1/auth/reauth/password',authenticated:true,idempotent:false},
    {name:'password-change',path:'/v1/me/password/change',authenticated:true,idempotent:true},
    {name:'link-request',path:'/v1/me/email/link/request',authenticated:true,idempotent:true},
    {name:'link-confirm',path:'/v1/me/email/link/confirm',authenticated:true,idempotent:true},
  ] as const;
  for(const {name,path,authenticated,idempotent} of operations) app.post(path,{bodyLimit:8192},async(request,reply)=>{
    if(active>=4) return error(reply,request.id,'AUTH_BUSY',429);
    if(request.raw.url?.includes('?')) return error(reply,request.id,'AUTH_INVALID_REQUEST',400);
    const authorization=request.headers.authorization;
    const duplicate=(header:string)=>request.raw.rawHeaders.filter((value,index)=>index%2===0 && value.toLowerCase()===header).length>1;
    if(duplicate('authorization') || duplicate('idempotency-key') || (authenticated ? !authorization || !/^Bearer [A-Za-z0-9._-]{1,4096}$/.test(authorization) : authorization!==undefined)) return error(reply,request.id,'AUTH_INVALID_REQUEST',400);
    const key=request.headers['idempotency-key'];
    if(idempotent && !z.uuid().safeParse(key).success) return error(reply,request.id,'AUTH_IDEMPOTENCY_KEY_REQUIRED',400);
    const context={ip:request.ip,requestId:request.id};
    active++;
    try {
      let data:unknown;
      let status=200;
      if(name==='register-request'||name==='reset-request') {
        data=await email.request(name==='register-request'?'register':'password-reset',emailChallengeRequestSchema.parse(request.body),key as string,context);status=202;
      } else if(name==='register-confirm') {
        data=await email.register(emailRegisterConfirmSchema.parse(request.body),key as string,context);status=201;
      } else if(name==='login') data=await email.login(emailLoginSchema.parse(request.body),context);
      else if(name==='reset-confirm') {data=await email.reset(emailPasswordResetConfirmSchema.parse(request.body),key as string,context);status=204;}
      else if(name==='password-change') {data=await email.changePassword(authorization!.slice(7),passwordChangeSchema.parse(request.body),key as string,context);status=204;}
      else if(name==='link-request') {data=await email.linkRequest(authorization!.slice(7),emailLinkRequestSchema.parse(request.body),key as string,context);status=202;}
      else if(name==='link-confirm') {data=await email.linkConfirm(authorization!.slice(7),emailLinkConfirmSchema.parse(request.body),key as string,context);status=204;}
      else data=await email.reauth(authorization!.slice(7),passwordReauthSchema.parse(request.body),context);
      if(status===204) return reply.code(204).send();
      return reply.code(status).send({data,meta:{requestId:request.id}});
    } catch(failure) {
      if(failure instanceof z.ZodError) return error(reply,request.id,'AUTH_INVALID_REQUEST',400);
      if(failure instanceof AuthError) return error(reply,request.id,failure.code,failure.status);
      return error(reply,request.id,'AUTH_TEMPORARILY_UNAVAILABLE',503);
    } finally {active--;}
  });
}
