import {accountDeletionRequestSchema} from '@siyue/contracts';
import {z} from 'zod';
import type {createAccountDeletionSubmission} from './account-deletion-submission.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { AuthError } from './sessions.js';
import type { AccountDeletionImpactService } from './account-deletion-impact.js';
import type { AccountDeletionJobStore } from './account-deletion-jobs.js';

/** Submission is registered only when the runtime supplies its ledger-protected service. */
export function registerAccountDeletionReadRoutes(app: FastifyInstance,
  impact: AccountDeletionImpactService, jobs: AccountDeletionJobStore, submission?:ReturnType<typeof createAccountDeletionSubmission>) {
  let active = 0;
  const sendError = (reply: FastifyReply, requestId: string, code: string, status: number) =>
    reply.code(status).send({error:{code,messageKey:`auth.errors.${code}`,retryable:status>=500||status===429},meta:{requestId}});
  app.get('/v1/me/account/deletion/impact', async (request, reply) => {
    const authorization = request.headers.authorization;
    const count = request.raw.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
    if (request.raw.url?.includes('?') || request.body !== undefined || count !== 1 ||
      !authorization || !/^Bearer [A-Za-z0-9._-]{1,4096}$/.test(authorization))
      return sendError(reply, request.id, 'AUTH_INVALID_REQUEST', 400);
    if (active >= 4) return sendError(reply.header('Retry-After','1'), request.id, 'AUTH_BUSY', 429);
    active++;
    try { return {data:await impact.inspect(authorization.slice(7)),meta:{requestId:request.id}}; }
    catch (error) { return error instanceof AuthError
      ? sendError(reply, request.id, error.code, error.status)
      : sendError(reply, request.id, 'AUTH_TEMPORARILY_UNAVAILABLE', 503); }
    finally { active--; }
  });
  app.post('/v1/account/deletion/status', {bodyLimit:8192}, async (request, reply) => {
    if (request.raw.url?.includes('?') || request.headers.authorization !== undefined)
      return sendError(reply, request.id, 'AUTH_INVALID_REQUEST', 400);
    if (active >= 4) return sendError(reply.header('Retry-After','1'), request.id, 'AUTH_BUSY', 429);
    active++;
    try { return {data:await jobs.status(request.body),meta:{requestId:request.id}}; }
    catch (error) { return error instanceof AuthError
      ? sendError(reply, request.id, error.code, error.status)
      : sendError(reply, request.id, 'AUTH_TEMPORARILY_UNAVAILABLE', 503); }
    finally { active--; }
  });
  if(submission)app.delete('/v1/me/account',{bodyLimit:16384},async(request,reply)=>{
    const one=(name:string)=>request.raw.rawHeaders.filter((value,index)=>index%2===0&&value.toLowerCase()===name).length===1;
    const authorization=request.headers.authorization;
    const key=z.uuid().safeParse(request.headers['idempotency-key']);
    const body=accountDeletionRequestSchema.safeParse(request.body);
    if(request.raw.url?.includes('?')||!one('authorization')||!one('idempotency-key')||
      !authorization||!/^Bearer [A-Za-z0-9._-]{1,4096}$/.test(authorization)||!key.success||!body.success)
      return sendError(reply,request.id,'AUTH_INVALID_REQUEST',400);
    if(active>=4)return sendError(reply.header('Retry-After','1'),request.id,'AUTH_BUSY',429);
    active++;
    try {return reply.code(202).send({data:await submission.submit({key:key.data,
      accessToken:authorization.slice(7),...body.data}),meta:{requestId:request.id}});}
    catch(error){return error instanceof AuthError?sendError(reply,request.id,error.code,error.status)
      :sendError(reply,request.id,'AUTH_TEMPORARILY_UNAVAILABLE',503);}
    finally {active--;}
  });

}
