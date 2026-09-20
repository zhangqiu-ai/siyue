import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AccountSessionError,
  createAccountSessionClient,
  createAccountSessionCoordinator,
  type AccountSessionClient,
} from './account-session-client.js';

const identity = (subjectId = 'account-a') => ({
  subjectId,
  subjectKind: 'adult' as const,
  sessionId: `session-${subjectId}`,
  expiresAt: '2026-09-14T00:00:00.000Z',
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {'content-type': 'application/json'},
});
const errorCode = (code: string) => (error: unknown) => error instanceof AccountSessionError && error.code === code;

test('session query sends the credential only in a non-redirecting Authorization header', async () => {
  let called = false;
  const client = createAccountSessionClient({baseUrl: 'https://api.example.test', now: () => Date.parse('2026-09-13T00:00:00.000Z'), fetcher: async (url, init) => {
    called = true;
    assert.equal(url, 'https://api.example.test/v1/account/session');
    assert.equal(url.includes('synthetic-secret'), false);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer synthetic-secret');
    assert.equal(init.body, undefined);
    return json(identity());
  }});
  assert.deepEqual(await client.query('synthetic-secret'), identity());
  assert.equal(called, true);
});

test('configuration and credentials are rejected before transport', async () => {
  for (const baseUrl of ['not a url', 'http://api.example.test', 'https://user:pass@api.example.test', 'https://api.example.test/path', 'https://api.example.test?token=x']) {
    assert.throws(() => createAccountSessionClient({baseUrl, fetcher: async () => json(identity())}), errorCode('invalid_config'));
  }
  let calls = 0;
  const client = createAccountSessionClient({baseUrl: 'http://127.0.0.1:3000', fetcher: async () => {calls++; return json(identity());}});
  for (const token of ['', 'has space', 'x'.repeat(4097)]) await assert.rejects(client.query(token), errorCode('invalid_credential'));
  assert.equal(calls, 0);
});

test('denials never consume or expose response bodies', async () => {
  for (const [status, expected] of [[401, 'unauthorized'], [429, 'busy'], [500, 'unavailable']] as const) {
    let bodyRead = false;
    const response = json({error: 'synthetic-private-token'}, status);
    Object.defineProperty(response, 'body', {get() {bodyRead = true; return null;}});
    const client = createAccountSessionClient({baseUrl: 'https://api.example.test', fetcher: async () => response});
    await assert.rejects(client.query('token'), errorCode(expected));
    assert.equal(bodyRead, false);
  }
});

test('strict response validation rejects expired, oversized and authority-bearing payloads', async () => {
  const cases: Array<[Response, string]> = [
    [json({...identity(), role: 'owner'}), 'invalid_response'],
    [json({...identity(), expiresAt: '2026-09-12T00:00:00.000Z'}), 'expired'],
    [new Response('x'.repeat(5000), {headers: {'content-type': 'application/json'}}), 'invalid_response'],
    [new Response('{broken', {headers: {'content-type': 'application/json'}}), 'invalid_response'],
    [new Response(JSON.stringify(identity()), {headers: {'content-type': 'text/plain'}}), 'invalid_response'],
  ];
  for (const [response, code] of cases) {
    const client = createAccountSessionClient({baseUrl: 'https://api.example.test', now: () => Date.parse('2026-09-13T00:00:00.000Z'), fetcher: async () => response});
    await assert.rejects(client.query('token'), errorCode(code));
  }
});

test('cancellation and deadline settle even when the transport ignores AbortSignal', async () => {
  const never = () => new Promise<Response>(() => {});
  const cancelled = createAccountSessionClient({baseUrl: 'https://api.example.test', timeoutMs: 500, fetcher: never});
  const controller = new AbortController();
  const pending = cancelled.query('token', {signal: controller.signal});
  controller.abort();
  await assert.rejects(pending, errorCode('cancelled'));
  const timed = createAccountSessionClient({baseUrl: 'https://api.example.test', timeoutMs: 5, fetcher: never});
  await assert.rejects(timed.query('token'), errorCode('timeout'));
});

test('response stream failures are reduced to a controlled transport error', async () => {
  const response = new Response(new ReadableStream({start(controller) { controller.error(new Error('private transport detail')); }}), {
    headers: {'content-type': 'application/json'},
  });
  const client = createAccountSessionClient({baseUrl: 'https://api.example.test', fetcher: async () => response});
  await assert.rejects(client.query('token'), errorCode('unavailable'));
});

test('deadline and cancellation cover a response body that never settles', async () => {
  const body = () => new Response(new ReadableStream({pull: () => new Promise(() => {})}), {
    headers: {'content-type': 'application/json'},
  });
  const timed = createAccountSessionClient({baseUrl: 'https://api.example.test', timeoutMs: 5, fetcher: async () => body()});
  await assert.rejects(timed.query('token'), errorCode('timeout'));
  const cancelled = createAccountSessionClient({baseUrl: 'https://api.example.test', timeoutMs: 500, fetcher: async () => body()});
  const controller = new AbortController();
  const pending = cancelled.query('token', {signal: controller.signal});
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, errorCode('cancelled'));
});

test('credential replacement discards late success and late denial from the previous account', async () => {
  const requests: Array<{token: string; resolve: (value: ReturnType<typeof identity>) => void; reject: (error: unknown) => void}> = [];
  const client: AccountSessionClient = {query: (token) => new Promise((resolve, reject) => requests.push({token, resolve, reject}))};
  const coordinator = createAccountSessionCoordinator(client);
  coordinator.setCredential('token-a');
  const oldSuccess = coordinator.refresh();
  coordinator.setCredential('token-b');
  const current = coordinator.refresh();
  requests[1]!.resolve(identity('account-b'));
  assert.deepEqual(await current, {status: 'ready', session: identity('account-b')});
  requests[0]!.resolve(identity('account-a'));
  assert.deepEqual(await oldSuccess, {status: 'stale'});
  assert.equal(coordinator.getState().status, 'ready');
  assert.equal(coordinator.getState().session?.subjectId, 'account-b');

  coordinator.setCredential('token-a2');
  const oldDenial = coordinator.refresh();
  coordinator.setCredential('token-b2');
  const latest = coordinator.refresh();
  requests[3]!.resolve(identity('account-b2'));
  await latest;
  requests[2]!.reject(new AccountSessionError('unauthorized'));
  assert.deepEqual(await oldDenial, {status: 'stale'});
  assert.equal(coordinator.getState().session?.subjectId, 'account-b2');
});

test('current unauthorized response clears only the verified session state', async () => {
  let rejectNext = false;
  const client: AccountSessionClient = {async query() {
    if (rejectNext) throw new AccountSessionError('unauthorized');
    return identity();
  }};
  const coordinator = createAccountSessionCoordinator(client);
  coordinator.setCredential('token');
  await coordinator.refresh();
  assert.equal(coordinator.getState().status, 'ready');
  rejectNext = true;
  await assert.rejects(coordinator.refresh(), errorCode('unauthorized'));
  assert.deepEqual(coordinator.getState(), {status: 'signed-out', generation: 1, session: null, error: 'unauthorized'});
});
