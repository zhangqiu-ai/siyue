import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { accountLoginMethodsSchema } from '@siyue/contracts';
import { AuthError, type SessionService } from './sessions.js';
import type { IdentitySummary } from './identities.js';

/** Exactly one well-formed Authorization header; a body or query is never a credential source. */
function bearerToken(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  const count = request.raw.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
  return authorization && count === 1 && /^Bearer [A-Za-z0-9._-]{1,4096}$/.test(authorization) ? authorization.slice(7) : null;
}

export function registerIdentityRoutes(app: FastifyInstance, sessions: SessionService, identities: IdentitySummary) {
  let active = 0;
  const sendError = (reply: FastifyReply, requestId: string, code: string, status = 401) =>
    reply.code(status).send({error:{code,messageKey:`auth.errors.${code}`,retryable:status>=500||status===429},meta:{requestId}});
  app.get('/v1/me/identities', async (request, reply) => {
    if (active >= 4) return sendError(reply.header('Retry-After','1'),request.id,'AUTH_BUSY',429);
    if (request.raw.url?.includes('?') || request.body !== undefined || request.headers.authorization === undefined)
      return sendError(reply,request.id,'AUTH_INVALID_REQUEST',400);
    const token = bearerToken(request);
    if (!token) return sendError(reply,request.id,'AUTH_INVALID_REQUEST',400);
    active++;
    try {
      // The subject comes from the verified session only, so a caller can never ask for another
      // account's methods; a blocked, deleted, revoked or expired session already fails here.
      const verified = await sessions.verify(token);
      return {data:accountLoginMethodsSchema.parse(await identities.list(verified.subjectId)),meta:{requestId:request.id}};
    } catch (failure) {
      return failure instanceof AuthError ? sendError(reply,request.id,failure.code,failure.status)
        : sendError(reply,request.id,'AUTH_TEMPORARILY_UNAVAILABLE',503);
    } finally { active--; }
  });
}
