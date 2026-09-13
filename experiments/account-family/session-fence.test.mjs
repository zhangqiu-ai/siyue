import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionFence } from './session-fence.mjs';
const A = { subjectId: 'adult-a', spaceId: 'personal-a' };
const B = { subjectId: 'adult-b', spaceId: 'personal-b' };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture() {
  const fence = createSessionFence(); fence.switchTo(A);
  const work = fence.stage('command-a', { text: 'synthetic A input' });
  const sent = [], cache = [];
  const callbacks = { authorize: async () => true, dispatch: async w => { sent.push(w); return { scope: w.scope, commandId: w.commandId, value: 'A result' }; }, commit: r => cache.push(r) };
  return { fence, work, sent, cache, callbacks };
}
test('current verified scope can dispatch and commit its matching receipt', async () => {
  const f = fixture(); assert.deepEqual(await f.fence.execute(f.work, f.callbacks), { status: 'applied' });
  assert.equal(f.sent.length, 1); assert.equal(f.cache[0].value, 'A result');
});
test('queued A command is not relabeled or dispatched as B', async () => {
  const f = fixture(); f.fence.switchTo(B);
  assert.equal((await f.fence.execute(f.work, f.callbacks)).status, 'stale');
  assert.deepEqual(f.work.scope, A); assert.equal(JSON.parse(f.work.payload).text, 'synthetic A input');
  assert.equal(f.sent.length, 0); assert.deepEqual(f.cache, []);
});
test('switch during async permission check prevents dispatch even if permission returns true', async () => {
  const f = fixture(), permission = deferred();
  const pending = f.fence.execute(f.work, { ...f.callbacks, authorize: () => permission.promise });
  f.fence.switchTo(B); permission.resolve(true);
  assert.equal((await pending).status, 'stale'); assert.equal(f.sent.length, 0);
});
test('late response after logout cannot update UI/cache even if transport ignores abort', async () => {
  const f = fixture(), started = deferred(), response = deferred(); let signal;
  const pending = f.fence.execute(f.work, { ...f.callbacks, dispatch: (w, s) => { signal = s; started.resolve(); return response.promise; } });
  await started.promise; f.fence.switchTo(null); assert.equal(signal.aborted, true);
  response.resolve({ scope: A, commandId: f.work.commandId });
  assert.equal((await pending).status, 'stale'); assert.deepEqual(f.cache, []);
  assert.throws(() => f.fence.stage('new', {}), /signed_out/);
});
test('A to B to A does not revive work from an earlier A login', async () => {
  const f = fixture(); f.fence.switchTo(B); f.fence.switchTo(A);
  assert.equal((await f.fence.execute(f.work, f.callbacks)).status, 'stale');
  const fresh = f.fence.stage('new-a-command', {});
  assert.equal((await f.fence.execute(fresh, f.callbacks)).status, 'applied');
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].commandId, 'new-a-command');
});
test('same account changing spaces invalidates pending work', async () => {
  const f = fixture(); f.fence.switchTo({ ...A, spaceId: 'family-1' });
  assert.equal((await f.fence.execute(f.work, f.callbacks)).status, 'stale'); assert.equal(f.sent.length, 0);
});
test('denied permission and mismatched receipts produce no cache write', async () => {
  const f = fixture();
  assert.equal((await f.fence.execute(f.work, { ...f.callbacks, authorize: async () => false })).status, 'denied');
  assert.equal(f.sent.length, 0);
  for (const receipt of [{ scope: B, commandId: f.work.commandId }, { scope: A, commandId: 'another-command' }]) {
    await assert.rejects(f.fence.execute(f.work, { ...f.callbacks, dispatch: async () => receipt }), /receipt_scope_mismatch/);
  }
  assert.deepEqual(f.cache, []);
});
test('late errors from an old session do not surface in the new session', async () => {
  const f = fixture(), started = deferred(), response = deferred();
  const pending = f.fence.execute(f.work, { ...f.callbacks, dispatch: () => { started.resolve(); return response.promise; } });
  await started.promise; f.fence.switchTo(B); response.reject(Error('old transport failed'));
  assert.equal((await pending).status, 'stale'); assert.deepEqual(f.cache, []);
  const work = f.fence.stage('b-command', {});
  await assert.rejects(f.fence.execute(work, { ...f.callbacks, dispatch: async () => { throw Error('current failure'); } }), /current failure/);
});
test('fabricated work and mutable caller scope cannot bypass the fence', async () => {
  const f = fixture();
  assert.equal((await f.fence.execute({ ...f.work }, f.callbacks)).status, 'stale');
  const scope = { ...A }; f.fence.switchTo(scope); scope.subjectId = B.subjectId;
  const work = f.fence.stage('immutable', { n: 1 }); assert.deepEqual(work.scope, A);
  assert.throws(() => { work.scope.subjectId = B.subjectId; }, TypeError);
  assert.equal(f.sent.length, 0);
});
test('discarding a late response does not claim to roll back a remote commit', async () => {
  const f = fixture(), response = deferred(), committed = deferred(), serverReceipts = [];
  const pending = f.fence.execute(f.work, { ...f.callbacks, dispatch: w => {
    const receipt = { scope: w.scope, commandId: w.commandId };
    serverReceipts.push(receipt); committed.resolve(); return response.promise;
  } });
  await committed.promise; f.fence.switchTo(B); response.resolve(serverReceipts[0]);
  assert.equal((await pending).status, 'stale'); assert.equal(f.cache.length, 0);
  assert.equal(serverReceipts.length, 1); assert.equal(serverReceipts[0].commandId, f.work.commandId);
  assert.deepEqual(serverReceipts[0].scope, A); // A must reconcile this receipt after verified login.
});
