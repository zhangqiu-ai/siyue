import test from 'node:test';
import assert from 'node:assert/strict';
import { aiProviderStatusTone } from '../src/settings/ai-provider-status.ts';

test('AI provider feedback distinguishes progress, success, and recoverable errors', () => {
  for (const notice of ['ai.testing', 'ai.cancelledTest', 'ai.cancelledModels']) {
    assert.equal(aiProviderStatusTone(notice), 'info');
  }
  for (const notice of ['ai.saved', 'ai.removed', 'ai.connected']) {
    assert.equal(aiProviderStatusTone(notice), 'success');
  }
  for (const notice of ['ai.modelsFailed', 'ai.saveFailed', 'unknown-provider-error']) {
    assert.equal(aiProviderStatusTone(notice), 'error');
  }
});
