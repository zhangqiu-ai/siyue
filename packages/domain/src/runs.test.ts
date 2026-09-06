import test from 'node:test';
import assert from 'node:assert/strict';
import {createCommandService, createRunService, createSpaceState, spaceStateSchema, CommandError, type Actor, type SpaceState, type SpaceStore} from './index.js';

const actor: Actor = {id: 'owner', kind: 'user'};
const timestamp = '2026-09-05T00:00:00Z';
class MemoryStore implements SpaceStore {
  state = createSpaceState({id: 'space-a', name: 'Personal'}, actor.id);
  async transaction<T>(_spaceId: string, work: (state: SpaceState) => Promise<T>) {
    const state = spaceStateSchema.parse(JSON.parse(JSON.stringify(this.state)));
    const result = await work(state); this.state = spaceStateSchema.parse(state); return result;
  }
  async read<T>(_spaceId: string, query: (state: SpaceState) => T) {return query(spaceStateSchema.parse(this.state));}
}
function setup(store = new MemoryStore()) {
  let nextId = store.state.runs.length + store.state.goals.length + store.state.drafts.length + 100;
  const deps = {store, now: () => timestamp, newId: () => `id-${++nextId}`};
  return {store, runs: createRunService(deps), commands: createCommandService({...deps, hash: (value) => `hash:${value}`})};
}
const hasCode = (code: string) => (error: unknown) => error instanceof CommandError && error.code === code;
async function attached() {
  const f = setup(); const run = await f.runs.start('space-a', actor);
  const draft = await f.commands.createDraft({schemaVersion: 1, commandId: 'command-plan', spaceId: 'space-a', issuedAt: timestamp, kind: 'plan.create', payload: {title: 'Goal', rationale: 'Private reason', projectTitles: [], taskTitles: ['Task']}}, actor, {source: 'ai', expiresAt: '2026-09-05T01:00:00Z'});
  await f.runs.attachDraft('space-a', actor, run.id, draft.id);
  return {...f, run, draft};
}

