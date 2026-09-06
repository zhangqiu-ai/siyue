import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCommandService, createSpaceState, CommandError, type Actor, type BusinessCommand, type SpaceState, type SpaceStore, spaceStateSchema } from './index.js';

const actor: Actor = {id: 'owner', kind: 'user'};
const plan = (commandId = 'command-0001'): BusinessCommand => ({schemaVersion: 1, commandId, spaceId: 'space-a', issuedAt: '2026-09-05T00:00:00.000Z', kind: 'plan.create', payload: {title: 'Learn English', projectTitles: ['Practice'], taskTitles: ['Speak for five minutes']}});
/** Test-only store proves service behavior; durable adapters need their own rollback/restart tests. */
class MemoryStore implements SpaceStore {
  state = createSpaceState({id: 'space-a', name: 'Personal'}, actor.id);
  failCommit = false;
  loseResponse = false;
  tail: Promise<unknown> = Promise.resolve();
  transaction<T>(_spaceId: string, work: (state: SpaceState) => Promise<T>): Promise<T> {
    const job = this.tail.then(async () => {
      const working = JSON.parse(JSON.stringify(this.state)) as SpaceState;
      const result = await work(working);
      if (this.failCommit) throw new Error('disk full');
      this.state = working;
      if (this.loseResponse) {this.loseResponse = false; throw new Error('response lost');}
      return result;
    });
    this.tail = job.catch(() => {});
    return job;
  }
  async read<T>(_spaceId: string, query: (state: SpaceState) => T) {await this.tail; return query(JSON.parse(JSON.stringify(this.state)) as SpaceState);}
}
function setup() {
  const store = new MemoryStore(); let id = 0; let clock = '2026-09-05T00:01:00.000Z';
  const service = createCommandService({store, now: () => clock, newId: () => `generated-${++id}`, hash: async (value) => createHash('sha256').update(value).digest('hex')});
  return {store, service, advance: () => {clock = '2026-09-06T00:00:00.000Z';}};
}
async function approved(f = setup(), context = actor) {
  const draft = await f.service.createDraft(plan(), context, {source: 'ai', expiresAt: '2026-09-05T01:00:00.000Z'});
  const approval = await f.service.approveDraft('space-a', actor, draft.id, draft.version);
  return {...f, draft, approval};
}
const code = (expected: string) => (error: unknown) => error instanceof CommandError && error.code === expected;
const noWrites = (state: SpaceState) => {assert.equal(state.goals.length + state.projects.length + state.tasks.length + state.receipts.length + state.events.length, 0);};

