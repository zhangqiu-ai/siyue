import test from 'node:test';
import assert from 'node:assert/strict';
import { editableDraftPayload, validateDraftInput, reconcileDraftReceipt } from '../src/space/draft-state.ts';

const now = Date.parse('2026-09-09T00:00:00Z');
const payload = () => ({ title: ' Goal ', projectTitles: [' Project '], taskTitles: [' Task '], rationale: ' Why ' });
const draft = () => ({ id: 'draft', schemaVersion: 1, spaceId: 'space', actorId: 'owner', actorKind: 'user', source: 'ai', payloadHash: 'hash', version: 1, status: 'draft', expiresAt: '2026-09-09T00:30:00Z', createdAt: '2026-09-09T00:00:00Z', updatedAt: '2026-09-09T00:00:00Z', command: { schemaVersion: 1, commandId: 'command-id', spaceId: 'space', issuedAt: '2026-09-09T00:00:00Z', kind: 'plan.create', payload: payload() } });
const receipt = () => ({ schemaVersion: 1, commandId: 'command-id', spaceId: 'space', actorId: 'owner', actorKind: 'user', payloadHash: 'hash', status: 'applied', appliedAt: '2026-09-09T00:01:00Z', result: { entities: [{ kind: 'goal', id: 'goal', version: 1 }, { kind: 'project', id: 'project', version: 1 }, { kind: 'task', id: 'task', version: 1 }] } });
const snapshot = () => ({ goals: [{ id: 'goal', spaceId: 'space', version: 1 }], projects: [{ id: 'project', spaceId: 'space', version: 1 }], tasks: [{ id: 'task', spaceId: 'space', version: 1 }], drafts: [], runs: [] });
const client = (r = receipt(), s = snapshot()) => ({ receipt: async id => { assert.equal(id, 'command-id'); return r; }, snapshot: async () => s });

test('editable draft returns trimmed independent payload and arrays', () => {
  const original = draft();
  const result = editableDraftPayload(original, now);
  assert.deepEqual(result, { title: 'Goal', projectTitles: ['Project'], taskTitles: ['Task'], rationale: 'Why' });
  result.projectTitles[0] = 'Changed'; result.taskTitles.push('Another');
  assert.deepEqual(original.command.payload, payload());
});

test('only unexpired draft plan.create can be edited', () => {
  assert.equal(editableDraftPayload(null, now), null);
  for (const status of ['approved', 'applied', 'cancelled', 'rejected', 'expired']) assert.equal(editableDraftPayload({ ...draft(), status }, now), null);
  assert.equal(editableDraftPayload(draft(), Date.parse(draft().expiresAt)), null);
  assert.equal(editableDraftPayload(draft(), now + 3600000), null);
  assert.equal(editableDraftPayload(draft(), NaN), null);
  assert.equal(editableDraftPayload({ ...draft(), expiresAt: 'invalid' }, now), null);
  assert.equal(editableDraftPayload({ ...draft(), command: { ...draft().command, kind: 'task.create' } }, now), null);
});

test('exactly one project and strict nonempty titles are required without dropping tasks', () => {
  for (const patch of [{ projectTitles: [] }, { projectTitles: ['A', 'B'] }, { projectTitles: [' '] }, { title: ' ' }, { taskTitles: ['Keep', ' '] }, { taskTitles: ['x'.repeat(241)] }, { taskTitles: Array(25).fill('Task') }, { approved: true }]) {
    assert.equal(validateDraftInput({ ...payload(), ...patch }), null);
    assert.equal(editableDraftPayload({ ...draft(), command: { ...draft().command, payload: { ...payload(), ...patch } } }, now), null);
  }
  assert.deepEqual(validateDraftInput({ title: 'Goal', projectTitles: ['Project'], taskTitles: [] }), { title: 'Goal', projectTitles: ['Project'], taskTitles: [] });
});

test('receipt reconciliation confirms existing entities, including subsequently updated versions', async () => {
  assert.equal(await reconcileDraftReceipt(client(), draft()), true);
  const updated = snapshot(); updated.tasks[0].version = 2;
  assert.equal(await reconcileDraftReceipt(client(receipt(), updated), draft()), true);
});

test('missing or mismatched receipts cannot prove success', async () => {
  assert.equal(await reconcileDraftReceipt(client(null), draft()), false);
  for (const patch of [{ commandId: 'other' }, { spaceId: 'other' }, { actorId: 'other' }, { actorKind: 'ai' }, { payloadHash: 'other' }, { status: 'unknown' }, { result: { entities: [] } }]) assert.equal(await reconcileDraftReceipt(client({ ...receipt(), ...patch }), draft()), false);
  assert.equal(await reconcileDraftReceipt(client(), { ...draft(), command: { ...draft().command, spaceId: 'other' } }), false);
});

test('every receipt entity must exist in the correct space and at least its committed version', async () => {
  for (const group of ['goals', 'projects', 'tasks']) {
    for (const fault of ['missing', 'space', 'version']) {
      const s = snapshot();
      if (fault === 'missing') s[group] = [];
      else if (fault === 'space') s[group][0].spaceId = 'other';
      else s[group][0].version = 0;
      assert.equal(await reconcileDraftReceipt(client(receipt(), s), draft()), false);
    }
  }
});

test('receipt and snapshot read failures propagate instead of declaring failure to save', async () => {
  const failure = new Error('read unavailable');
  await assert.rejects(reconcileDraftReceipt({ ...client(), receipt: async () => { throw failure; } }, draft()), error => error === failure);
  await assert.rejects(reconcileDraftReceipt({ ...client(), snapshot: async () => { throw failure; } }, draft()), error => error === failure);
});
