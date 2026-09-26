import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { refreshRequestSchema, refreshTokenSchema,accountDeviceSessionsPageSchema } from '@siyue/contracts';
import { AuthError, type SessionService } from './sessions.js';

export function registerAuthRoutes(app: FastifyInstance, sessions: SessionService, emailEnabled = false, appleEnabled = false) {
  let active = 0;
  const logoutBody = z.object({refreshToken:refreshTokenSchema}).strict();
  const sendError = (reply: import('fastify').FastifyReply, requestId: string, code: string, status = 401) =>
    reply.code(status).send({error:{code,messageKey:`auth.errors.${code}`,retryable:status>=500 || status===429},meta:{requestId}});
  for (const operation of ['refresh','logout'] as const) {
    app.post(`/v1/auth/${operation}`, {bodyLimit:8192}, async (request,reply) => {
      if (request.raw.url?.includes('?')) return sendError(reply,request.id,'AUTH_INVALID_REQUEST',400);
      if (active >= 4) return sendError(reply.header('Retry-After','1'),request.id,'AUTH_BUSY',429);
      active++;
      try {
        if (operation === 'refresh') {
          const parsed=refreshRequestSchema.safeParse(request.body);
          if (!parsed.success || request.headers.authorization) return sendError(reply,request.id,'AUTH_INVALID_REQUEST',400);
          return {data:await sessions.refresh(parsed.data.refreshToken,parsed.data.rotationId),meta:{requestId:request.id}};
        }
        const authorization=request.headers.authorization;
        const headerCount=request.raw.rawHeaders.filter((_,i)=>i%2===0 && request.raw.rawHeaders[i]?.toLowerCase()==='authorization').length;
        if (authorization) {
          if (headerCount!==1 || !/^Bearer [A-Za-z0-9._-]{1,4096}$/.test(authorization) ||
              (request.body!==undefined && !z.object({}).strict().safeParse(request.body).success)) return sendError(reply,request.id,'AUTH_INVALID_REQUEST',400);
          await sessions.logoutAccess(authorization.slice(7));
        } else {
          const body=logoutBody.safeParse(request.body);
          if (!body.success) return sendError(reply,request.id,'AUTH_INVALID_REQUEST',400);
          await sessions.logoutRefresh(body.data.refreshToken);
        }
        return reply.code(204).send();
      } catch (error) {
        return error instanceof AuthError ? sendError(reply,request.id,error.code,error.status) : sendError(reply,request.id,'AUTH_TEMPORARILY_UNAVAILABLE',503);
      } finally { active--; }
    });
  }
  app.get('/v1/auth/providers', async (request,reply) => {
    const query=z.object({platform:z.enum(['ios','android','desktop']).optional()}).strict().safeParse(request.query);
    if(!query.success) return sendError(reply,request.id,'AUTH_INVALID_REQUEST',400);
    return {data:{emailPassword:{enabled:emailEnabled},apple:{enabled:appleEnabled&&(query.data.platform===undefined||query.data.platform==='ios'),platforms:['ios']}},meta:{requestId:request.id}};
  });
  const bearer=(request:import('fastify').FastifyRequest)=>{
    const authorization=request.headers.authorization;
    const count=request.raw.rawHeaders.filter((_,i)=>i%2===0&&request.raw.rawHeaders[i]?.toLowerCase()==='authorization').length;
    return authorization&&count===1&&/^Bearer [A-Za-z0-9._-]{1,4096}$/.test(authorization)?authorization.slice(7):null;
  };
  app.get('/v1/me/sessions',async(request,reply)=>{
    if(active>=4)return sendError(reply.header('Retry-After','1'),request.id,'AUTH_BUSY',429);
    if(request.body!==undefined||request.headers.authorization===undefined)return sendError(reply,request.id,'AUTH_INVALID_REQUEST',400);
    const token=bearer(request),query=z.object({limit:z.coerce.number().int().min(1).max(25).default(25),cursor:z.uuid().optional()}).strict().safeParse(request.query);
    if(!token||!query.success)return sendError(reply,request.id,'AUTH_INVALID_REQUEST',400);
    active++;
    try{return {data:accountDeviceSessionsPageSchema.parse(await sessions.listDeviceSessions(token,query.data.cursor,query.data.limit)),meta:{requestId:request.id}};}
    catch(failure){return failure instanceof AuthError?sendError(reply,request.id,failure.code,failure.status):sendError(reply,request.id,'AUTH_TEMPORARILY_UNAVAILABLE',503);}
    finally{active--;}
  });
  app.delete('/v1/me/sessions/:sessionId',{bodyLimit:8192},async(request,reply)=>{
    if(active>=4)return sendError(reply.header('Retry-After','1'),request.id,'AUTH_BUSY',429);
    if(request.raw.url?.includes('?'))return sendError(reply,request.id,'AUTH_INVALID_REQUEST',400);
    const token=bearer(request),params=z.object({sessionId:z.uuid()}).strict().safeParse(request.params);
    const body=request.body===undefined?{success:true as const,data:{}}:z.object({reauthGrant:refreshTokenSchema.optional()}).strict().safeParse(request.body);
    if(!token||!params.success||!body.success)return sendError(reply,request.id,'AUTH_INVALID_REQUEST',400);
    active++;
    try{await sessions.revokeDeviceSession(token,params.data.sessionId,body.data.reauthGrant,request.id);return reply.code(204).send();}
    catch(failure){return failure instanceof AuthError?sendError(reply,request.id,failure.code,failure.status):sendError(reply,request.id,'AUTH_TEMPORARILY_UNAVAILABLE',503);}
    finally{active--;}
  });
  app.post('/v1/me/sessions/revoke-all',{bodyLimit:8192},async(request,reply)=>{
    if(active>=4)return sendError(reply.header('Retry-After','1'),request.id,'AUTH_BUSY',429);
    if(request.raw.url?.includes('?'))return sendError(reply,request.id,'AUTH_INVALID_REQUEST',400);
    const token=bearer(request),body=z.object({reauthGrant:refreshTokenSchema}).strict().safeParse(request.body);
    if(!token||!body.success)return sendError(reply,request.id,'AUTH_INVALID_REQUEST',400);
    active++;
    try{await sessions.revokeAllDeviceSessions(token,body.data.reauthGrant,request.id);return reply.code(204).send();}
    catch(failure){return failure instanceof AuthError?sendError(reply,request.id,failure.code,failure.status):sendError(reply,request.id,'AUTH_TEMPORARILY_UNAVAILABLE',503);}
    finally{active--;}
  });
}
