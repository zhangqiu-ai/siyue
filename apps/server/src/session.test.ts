import assert from 'node:assert/strict';
import test from 'node:test';
import { request as httpRequest } from 'node:http';
import { createApp } from './app.js';
const route = '/v1/account/session';
const identity = () => ({subjectId: 'synthetic-user', subjectKind: 'adult', sessionId: 'synthetic-session', expiresAt: new Date(Date.now() + 60_000).toISOString()});
const headers = {authorization: 'Bearer synthetic-secret'};

test('unconfigured verifier fails closed without caching', async t => {
  const app = createApp(); t.after(() => app.close());
  const response = await app.inject({url: route, headers});
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), {error: 'unauthorized'});
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('verified identity is strictly projected without granting roles or spaces', async t => {
  const value = identity();
  const app = createApp({sessionVerifier: async (token, signal) => {
    assert.equal(token, 'synthetic-secret'); assert.equal(signal.aborted, false); return value;
  }}); t.after(() => app.close());
  const response = await app.inject({url: route, headers});
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), value);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.body.includes('synthetic-secret'), false);
});

for (const value of [null, {...identity(), subjectKind: 'admin'}, {...identity(), role: 'owner'}, {...identity(), expiresAt: '2000-01-01T00:00:00.000Z'}, {...identity(), sessionId: ''}]) {
  test('invalid or expired verifier result returns generic denial', async t => {
    const app = createApp({sessionVerifier: async () => value}); t.after(() => app.close());
    const response = await app.inject({url: route, headers});
    assert.equal(response.statusCode, 401); assert.deepEqual(response.json(), {error: 'unauthorized'});
  });
}

test('query, body and ambiguous bearer credentials never invoke verifier', async t => {
  let calls = 0;
  const app = createApp({sessionVerifier: async () => { calls++; return identity(); }}); t.after(() => app.close());
  for (const request of [
    {url: route + '?actor=owner', headers},
    {url: route + '?token=synthetic-secret', headers},
    {url: route, headers: {}},
    {url: route, headers: {authorization: 'Basic synthetic-secret'}},
    {url: route, headers: {authorization: 'Bearer a, Bearer b'}},
    {url: route, headers: {authorization: ['Bearer a', 'Bearer b']}},
    {url: route, headers: {authorization: 'Bearer ' + 'x'.repeat(4097)}},
    {url: route, headers: {...headers, 'content-length': '2'}, payload: '{}'},
  ]) {
    const response = await app.inject(request);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), {error: 'unauthorized'});
  }
  assert.equal(calls, 0);
});

test('hanging verifier is aborted and late success cannot replace denial', async t => {
  let signal: AbortSignal | undefined;
  let finish: ((value: unknown) => void) | undefined;
  const app = createApp({sessionTimeoutMs: 5, sessionVerifier: async (_token, current) => {
    signal = current; return new Promise(resolve => {finish = resolve;});
  }}); t.after(() => app.close());
  const response = await app.inject({url: route, headers});
  assert.equal(response.statusCode, 401); assert.equal(signal?.aborted, true);
  finish?.(identity());
  assert.deepEqual(response.json(), {error: 'unauthorized'});
});

test('verifier exceptions never expose tokens or error details', async t => {
  const app = createApp({sessionVerifier: async () => {throw new Error('synthetic-secret');}}); t.after(() => app.close());
  const response = await app.inject({url: route, headers});
  assert.equal(response.statusCode, 401); assert.deepEqual(response.json(), {error: 'unauthorized'});
});

test('loopback connection rejects duplicate Authorization headers regardless of case', async t => {
  let calls = 0;
  const app = createApp({sessionVerifier: async () => {calls++; return identity();}});
  t.after(() => app.close());
  const address = await app.listen({host: '127.0.0.1', port: 0});
  const result = await new Promise<{status: number | undefined; body: string}>(resolve => {
    const req = httpRequest(`${address}${route}`, {headers: ['Host', new URL(address).host, 'Authorization', 'Bearer one', 'authorization', 'Bearer two']}, response => {
      let body = '';
      response.on('data', chunk => {body += chunk;});
      response.on('end', () => resolve({status: response.statusCode, body}));
    });
    req.end();
  });
  assert.equal(result.status, 401);
  assert.deepEqual(JSON.parse(result.body), {error: 'unauthorized'});
  assert.equal(calls, 0);
});