test('a draft creates no formal records; approval persists actual linked IDs and one receipt', async () => {
  const {store, service, draft, approval} = await approved(); noWrites(store.state);
  const receipt = await service.applyApproved('space-a', actor, draft.id, approval.id);
  assert.equal(receipt.result.entities.length, 3);
  const view = await service.listPlan('space-a', actor);
  assert.equal(view.goals[0]?.title, 'Learn English');
  assert.equal(view.projects[0]?.goalId, view.goals[0]?.id);
  assert.equal(view.tasks[0]?.projectId, view.projects[0]?.id);
  assert.equal(store.state.events.length, 1);
  assert.equal(store.state.drafts[0]?.status, 'applied');
});
test('manual and approved creation share the same result semantics', async () => {
  const manual = setup(); const ai = await approved();
  await manual.service.execute(plan(), actor); await ai.service.applyApproved('space-a', actor, ai.draft.id, ai.approval.id);
  const left = await manual.service.listPlan('space-a', actor), right = await ai.service.listPlan('space-a', actor);
  assert.deepEqual(left.tasks.map((task) => task.title), right.tasks.map((task) => task.title));
  assert.equal(left.goals.length, right.goals.length);
});
test('AI executor cannot directly execute or approve its own draft', async () => {
  const {service, store} = setup(); const ai: Actor = {...actor, kind: 'ai'};
  await assert.rejects(service.execute(plan(), ai), code('approval_required'));
  const draft = await service.createDraft(plan(), ai, {source: 'ai', expiresAt: '2026-09-05T01:00:00.000Z'});
  await assert.rejects(service.approveDraft('space-a', ai, draft.id, 1), code('approval_required')); noWrites(store.state);
});
test('approval binds the executor kind as well as principal', async () => {
  const {service, store, draft, approval} = await approved(setup(), {...actor, kind: 'ai'});
  await assert.rejects(service.applyApproved('space-a', actor, draft.id, approval.id), code('forbidden')); noWrites(store.state);
  await service.applyApproved('space-a', {...actor, kind: 'ai'}, draft.id, approval.id);
  assert.equal(store.state.events[0]?.actorType, 'ai');
});
for (const status of ['rejected', 'cancelled'] as const) test(`${status} draft cannot write via approval or manual bypass`, async () => {
  const {service, store, draft, approval} = await approved();
  await service.rejectDraft('space-a', actor, draft.id, draft.version, status);
  await assert.rejects(service.applyApproved('space-a', actor, draft.id, approval.id), code('approval_invalid'));
  await assert.rejects(service.execute(plan(), actor), code('approval_required')); noWrites(store.state);
});
test('expired approval cannot write', async () => {
  const {service, store, draft, approval, advance} = await approved(); advance();
  await assert.rejects(service.applyApproved('space-a', actor, draft.id, approval.id), code('approval_expired')); noWrites(store.state);
});
test('editing invalidates old approval and requires a new version-bound confirmation', async () => {
  const {service, store, draft, approval} = await approved();
  const changed = plan(); if (changed.kind === 'plan.create') changed.payload.title = 'Edited goal';
  const edit = await service.editDraft('space-a', actor, draft.id, 1, changed);
  await assert.rejects(service.applyApproved('space-a', actor, draft.id, approval.id), code('approval_invalid'));
  await assert.rejects(service.approveDraft('space-a', actor, draft.id, 1), code('version_conflict')); noWrites(store.state);
  const fresh = await service.approveDraft('space-a', actor, draft.id, edit.version);
  await service.applyApproved('space-a', actor, draft.id, fresh.id); assert.equal(store.state.goals[0]?.title, 'Edited goal');
});
test('tampering with command parameters after approval fails the hash check', async () => {
  const {service, store, draft, approval} = await approved();
  const stored = store.state.drafts[0]!; if (stored.command.kind === 'plan.create') stored.command.payload.title = 'Tampered';
  await assert.rejects(service.applyApproved('space-a', actor, draft.id, approval.id), code('approval_invalid')); noWrites(store.state);
});
test('concurrent duplicate deliveries apply once and return the same receipt', async () => {
  const {service, store, draft, approval} = await approved();
  const results = await Promise.all(Array.from({length: 10}, () => service.applyApproved('space-a', actor, draft.id, approval.id)));
  results.forEach((result) => assert.deepEqual(result, results[0]));
  assert.equal(store.state.goals.length, 1); assert.equal(store.state.receipts.length, 1); assert.equal(store.state.events.length, 1);
});
test('same command ID with different content conflicts and preserves receipt', async () => {
  const {service, store} = setup(); const receipt = await service.execute(plan(), actor);
  const changed = plan(); if (changed.kind === 'plan.create') changed.payload.title = 'Another goal';
  await assert.rejects(service.execute(changed, actor), code('command_conflict'));
  assert.deepEqual(store.state.receipts, [receipt]); assert.equal(store.state.goals.length, 1);
});
test('lost response is reconciled by command ID without recreating records', async () => {
  const {service, store, draft, approval} = await approved(); store.loseResponse = true;
  await assert.rejects(service.applyApproved('space-a', actor, draft.id, approval.id), /response lost/);
  const receipt = await service.getReceipt('space-a', actor, plan().commandId);
  assert.equal(receipt?.status, 'applied');
  assert.deepEqual(await service.applyApproved('space-a', actor, draft.id, approval.id), receipt);
  assert.equal(store.state.tasks.length, 1);
});
test('authorization revocation prevents pending execution and receipt access', async () => {
  const {service, store, draft, approval} = await approved(); store.state.members[0]!.canWrite = false;
  await assert.rejects(service.applyApproved('space-a', actor, draft.id, approval.id), code('forbidden')); noWrites(store.state);
  store.state.members[0]!.canRead = false;
  await assert.rejects(service.listPlan('space-a', actor), code('forbidden'));
  await assert.rejects(service.getReceipt('space-a', actor, plan().commandId), code('forbidden'));
});
test('cross-space access and references are rejected', async () => {
  const {service, store} = setup();
  await assert.rejects(service.execute({...plan(), spaceId: 'space-b'}, actor), code('forbidden'));
  store.state.projects.push({id: 'foreign-project', spaceId: 'space-b', title: 'Foreign', status: 'active', version: 1, createdAt: plan().issuedAt, updatedAt: plan().issuedAt});
  await assert.rejects(service.execute({schemaVersion: 1, commandId: 'command-task', spaceId: 'space-a', issuedAt: plan().issuedAt, kind: 'task.create', payload: {title: 'Task', projectId: 'foreign-project'}}, actor), code('not_found'));
  assert.equal(store.state.tasks.length, 0);
  assert.equal((await service.listPlan('space-a', actor)).projects.length, 0);
});
test('version conflict after approval preserves the draft and latest formal record', async () => {
  const {service, store} = setup(); const receipt = await service.execute(plan(), actor); const taskId = receipt.result.entities.find((ref) => ref.kind === 'task')!.id;
  const update = {schemaVersion: 1, commandId: 'command-update', spaceId: 'space-a', issuedAt: plan().issuedAt, kind: 'task.update', entityId: taskId, expectedVersion: 1, patch: {status: 'done'}};
  const draft = await service.createDraft(update, actor, {source: 'ai', expiresAt: '2026-09-05T01:00:00.000Z'});
  const approval = await service.approveDraft('space-a', actor, draft.id, draft.version);
  await service.execute({...update, commandId: 'command-manual', patch: {title: 'Changed manually'}}, actor);
  await assert.rejects(service.applyApproved('space-a', actor, draft.id, approval.id), code('version_conflict'));
  assert.equal(store.state.tasks[0]?.title, 'Changed manually'); assert.equal(store.state.tasks[0]?.status, 'open');
  assert.equal(store.state.drafts[0]?.status, 'approved');
});
test('manual completion, reopening and archive obey versions; old edits cannot revive archive', async () => {
  const {service, store} = setup(); const receipt = await service.execute(plan(), actor); const entityId = receipt.result.entities.find((ref) => ref.kind === 'task')!.id;
  for (const [index, status] of ['done', 'open', 'archived'].entries()) {
    await service.execute({schemaVersion: 1, commandId: `task-update-${index}`, spaceId: 'space-a', issuedAt: plan().issuedAt, kind: 'task.update', entityId, expectedVersion: index + 1, patch: {status}}, actor);
  }
  assert.equal(store.state.tasks[0]?.status, 'archived');
  await assert.rejects(service.execute({schemaVersion: 1, commandId: 'task-revive', spaceId: 'space-a', issuedAt: plan().issuedAt, kind: 'task.update', entityId, expectedVersion: 4, patch: {status: 'open'}}, actor), code('invalid_state'));
});
test('failed transaction commits neither formal records, event, receipt nor consumed approval', async () => {
  const {service, store, draft, approval} = await approved(); store.failCommit = true;
  await assert.rejects(service.applyApproved('space-a', actor, draft.id, approval.id), /disk full/); noWrites(store.state);
  assert.equal(store.state.approvals[0]?.status, 'active'); assert.equal(store.state.drafts[0]?.status, 'approved');
});
test('generated ID collisions abort the full transaction', async () => {
  const store = new MemoryStore(); const service = createCommandService({store, now: () => plan().issuedAt, newId: () => 'same-id', hash: (s) => s});
  await assert.rejects(service.execute(plan(), actor), code('id_collision')); noWrites(store.state);
});
test('untrusted extra fields and unsupported schema versions never execute', async () => {
  const {service, store} = setup();
  await assert.rejects(service.execute({...plan(), schemaVersion: 2}, actor), code('invalid_input'));
  await assert.rejects(service.execute({...plan(), approved: true}, actor), code('invalid_input')); noWrites(store.state);
});
test('approval binds the version of a referenced project', async () => {
  const {service, store} = setup(); const receipt = await service.execute(plan(), actor); const projectId = receipt.result.entities.find((ref) => ref.kind === 'project')!.id;
  const draft = await service.createDraft({schemaVersion: 1, commandId: 'command-linked', spaceId: 'space-a', issuedAt: plan().issuedAt, kind: 'task.create', payload: {title: 'Linked task', projectId}}, actor, {source: 'ai', expiresAt: '2026-09-05T01:00:00.000Z'});
  const approval = await service.approveDraft('space-a', actor, draft.id, draft.version);
  await service.execute({schemaVersion: 1, commandId: 'project-change', spaceId: 'space-a', issuedAt: plan().issuedAt, kind: 'project.update', entityId: projectId, expectedVersion: 1, patch: {title: 'Replanned'}}, actor);
  await assert.rejects(service.applyApproved('space-a', actor, draft.id, approval.id), code('version_conflict'));
  assert.equal(store.state.tasks.length, 1);
});
test('key ordering does not change a command fingerprint', async () => {
  const {service, store} = setup(); const command = plan();
  const receipt = await service.execute(command, actor);
  const reordered = Object.fromEntries(Object.entries(command).reverse());
  assert.deepEqual(await service.execute(reordered, actor), receipt); assert.equal(store.state.goals.length, 1);
});
test('model-sourced draft held by the user requires confirmation and works without structuredClone', async (context) => {
  context.mock.method(globalThis, 'structuredClone', () => {throw new Error('structuredClone is unavailable');});
  const {service, store} = setup();
  const draft = await service.createDraft(plan(), actor, {source: 'ai', expiresAt: '2026-09-05T01:00:00.000Z'});
  assert.equal(draft.source, 'ai'); assert.equal(draft.actorKind, 'user');
  spaceStateSchema.parse(store.state);
  await assert.rejects(service.execute(plan(), actor), code('approval_required'));
  const approval = await service.approveDraft('space-a', actor, draft.id, draft.version);
  spaceStateSchema.parse(store.state);
  const receipt = await service.applyApproved('space-a', actor, draft.id, approval.id);
  spaceStateSchema.parse(store.state);
  assert.deepEqual(await service.getReceipt('space-a', actor, plan().commandId), receipt);
  assert.equal(await service.getReceipt('space-a', actor, 'unknown-command'), null);
  const view = await service.listPlan('space-a', actor);
  view.goals[0]!.title = 'Mutated by caller'; receipt.result.entities[0]!.id = 'fake';
  assert.equal((await service.listPlan('space-a', actor)).goals[0]?.title, 'Learn English');
  assert.notEqual((await service.getReceipt('space-a', actor, plan().commandId))?.result.entities[0]?.id, 'fake');
});
test('strict snapshots detect approval identity changes and missing transaction evidence', async () => {
  const {service, store, draft, approval} = await approved();
  assert.equal(spaceStateSchema.safeParse(store.state).success, true);
  const clone = () => JSON.parse(JSON.stringify(store.state)) as SpaceState;
  let malformed = clone(); malformed.members.push({...malformed.members[0]!});
  assert.equal(spaceStateSchema.safeParse(malformed).success, false);
  malformed = clone(); malformed.approvals[0]!.actorKind = 'ai';
  assert.equal(spaceStateSchema.safeParse(malformed).success, false);
  malformed = clone(); malformed.approvals = [];
  assert.equal(spaceStateSchema.safeParse(malformed).success, false);
  await service.applyApproved('space-a', actor, draft.id, approval.id);
  assert.equal(spaceStateSchema.safeParse(store.state).success, true);
  malformed = clone(); malformed.events = [];
  assert.equal(spaceStateSchema.safeParse(malformed).success, false);
  malformed = clone(); malformed.receipts = [];
  assert.equal(spaceStateSchema.safeParse(malformed).success, false);
  malformed = clone(); malformed.events[0]!.entities[0]!.id = 'fabricated';
  assert.equal(spaceStateSchema.safeParse(malformed).success, false);
});
test('AI receipt cannot be claimed by the user executor with the same principal', async () => {
  const ai: Actor = {...actor, kind: 'ai'};
  const {service, store, draft, approval} = await approved(setup(), ai);
  const receipt = await service.applyApproved('space-a', ai, draft.id, approval.id);
  assert.equal(receipt.actorKind, 'ai');
  await assert.rejects(service.execute(plan(), actor), code('command_conflict'));
  assert.equal(await service.getReceipt('space-a', actor, plan().commandId), null);
  assert.deepEqual(await service.getReceipt('space-a', ai, plan().commandId), receipt);
  assert.deepEqual(await service.applyApproved('space-a', ai, draft.id, approval.id), receipt);
  assert.equal(store.state.goals.length, 1);
});
test('user receipt cannot be claimed by an AI draft with the same principal', async () => {
  const {service, store} = setup(); const ai: Actor = {...actor, kind: 'ai'};
  const receipt = await service.execute(plan(), actor);
  assert.equal(receipt.actorKind, 'user');
  await assert.rejects(service.createDraft(plan(), ai, {source: 'ai', expiresAt: '2026-09-05T01:00:00.000Z'}), code('command_conflict'));
  assert.equal(await service.getReceipt('space-a', ai, plan().commandId), null);
  assert.deepEqual(await service.getReceipt('space-a', actor, plan().commandId), receipt);
  assert.deepEqual(await service.execute(plan(), actor), receipt);
  assert.equal(store.state.goals.length, 1);
});
test('edited rationale is saved as formal goal data and remains directly editable', async () => {
  const {service, store, draft} = await approved();
  const editedCommand = plan();
  if (editedCommand.kind === 'plan.create') editedCommand.payload.rationale = '为了能在工作会议中表达想法。';
  const edited = await service.editDraft('space-a', actor, draft.id, draft.version, editedCommand);
  const approval = await service.approveDraft('space-a', actor, draft.id, edited.version);
  const receipt = await service.applyApproved('space-a', actor, draft.id, approval.id);
  const goalId = receipt.result.entities.find((ref) => ref.kind === 'goal')!.id;
  assert.equal((await service.listPlan('space-a', actor)).goals[0]?.rationale, '为了能在工作会议中表达想法。');
  const update = {schemaVersion: 1, commandId: 'rationale-edit', spaceId: 'space-a', issuedAt: plan().issuedAt, kind: 'goal.update', entityId: goalId, expectedVersion: 1, patch: {rationale: '练习清楚、简洁地表达。'}};
  await service.execute(update, actor);
  assert.equal((await service.listPlan('space-a', actor)).goals[0]?.rationale, '练习清楚、简洁地表达。');
  spaceStateSchema.parse(store.state);
  await service.execute({...update, commandId: 'rationale-clear', expectedVersion: 2, patch: {rationale: null}}, actor);
  assert.equal((await service.listPlan('space-a', actor)).goals[0]?.rationale, undefined);
  spaceStateSchema.parse(store.state);
});
