import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { MockAgentExecutor } from '@siyue/ai';
import { createApp } from './app.js';

const route = '/v1/ai/mock-plan';

test('local service reports mock limits and returns preview data only', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  const capabilities = (await app.inject('/v1/ai/capabilities')).json();
  assert.equal(capabilities.productionReady, false);
  assert.equal(capabilities.providerConfigured, false);
  const response = await app.inject({ method: 'POST', url: route, payload: { goal: '  练习英语  ' } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().title, '练习英语');
  assert.equal(response.json().commandId, undefined);
  assert.match(response.json().rationale, /preview only/);
});

test('request schema rejects malformed, oversized, missing and coerced input', async (t) => {
  let calls = 0;
  const app = createApp({ executor: { createGoalPlan: async () => { calls += 1; throw new Error('should not run'); } } });
  t.after(() => app.close());
  for (const payload of [{}, { goal: '' }, { goal: ' ' }, { goal: 42 }, { goal: 'x'.repeat(161) }, { goal: 'test', secret: 'unexpected' }, ['test']]) {
    const response = await app.inject({ method: 'POST', url: route, payload });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }
  const malformed = await app.inject({ method: 'POST', url: route, headers: { 'content-type': 'application/json' }, payload: '{' });
  assert.equal(malformed.statusCode, 400);
  const oversized = await app.inject({ method: 'POST', url: route, payload: { goal: 'x'.repeat(5000) } });
  assert.equal(oversized.statusCode, 413);
  assert.equal(calls, 0);
});

test('browser origins are denied before the executor runs', async (t) => {
  const app = createApp();
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: route, headers: { origin: 'https://untrusted.example' }, payload: { goal: 'test' } });
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.json(), { error: 'origin_denied' });
});

test('provider errors and malformed output never leak response bodies', async (t) => {
  const app = createApp({ executor: { createGoalPlan: async () => { throw new Error('secret-goal-and-provider-key'); } } });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: route, payload: { goal: 'secret-goal' } });
  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.json(), { error: 'failed' });
  const malformed = createApp({ executor: { createGoalPlan: async () => ({ title: '' } as never) } });
  t.after(() => malformed.close());
  assert.equal((await malformed.inject({ method: 'POST', url: route, payload: { goal: 'test' } })).statusCode, 502);
});

test('unsupported and timeout states are explicit', async (t) => {
  const unsupported = createApp({ executor: new MockAgentExecutor({ failure: 'unsupported' }) });
  const timeout = createApp({ executor: { createGoalPlan: () => new Promise(() => {}) }, timeoutMs: 5 });
  t.after(() => unsupported.close());
  t.after(() => timeout.close());
  const response = await unsupported.inject({ method: 'POST', url: route, payload: { goal: 'test' } });
  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.json(), { error: 'unsupported' });
  const expired = await timeout.inject({ method: 'POST', url: route, payload: { goal: 'test' } });
  assert.equal(expired.statusCode, 504);
  assert.deepEqual(expired.json(), { error: 'timeout' });
});

test('concurrency cap rejects excess work and releases the slot after completion', async (t) => {
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const app = createApp({ maxConcurrentRuns: 1, executor: { createGoalPlan: async (goal) => {
    entered();
    await gate;
    return new MockAgentExecutor().createGoalPlan(goal);
  } } });
  t.after(() => app.close());
  const first = app.inject({ method: 'POST', url: route, payload: { goal: 'first' } });
  await started;
  const excess = await app.inject({ method: 'POST', url: route, payload: { goal: 'second' } });
  assert.equal(excess.statusCode, 429);
  finish();
  assert.equal((await first).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: route, payload: { goal: 'third' } })).statusCode, 200);
});


test('disconnecting a real loopback HTTP client cancels the in-flight executor', { timeout: 2000 }, async (t) => {
  let entered!: () => void;
  let cancelled!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const aborted = new Promise<void>((resolve) => { cancelled = resolve; });
  const app = createApp({ executor: { createGoalPlan: async (_goal, context) => {
    entered();
    return new Promise((_resolve, reject) => {
      context?.signal?.addEventListener('abort', () => { cancelled(); reject(new Error('disconnected')); }, { once: true });
    });
  } } });
  t.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const request = httpRequest(`${address}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' } });
  request.on('error', () => {}); // Client intentionally closes its socket.
  t.after(() => request.destroy());
  request.end(JSON.stringify({ goal: 'local-only-test' }));
  await started;
  request.destroy();
  await aborted;
});
