import assert from 'node:assert/strict';
import test from 'node:test';
import { SettingsError } from '../src/settings/credential-store.ts';
import { requirePlanSettings } from '../src/space/plan-settings.ts';

const configured = {ready: true, config: {baseUrl: 'https://example.invalid/v1', model: 'test'}, storageError: null};

test('configured settings allow plan generation', () => {
  assert.doesNotThrow(() => requirePlanSettings(configured));
});

test('loading and unconfigured settings require configuration', () => {
  for (const state of [{...configured, ready: false}, {...configured, config: null}]) {
    assert.throws(() => requirePlanSettings(state), {code: 'configuration_required'});
  }
});

test('secure storage failure remains a configuration error instead of appearing unconfigured', () => {
  assert.throws(
    () => requirePlanSettings({...configured, config: null, storageError: 'fixed safe storage message'}),
    error => error instanceof SettingsError && error.message === 'fixed safe storage message',
  );
});
