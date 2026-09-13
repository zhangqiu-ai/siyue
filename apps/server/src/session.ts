import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export type SessionVerifier = (token: string, signal: AbortSignal) => Promise<unknown>;
export interface SessionOptions {
  sessionVerifier?: SessionVerifier;
  sessionTimeoutMs?: number;
  maxConcurrentSessionVerifications?: number;
}
const identifier = z.string().min(1).max(200).refine(value => value === value.trim());
const verifiedSessionSchema = z.object({
  subjectId: identifier,
  subjectKind: z.enum(['adult', 'child']),
  sessionId: identifier,
  expiresAt: z.string().datetime(),
}).strict();

/** Identity verification boundary only; it grants no family, space or object permissions. */
export function registerSessionRoute(app: FastifyInstance, options: SessionOptions) {
  const timeoutMs = options.sessionTimeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('invalid_session_timeout');
  const maximum = options.maxConcurrentSessionVerifications ?? 4;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16) throw new Error('invalid_session_concurrency');
  let activeVerifications = 0;
  app.get('/v1/account/session', {
    // Reject body/query credentials before body parsing; all auth failures share one response.
    onRequest: async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      let authorizationHeaders = 0;
      for (let i = 0; i < request.raw.rawHeaders.length; i += 2) {
        if (request.raw.rawHeaders[i]?.toLowerCase() === 'authorization') authorizationHeaders++;
      }
      if (request.raw.url?.includes('?') || authorizationHeaders !== 1 ||
          request.headers['transfer-encoding'] !== undefined ||
          request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0') {
        return reply.code(401).send({error: 'unauthorized'});
      }
      const header = request.headers.authorization;
      if (typeof header !== 'string' || header.length > 4103 || !/^Bearer [A-Za-z0-9._~+/-]+=*$/i.test(header)) {
        return reply.code(401).send({error: 'unauthorized'});
      }
    },
  }, async (request, reply) => {
    const deny = () => reply.code(401).send({error: 'unauthorized'});
    if (!options.sessionVerifier || request.body !== undefined) return deny();
    if (activeVerifications >= maximum) return reply.code(429).send({error: 'busy'});
    const verifier = options.sessionVerifier;
    activeVerifications += 1;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const onClose = () => { if (!reply.raw.writableEnded) abort(); };
    request.raw.on('aborted', abort);
    reply.raw.on('close', onClose);
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(abort, timeoutMs);
    if (request.raw.aborted || reply.raw.destroyed) abort();
    let cancel: (() => void) | undefined;
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        cancel = () => reject(new Error('unauthorized'));
        controller.signal.addEventListener('abort', cancel, {once: true});
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new Error('unauthorized');
          return verifier(request.headers.authorization!.slice(7), controller.signal);
        }).then(value => {
          activeVerifications -= 1;
          resolve(value);
        }, error => {
          activeVerifications -= 1;
          reject(error);
        });
        if (controller.signal.aborted) cancel();
      });
      const parsed = verifiedSessionSchema.safeParse(result);
      if (controller.signal.aborted || Date.now() >= deadline || !parsed.success || Date.parse(parsed.data.expiresAt) <= Date.now()) return deny();
      return parsed.data;
    } catch {
      return deny();
    } finally {
      clearTimeout(timer);
      if (cancel) controller.signal.removeEventListener('abort', cancel);
      request.raw.off('aborted', abort);
      reply.raw.off('close', onClose);
      controller.abort();
    }
  });
}
