import Fastify from 'fastify';
import {
  AgentExecutionError,
  executeGoalPlan,
  MockAgentExecutor,
  mockCapabilities,
  type AgentExecutor,
} from '@siyue/ai';

export interface AppOptions {
  executor?: AgentExecutor;
  timeoutMs?: number;
  maxConcurrentRuns?: number;
}

/** Local development Mock service. This is not a production authentication boundary. */
export function createApp(options: AppOptions = {}) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxConcurrentRuns = options.maxConcurrentRuns ?? 4;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000 ||
      !Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 16) {
    throw new Error('invalid_server_limits');
  }
  const app = Fastify({
    logger: false,
    bodyLimit: 4096,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const executor = options.executor ?? new MockAgentExecutor();
  let activeRuns = 0;

  // No browser origin is needed by the local native/CLI prototype.
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.origin) return reply.code(403).send({ error: 'origin_denied' });
  });
  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error instanceof Error && 'statusCode' in error ? error.statusCode : undefined;
    const status = typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    return reply.code(status).send({ error: status === 413 ? 'body_too_large' : status < 500 ? 'invalid_request' : 'internal_error' });
  });

  app.get('/health', async () => ({ ok: true, service: 'siyue-server', version: '0.1.0' }));
  app.get('/v1/ai/capabilities', async () => ({
    execution: ['mock'],
    tools: ['draft.goal-plan'],
    modelCapabilities: mockCapabilities,
    writesRequireConfirmation: true,
    productionReady: false,
    authentication: 'none-local-development-only',
    providerConfigured: false,
  }));
  app.post<{ Body: { goal: string } }>('/v1/ai/mock-plan', {
    schema: {
      body: {
        type: 'object', required: ['goal'], additionalProperties: false,
        properties: { goal: { type: 'string', minLength: 1, maxLength: 160 } },
      },
    },
  }, async (request, reply) => {
    if (activeRuns >= maxConcurrentRuns) return reply.code(429).send({ error: 'busy' });
    activeRuns += 1;
    const controller = new AbortController();
    const onClose = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', onClose);
    try {
      return await executeGoalPlan(executor, request.body.goal, {
        runId: request.id, spaceId: 'local-development', signal: controller.signal, timeoutMs,
      });
    } catch (error) {
      const code = error instanceof AgentExecutionError ? error.code : 'failed';
      const status = { invalid_input: 400, cancelled: 499, timeout: 504, unsupported: 422, failed: 502 }[code];
      return reply.code(status).send({ error: code });
    } finally {
      reply.raw.off('close', onClose);
      activeRuns -= 1;
    }
  });
  return app;
}
