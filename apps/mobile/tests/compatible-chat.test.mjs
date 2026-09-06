import assert from 'node:assert/strict';
import test from 'node:test';
import { CompatibleChatError, normalizeBaseUrl, streamCompatibleReply } from '../src/chat/compatible-transport.ts';

const config = { baseUrl: 'https://example.com/v1/', model: 'test-model', apiKey: 'synthetic-test-key' };
const messages = [{ role: 'user', content: '测试' }];
const event = (text) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\r\n\r\n`;
const collect = async (stream) => { const results = []; for await (const value of stream) results.push(value); return results; };
function response(bytes, split = bytes.length) {
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) return controller.close();
    controller.enqueue(bytes.slice(offset, offset += split));
  } }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
const fetchText = (text, split) => async () => response(new TextEncoder().encode(text), split);
const run = (fetcher, signal = new AbortController().signal) => streamCompatibleReply(config, messages, signal, fetcher);

test('normalizes HTTPS base URLs and rejects credential/query/hash/non-HTTPS URLs', () => {
  assert.equal(normalizeBaseUrl(' https://example.com/v1/// '), 'https://example.com/v1');
  for (const url of ['http://example.com', 'https://a:b@example.com', 'https://example.com/?key=secret', 'https://example.com/#part', 'nonsense']) {
    assert.throws(() => normalizeBaseUrl(url), CompatibleChatError);
  }
});

test('streams accumulated content with UTF8 and CRLF split at every byte, excludes reasoning', async () => {
  const hidden = 'data: {"choices":[{"index":0,"delta":{"reasoning_content":"private"}}]}\r\n\r\n';
  const chunks = await collect(run(fetchText(': keepalive\r\n\r\n' + hidden + event('你') + event('好🌙') + 'data: [DONE]\r\n\r\n', 1)));
  assert.deepEqual(chunks, ['你', '你好🌙']);
});

test('posts only supplied messages with fixed output budget and redirects disabled', async () => {
  let calls = 0;
  await collect(run(async (url, init) => {
    calls++;
    assert.equal(url, 'https://example.com/v1/chat/completions');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-test-key');
    assert.deepEqual(JSON.parse(init.body), { model: 'test-model', messages, stream: true, max_tokens: 2048 });
    return response(new TextEncoder().encode(event('OK') + 'data: [DONE]\n\n'));
  }));
  assert.equal(calls, 1);
});

for (const status of [401, 403, 429, 500]) {
  test(`HTTP ${status} uses safe error and never reads hostile body`, async () => {
    let calls = 0;
    await assert.rejects(collect(run(async () => {
      calls++;
      return new Response('secret-key hostile server instructions', { status });
    })), (error) => error instanceof CompatibleChatError && !/secret|hostile/.test(error.message));
    assert.equal(calls, 1);
  });
}

test('incomplete stream preserves partial output but fails instead of declaring success', async () => {
  const stream = run(fetchText(event('部分')));
  assert.deepEqual(await stream.next(), { value: '部分', done: false });
  await assert.rejects(stream.next(), /提前中断/);
});

for (const data of ['{bad-json', '{"error":{"message":"secret"}}', '{"choices":[{"delta":{"content":4}}]}']) {
  test(`malformed stream is sanitized: ${data.slice(0, 15)}`, async () => {
    await assert.rejects(collect(run(fetchText(`data: ${data}\n\n`))), (error) => error instanceof CompatibleChatError && !error.message.includes('secret'));
  });
}

test('pre-cancellation sends no request', async () => {
  const abort = new AbortController(); abort.abort();
  assert.deepEqual(await collect(run(async () => { assert.fail('network must not run'); }, abort.signal)), []);
});

test('cancellation unblocks pending reader, keeps partial text and cancels source', async () => {
  const abort = new AbortController();
  let cancelled = false;
  const stream = run(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(event('已有'))); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/event-stream' } }), abort.signal);
  assert.equal((await stream.next()).value, '已有');
  const pending = stream.next(); abort.abort();
  assert.equal((await pending).done, true);
  assert.equal(cancelled, true);
});

test('network exceptions never expose arbitrary error details', async () => {
  await assert.rejects(collect(run(async () => { throw new Error('secret-key'); })), (error) => error instanceof CompatibleChatError && !error.message.includes('secret'));
});

test('consumer exit cancels reader', async () => {
  let cancelled = false;
  for await (const _ of run(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(event('你好'))); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/event-stream' } }))) break;
  assert.equal(cancelled, true);
});

test('90-second deadline aborts hanging response without exposing transport error', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal;
  const stream = run(async (_url, init) => {
    requestSignal = init.signal;
    return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('secret transport details')), { once: true }));
  });
  const pending = stream.next();
  t.mock.timers.tick(90_000);
  await assert.rejects(pending, /超时/);
  assert.equal(requestSignal.aborted, true);
});

test('successful DONE releases stream rather than waiting for server to close connection', async () => {
  let cancelled = false;
  const values = await collect(run(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(event('完成') + 'data: [DONE]\n\n')); },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/event-stream' } })));
  assert.deepEqual(values, ['完成']);
  assert.equal(cancelled, true);
});

test('empty completion and non-SSE response are not reported as successful chat', async () => {
  await assert.rejects(collect(run(fetchText('data: [DONE]\n\n'))), /没有返回文字/);
  await assert.rejects(collect(run(async () => new Response('{"secret":"sensitive"}'))), /无法识别/);
});

for (const [reason, expected] of [['length', /长度上限/], ['content_filter', /服务商中止/], ['tool_calls', /不支持/], ['function_call', /不支持/], ['unsupported', /不支持/], ['unknown-secret-reason', /不支持/]]) {
  test(`finish_reason ${reason} preserves final text and reports incomplete reply`, async () => {
    const finalEvent = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '末段' }, finish_reason: reason }] })}\n\n`;
    const stream = run(fetchText(event('前段') + finalEvent + 'data: [DONE]\n\n'));
    assert.equal((await stream.next()).value, '前段');
    assert.equal((await stream.next()).value, '前段末段');
    await assert.rejects(stream.next(), (error) => error instanceof CompatibleChatError && expected.test(error.message) && !error.message.includes('secret'));
  });
}

test('normal stop followed by usage and DONE completes successfully', async () => {
  const end = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    'data: {"choices":[],"usage":{"total_tokens":10}}\n\n' + 'data: [DONE]\n\n';
  assert.deepEqual(await collect(run(fetchText(event('完整') + end))), ['完整']);
});

test('tool-call delta is rejected even if provider omits finish reason', async () => {
  const tool = 'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"id":"call-1","function":{"name":"secret"}}]}}]}\n\n';
  await assert.rejects(collect(run(fetchText(tool + 'data: [DONE]\n\n'))), /不支持/);
});
