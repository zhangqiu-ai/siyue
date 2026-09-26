import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmVisibleDraft, receiptCounts, recheckDraft } from '../src/space/draft-actions.ts';

test('join saves the final visible edit before confirming its exact version and hash', async () => {
  const order = [];
  let visible = { payloadHash: 'old', version: 1 };
  const receipt = { result: { entities: [{ kind: 'goal', id: 'g1' }, { kind: 'project', id: 'p1' }, { kind: 'task', id: 't1' }] } };
  const result = await confirmVisibleDraft({
    flush: async () => { order.push('save'); visible = { payloadHash: 'new', version: 2 }; return { version: 2 }; },
    visible: () => visible,
    confirm: async (hash, version) => { order.push(`confirm:${hash}:${version}`); return receipt; },
    latest: async () => { throw new Error('should not read'); },
    reconcile: async () => false,
  });
  assert.deepEqual(order, ['save', 'confirm:new:2']);
  assert.equal(result.kind, 'applied');
  assert.deepEqual(receiptCounts(result.receipt), { goals: 1, projects: 1, tasks: 1, goalId: 'g1' });
});

test('a failed autosave never confirms an older draft', async () => {
  let confirmations = 0;
  const result = await confirmVisibleDraft({
    flush: async () => { throw new Error('offline'); },
    visible: () => ({ payloadHash: 'old', version: 1 }),
    confirm: async () => { confirmations++; throw new Error('should not confirm'); },
    latest: async () => null,
    reconcile: async () => false,
  });
  assert.equal(result.kind, 'save_failed');
  assert.equal(confirmations, 0);
});

test('unknown confirmation locks until receipt reconciliation, without issuing another confirmation', async () => {
  let confirmations = 0;
  const latest = async () => ({ id: 'd1' });
  const deps = {
    flush: async () => ({ version: 2 }),
    visible: () => ({ payloadHash: 'new', version: 2 }),
    confirm: async () => { confirmations++; throw new Error('connection lost'); },
    latest,
    reconcile: async () => false,
  };
  assert.equal((await confirmVisibleDraft(deps)).kind, 'unknown');
  assert.equal(await recheckDraft({ latest, reconcile: deps.reconcile }), 'not_applied');
  assert.equal(confirmations, 1);
});
