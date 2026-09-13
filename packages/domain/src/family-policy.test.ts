import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFamilyPolicy } from './family-policy.js';
const member = (subjectId = 'a', role = 'member', subjectKind = 'adult') => ({
  familyId: 'f', subjectId, subjectKind, role, active: true, version: 2
});
const snapshot = () => ({
  subject: {
    id: 'a', kind: 'adult'
  }, family: {
    id: 'f', active: true
  }, record: {
    id: 'r', spaceId: 's', ownerId: 'owner'
  }, memberships: [member()], grants: [{
      familyId: 'f', sourceSpaceId: 's', recordId: 'r', permission: 'edit', active: true, version: 3
    }]
});
const request = {
  kind: 'record', context: 'family', familyId: 'f', sourceSpaceId: 's', recordId: 'r', action: 'edit', expectedMembershipVersion: 2, expectedGrantVersion: 3
};
test('shared edit requires current scoped membership and grant versions', () => {
  assert.equal(evaluateFamilyPolicy(snapshot(), request).allowed, true);
  for (const patch of [{
      familyId: 'other'
    }, {
      sourceSpaceId: 'other'
    }, {
      recordId: 'other'
    }, {
      expectedMembershipVersion: 1
    }, {
      expectedGrantVersion: 1
    }])
    assert.equal(evaluateFamilyPolicy(snapshot(), {
      ...request, ...patch
    }).allowed, false);
  for (const field of ['memberships', 'grants'] as const) {
    const s = snapshot();
    s[field][0].active = false;
    assert.equal(evaluateFamilyPolicy(s, request).allowed, false);
  }
  const s = snapshot();
  s.grants[0].permission = 'read';
  assert.equal(evaluateFamilyPolicy(s, request).allowed, false);
  assert.equal(evaluateFamilyPolicy(s, {
    ...request, action: 'read'
  }).allowed, true);
});
test('only original owner manages records; personal access needs no family', () => {
  for (const action of ['share', 'revoke', 'delete'])
    assert.equal(evaluateFamilyPolicy(snapshot(), {
      ...request, action
    }).allowed, false);
  const s = snapshot();
  s.subject.id = 'owner';
  s.memberships = [];
  s.grants = [];
  for (const action of ['read', 'edit', 'share', 'revoke', 'delete'])
    assert.equal(evaluateFamilyPolicy({
      ...s, family: null
    }, {
      kind: 'record', context: 'personal', sourceSpaceId: 's', recordId: 'r', action
    }).allowed, true);
});
test('family management protects owners, administrators and children', () => {
  const req = {
    kind: 'family', familyId: 'f', action: 'remove-member', targetSubjectId: 'target', expectedMembershipVersion: 2
  };
  for (const role of ['owner', 'admin']) {
    const s = snapshot();
    s.memberships = [member('a', role), member('target')];
    assert.equal(evaluateFamilyPolicy(s, req).allowed, true);
    for (const protectedRole of ['owner', 'admin']) {
      s.memberships[1].role = protectedRole;
      assert.equal(evaluateFamilyPolicy(s, req).allowed, false);
    }
  }
  const s = snapshot();
  s.subject.kind = 'child';
  s.memberships = [member('a', 'owner', 'child')];
  assert.equal(evaluateFamilyPolicy(s, {
    kind: 'family', familyId: 'f', action: 'dissolve', expectedMembershipVersion: 2
  }).allowed, false);
});
test('transfer requires owner and distinct active adult target; admin cannot dissolve', () => {
  const s = snapshot();
  s.memberships = [member('a', 'owner'), member('target')];
  const req = {
    kind: 'family', familyId: 'f', action: 'transfer', targetSubjectId: 'target', expectedMembershipVersion: 2
  };
  assert.equal(evaluateFamilyPolicy(s, req).allowed, true);
  s.memberships[1].subjectKind = 'child';
  assert.equal(evaluateFamilyPolicy(s, req).allowed, false);
  s.memberships[0].role = 'admin';
  assert.equal(evaluateFamilyPolicy(s, {
    kind: 'family', familyId: 'f', action: 'dissolve', expectedMembershipVersion: 2
  }).allowed, false);
});
test('inconsistent trusted snapshots and unsupported actions fail closed', () => {
  const mismatched = snapshot();
  mismatched.memberships[0].subjectKind = 'child';
  assert.equal(evaluateFamilyPolicy(mismatched, request).allowed, false);
  const inactive = snapshot();
  inactive.family.active = false;
  assert.equal(evaluateFamilyPolicy(inactive, request).allowed, false);
  assert.equal(evaluateFamilyPolicy(snapshot(), {
    ...request, action: 'ai-export'
  }).allowed, false);
  const duplicateMember = snapshot();
  duplicateMember.memberships.push({
    ...duplicateMember.memberships[0], active: false, version: 3
  });
  assert.equal(evaluateFamilyPolicy(duplicateMember, request).allowed, false);
  const duplicateGrant = snapshot();
  duplicateGrant.grants.push({
    ...duplicateGrant.grants[0], active: false, version: 4
  });
  assert.equal(evaluateFamilyPolicy(duplicateGrant, request).allowed, false);
});
test('a caller cannot mutate later decisions and whitespace IDs do not borrow authority', () => {
  const first = evaluateFamilyPolicy(snapshot(), request);
  Object.assign(first, {
    allowed: false
  });
  assert.equal(evaluateFamilyPolicy(snapshot(), request).allowed, true);
  assert.equal(evaluateFamilyPolicy(snapshot(), {
    ...request, familyId: ' f '
  }).allowed, false);
});
