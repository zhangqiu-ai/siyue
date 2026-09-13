import assert from 'node:assert/strict';
import test from 'node:test';
import { planErrorKey } from '../src/space/plan-error.ts';
import { CompatibleChatError } from '../src/chat/compatible-transport.ts';
import { SettingsError } from '../src/settings/credential-store.ts';
import { translate } from '../src/i18n/core.ts';

test('generation failures map to controlled bilingual messages without provider details', () => {
  for (const [error, expected] of [
    [{code: 'configuration_required'}, 'plan.configRequired'],
    [{code: 'cancelled'}, 'plan.cancelled'],
    [{code: 'invalid_output'}, 'plan.invalidOutput'],
    [{code: 'invalid_output', reason: 'json'}, 'plan.invalidJson'],
    [{code: 'invalid_output', reason: 'schema'}, 'plan.invalidSchema'],
    [{code: 'invalid_output', reason: 'project_count'}, 'plan.invalidOutput'],
    [{code: 'invalid_input'}, 'plan.invalidInput'],
    [new SettingsError('synthetic secret'), 'plan.configError'],
    [new CompatibleChatError('请求过于频繁或额度不足，请稍后重试并检查服务商额度。'), 'plan.rateLimit'],
    [new CompatibleChatError('回复已达到长度上限，内容尚未完整，已收到的文字已保留。'), 'plan.incomplete'],
    [new Error('synthetic secret'), 'plan.failed'],
    [{message: 'synthetic secret', code: 'unexpected'}, 'plan.failed'],
  ]) {
    assert.equal(planErrorKey(error), expected);
    for (const locale of ['zh-CN', 'en']) {
      const message = translate(locale, expected);
      assert.ok(message.length > 0);
      assert.ok(!message.includes('synthetic secret'));
    }
  }
});
