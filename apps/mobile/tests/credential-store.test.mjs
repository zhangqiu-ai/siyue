import assert from 'node:assert/strict';
import test from 'node:test';
import { createCredentialStore } from '../src/settings/credential-store.ts';

const input = { baseUrl: 'https://example.test/v1/', model: 'test-model', apiKey: 'synthetic-test-key' };
function fixture() {
  let record = null;
  const storage = { read: async () => record, write: async (value) => { record = value; }, remove: async () => { record = null; } };
  return { storage, store: createCredentialStore(storage) };
}
test('secure record survives a new store instance and binds key to canonical endpoint', async () => {
  const { storage, store } = fixture();
  assert.equal(await store.load(), null);
  await store.save(input);
  assert.deepEqual(await createCredentialStore(storage).load(), { ...input, baseUrl: 'https://example.test/v1' });
  assert.equal((await store.save({ ...input, model: 'next', apiKey: '' })).apiKey, input.apiKey);
});
test('changing endpoint cannot reuse a saved key, including changes to its path', async () => {
  const { store } = fixture();
  await store.save(input);
  for (const baseUrl of ['https://other.test/v1', 'https://example.test/other']) {
    await assert.rejects(store.save({ ...input, baseUrl, apiKey: '' }), /重新输入/);
  }
  assert.equal((await store.load()).model, input.model);
});
test('invalid or unsafe configuration cannot overwrite valid secure record', async () => {
  const { store } = fixture();
  await store.save(input);
  for (const patch of [{ baseUrl: 'http://example.test' }, { baseUrl: 'https://user:pass@example.test' }, { baseUrl: 'https://example.test?key=secret' }, { model: '' }, { apiKey: 'key\r\nInjected: value' }]) {
    await assert.rejects(store.save({ ...input, ...patch }));
  }
  assert.equal((await store.load()).apiKey, input.apiKey);
});
test('failed native storage never falls back to plaintext or exposes native error data', async () => {
  const { storage, store } = fixture();
  await store.save(input);
  storage.write = async () => { throw new Error('sensitive-native-payload'); };
  await assert.rejects(store.save({ ...input, apiKey: 'replacement' }), (error) => /未保存/.test(error.message) && !error.message.includes('sensitive-native-payload'));
  assert.equal((await store.load()).apiKey, input.apiKey);
  storage.read = async () => { throw new Error('sensitive-native-payload'); };
  await assert.rejects(store.load(), /无法读取手机安全存储/);
});
test('corrupt or future data is blocked without deleting it, explicit removal recovers', async () => {
  const { storage, store } = fixture();
  for (const value of ['{bad', JSON.stringify({ schemaVersion: 2, ...input }), JSON.stringify({ schemaVersion: 1, ...input, apiKey: 42 })]) {
    await storage.write(value);
    await assert.rejects(store.load(), /重新设置/);
    assert.equal(await storage.read(), value);
  }
  await store.remove();
  assert.equal(await store.load(), null);
});
test('concurrent save/remove cannot race and later restore a deleted key', async () => {
  const { storage, store } = fixture();
  let release;
  const original = storage.write;
  storage.write = async (value) => { await new Promise(resolve => { release = resolve; }); await original(value); };
  const saving = store.save(input);
  await assert.rejects(store.remove(), /正在保存/);
  await assert.rejects(store.save(input), /正在保存/);
  release();
  await saving;
  await store.remove();
  assert.equal(await store.load(), null);
});
