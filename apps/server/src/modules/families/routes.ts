import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { familyListSchema, familySummarySchema, type VerifiedAccountSession } from '@siyue/contracts';
import { transaction } from '../../adapters/postgres/database.js';
import { AuthError, type SessionService } from '../auth/sessions.js';
import { FamilyRepositoryError, type FamilyRepository } from './repository.js';

function bearer(request: FastifyRequest): string | null {
  const count = request.raw.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
  const value = request.headers.authorization;
  return count === 1 && value && /^Bearer [A-Za-z0-9._-]{1,4096}$/.test(value) ? value.slice(7) : null;
}

/**
 * Family existence is never disclosed to a non-member. Membership alone grants no records, and a family
 * summary is an adult read: a restricted child session keeps its own membership without receiving the
 * owner subjectId, its role or the membership and family versions. Explicit room or board authorization
 * stays a separate device-grant path, so nothing here pre-empts it.
 */
export function registerFamilyRoutes(app: FastifyInstance, pool: Pool, sessions: SessionService, families: FamilyRepository) {
  let active = 0;
  const adultSession = (session: VerifiedAccountSession): VerifiedAccountSession => {
    if (session.subjectKind !== 'adult') throw new AuthError('FAMILY_ADULT_REQUIRED', 403);
    return session;
  };
  const error = (reply:FastifyReply,requestId:string,code:string,status:number) =>
    reply.code(status).send({error:{code,messageKey:`family.errors.${code}`,retryable:status===429||status>=500},meta:{requestId}});
  const run = async (request:FastifyRequest,reply:FastifyReply,work:(token:string)=>Promise<unknown>,status=200) => {
    if (active>=4) return error(reply.header('Retry-After','1'),request.id,'FAMILY_BUSY',429);
    if (request.raw.url?.includes('?') || request.body!==undefined) return error(reply,request.id,'FAMILY_INVALID_REQUEST',400);
    const token=bearer(request);
    if (!token) return error(reply,request.id,'FAMILY_INVALID_REQUEST',400);
    active++;
    try {return reply.code(status).send({data:await work(token),meta:{requestId:request.id}});}
    catch (failure) {
      return failure instanceof AuthError ? error(reply,request.id,failure.code,failure.status)
        : failure instanceof FamilyRepositoryError ? error(reply,request.id,failure.code,
          failure.code==='FAMILY_CREATE_CONFLICT'?409:failure.code==='FAMILY_SUBJECT_NOT_ELIGIBLE'?403:400)
        : error(reply,request.id,'FAMILY_TEMPORARILY_UNAVAILABLE',503);
    } finally {active--;}
  };
  app.get('/v1/families', (request,reply)=>run(request,reply,async token=>{
    const session=adultSession(await sessions.verify(token));
    return familyListSchema.parse({items:await families.list(session.subjectId)});
  }));
  app.get('/v1/families/:familyId', (request,reply)=>run(request,reply,async token=>{
    const familyId=z.uuid().safeParse((request.params as {familyId?:unknown}).familyId);
    if (!familyId.success) throw new AuthError('FAMILY_INVALID_REQUEST',400);
    const session=adultSession(await sessions.verify(token));
    const found=await families.get(session.subjectId,familyId.data);
    if (!found) throw new AuthError('FAMILY_NOT_FOUND',404);
    return familySummarySchema.parse(found);
  }));
  app.post('/v1/families', (request,reply)=>{
    const headers=request.raw.rawHeaders.filter((value,index)=>index%2===0 && value.toLowerCase()==='idempotency-key').length;
    const key=request.headers['idempotency-key'];
    if (headers!==1 || !z.uuid().safeParse(key).success) return error(reply,request.id,'FAMILY_IDEMPOTENCY_KEY_REQUIRED',400);
    return run(request,reply,async token=>transaction(pool,async client=>{
      const session=await sessions.verifyForMutation(client,token);
      if (session.subjectKind!=='adult') throw new AuthError('FAMILY_ADULT_REQUIRED',403);
      const keyHash=createHash('sha256').update(key as string).digest('hex');
      return familySummarySchema.parse(await families.create(client,session.subjectId,keyHash));
    }),201);
  });
}
