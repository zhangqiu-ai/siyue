import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { parseEmailLoginMethodId, unlinkIdentityRequestSchema } from '@siyue/contracts';
import { AuthError } from './sessions.js';
import type { IdentityUnlinkService } from './identity-unlink.js';

/**
 * `DELETE /me/identities/{identityId}` for the one method this slice supports: the calling subject's
 * verified email plus password login. The caller proves itself twice — one bearer access token and
 * one single-use `unlink-identity` grant — and the grant is spent inside the transaction that
 * removes the method, so a lost response cannot be replayed into a second change.
 *
 * Registration is owned by the runtime, which only wires this route together with the mail
 * capability that sends the security notice to the removed address (design 12.3): without that
 * capability the endpoint stays closed instead of removing a login method silently.
 */
export function registerIdentityUnlinkRoutes(app: FastifyInstance, service: IdentityUnlinkService) {
  let active = 0;
  const sendError = (reply: FastifyReply, requestId: string, code: string, status = 401) =>
    reply.code(status).send({error:{code,messageKey:`auth.errors.${code}`,retryable:status>=500||status===429},meta:{requestId}});
  app.delete('/v1/me/identities/:identityId', {bodyLimit:8192}, async (request, reply) => {
    // A body or query is never a credential source: exactly one bearer header, no query, one grant.
    if (active >= 4) return sendError(reply.header('Retry-After','1'), request.id, 'AUTH_BUSY', 429);
    if (request.raw.url?.includes('?') || request.headers.authorization === undefined)
      return sendError(reply, request.id, 'AUTH_INVALID_REQUEST', 400);
    const authorization = request.headers.authorization;
    const headers = request.raw.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
    if (headers !== 1 || !/^Bearer [A-Za-z0-9._-]{1,4096}$/.test(authorization))
      return sendError(reply, request.id, 'AUTH_INVALID_REQUEST', 400);
    const params = z.object({identityId:z.string().min(1).max(64)}).strict().safeParse(request.params);
    const body = unlinkIdentityRequestSchema.safeParse(request.body);
    // An Apple handle, a bare row id or a differently cased value is not a request this route
    // serves; it fails before any database work instead of reaching the email removal path.
    if (!params.success || !body.success || parseEmailLoginMethodId(params.data.identityId) === null)
      return sendError(reply, request.id, 'AUTH_INVALID_REQUEST', 400);
    active++;
    try {
      await service.unlinkEmailLoginMethod({accessToken:authorization.slice(7), identityId:params.data.identityId,
        reauthGrant:body.data.reauthGrant, requestId:request.id});
      return reply.code(204).send();
    } catch (failure) {
      return failure instanceof AuthError ? sendError(reply, request.id, failure.code, failure.status)
        : sendError(reply, request.id, 'AUTH_TEMPORARILY_UNAVAILABLE', 503);
    } finally { active--; }
  });
}
