import test from 'node:test';
import assert from 'node:assert/strict';
import { businessCommandSchema, goalDraftSchema, localDateSchema, taskSchema, commandReceiptSchema } from './index.js';

test('dates retain calendar semantics separately from absolute instants', () => {
  assert.equal(localDateSchema.safeParse('2024-02-29').success, true);
  for (const date of ['2025-02-29', '2026-04-31', '2026-13-01', '2026-09-05T00:00:00Z']) assert.equal(localDateSchema.safeParse(date).success, false);
  assert.equal(taskSchema.safeParse({id: 'task', spaceId: 'space', title: 'Practice', version: 1, status: 'open', createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z', dueLocalDate: '2026-09-06', dueAt: '2026-09-06T10:00:00Z'}).success, true);
});
test('draft normalizes titles, applies bounded lists and rejects extra authority fields', () => {
  assert.deepEqual(goalDraftSchema.parse({title: '  Goal  '}), {title: 'Goal', projectTitles: [], taskTitles: []});
  assert.equal(goalDraftSchema.safeParse({title: 'Goal', approved: true}).success, false);
  assert.equal(goalDraftSchema.safeParse({title: 'Goal', taskTitles: Array(25).fill('Task')}).success, false);
  assert.equal(goalDraftSchema.safeParse({title: '   '}).success, false);
});
test('updates require positive versions and meaningful allowlisted patches', () => {
  const base = {schemaVersion: 1, commandId: 'command-test', spaceId: 'space', issuedAt: '2026-09-05T00:00:00Z', kind: 'task.update', entityId: 'task', expectedVersion: 1};
  assert.equal(businessCommandSchema.safeParse({...base, patch: {status: 'done'}}).success, true);
  assert.equal(businessCommandSchema.safeParse({...base, patch: {dueAt: null}}).success, true);
  for (const patch of [{}, {title: undefined}, {spaceId: 'foreign'}, {version: 8}, {status: 'completed'}]) assert.equal(businessCommandSchema.safeParse({...base, patch}).success, false);
  assert.equal(businessCommandSchema.safeParse({...base, expectedVersion: 0, patch: {status: 'done'}}).success, false);
});
test('a success claim without actual object identities is not a command receipt', () => {
  assert.equal(commandReceiptSchema.safeParse({status: 'applied', message: 'I created your goal'}).success, false);
});
test('persisted snapshots reject cross-space records and dangling references', async () => {
  const {spaceStateSchema} = await import('./index.js');
  const state = {schemaVersion: 1, space: {id: 'space-a', name: 'Personal'}, members: [{actorId: 'owner', canRead: true, canWrite: true}], goals: [], projects: [], tasks: [], drafts: [], approvals: [], receipts: [], events: []};
  assert.equal(spaceStateSchema.safeParse(state).success, true);
  const task = {id: 'task', spaceId: 'space-b', title: 'Private', status: 'open', version: 1, createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z'};
  assert.equal(spaceStateSchema.safeParse({...state, tasks: [task]}).success, false);
  assert.equal(spaceStateSchema.safeParse({...state, tasks: [{...task, spaceId: 'space-a', projectId: 'missing'}]}).success, false);
});
test('standalone run events and replay envelopes require explicit scoped versions', async () => {
  const {agentRunEventSchema, runEventReplaySchema} = await import('./index.js');
  const event = {schemaVersion: 1, runId: 'run-a', seq: 1, state: 'running', time: '2026-09-06T00:00:00Z'};
  assert.equal(agentRunEventSchema.safeParse(event).success, true);
  const {runId: _runId, ...withoutRun} = event;
  const {schemaVersion: _version, ...withoutVersion} = event;
  assert.equal(agentRunEventSchema.safeParse(withoutRun).success, false);
  assert.equal(agentRunEventSchema.safeParse(withoutVersion).success, false);
  const replay = {schemaVersion: 1, runId: 'run-a', afterSeq: 0, nextSeq: 1, events: [event]};
  assert.equal(runEventReplaySchema.safeParse(replay).success, true);
  assert.equal(runEventReplaySchema.safeParse({...replay, runId: 'run-b'}).success, false);
  assert.equal(runEventReplaySchema.safeParse({...replay, nextSeq: 2}).success, false);
  assert.equal(runEventReplaySchema.safeParse({...replay, events: [event, event], nextSeq: 2}).success, false);
});