test('run records a bounded versioned state sequence without draft prose', async () => {
  const {runs, run, draft} = await attached();
  const result = await runs.attachDraft('space-a', actor, run.id, draft.id);
  assert.equal(result.executor, 'mock'); assert.equal(result.policyVersion, '1');
  assert.equal(result.modelVersion, 'deterministic-mock-v1');
  assert.equal(result.promptVersion, 'mock-plan-v1');
  assert.equal(result.dataCutoff, timestamp);
  assert.equal(result.status, 'awaiting_approval'); assert.equal(result.seq, 2);
  assert.deepEqual(result.events.map((event) => [event.seq, event.state]), [[1, 'running'], [2, 'awaiting_approval']]);
  assert.equal(JSON.stringify(result).includes('Private reason'), false);
  assert.equal((await runs.settleDraft('space-a', actor, draft.id))?.status, 'awaiting_approval');
});
test('receipt evidence is required for success and duplicate settle does not append events', async () => {
  const {runs, commands, store, run, draft} = await attached();
  assert.equal((await runs.settleDraft('space-a', actor, draft.id))?.status, 'awaiting_approval');
  const approval = await commands.approveDraft('space-a', actor, draft.id, draft.version);
  const receipt = await commands.applyApproved('space-a', actor, draft.id, approval.id);
  const settled = await runs.settleDraft('space-a', actor, draft.id);
  assert.equal(settled?.status, 'succeeded'); assert.equal(settled?.commandId, receipt.commandId);
  assert.equal(settled?.seq, 3);
  assert.deepEqual(await runs.settleDraft('space-a', actor, draft.id), settled);
  assert.deepEqual(await runs.cancel('space-a', actor, run.id), settled);
  assert.equal(store.state.tasks.length, 1);
});
test('recovery reconciles committed drafts whose run response was lost', async () => {
  const {runs, commands, store, draft} = await attached();
  const approval = await commands.approveDraft('space-a', actor, draft.id, draft.version);
  await commands.applyApproved('space-a', actor, draft.id, approval.id);
  assert.equal((await runs.list('space-a', actor))[0]?.status, 'awaiting_approval');
  const reopened = setup(store);
  const recovered = await reopened.runs.recover('space-a', actor);
  assert.equal(recovered[0]?.status, 'succeeded');
  assert.equal((await reopened.runs.recover('space-a', actor))[0]?.seq, recovered[0]?.seq);
});
test('running and queued work becomes interrupted after reopen; recovery never invents success', async () => {
  const {runs, store} = setup(); const running = await runs.start('space-a', actor);
  await store.transaction('space-a', async (state) => {
    state.runs.push({...running, id: 'queued-run', status: 'queued', events: [{seq: 1, state: 'queued', time: timestamp}]});
  });
  const recovered = await setup(store).runs.recover('space-a', actor);
  assert.deepEqual(recovered.map((run) => run.status), ['interrupted', 'interrupted']);
  assert.equal(store.state.receipts.length, 0);
  assert.deepEqual(await runs.recover('space-a', actor), recovered);
});
test('cancellation before provider completion cannot later attach a draft or become success', async () => {
  const {runs, commands} = setup(); const run = await runs.start('space-a', actor);
  const cancelled = await runs.cancel('space-a', actor, run.id);
  assert.equal(cancelled.status, 'cancelled');
  const draft = await commands.createDraft({schemaVersion: 1, commandId: 'late-command', spaceId: 'space-a', issuedAt: timestamp, kind: 'plan.create', payload: {title: 'Late result', projectTitles: [], taskTitles: []}}, actor, {source: 'ai', expiresAt: '2026-09-05T01:00:00Z'});
  await assert.rejects(runs.attachDraft('space-a', actor, run.id, draft.id), hasCode('invalid_state'));
  assert.deepEqual(await runs.fail('space-a', actor, run.id, 'provider_error'), cancelled);
});
test('attached cancellation requires draft rejection; applied records are reconciled instead', async () => {
  const {runs, commands, run, draft} = await attached();
  await assert.rejects(runs.cancel('space-a', actor, run.id), hasCode('invalid_state'));
  await assert.rejects(runs.fail('space-a', actor, run.id, 'provider_error'), hasCode('invalid_state'));
  await commands.rejectDraft('space-a', actor, draft.id, draft.version);
  assert.equal((await runs.cancel('space-a', actor, run.id)).status, 'cancelled');
  const executed = await attached();
  const approval = await executed.commands.approveDraft('space-a', actor, executed.draft.id, 1);
  await executed.commands.applyApproved('space-a', actor, executed.draft.id, approval.id);
  assert.equal((await executed.runs.cancel('space-a', actor, executed.run.id)).status, 'succeeded');
});
test('failure uses safe codes and cannot be rolled back by cancellation', async () => {
  const {runs} = setup(); const run = await runs.start('space-a', actor);
  await assert.rejects(runs.fail('space-a', actor, run.id, 'Error: secret user message'), hasCode('invalid_input'));
  const failed = await runs.fail('space-a', actor, run.id, 'provider_error');
  assert.equal(failed.errorCode, 'provider_error'); assert.equal(failed.status, 'failed');
  assert.deepEqual(await runs.cancel('space-a', actor, run.id), failed);
});
test('run access checks space, actor kind and current authorization', async () => {
  const {runs, store, run, draft} = await attached();
  await assert.rejects(runs.cancel('space-a', {...actor, kind: 'ai'}, run.id), hasCode('not_found'));
  await assert.rejects(runs.attachDraft('space-b', actor, run.id, draft.id), hasCode('forbidden'));
  await store.transaction('space-a', async (state) => {state.members[0]!.canWrite = false;});
  await assert.rejects(runs.recover('space-a', actor), hasCode('forbidden'));
  await store.transaction('space-a', async (state) => {state.members[0]!.canRead = false;});
  await assert.rejects(runs.list('space-a', actor), hasCode('forbidden'));
});
test('run schema rejects sequence gaps, forged success and invalid transition history', async () => {
  const {store} = await attached();
  const clone = () => JSON.parse(JSON.stringify(store.state)) as SpaceState;
  let invalid = clone(); invalid.runs[0]!.events[1]!.seq = 3;
  assert.equal(spaceStateSchema.safeParse(invalid).success, false);
  invalid = clone(); invalid.runs[0]!.status = 'succeeded'; invalid.runs[0]!.events[1]!.state = 'succeeded';
  assert.equal(spaceStateSchema.safeParse(invalid).success, false);
  invalid = clone(); invalid.runs[0]!.events[0]!.state = 'cancelled';
  assert.equal(spaceStateSchema.safeParse(invalid).success, false);
  const {runs: _runs, ...oldSnapshot} = clone();
  assert.deepEqual(spaceStateSchema.parse(oldSnapshot).runs, []);
});
test('draft and run linkage commit atomically even when the returned draft is lost', async () => {
  const base = new MemoryStore(); let loseResponse = false;
  const store: SpaceStore = {
    read: (spaceId, query) => base.read(spaceId, query),
    async transaction(spaceId, work) {
      const result = await base.transaction(spaceId, work);
      if (loseResponse) {loseResponse = false; throw new Error('draft response lost after commit');}
      return result;
    },
  };
  let nextId = 0;
  const deps = {store, now: () => timestamp, newId: () => `atomic-${++nextId}`};
  const runs = createRunService(deps), commands = createCommandService({...deps, hash: (value) => value});
  const run = await runs.start('space-a', actor);
  const command = {schemaVersion: 1, commandId: 'atomic-command', spaceId: 'space-a', issuedAt: timestamp, kind: 'plan.create', payload: {title: 'Goal', projectTitles: [], taskTitles: ['Task']}};
  const options = {source: 'ai' as const, expiresAt: '2026-09-05T01:00:00Z', runId: run.id};
  loseResponse = true;
  await assert.rejects(commands.createDraft(command, actor, options), /draft response lost/);
  const persistedRun = (await runs.list('space-a', actor))[0]!;
  assert.equal(persistedRun.status, 'awaiting_approval');
  assert.equal(persistedRun.draftId, base.state.drafts[0]?.id);
  assert.equal(persistedRun.commandId, command.commandId);
  const draft = await commands.createDraft(command, actor, options);
  assert.deepEqual((await runs.list('space-a', actor))[0], persistedRun);
  const approval = await commands.approveDraft('space-a', actor, draft.id, draft.version);
  await commands.applyApproved('space-a', actor, draft.id, approval.id);
  const recovered = await createRunService(deps).recover('space-a', actor);
  assert.equal(recovered[0]?.status, 'succeeded');
  assert.equal(base.state.goals.length, 1);
});
test('atomic draft linkage refuses other runs and identities without leaving orphan drafts', async () => {
  const {runs, commands, store} = setup();
  const first = await runs.start('space-a', actor), second = await runs.start('space-a', actor);
  const command = {schemaVersion: 1, commandId: 'bound-command', spaceId: 'space-a', issuedAt: timestamp, kind: 'plan.create', payload: {title: 'Goal', projectTitles: [], taskTitles: []}};
  const options = {source: 'ai' as const, expiresAt: '2026-09-05T01:00:00Z', runId: first.id};
  const draft = await commands.createDraft(command, actor, options);
  await assert.rejects(commands.createDraft(command, actor, {...options, runId: second.id}), hasCode('command_conflict'));
  await assert.rejects(commands.createDraft({...command, commandId: 'another-command'}, {...actor, kind: 'ai'}, {...options, runId: second.id}), hasCode('not_found'));
  await runs.cancel('space-a', actor, second.id);
  await assert.rejects(commands.createDraft({...command, commandId: 'cancelled-command'}, actor, {...options, runId: second.id}), hasCode('invalid_state'));
  assert.equal(store.state.drafts.length, 1); assert.equal(store.state.drafts[0]?.id, draft.id);
  assert.equal(store.state.runs[0]?.seq, 2); assert.equal(store.state.runs[1]?.draftId, undefined);
});
test('event replay returns explicitly versioned run-scoped events after the cursor', async () => {
  const {runs, run} = await attached();
  const initial = await runs.replayEvents('space-a', actor, run.id);
  assert.equal(initial.schemaVersion, 1); assert.equal(initial.afterSeq, 0); assert.equal(initial.nextSeq, 2);
  assert.deepEqual(initial.events.map((event) => [event.schemaVersion, event.runId, event.seq]), [[1, run.id, 1], [1, run.id, 2]]);
  const resumed = await runs.replayEvents('space-a', actor, run.id, 1);
  assert.deepEqual(resumed.events, initial.events.slice(1));
  assert.deepEqual((await runs.replayEvents('space-a', actor, run.id, resumed.nextSeq)).events, []);
  initial.events[0]!.state = 'failed';
  assert.equal((await runs.replayEvents('space-a', actor, run.id)).events[0]?.state, 'running');
});
test('event replay rejects negative, fractional, unsafe and future cursors', async () => {
  const {runs, run} = await attached();
  for (const cursor of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 3])
    await assert.rejects(runs.replayEvents('space-a', actor, run.id, cursor), hasCode('invalid_input'));
});
test('replaying cancelled or succeeded states never invokes execution or appends events', async () => {
  const cancelled = setup(); const run = await cancelled.runs.start('space-a', actor);
  await cancelled.runs.cancel('space-a', actor, run.id);
  const beforeCancelReplay = JSON.stringify(cancelled.store.state);
  assert.equal((await cancelled.runs.replayEvents('space-a', actor, run.id, 1)).events[0]?.state, 'cancelled');
  await cancelled.runs.replayEvents('space-a', actor, run.id, 1);
  assert.equal(JSON.stringify(cancelled.store.state), beforeCancelReplay);
  const completed = await attached();
  const approval = await completed.commands.approveDraft('space-a', actor, completed.draft.id, completed.draft.version);
  await completed.commands.applyApproved('space-a', actor, completed.draft.id, approval.id);
  await completed.runs.settleDraft('space-a', actor, completed.draft.id);
  const beforeSuccessReplay = JSON.stringify(completed.store.state);
  const result = await completed.runs.replayEvents('space-a', actor, completed.run.id, 2);
  assert.equal(result.events[0]?.state, 'succeeded');
  assert.deepEqual(await completed.runs.replayEvents('space-a', actor, completed.run.id, 2), result);
  assert.equal(JSON.stringify(completed.store.state), beforeSuccessReplay);
});
test('historical nested events gain version and identity without changing their source snapshot', async () => {
  const {store, run} = await attached();
  const legacy = JSON.parse(JSON.stringify(store.state));
  for (const event of legacy.runs[0].events) {delete event.runId; delete event.schemaVersion;}
  const original = JSON.stringify(legacy);
  const readonlyStore: SpaceStore = {
    async read(_spaceId, query) {return query(legacy);},
    async transaction() {throw new Error('Replay must never write');},
  };
  const replay = await createRunService({store: readonlyStore, now: () => timestamp, newId: () => 'unused'}).replayEvents('space-a', actor, run.id);
  assert.equal(replay.events.length, 2);
  assert.equal(replay.events.every((event) => event.runId === run.id && event.schemaVersion === 1), true);
  assert.deepEqual(replay.events.map(({seq, state, time}) => ({seq, state, time})), legacy.runs[0].events);
  assert.equal(JSON.stringify(legacy), original);
});
test('explicit wrong run/version and sequence gaps or duplicates are never treated as legacy', async () => {
  const {store} = await attached();
  const clone = () => JSON.parse(JSON.stringify(store.state));
  for (const mutate of [
    (state: SpaceState) => {state.runs[0]!.events[0]!.runId = 'another-run';},
    (state: any) => {state.runs[0].events[0].schemaVersion = 2;},
    (state: any) => {state.runs[0].events[0].schemaVersion = null;},
    (state: SpaceState) => {state.runs[0]!.events[1]!.seq = 3;},
    (state: SpaceState) => {state.runs[0]!.events[1]!.seq = 1;},
  ]) {const invalid = clone(); mutate(invalid); assert.equal(spaceStateSchema.safeParse(invalid).success, false);}
});
test('event replay enforces space, principal, executor identity and read authorization', async () => {
  const {runs, store, run} = await attached();
  await assert.rejects(runs.replayEvents('space-b', actor, run.id), hasCode('forbidden'));
  await assert.rejects(runs.replayEvents('space-a', {id: 'other-user', kind: 'user'}, run.id), hasCode('forbidden'));
  await assert.rejects(runs.replayEvents('space-a', {...actor, kind: 'ai'}, run.id), hasCode('not_found'));
  await store.transaction('space-a', async (state) => {state.members[0]!.canWrite = false;});
  assert.equal((await runs.replayEvents('space-a', actor, run.id)).events.length, 2);
  await store.transaction('space-a', async (state) => {state.members[0]!.canRead = false;});
  await assert.rejects(runs.replayEvents('space-a', actor, run.id), hasCode('forbidden'));
});
