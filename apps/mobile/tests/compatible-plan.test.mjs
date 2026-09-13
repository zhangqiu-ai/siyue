import assert from 'node:assert/strict';
import test from 'node:test';
import { generateCompatiblePlan } from '../src/space/compatible-plan.ts';
const plan = { title: 'Practice English', projectTitles: ['Work communication'], taskTitles: ['Introduce yourself'] };
function setup(body = JSON.stringify(plan)) {
  const session = new AbortController();
  const calls = [];
  const deps = {
    getSessionSignal: () => session.signal,
    isActive: () => true,
    getCredentials: async () => ({ baseUrl: 'https://example.invalid/v1', model: 'test', apiKey: 'synthetic' }),
    fetcher: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: body } }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    },
  };
  return { deps, session, calls };
}
test('real transport returns validated single-project draft and sends only explicit input', async () => {
  const { deps, calls } = setup();
  assert.deepEqual(await generateCompatiblePlan('Practice English', deps), plan);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].messages.filter(x => x.role === 'user'), [{ role: 'user', content: 'Practice English' }]);
  assert.equal(calls[0].max_tokens, 2048);
});
for (const body of ['not JSON', '```json\n{}\n```', JSON.stringify({ ...plan, approved: true }), JSON.stringify({ ...plan, projectTitles: [] }), JSON.stringify({ ...plan, projectTitles: ['A', 'B'] })]) {
  test(`rejects invalid model output: ${body.slice(0, 30)}`, async () => {
    const { deps, calls } = setup(body);
    await assert.rejects(generateCompatiblePlan('Goal', deps), error => error.code === 'invalid_output' && !error.message.includes(body));
    assert.equal(calls.length, 1);
  });
}
test('inactive start performs no credential access or request', async () => {
  const { deps, calls } = setup();
  deps.isActive = () => false;
  deps.getCredentials = async () => { throw Error('must not read'); };
  await assert.rejects(generateCompatiblePlan('Goal', deps), error => error.code === 'cancelled');
  assert.equal(calls.length, 0);
});
test('configuration invalidated during credential read cannot start request', async () => {
  const { deps, session, calls } = setup();
  const read = deps.getCredentials;
  deps.getCredentials = async () => { session.abort(); return read(); };
  await assert.rejects(generateCompatiblePlan('Goal', deps), error => error.code === 'cancelled');
  assert.equal(calls.length, 0);
});
test('cancellation before response consumption rejects draft', async () => {
  const { deps, calls } = setup(); const abort = new AbortController(); const send = deps.fetcher;
  deps.fetcher = async (...args) => { const result = await send(...args); abort.abort(); return result; };
  await assert.rejects(generateCompatiblePlan('Goal', deps, abort.signal), error => error.code === 'cancelled');
  assert.equal(calls.length, 1);
});

test('session invalidation unblocks a fetcher that ignores AbortSignal', async () => {
  const { deps, session } = setup();
  let started = false;
  let markStarted;
  const requestStarted = new Promise(resolve => { markStarted = resolve; });
  deps.fetcher = async () => { started = true; markStarted(); return new Promise(() => {}); };
  const result = generateCompatiblePlan('Goal', deps).then(() => 'completed', error => error.code);
  await requestStarted;
  assert.equal(started, true);
  session.abort();
  let timer;
  try {
    assert.equal(await Promise.race([
      result,
      new Promise(resolve => { timer = setTimeout(() => resolve('still waiting'), 100); }),
    ]), 'cancelled');
  } finally {
    clearTimeout(timer);
  }
});
test('invalid input is rejected before any external request', async () => {
  const { deps, calls } = setup();
  await assert.rejects(generateCompatiblePlan(' ', deps), error => error.code === 'invalid_input');
  assert.equal(calls.length, 0);
});
test('cancellation ends a pending credential read without starting a request', async () => {
  const { deps, calls } = setup();
  const controller = new AbortController();
  let rejectRead;
  deps.getCredentials = () => new Promise((_resolve, reject) => { rejectRead = reject; });
  const result = generateCompatiblePlan('Goal', deps, controller.signal).catch(error => error.code);
  await Promise.resolve();
  controller.abort();
  let timer;
  try {
    assert.equal(await Promise.race([result, new Promise(resolve => { timer = setTimeout(() => resolve('still waiting'), 100); })]), 'cancelled');
    assert.equal(calls.length, 0);
  } finally {
    clearTimeout(timer);
    rejectRead(new Error('late credential failure'));
    await result;
  }
});


test('cancellation after consuming complete JSON but before DONE rejects draft', async () => {
  const {deps} = setup();
  const abort = new AbortController();
  let reads = 0;
  let released = false;
  const encoded = new TextEncoder().encode(`data: ${JSON.stringify({choices: [{delta: {content: JSON.stringify(plan)}}]})}\n\n`);
  deps.fetcher = async () => ({
    ok: true,
    headers: new Headers({'Content-Type': 'text/event-stream'}),
    body: {getReader: () => ({
      read: async () => {
        reads += 1;
        if (reads === 1) return {done: false, value: encoded};
        // A second read can only happen after the first frame was consumed.
        abort.abort();
        return {done: true};
      },
      cancel: async () => {},
      releaseLock: () => { released = true; },
    })},
  });
  await assert.rejects(generateCompatiblePlan('Goal', deps, abort.signal), {code: 'cancelled'});
  assert.equal(reads, 2);
  assert.equal(released, true);
});
