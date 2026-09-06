import assert from 'node:assert/strict';
import test from 'node:test';
import { streamMockReply } from '../src/chat/mock-adapter.ts';

test('mock chat yields growing chunks and stops promptly when aborted', async () => {
  const controller = new AbortController();
  const stream = streamMockReply('每天读书', controller.signal);
  const first = await stream.next();
  const second = await stream.next();
  assert.equal(first.done, false);
  assert.equal(second.done, false);
  const before = first.value.content[0].text;
  const after = second.value.content[0].text;
  assert.ok(after.startsWith(before));
  assert.ok(after.length > before.length);
  const pending = stream.next();
  controller.abort();
  assert.equal((await pending).done, true);
});

test('already cancelled mock chat emits no reply', async () => {
  const controller = new AbortController();
  controller.abort();
  const chunks = [];
  for await (const chunk of streamMockReply('不执行', controller.signal)) chunks.push(chunk);
  assert.deepEqual(chunks, []);
});