test('loopback disconnect aborts verifier even when it ignores cancellation', async t => {
  let started!: () => void;
  let aborted!: () => void;
  const start = new Promise<void>(resolve => {started = resolve;});
  const stop = new Promise<void>(resolve => {aborted = resolve;});
  const app = createApp({sessionVerifier: async (_token, signal) => {
    signal.addEventListener('abort', aborted, {once: true});
    started();
    return new Promise(() => {});
  }});
  t.after(() => app.close());
  const address = await app.listen({host: '127.0.0.1', port: 0});
  const req = httpRequest(`${address}${route}`, {headers});
  req.on('error', () => {});
  t.after(() => req.destroy());
  req.end();
  await start;
  req.destroy();
  await stop;
});

test('expiry is checked after asynchronous verification, not at admission', async t => {
  const app = createApp({sessionVerifier: async () => {
    const result = {...identity(), expiresAt: new Date(Date.now() + 5).toISOString()};
    await new Promise(resolve => setTimeout(resolve, 15));
    return result;
  }});
  t.after(() => app.close());
  const response = await app.inject({url: route, headers});
  assert.equal(response.statusCode, 401);
});

test('session verification cap rejects excess calls until the actual verifier settles', async t => {
  let finish!: (value: unknown) => void;
  let calls = 0;
  const app = createApp({maxConcurrentSessionVerifications: 1, sessionTimeoutMs: 10, sessionVerifier: async () => {
    calls++;
    if (calls === 1) return new Promise(resolve => {finish = resolve;});
    return identity();
  }});
  t.after(() => app.close());
  const timedOut = await app.inject({url: route, headers});
  assert.equal(timedOut.statusCode, 401);
  const excess = await app.inject({url: route, headers});
  assert.equal(excess.statusCode, 429);
  assert.deepEqual(excess.json(), {error: 'busy'});
  assert.equal(excess.headers['cache-control'], 'no-store');
  assert.equal(calls, 1);
  finish(identity());
  await new Promise(resolve => setImmediate(resolve));
  const next = await app.inject({url: route, headers});
  assert.equal(next.statusCode, 200);
  assert.equal(calls, 2);
});

test('late verifier rejection releases capacity without exposing its error', async t => {
  let fail!: (error: Error) => void;
  let calls = 0;
  const app = createApp({maxConcurrentSessionVerifications: 1, sessionTimeoutMs: 10, sessionVerifier: async () => {
    calls++;
    if (calls === 1) return new Promise((_resolve, reject) => {fail = reject;});
    return identity();
  }});
  t.after(() => app.close());
  assert.equal((await app.inject({url: route, headers})).statusCode, 401);
  assert.equal((await app.inject({url: route, headers})).statusCode, 429);
  fail(new Error('synthetic-private-error'));
  await new Promise(resolve => setImmediate(resolve));
  const response = await app.inject({url: route, headers});
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.includes('synthetic-private-error'), false);
});

test('synchronous verifier exceptions release capacity and invalid requests do not consume it', async t => {
  let calls = 0;
  const app = createApp({maxConcurrentSessionVerifications: 1, sessionVerifier: () => {
    calls++;
    if (calls === 1) throw new Error('synthetic-secret');
    return Promise.resolve(identity());
  }});
  t.after(() => app.close());
  assert.equal((await app.inject({url: route})).statusCode, 401);
  assert.equal(calls, 0);
  assert.equal((await app.inject({url: route, headers})).statusCode, 401);
  assert.equal((await app.inject({url: route, headers})).statusCode, 200);
  assert.equal(calls, 2);
});
