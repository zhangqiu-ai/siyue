import assert from 'node:assert/strict';
import test from 'node:test';
import { createIpcDispatcher, isTrustedSender, validateCall } from './ipc.mjs';

const rendererUrl = 'http://127.0.0.1:5173/';
function setup(client = {}) {
  const frame = { url: rendererUrl };
  const webContents = { id: 1, mainFrame: frame, getURL: () => rendererUrl, isDestroyed: () => false };
  const event = { sender: webContents, senderFrame: frame };
  return { event, webContents, dispatcher: createIpcDispatcher({ client, webContents, rendererUrl }) };
}
const message = (method, args = [], requestId = 'request-1') => ({ requestId, method, args });

test('disposed workspace dispatcher never returns a late read from its previous context',async()=>{
 let release;const {event,dispatcher}=setup({snapshot:()=>new Promise(resolve=>{release=resolve;})});
 const result=dispatcher.handle(event,message('snapshot'));dispatcher.dispose();release({privateOldAccount:'synthetic'});
 assert.deepEqual(await result,{ok:false,error:{code:'cancelled'}});
});

test('IPC only trusts the exact loaded URL and owning main frame', () => {
  const { event, webContents } = setup();
  assert.equal(isTrustedSender(event, webContents, rendererUrl), true);
  for (const url of [`${rendererUrl}malicious`, 'http://127.0.0.1:51730/', 'http://127.0.0.1:5173@attacker.example/', 'file:///other/index.html']) {
    event.senderFrame.url = url;
    assert.equal(isTrustedSender(event, webContents, rendererUrl), false);
  }
  event.senderFrame.url = rendererUrl;
  assert.equal(isTrustedSender({ ...event, senderFrame: { url: rendererUrl } }, webContents, rendererUrl), false);
  assert.equal(isTrustedSender({ ...event, sender: { ...webContents } }, webContents, rendererUrl), false);
  const navigated = { ...webContents, getURL: () => 'https://other.example/' };
  assert.equal(isTrustedSender({ sender: navigated, senderFrame: navigated.mainFrame }, navigated, rendererUrl), false);
});

test('strict call schema rejects injected actor, unknown methods, invalid versions and patches', () => {
  for (const input of [
    null, {}, message('__proto__'), message('constructor'), message('shell', ['rm']),
    { ...message('snapshot'), actor: 'other' }, message('snapshot', ['other-space']),
    message('propose', ['']), message('propose', ['x'.repeat(161)]), message('confirmDraft', ['id', 0]),
    message('confirmDraft', ['id', '1']), message('editDraft', ['id', 1, { title: 'test', actorId: 'other' }]),
    message('update', ['task', 'id', 1, { spaceId: 'other' }]), message('update', ['goal', 'id', 1, {}]),
  ]) assert.throws(() => validateCall(input), { code: 'invalid_input' });
  assert.deepEqual(validateCall(message('saveManual', [{ title: 'test' }])), [{ title: 'test', projectTitles: [], taskTitles: [] }]);
});

test('only validated method arguments are dispatched; errors expose a known code only', async () => {
  const calls = [];
  const { event, dispatcher } = setup({
    saveManual: async (...args) => { calls.push(args); return { commandId: 'receipt-1' }; },
    snapshot: async () => { throw Object.assign(new Error('private database details'), { code: 'corrupt_data' }); },
    receipt: async () => { throw new Error('private stack and path'); },
  });
  assert.deepEqual(await dispatcher.handle(event, message('saveManual', [{ title: 'test' }])), { ok: true, value: { commandId: 'receipt-1' } });
  assert.equal(calls.length, 1);
  assert.deepEqual(await dispatcher.handle(event, message('snapshot')), { ok: false, error: { code: 'corrupt_data' } });
  assert.deepEqual(await dispatcher.handle(event, message('receipt', ['id'])), { ok: false, error: { code: 'failed' } });
  assert.deepEqual(await dispatcher.handle({ ...event, senderFrame: { url: rendererUrl } }, message('snapshot')), { ok: false, error: { code: 'forbidden' } });
});

test('manual drafts require one project and an explicit strict operation identity', async () => {
  const payload = { title: 'Goal', projectTitles: ['Project'], taskTitles: ['Task'] };
  const request = { commandId: 'manual-command-1', issuedAt: '2026-09-13T08:00:00.000Z' };
  const calls = [];
  const draft = { id: 'draft-1', status: 'draft' };
  const { event, dispatcher } = setup({ createManualDraft: async (...args) => { calls.push(args); return draft; } });
  for (const args of [
    [payload], [payload, undefined], [payload, null], [payload, {}],
    [payload, { commandId: request.commandId }], [payload, { issuedAt: request.issuedAt }],
    [payload, { ...request, commandId: 'bad' }], [payload, { ...request, issuedAt: 'yesterday' }],
    [payload, { ...request, actorId: 'other' }], [payload, { ...request, spaceId: 'other' }],
    [{ ...payload, projectTitles: [] }, request], [{ ...payload, projectTitles: ['One', 'Two'] }, request],
    [{ ...payload, projectTitles: [' '] }, request], [{ title: 'Goal' }, request],
    [{ ...payload, actorId: 'other' }, request], [payload, request, 'extra'],
  ]) {
    assert.throws(() => validateCall(message('createManualDraft', args)), { code: 'invalid_input' });
    assert.deepEqual(await dispatcher.handle(event, message('createManualDraft', args)), { ok: false, error: { code: 'invalid_input' } });
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await dispatcher.handle(event, message('createManualDraft', [payload, request])), { ok: true, value: draft });
  assert.deepEqual(calls, [[payload, request]]);
  // IPC retries preserve the caller's identity; reconciliation belongs to LocalClient.
  await dispatcher.handle(event, message('createManualDraft', [payload, request], 'transport-retry'));
  assert.deepEqual(calls[1], [payload, request]);
});

test('proposal cancellation is scoped to its request and window; duplicate requests are rejected', async () => {
  let signal;
  const { event, dispatcher } = setup({ propose: async (_goal, controllerSignal) => {
    signal = controllerSignal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject({ code: 'cancelled' }), { once: true }));
  } });
  const running = dispatcher.handle(event, message('propose', ['goal']));
  assert.deepEqual(await dispatcher.handle(event, message('propose', ['goal'])), { ok: false, error: { code: 'command_conflict' } });
  dispatcher.cancel({ ...event, senderFrame: { url: rendererUrl } }, 'request-1');
  dispatcher.cancel(event, 'different-request');
  assert.equal(signal.aborted, false);
  dispatcher.cancel(event, 'request-1');
  assert.deepEqual(await running, { ok: false, error: { code: 'cancelled' } });
});

test('closing the window cancels outstanding proposals and denies subsequent calls', async () => {
  const { event, dispatcher } = setup({ propose: async (_goal, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject({ code: 'cancelled' }), { once: true });
  }) });
  const running = dispatcher.handle(event, message('propose', ['goal']));
  dispatcher.dispose();
  assert.deepEqual(await running, { ok: false, error: { code: 'cancelled' } });
  assert.deepEqual(await dispatcher.handle(event, message('snapshot')), { ok: false, error: { code: 'forbidden' } });
});
