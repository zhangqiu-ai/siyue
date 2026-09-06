import assert from 'node:assert/strict';
import test from 'node:test';
import { goalDraftSchema } from '@siyue/contracts';
import { AgentExecutionError, executeGoalPlan, MockAgentExecutor, mockCapabilities } from './index.js';

const context = { runId: 'test-run', spaceId: 'test-space' };
const errorCode = (code: string) => (error: unknown) => error instanceof AgentExecutionError && error.code === code;

test('mock returns deterministic valid drafts without claiming a formal write', async () => {
  const executor = new MockAgentExecutor();
  const first = await executor.createGoalPlan('  提升英语表达  ');
  assert.equal(first.title, '提升英语表达');
  assert.match(first.rationale ?? '', /preview only/i);
  assert.ok(goalDraftSchema.safeParse(first).success);
  assert.deepEqual(first, await executor.createGoalPlan('提升英语表达'));
  first.taskTitles.push('changed');
  assert.equal((await executor.createGoalPlan('提升英语表达')).taskTitles.length, 3);
});

test('invalid input is rejected instead of inventing a goal', async () => {
  const executor = new MockAgentExecutor();
  for (const input of ['', '   ', 'x'.repeat(161), null, {}, 42]) {
    await assert.rejects(executor.createGoalPlan(input as string), errorCode('invalid_input'));
  }
  assert.equal((await executor.createGoalPlan('x'.repeat(160))).title.length, 160);
});

test('cancellation before and during generation does not return a draft', async () => {
  const executor = new MockAgentExecutor({ delayMs: 50 });
  const pre = new AbortController();
  pre.abort();
  await assert.rejects(executor.createGoalPlan('目标', { ...context, signal: pre.signal }), errorCode('cancelled'));
  const active = new AbortController();
  const promise = executor.createGoalPlan('目标', { ...context, signal: active.signal });
  setTimeout(() => active.abort(), 5);
  await assert.rejects(promise, errorCode('cancelled'));
});

test('timeout and deterministic provider failures have explicit errors', async () => {
  await assert.rejects(new MockAgentExecutor({ delayMs: 100 }).createGoalPlan('目标', { ...context, timeoutMs: 5 }), errorCode('timeout'));
  for (const failure of ['failed', 'unsupported'] as const) {
    await assert.rejects(new MockAgentExecutor({ failure }).createGoalPlan('目标'), errorCode(failure));
  }
  assert.equal(mockCapabilities.vision, false);
  assert.equal(mockCapabilities.structuredOutput, true);
});

test('invalid limits and provider output are rejected; provider secrets do not escape', async () => {
  for (const timeoutMs of [0, -1, 0.5, Infinity, 30_001]) {
    await assert.rejects(new MockAgentExecutor().createGoalPlan('目标', { ...context, timeoutMs }), errorCode('invalid_input'));
  }
  await assert.rejects(executeGoalPlan({ createGoalPlan: async () => ({ title: '' } as never) }, '目标', context), errorCode('failed'));
  await assert.rejects(executeGoalPlan({ createGoalPlan: async () => { throw new Error('private-provider-key'); } }, '目标', context), { message: 'failed' });
});

test('timeout bounds an executor that ignores the signal', async () => {
  await assert.rejects(executeGoalPlan({ createGoalPlan: () => new Promise(() => {}) }, '目标', { ...context, timeoutMs: 5 }), errorCode('timeout'));
});
