import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftAutosave } from '../src/space/draft-autosave.ts';

/** Drains every pending microtask so the serialised save loop reaches a stable state. */
const settle = () => new Promise((resolve) => setImmediate(resolve));
/** Deterministic clock: only timers scheduled through the controller are advanced. */
function fakeClock() {
  let time = 0, seq = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(callback, delayMs) { const handle = ++seq; timers.set(handle, {at: time + delayMs, callback}); return handle; },
    clearTimer(handle) { timers.delete(handle); },
    pending: () => timers.size,
    async advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, entry]) => entry.at <= target).sort(([, a], [, b]) => a.at - b.at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].callback();
        await settle();
      }
      time = target;
    },
  };
}
function deferred() { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return {promise, resolve, reject}; }
function controller(save) {
  const clock = fakeClock();
  const statuses = [];
  const autosave = createDraftAutosave({save, delayMs: 600, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
  const unsubscribe = autosave.subscribe((state) => statuses.push(state.status));
  return {autosave, clock, statuses, unsubscribe};
}

test('a burst of edits collapses into one debounced save of the newest payload', async () => {
  const saved = [];
  const {autosave, clock, statuses} = controller(async (payload) => { saved.push(payload); return {version: saved.length}; });
  autosave.update({title: 'A'});
  await clock.advance(599);
  assert.deepEqual(saved, []);
  autosave.update({title: 'B'});
  await clock.advance(599);
  assert.deepEqual(saved, [], 'the debounce restarts on every edit');
  assert.equal(autosave.getState().dirty, true);
  await clock.advance(1);
  assert.deepEqual(saved, [{title: 'B'}]);
  assert.equal(autosave.status, 'saved');
  assert.deepEqual(autosave.getState(), {status: 'saved', version: 1, savedAt: 1199, error: null, dirty: false});
  assert.deepEqual(statuses, ['idle', 'saving', 'saved']);
  assert.equal(clock.pending(), 0);
});

test('saves are serialised and a newer payload is saved after the in-flight save', async () => {
  const calls = [], gates = [];
  const {autosave, clock} = controller((payload) => { calls.push(payload); const gate = deferred(); gates.push(gate); return gate.promise; });
  autosave.update({title: 'A'});
  await clock.advance(600);
  assert.deepEqual(calls, [{title: 'A'}]);
  assert.equal(autosave.status, 'saving');
  autosave.update({title: 'B'});
  autosave.update({title: 'C'});
  await clock.advance(600);
  assert.equal(calls.length, 1, 'a debounced tick never starts a second save while one is in flight');
  gates[0].resolve({version: 1});
  await settle();
  assert.deepEqual(calls, [{title: 'A'}, {title: 'C'}]);
  assert.deepEqual(autosave.getState(), {status: 'saving', version: 1, savedAt: 1200, error: null, dirty: true});
  gates[1].resolve({version: 2});
  await settle();
  assert.deepEqual(autosave.getState(), {status: 'saved', version: 2, savedAt: 1200, error: null, dirty: false});
  assert.equal(clock.pending(), 0);
});

test('flush waits for the in-flight and the queued save and resolves with the final version', async () => {
  const calls = [], gates = [];
  const {autosave, clock} = controller((payload) => { calls.push(payload); const gate = deferred(); gates.push(gate); return gate.promise; });
  autosave.update({title: 'A'});
  await clock.advance(600);
  autosave.update({title: 'B'});
  const flushed = autosave.flush();
  assert.equal(clock.pending(), 0, 'flush saves immediately instead of waiting for the debounce');
  assert.equal(calls.length, 1);
  gates[0].resolve({version: 1});
  await settle();
  assert.deepEqual(calls, [{title: 'A'}, {title: 'B'}]);
  gates[1].resolve({version: 2});
  assert.deepEqual(await flushed, {version: 2});
  assert.equal(autosave.getState().dirty, false);
  assert.equal(autosave.getState().error, null);
});

test('nothing to save resolves version 0 without calling the save function', async () => {
  const saved = [];
  const {autosave, clock} = controller(async (payload) => { saved.push(payload); return {version: 1}; });
  assert.deepEqual(await autosave.flush(), {version: 0});
  autosave.retry();
  await clock.advance(6000);
  assert.deepEqual(saved, []);
  assert.deepEqual(autosave.getState(), {status: 'idle', version: 0, savedAt: null, error: null, dirty: false});
});

test('a failed save keeps the newest payload, reports the error and retry persists it', async () => {
  const failure = new Error('offline');
  const saved = [];
  let failing = true;
  const {autosave, clock} = controller(async (payload) => { if (failing) throw failure; saved.push(payload); return {version: 7}; });
  autosave.update({title: 'A'});
  await clock.advance(600);
  assert.equal(autosave.status, 'error');
  assert.equal(autosave.getState().error, failure);
  assert.equal(autosave.getState().dirty, true);
  await assert.rejects(autosave.flush(), (error) => error === failure);
  autosave.retry();
  await settle();
  assert.equal(autosave.status, 'error', 'a retry that fails again keeps the payload for the next retry');
  failing = false;
  autosave.retry();
  await settle();
  assert.deepEqual(saved, [{title: 'A'}]);
  assert.deepEqual(autosave.getState(), {status: 'saved', version: 7, savedAt: 600, error: null, dirty: false});
});

test('an edit after a failure retries on the debounce without an explicit retry', async () => {
  let failing = true;
  const saved = [];
  const {autosave, clock} = controller(async (payload) => { if (failing) throw new Error('offline'); saved.push(payload); return {version: 3}; });
  autosave.update({title: 'A'});
  await clock.advance(600);
  assert.equal(autosave.status, 'error');
  failing = false;
  autosave.update({title: 'A2'});
  assert.equal(autosave.status, 'idle');
  assert.equal(autosave.getState().error, null);
  await clock.advance(600);
  assert.deepEqual(saved, [{title: 'A2'}]);
  assert.equal(autosave.status, 'saved');
});

test('dispose cancels the pending debounce, detaches listeners and refuses an unsaved flush', async () => {
  const saved = [];
  const {autosave, clock, statuses, unsubscribe} = controller(async (payload) => { saved.push(payload); return {version: 1}; });
  autosave.update({title: 'A'});
  assert.equal(clock.pending(), 1);
  autosave.dispose();
  assert.equal(clock.pending(), 0);
  await clock.advance(6000);
  assert.deepEqual(saved, []);
  autosave.update({title: 'B'});
  await assert.rejects(autosave.flush(), {message: 'draft_autosave_disposed'});
  assert.deepEqual(statuses, ['idle'], 'a disposed controller notifies nobody');
  assert.deepEqual(autosave.getState(), {status: 'idle', version: 0, savedAt: null, error: null, dirty: true});
  unsubscribe();
});

test('an in-flight save settles after dispose and never starts the queued payload', async () => {
  const calls = [], gates = [];
  const {autosave, clock} = controller((payload) => { calls.push(payload); const gate = deferred(); gates.push(gate); return gate.promise; });
  autosave.update({title: 'A'});
  await clock.advance(600);
  autosave.update({title: 'B'});
  autosave.dispose();
  gates[0].resolve({version: 3});
  await settle();
  assert.deepEqual(calls, [{title: 'A'}]);
  assert.deepEqual(autosave.getState(), {status: 'saved', version: 3, savedAt: 600, error: null, dirty: true});
});

test('a save without a usable version is an error instead of a saved draft', async () => {
  const {autosave, clock} = controller(async () => ({version: 0}));
  autosave.update({title: 'A'});
  await clock.advance(600);
  assert.equal(autosave.status, 'error');
  assert.equal(autosave.getState().error?.message, 'draft_autosave_invalid_version');
  assert.equal(autosave.getState().version, 0);
  await assert.rejects(autosave.flush(), /draft_autosave_invalid_version/);
  assert.throws(() => createDraftAutosave({save: async () => ({version: 1}), delayMs: -1}), /draft_autosave_invalid_delay/);
});

test('the published state keeps its identity until something changes', async () => {
  const {autosave, clock} = controller(async () => ({version: 1}));
  const initial = autosave.getState();
  assert.equal(autosave.getState(), initial);
  autosave.update({title: 'A'});
  const dirty = autosave.getState();
  assert.notEqual(dirty, initial);
  assert.equal(autosave.getState(), dirty);
  await clock.advance(600);
  assert.notEqual(autosave.getState(), dirty);
  assert.equal(autosave.status, 'saved');
});
