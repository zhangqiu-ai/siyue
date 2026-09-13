import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mayAccessRecord } from './share-policy.mjs';
const record = { id: 'conversation-1', spaceId: 'private-a', ownerId: 'a' };
const base = { actorId: 'b', record, action: 'read', familyId: 'family-1',
  memberships: [{ actorId: 'b', familyId: 'family-1', role: 'admin', active: true }],
  grants: [{ recordId: record.id, sourceSpaceId: record.spaceId, familyId: 'family-1', permission: 'edit', active: true }] };

test('membership and administration alone never expose private records', () => {
  assert.equal(mayAccessRecord({ ...base, grants: [] }), false);
  assert.equal(mayAccessRecord({ ...base, actorId: 'outsider' }), false);
});
test('read-only grant cannot write, even for a family administrator', () => {
  const grants = [{ ...base.grants[0], permission: 'read' }];
  assert.equal(mayAccessRecord({ ...base, grants }), true);
  assert.equal(mayAccessRecord({ ...base, grants, action: 'edit' }), false);
});
test('editor cannot grant, revoke or delete the source', () => {
  assert.equal(mayAccessRecord({ ...base, action: 'edit' }), true);
  for (const action of ['share', 'revoke', 'delete']) {
    assert.equal(mayAccessRecord({ ...base, action }), false);
    assert.equal(mayAccessRecord({ ...base, action, actorId: 'a' }), true);
  }
});
test('current membership and grant are both required after revocation', () => {
  assert.equal(mayAccessRecord({ ...base, memberships: [{ ...base.memberships[0], active: false }] }), false);
  assert.equal(mayAccessRecord({ ...base, grants: [{ ...base.grants[0], active: false }] }), false);
  assert.equal(mayAccessRecord({ ...base, memberships: [] }), false);
});
test('same ID in another source space and another family cannot borrow a grant', () => {
  assert.equal(mayAccessRecord({ ...base, record: { ...record, spaceId: 'private-c' } }), false);
  assert.equal(mayAccessRecord({ ...base, familyId: 'family-2' }), false);
  assert.equal(mayAccessRecord({ ...base, record: { ...record, id: 'unshared-conversation' } }), false);
});
test('new messages retain conversation scope; revoked grant stops subsequent reads', () => {
  assert.equal(mayAccessRecord({ ...base, record: { ...record, version: 2 } }), true);
  assert.equal(mayAccessRecord({ ...base, record: { ...record, version: 3 }, grants: [] }), false);
});
test('AI export and unknown operations fail closed', () => {
  assert.equal(mayAccessRecord({ ...base, action: 'ai-export' }), false);
  assert.equal(mayAccessRecord({ ...base, actorId: 'a', action: 'ai-export' }), false);
});
