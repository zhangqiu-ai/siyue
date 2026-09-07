import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCompatibleModels, ModelCatalogError } from '../src/settings/model-catalog.ts';

const config = { baseUrl: ' https://example.com/v1/// ', apiKey: ' synthetic-key ' };
const run = (fetcher, signal = new AbortController().signal) => fetchCompatibleModels(config, signal, fetcher);
const json = (value) => async () => Response.json(value);

test('GET models normalizes URL, uses bearer with redirects disabled, deduplicates IDs', async () => {
  let calls = 0;
  assert.deepEqual(await run(async (url, init) => {
    calls++;
    assert.equal(url, 'https://example.com/v1/models');
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-key');
    assert.equal(init.body, undefined);
    return Response.json({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-b' }] });
  }), ['model-b', 'model-a']);
  assert.equal(calls, 1);
});

for (const packet of [null, [], {}, { data: {} }, { data: [null] }, { data: [{ id: 4 }] }, { data: [{ id: ' ' }] }, { data: [{ id: 'a\nb' }] }, { data: [{ id: 'a'.repeat(201) }] }, { error: 'secret', data: [{ id: 'a' }] }]) {
  test(`rejects malformed response ${JSON.stringify(packet).slice(0, 45)}`, async () => {
    await assert.rejects(run(json(packet)), /无法识别/);
  });
}

test('empty model list is an actionable error', async () => {
  await assert.rejects(run(json({ data: [] })), /未返回可用模型/);
});

test('invalid JSON response does not expose its body', async () => {
  await assert.rejects(run(async () => new Response('secret-key')), /无法识别/);
});

for (const status of [401, 403, 429, 404, 500]) {
  test(`HTTP ${status} never exposes response body or retries`, async () => {
    let calls = 0;
    await assert.rejects(run(async () => {
      calls++;
      return new Response('synthetic-key hostile body', { status });
    }), (error) => error instanceof ModelCatalogError && !/synthetic|hostile/.test(error.message));
    assert.equal(calls, 1);
  });
}

test('network errors are sanitized', async () => {
  await assert.rejects(run(async () => { throw new Error('synthetic-key'); }), (error) => error instanceof ModelCatalogError && /无法连接/.test(error.message) && !error.message.includes('synthetic'));
});

test('pre-cancelled request never sends key', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run(async () => assert.fail('must not fetch'), controller.signal), /已取消/);
});

test('cancellation terminates pending request even when fetch does not settle', async () => {
  const controller = new AbortController();
  let requestSignal;
  const pending = run(async (_url, init) => { requestSignal = init.signal; return new Promise(() => {}); }, controller.signal);
  controller.abort();
  await assert.rejects(pending, /已取消/);
  assert.equal(requestSignal.aborted, true);
});

test('15-second deadline terminates pending response body and aborts transport', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal;
  let reading = false;
  const pending = run(async (_url, init) => {
    requestSignal = init.signal;
    return { ok: true, json: () => { reading = true; return new Promise(() => {}); } };
  });
  await Promise.resolve();
  assert.equal(reading, true);
  t.mock.timers.tick(15_000);
  await assert.rejects(pending, /超时/);
  assert.equal(requestSignal.aborted, true);
});

test('invalid endpoint or key sends no request', async () => {
  for (const input of [{ ...config, baseUrl: 'http://example.com' }, { ...config, baseUrl: 'https://example.com/?secret=1' }, { ...config, apiKey: '' }, { ...config, apiKey: 'a\nb' }]) {
    await assert.rejects(fetchCompatibleModels(input, new AbortController().signal, async () => assert.fail('must not fetch')));
  }
});
