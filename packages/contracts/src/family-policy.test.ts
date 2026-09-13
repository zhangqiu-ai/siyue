import test from 'node:test';
import assert from 'node:assert/strict';
import { familyPolicyRequestSchema, familyPolicySnapshotSchema } from './family-policy.js';
test('policy boundaries reject extra fields and missing edit versions', () => {
  assert.equal(familyPolicyRequestSchema.safeParse({
    kind: 'record', action: 'edit', context: 'family', familyId: 'f', sourceSpaceId: 's', recordId: 'r'
  }).success, false);
  assert.equal(familyPolicySnapshotSchema.safeParse({
    subject: {
      id: 'a', kind: 'adult', token: 'secret'
    }, family: null, record: null, memberships: [], grants: []
  }).success, false);
});
test('duplicate membership and grant identities are rejected', () => {
  const member = {
    familyId: 'f', subjectId: 'a', subjectKind: 'adult', role: 'member', active: true, version: 1
  };
  const base = {
    subject: {
      id: 'a', kind: 'adult'
    }, family: null, record: null, memberships: [member, member], grants: []
  };
  assert.equal(familyPolicySnapshotSchema.safeParse(base).success, false);
  const grant = {
    familyId: 'f', sourceSpaceId: 's', recordId: 'r', permission: 'read', active: true, version: 1
  };
  assert.equal(familyPolicySnapshotSchema.safeParse({
    ...base, memberships: [], grants: [grant, grant]
  }).success, false);
});
