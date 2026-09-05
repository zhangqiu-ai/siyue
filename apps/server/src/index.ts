import Fastify from 'fastify';
import { MockAgentExecutor } from '@siyue/ai';

const app = Fastify({ logger: true });
const mockAgent = new MockAgentExecutor();

app.get('/health', async () => ({ ok: true, service: 'siyue-server', version: '0.1.0' }));

app.get('/v1/ai/capabilities', async () => ({
  execution: ['mock'],
  tools: ['draft.goal-plan'],
  writesRequireConfirmation: true,
}));

app.post('/v1/ai/mock-plan', async (request) => {
  const body = request.body as { goal?: string };
  return mockAgent.createGoalPlan(body.goal ?? '');
});

const port = Number(process.env.SIYUE_SERVER_PORT ?? 8787);
await app.listen({ port, host: '127.0.0.1' });
