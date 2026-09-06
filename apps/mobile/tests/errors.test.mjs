import assert from 'node:assert/strict';
import test from 'node:test';
import { describeError } from '../src/errors.ts';

const generic = '操作未能确认完成。请刷新本地记录后重试，输入仍然保留。';
test('unknown errors never expose synthetic private codes, messages or stacks', () => {
  const secret = 'SYNTHETIC_PRIVATE_GOAL_AND_PROVIDER_RESPONSE';
  for (const error of [Object.assign(new Error(secret), {code: secret}), new Error(secret), {code: 123}, null, undefined]) {
    assert.equal(describeError(error), generic);
  }
});
test('prototype names cannot escape the public error message allowlist', () => {
  for (const code of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(describeError({code}), generic);
});
test('unknown object codes are not stringified', () => {
  let called = false;
  assert.equal(describeError({code: {toString() {called = true; throw new Error('do not execute');}}}), generic);
  assert.equal(called, false);
});
test('known errors retain useful guidance without including private details', () => {
  assert.equal(describeError({code: 'cancelled', message: 'private'}), '生成已取消，输入仍然保留。');
  assert.equal(describeError(Object.assign(new Error('private'), {name: 'AbortError'})), '生成已取消，输入仍然保留。');
  assert.equal(describeError({code: 'corrupt_data'}), '本地数据未通过完整性检查，原始数据已保留。请停止写入并联系维护者恢复。');
  assert.equal(describeError({code: 'version_conflict'}), '记录已有变化，请刷新后重新检查。你的输入仍然保留。');
});
