import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDeletionLedgerRuntimeConfig } from './runtime-config.js';

const url = 'postgresql://siyue_deletion_ledger_app:ledger-app-credential@localhost/siyue_deletion_ledger';
const complete = {
  SIYUE_DELETION_LEDGER_URL: url,
  SIYUE_DELETION_LEDGER_DATABASE: 'siyue_deletion_ledger',
  SIYUE_DELETION_LEDGER_ENVIRONMENT: 'test',
};
const read = (env: NodeJS.ProcessEnv, mainEnvironment = 'test') =>
  readDeletionLedgerRuntimeConfig(env, mainEnvironment);

test('an absent ledger configuration returns null so the deletion endpoint stays closed', () => {
  assert.equal(read({}), null);
  assert.equal(read({ SIYUE_ENVIRONMENT: 'test', SIYUE_DATABASE_NAME: 'siyue_test' }), null);
  assert.equal(read({ SIYUE_DELETION_LEDGER_URL: '   ', SIYUE_DELETION_LEDGER_DATABASE: ' ',
    SIYUE_DELETION_LEDGER_ENVIRONMENT: '' }), null);
});

test('a partial ledger configuration is rejected instead of disabling the feature', () => {
  for (const partial of [
    { SIYUE_DELETION_LEDGER_URL: url },
    { SIYUE_DELETION_LEDGER_DATABASE: 'siyue_deletion_ledger' },
    { SIYUE_DELETION_LEDGER_ENVIRONMENT: 'test' },
    { SIYUE_DELETION_LEDGER_URL: url, SIYUE_DELETION_LEDGER_DATABASE: 'siyue_deletion_ledger' },
    { SIYUE_DELETION_LEDGER_URL: url, SIYUE_DELETION_LEDGER_ENVIRONMENT: 'test' },
    { ...complete, SIYUE_DELETION_LEDGER_DATABASE: '' },
    { ...complete, SIYUE_DELETION_LEDGER_ENVIRONMENT: '   ' },
  ]) assert.throws(() => read(partial), { message: 'invalid_config:SIYUE_DELETION_LEDGER_CONFIG_PARTIAL' });
});

test('a complete ledger configuration returns the connection string and its identity', () => {
  assert.deepEqual(read(complete),
    { connectionString: url, identity: { database: 'siyue_deletion_ledger', environment: 'test' } });
  const padded = { SIYUE_DELETION_LEDGER_URL: ` ${url} `,
    SIYUE_DELETION_LEDGER_DATABASE: ' siyue_deletion_ledger ',
    SIYUE_DELETION_LEDGER_ENVIRONMENT: ' test ' };
  assert.deepEqual(read(padded), { connectionString: url,
    identity: { database: 'siyue_deletion_ledger', environment: 'test' } });
  assert.deepEqual(read({ ...complete, SIYUE_DELETION_LEDGER_DATABASE: 'siyue_deletion_ledger_eu',
    SIYUE_DELETION_LEDGER_URL: 'postgres://siyue_deletion_ledger_app@localhost/siyue_deletion_ledger_eu',
    SIYUE_DELETION_LEDGER_ENVIRONMENT: 'staging' }, 'staging').identity,
    { database: 'siyue_deletion_ledger_eu', environment: 'staging' });
});

test('local peer authentication without a password is accepted', () => {
  const socket = 'postgresql://siyue_deletion_ledger_app@localhost/siyue_deletion_ledger?host=%2Ftmp%2Fsiyue-ledger';
  assert.deepEqual(read({ ...complete, SIYUE_DELETION_LEDGER_URL: socket }).connectionString, socket);
});

test('the ledger URL must be the provisioned postgres ledger identity', () => {
  for (const rejected of [
    'http://siyue_deletion_ledger_app:ledger-app-credential@localhost/siyue_deletion_ledger',
    'postgresql://siyue_app:ledger-app-credential@localhost/siyue_deletion_ledger',
    'postgresql://siyue_deletion_ledger_owner@localhost/siyue_deletion_ledger',
    'postgresql://siyue_deletion_ledger_app:ledger-app-credential@localhost/siyue_test',
    'postgresql://siyue_deletion_ledger_app:ledger-app-credential@localhost/siyue_deletion_ledger/extra',
    'postgresql://siyue_deletion_ledger_app:ledger-app-credential@localhost/siyue_deletion_ledger#fragment',
    'postgresql://siyue_deletion_ledger_app:password@localhost/siyue_deletion_ledger',
    'postgresql://siyue_deletion_ledger_app:PASSWORD@localhost/siyue_deletion_ledger',
    'postgresql://siyue_deletion_ledger_app:changeme@localhost/siyue_deletion_ledger',
    'postgresql://siyue_deletion_ledger_app:%ZZ@localhost/siyue_deletion_ledger',
    'not a connection string',
  ]) assert.throws(() => read({ ...complete, SIYUE_DELETION_LEDGER_URL: rejected }),
    { message: 'invalid_config:SIYUE_DELETION_LEDGER_URL' }, rejected);
});

test('the expected ledger database name is validated independently of the URL', () => {
  for (const rejected of ['siyue_deletion', 'siyue_deletion_ledger_', 'Siyue_Deletion_Ledger',
    'siyue_deletion_ledger-EU', 'other_ledger']) assert.throws(() => read({ ...complete,
      SIYUE_DELETION_LEDGER_DATABASE: rejected }),
      { message: 'invalid_config:SIYUE_DELETION_LEDGER_DATABASE' }, rejected);
});

test('the ledger environment must be known and equal the main configured environment', () => {
  for (const rejected of ['dev', 'prod', 'TEST', 'development ']) assert.throws(() => read({ ...complete,
    SIYUE_DELETION_LEDGER_ENVIRONMENT: rejected }),
    { message: 'invalid_config:SIYUE_DELETION_LEDGER_ENVIRONMENT' }, rejected);
  for (const mainEnvironment of ['development', 'staging', 'production'])
    assert.throws(() => read(complete, mainEnvironment),
      { message: 'invalid_config:SIYUE_DELETION_LEDGER_ENVIRONMENT' }, mainEnvironment);
  for (const mainEnvironment of ['', 'dev'])
    assert.throws(() => read(complete, mainEnvironment),
      { message: 'invalid_config:SIYUE_ENVIRONMENT' }, mainEnvironment);
});

test('rejections never repeat the connection string or its password', () => {
  for (const rejected of ['postgresql://siyue_deletion_ledger_app:hunter2-placeholder@localhost/siyue_test',
    'postgresql://siyue_app:hunter2-placeholder@localhost/siyue_deletion_ledger',
    'postgresql://siyue_deletion_ledger_app:hunter2-placeholder@localhost/siyue_deletion_ledger#fragment']) {
    assert.throws(() => read({ ...complete, SIYUE_DELETION_LEDGER_URL: rejected }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes('hunter2-placeholder'), false);
      assert.equal(error.message.includes(rejected), false);
      return true;
    });
  }
});
