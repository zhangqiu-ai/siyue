import assert from 'node:assert/strict';
import test from 'node:test';
import { createAISettingsSession, removeAndReplaceSession, replaceSessionForAppState, saveAndReplaceSession } from '../src/settings/ai-settings-session.ts';

const input = {baseUrl: 'https://example.invalid/v1', model: 'test', apiKey: 'synthetic'};

test('replacing a settings session aborts the captured signal and creates an active successor', () => {
  const session = createAISettingsSession();
  const captured = session.getSignal();
  session.replace();
  assert.equal(captured.aborted, true);
  assert.equal(session.getSignal().aborted, false);
  assert.notEqual(session.getSignal(), captured);
  session.dispose();
  assert.equal(session.getSignal().aborted, true);
});

test('successful save and remove replace the session only after secure storage succeeds', async () => {
  const session = createAISettingsSession();
  let captured = session.getSignal();
  const store = {save: async value => value, remove: async () => {}};
  assert.deepEqual(await saveAndReplaceSession(store, input, session), input);
  assert.equal(captured.aborted, true);
  captured = session.getSignal();
  await removeAndReplaceSession(store, session);
  assert.equal(captured.aborted, true);
  assert.equal(session.getSignal().aborted, false);
});

test('failed save or remove preserves the current settings session', async () => {
  const session = createAISettingsSession();
  const captured = session.getSignal();
  const failure = new Error('synthetic storage failure');
  await assert.rejects(saveAndReplaceSession({save: async () => { throw failure; }, remove: async () => {}}, input, session), failure);
  assert.equal(session.getSignal(), captured);
  assert.equal(captured.aborted, false);
  await assert.rejects(removeAndReplaceSession({save: async value => value, remove: async () => { throw failure; }}, session), failure);
  assert.equal(session.getSignal(), captured);
  assert.equal(captured.aborted, false);
});

test('AppState keeps the active session and replaces it for every non-active state', () => {
  const session = createAISettingsSession();
  const active = session.getSignal();
  assert.equal(replaceSessionForAppState(session, 'active'), false);
  assert.equal(session.getSignal(), active);
  for (const state of ['inactive', 'background', 'unknown', 'extension']) {
    const captured = session.getSignal();
    assert.equal(replaceSessionForAppState(session, state), true);
    assert.equal(captured.aborted, true);
    assert.equal(session.getSignal().aborted, false);
    assert.notEqual(session.getSignal(), captured);
  }
});
