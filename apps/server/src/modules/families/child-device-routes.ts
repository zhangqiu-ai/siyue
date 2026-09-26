import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { childDeviceRevokeRequestSchema } from '@siyue/contracts';
import { AuthError } from '../auth/sessions.js';
import type { ChildDeviceService } from './child-devices.js';

function bearer(request: FastifyRequest): string | null {
  const count = request.raw.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === 'authorization').length;
  const value = request.headers.authorization;
  return count === 1 && value && /^Bearer [A-Za-z0-9._-]{1,4096}$/.test(value) ? value.slice(7) : null;
}

/** Device management is based on a live guardian relationship, not on family admin status. */
export function registerChildDeviceRoutes(app: FastifyInstance, devices: ChildDeviceService) {
  let active = 0;
  const error = (reply: FastifyReply, requestId: string, code: string, status: number) =>
    reply.code(status).send({error: {code, messageKey: `childDevice.errors.${code}`, retryable: status === 429 || status >= 500}, meta: {requestId}});
  const run = async (request: FastifyRequest, reply: FastifyReply, work: (accessToken: string) => Promise<unknown>) => {
    if (active >= 4) return error(reply.header('Retry-After', '1'), request.id, 'CHILD_DEVICE_BUSY', 429);
    if (request.raw.url?.includes('?')) return error(reply, request.id, 'CHILD_DEVICE_INVALID_REQUEST', 400);
    const token = bearer(request);
    if (!token) return error(reply, request.id, 'CHILD_DEVICE_INVALID_REQUEST', 400);
    active++;
    try { return reply.send({data: await work(token), meta: {requestId: request.id}}); }
    catch (failure) { return failure instanceof AuthError ? error(reply, request.id, failure.code, failure.status)
      : error(reply, request.id, 'CHILD_DEVICE_TEMPORARILY_UNAVAILABLE', 503); }
    finally { active--; }
  };
  app.get('/v1/children/:childId/devices', (request, reply) => run(request, reply, token => {
    if (request.body !== undefined) throw new AuthError('CHILD_DEVICE_INVALID_REQUEST', 400);
    const childId = z.uuid().safeParse((request.params as {childId?: unknown}).childId);
    if (!childId.success) throw new AuthError('CHILD_DEVICE_INVALID_REQUEST', 400);
    return devices.list(token, childId.data);
  }));
  app.delete('/v1/children/:childId/devices/:grantId', {bodyLimit: 4096}, (request, reply) => run(request, reply, token => {
    const params = request.params as {childId?: unknown; grantId?: unknown};
    const childId = z.uuid().safeParse(params.childId), grantId = z.uuid().safeParse(params.grantId);
    const input = childDeviceRevokeRequestSchema.safeParse(request.body);
    if (!childId.success || !grantId.success || !input.success) throw new AuthError('CHILD_DEVICE_INVALID_REQUEST', 400);
    return devices.revoke(token, childId.data, grantId.data, input.data.expectedVersion);
  }));
}
