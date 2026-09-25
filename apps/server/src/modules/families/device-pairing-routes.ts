import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  devicePairingApproveRequestSchema, devicePairingCompleteRequestSchema, devicePairingCreateRequestSchema,
  devicePairingStatusRequestSchema, devicePairingPreviewRequestSchema,
} from '@siyue/contracts';
import { AuthError } from '../auth/sessions.js';
import { ChildDevicePairingError, type ChildDevicePairingService } from './device-pairings.js';

/** One Authorization header, one Bearer credential: a duplicated or malformed header is no session. */
function bearer(request: FastifyRequest): string | null {
  const count = request.raw.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
  const value = request.headers.authorization;
  return count === 1 && value && /^Bearer [A-Za-z0-9._-]{1,4096}$/.test(value) ? value.slice(7) : null;
}
const pairingIdOf = (request: FastifyRequest) => z.uuid().safeParse((request.params as { pairingId?: unknown }).pairingId);

/**
 * Child-device pairing endpoints (design 16.4). Three of the five routes are anonymous by design: the
 * child device holds no adult session, so the create/status/complete calls carry only the request body
 * and bound 32-byte secrets, and the service applies the anonymous rate limits. The two authenticated
 * calls are the guardian's: the preview is a plain adult read of the requesting device and the intended
 * child, and approval additionally needs the guardian's current relationship version and a single-use
 * `approve-child-device` reauth grant. Every route refuses a query string, uses a small body limit, keeps
 * a bounded in-flight count and never lets a failure disclose pairing or adult state.
 */
export function registerChildDevicePairingRoutes(app: FastifyInstance, pairings: ChildDevicePairingService) {
  let active = 0;
  const maximum = 8;
  const error = (reply: FastifyReply, requestId: string, code: string, status: number, retryAfterSeconds?: number) => {
    if (retryAfterSeconds !== undefined) reply.header('Retry-After', String(retryAfterSeconds));
    return reply.code(status).send({ error: { code, messageKey: `family.errors.${code}`, retryable: status === 429 || status >= 500 },
      meta: { requestId } });
  };
  const run = async (request: FastifyRequest, reply: FastifyReply, work: () => Promise<{ data: unknown; status: number }>) => {
    if (active >= maximum) return error(reply, request.id, 'CHILD_DEVICE_PAIRING_BUSY', 429, 1);
    if (request.raw.url?.includes('?')) return error(reply, request.id, 'CHILD_DEVICE_PAIRING_INVALID_REQUEST', 400);
    active += 1;
    try {
      const { data, status } = await work();
      return reply.code(status).send({ data, meta: { requestId: request.id } });
    } catch (failure) {
      // Only the service's own errors carry a wait hint; a session or policy refusal never does.
      return failure instanceof AuthError
        ? error(reply, request.id, failure.code, failure.status,
          failure instanceof ChildDevicePairingError ? failure.retryAfterSeconds : undefined)
        : error(reply, request.id, 'CHILD_DEVICE_PAIRING_UNAVAILABLE', 503);
    } finally { active -= 1; }
  };

  // Anonymous: without an adult session a child device can only open one pending pairing request.
  app.post('/v1/device-pairings', { bodyLimit: 8192 }, (request, reply) => run(request, reply, async () => {
    const input = devicePairingCreateRequestSchema.safeParse(request.body);
    if (!input.success) throw new ChildDevicePairingError('CHILD_DEVICE_PAIRING_INVALID_REQUEST', 400);
    return { data: await pairings.create(input.data, { ip: request.ip, requestId: request.id }), status: 201 };
  }));

  // The initiating device's own poll secret is the only credential a pending request accepts.
  app.post('/v1/device-pairings/:pairingId/status', { bodyLimit: 4096 }, (request, reply) => run(request, reply, async () => {
    const pairingId = pairingIdOf(request), input = devicePairingStatusRequestSchema.safeParse(request.body);
    if (!pairingId.success || !input.success) throw new ChildDevicePairingError('CHILD_DEVICE_PAIRING_INVALID_REQUEST', 400);
    return { data: await pairings.status(pairingId.data, input.data, { ip: request.ip, requestId: request.id }), status: 200 };
  }));

  // The guardian device reads what it is about to authorize, before spending a reauth grant on approval.
  app.post('/v1/device-pairings/:pairingId/preview', { bodyLimit: 8192 }, (request, reply) => run(request, reply, async () => {
    const token = bearer(request), pairingId = pairingIdOf(request);
    const input = devicePairingPreviewRequestSchema.safeParse(request.body);
    if (!token || !pairingId.success || !input.success) throw new ChildDevicePairingError('CHILD_DEVICE_PAIRING_INVALID_REQUEST', 400);
    return { data: await pairings.preview(token, pairingId.data, input.data, request.id), status: 200 };
  }));

  // The guardian device proves itself with the request token, an adult session and a fresh reauth grant.
  app.post('/v1/device-pairings/:pairingId/approve', { bodyLimit: 8192 }, (request, reply) => run(request, reply, async () => {
    const token = bearer(request), pairingId = pairingIdOf(request);
    const input = devicePairingApproveRequestSchema.safeParse(request.body);
    if (!token || !pairingId.success || !input.success) throw new ChildDevicePairingError('CHILD_DEVICE_PAIRING_INVALID_REQUEST', 400);
    return { data: await pairings.approve(token, pairingId.data, input.data, request.id), status: 200 };
  }));

  // One consumption by the initiating device; a repeat inside the recovery window repeats the result.
  app.post('/v1/device-pairings/:pairingId/complete', { bodyLimit: 4096 }, (request, reply) => run(request, reply, async () => {
    const pairingId = pairingIdOf(request), input = devicePairingCompleteRequestSchema.safeParse(request.body);
    if (!pairingId.success || !input.success) throw new ChildDevicePairingError('CHILD_DEVICE_PAIRING_INVALID_REQUEST', 400);
    return { data: await pairings.complete(pairingId.data, input.data, { ip: request.ip, requestId: request.id }), status: 200 };
  }));
}
