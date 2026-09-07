import test from 'node:test';
import assert from 'node:assert/strict';
import { zh, en } from '../src/i18n/messages.ts';
import { readLocale, saveLocale, translate, preferenceNotice } from '../src/i18n/core.ts';
import { localizedError, errorMessages } from '../src/i18n/errors.ts';

test('both languages cover every key and preserve interpolation parameters', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const key of Object.keys(zh)) {
    assert.ok(en[key].trim());
    assert.deepEqual(en[key].match(/\{\w+\}/g) ?? [], zh[key].match(/\{\w+\}/g) ?? [], key);
  }
  assert.equal(translate('en', 'chat.number', { count: 1200 }), 'Conversation 1,200');
  assert.equal(translate('zh-CN', 'settings.aiLabel', { name: 'my-model' }), 'AI 服务，my-model');
});
test('preference survives a new read and invalid values use Chinese', () => {
  let value = null;
  const storage = { getItemSync: () => value, setItemSync: (_key, next) => { value = next; } };
  assert.equal(readLocale(storage).locale, 'zh-CN');
  assert.equal(saveLocale(storage, 'en'), true);
  assert.equal(readLocale(storage).locale, 'en');
  value = 'invalid';
  assert.equal(readLocale(storage).locale, 'zh-CN');
});
test('storage failure is visible and retry can succeed', () => {
  const broken = { getItemSync() { throw Error('private'); }, setItemSync() { throw Error('private'); } };
  assert.deepEqual(readLocale(broken), { locale: 'zh-CN', failed: true });
  assert.equal(saveLocale(broken, 'en'), false);
  assert.match(preferenceNotice('en', true), /session/);
  assert.equal(preferenceNotice('en', false), null);
});
test('known errors render in current language, unknown errors do not leak', () => {
  for (const [source, english] of Object.entries(errorMessages)) {
    assert.equal(localizedError('en', new Error(source)), english);
    assert.equal(localizedError('zh-CN', source), source);
    assert.equal(localizedError('en', { message: source }), english);
  }
  assert.equal(localizedError('en', new Error('secret-api-key')), 'Something went wrong. Try again.');
  assert.equal(localizedError('en', {}, 'Retry safely'), 'Retry safely');
});
