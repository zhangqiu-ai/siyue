import { test, expect } from 'playwright/test';
import { createAccountSessionClient, AccountSessionError } from '../../packages/adapters/dist/index.js';
import { createApp } from '../../apps/server/dist/app.js';

const identity = () => ({
  subjectId: 'e2e-account',
  subjectKind: 'adult',
  sessionId: 'e2e-session',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
async function expectCode(promise, code) {
  let error;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(AccountSessionError);
  expect(error.code).toBe(code);
}

test('account session client verifies identity through the real loopback server', async () => {
  const app = createApp({sessionVerifier: async (token) => {
    expect(token).toBe('e2e-token');
    return identity();
  }});
  const address = await app.listen({host: '127.0.0.1', port: 0});
  try {
    const client = createAccountSessionClient({baseUrl: address, fetcher: fetch});
    const session = await client.query('e2e-token');
    expect(session).toMatchObject({subjectId: 'e2e-account', subjectKind: 'adult', sessionId: 'e2e-session'});
  } finally {
    await app.close();
  }
});

test('real HTTP denial and verifier timeout map to controlled client errors', async () => {
  const denied = createApp();
  const deniedAddress = await denied.listen({host: '127.0.0.1', port: 0});
  try {
    await expectCode(createAccountSessionClient({baseUrl: deniedAddress, fetcher: fetch}).query('e2e-token'), 'unauthorized');
  } finally {
    await denied.close();
  }

  const hanging = createApp({sessionTimeoutMs: 10, sessionVerifier: async () => new Promise(() => {})});
  const hangingAddress = await hanging.listen({host: '127.0.0.1', port: 0});
  try {
    await expectCode(createAccountSessionClient({baseUrl: hangingAddress, timeoutMs: 1_000, fetcher: fetch}).query('e2e-token'), 'unauthorized');
  } finally {
    await hanging.close();
  }
});
