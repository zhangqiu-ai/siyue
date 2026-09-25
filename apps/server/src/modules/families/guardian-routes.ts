import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { childCreateRequestSchema, childListResponseSchema, childSummarySchema } from '@siyue/contracts';
import { AuthError } from '../auth/sessions.js';
import type { GuardianshipService } from './guardianship.js';

/** One Authorization header, one Bearer credential: a duplicated or malformed header is no session. */
function bearer(request: FastifyRequest): string | null {
  const count = request.raw.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
  const value = request.headers.authorization;
  return count === 1 && value && /^Bearer [A-Za-z0-9._-]{1,4096}$/.test(value) ? value.slice(7) : null;
}
/** The family contracts carry a UUID idempotency key; anything else never reaches the service. */
function key(request: FastifyRequest): string | null {
  const count = request.raw.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'idempotency-key').length;
  const value = request.headers['idempotency-key'];
  return count === 1 && z.uuid().safeParse(value).success ? value as string : null;
}

/**
 * Explicit guardian consent for one supervised child subject (design 16.4
 * POST /families/{id}/children). The body carries only the child display name, the consent text
 * version the adult confirmed, and the membership and family versions the caller last read; role,
 * subject kind, guardian identity and policy snapshot are never client input.
 */
export function registerGuardianRoutes(app: FastifyInstance, guardianship: GuardianshipService) {
  let active = 0;
  const error = (reply: FastifyReply, requestId: string, code: string, status: number) =>
    reply.code(status).send({ error: { code, messageKey: `family.errors.${code}`, retryable: status === 429 || status >= 500 },
      meta: { requestId } });
  const run = async (request: FastifyRequest, reply: FastifyReply,
    work: (token: string, requestKey: string | null) => Promise<unknown>,
    options: { status: number; idempotencyKey?: boolean; bodyless?: boolean }) => {
    if (active >= 4) return error(reply.header('Retry-After', '1'), request.id, 'FAMILY_BUSY', 429);
    // A query string never carries identity or scope on these routes. The read is bodyless, so its body
    // could only be a forged payload; the write takes every field from the parsed body instead, against
    // the strict create contract and its own request key.
    if (request.raw.url?.includes('?') || (options.bodyless && request.body !== undefined))
      return error(reply, request.id, 'FAMILY_INVALID_REQUEST', 400);
    const token = bearer(request), requestKey = options.idempotencyKey ? key(request) : null;
    if (!token || (options.idempotencyKey && !requestKey)) return error(reply, request.id, 'FAMILY_INVALID_REQUEST', 400);
    active++;
    try { return reply.code(options.status).send({ data: await work(token, requestKey), meta: { requestId: request.id } }); }
    catch (failure) {
      return failure instanceof AuthError ? error(reply, request.id, failure.code, failure.status)
        : error(reply, request.id, 'FAMILY_TEMPORARILY_UNAVAILABLE', 503);
    } finally { active--; }
  };
  app.post('/v1/families/:familyId/children', { bodyLimit: 8192 }, (request, reply) => run(request, reply,
    async (token, requestKey) => {
      const familyId = z.uuid().safeParse((request.params as { familyId?: unknown }).familyId);
      const input = childCreateRequestSchema.safeParse(request.body);
      if (!familyId.success || !input.success) throw new AuthError('FAMILY_INVALID_REQUEST', 400);
      return childSummarySchema.parse(await guardianship.create(token, { familyId: familyId.data, ...input.data }, requestKey as string));
    }, { status: 201, idempotencyKey: true }));
  /**
   * GET /v1/families/{id}/children (design 16.4): the trusted child list a pairing approval restarts
   * from. The path names the family, the Bearer credential names the adult, and no query, body or
   * idempotency key is part of the read, so no field of the request can claim a role, a child or a
   * relationship. It answers only the caller's own live guardian relationships through the shared
   * strict list contract.
   */
  app.get('/v1/families/:familyId/children', (request, reply) => run(request, reply,
    async token => {
      const familyId = z.uuid().safeParse((request.params as { familyId?: unknown }).familyId);
      if (!familyId.success) throw new AuthError('FAMILY_INVALID_REQUEST', 400);
      return childListResponseSchema.parse({ items: await guardianship.list(token, familyId.data) });
    }, { status: 200, bodyless: true }));
}
