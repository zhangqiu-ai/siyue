import assert from 'node:assert/strict';
import test from 'node:test';
import { MockAgentExecutor } from './index.js';

test('mock agent returns draft data without claiming a write', async () => {
  const executor = new MockAgentExecutor();
  const draft = await executor.createGoalPlan('提升英语表达');
  assert.equal(draft.title, '提升英语表达');
  assert.match(draft.rationale ?? '', /preview only/i);
  assert.ok(draft.taskTitles.length >= 1);
});
