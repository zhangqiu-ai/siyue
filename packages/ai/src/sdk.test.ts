import assert from 'node:assert/strict';
import test from 'node:test';
import { generateText, Output, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { goalDraftSchema } from '@siyue/contracts';
import { executeGoalPlan } from './index.js';

const draft = { title: '练习英语', projectTitles: ['每周练习'], taskTitles: ['练习十分钟'] };
const usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};
const context = { runId: 'sdk-contract', spaceId: 'test-space', timeoutMs: 1000 };

// Offline SDK protocol tests; the test model cannot contact a real provider.
function textModel(text: string) {
  return new MockLanguageModelV4({ doGenerate: {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined },
    usage, warnings: [],
  } });
}

test('installed AI SDK produces schema-validated GoalDraft with one bounded model call', async () => {
  const model = textModel(JSON.stringify(draft));
  const result = await executeGoalPlan({ createGoalPlan: async (goal, run) => {
    const generated = await generateText({
      model, prompt: goal, output: Output.object({ schema: goalDraftSchema }),
      maxRetries: 0, maxOutputTokens: 1024, abortSignal: run?.signal,
    });
    assert.equal(generated.usage.totalTokens, undefined, 'unknown usage must not be reported as zero');
    return generated.output;
  } }, draft.title, context);
  assert.deepEqual(result, draft);
  assert.equal(model.doGenerateCalls.length, 1);
  assert.equal(model.doGenerateCalls[0]?.responseFormat?.type, 'json');
});

test('SDK malformed JSON and schema-invalid output fail instead of becoming a draft', async () => {
  for (const output of ['not-json', JSON.stringify({ title: '' })]) {
    const model = textModel(output);
    await assert.rejects(executeGoalPlan({ createGoalPlan: async (goal) => {
      const result = await generateText({ model, prompt: goal, output: Output.object({ schema: goalDraftSchema }), maxRetries: 0 });
      return result.output;
    } }, draft.title, context), { message: 'failed' });
    assert.equal(model.doGenerateCalls.length, 1);
  }
});

test('SDK tool approval request and denial never execute a write callback', async () => {
  let writes = 0;
  for (const decision of ['user-approval', 'denied'] as const) {
    const model = new MockLanguageModelV4({ doGenerate: {
      content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'applyPlan', input: JSON.stringify(draft) }],
      finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [],
    } });
    const result = await generateText({
      model, prompt: 'Create a plan', maxRetries: 0,
      tools: { applyPlan: tool({ inputSchema: goalDraftSchema, execute: async () => { writes += 1; return 'written'; } }) },
      toolApproval: () => decision,
    });
    assert.ok(result.content.some((part) => part.type === 'tool-approval-request'));
    assert.equal(writes, 0);
    assert.equal(model.doGenerateCalls.length, 1);
  }
});
