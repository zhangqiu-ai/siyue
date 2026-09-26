import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountDeletionImpact, DeletionDependencyDisposition } from '@siyue/contracts';
import { AuthError } from './sessions.js';
import { resolveAccountDeletionDisposition } from './account-deletion-disposition.js';

const subjectId = '2f1a4c0e-8b1d-4f2a-9c3e-5d6b7a8f9012';
const familyA = '11111111-1111-4111-8111-111111111111';
const familyB = '22222222-2222-4222-9222-222222222222';
const familyC = '33333333-3333-4333-a333-333333333333';
const childX = '44444444-4444-4444-b444-444444444444';
const childY = '55555555-5555-4555-8555-555555555555';
const recipient = '66666666-6666-4666-9666-666666666666';
const otherRecipient = '77777777-7777-4777-a777-777777777777';

type FamilyRow = AccountDeletionImpact['families'][number];
type GuardianshipRow = AccountDeletionImpact['guardianships'][number];

const familyRow = (familyId: string, role: FamilyRow['role'] = 'owner'): FamilyRow => ({ familyId, role,
  soleActiveOwner: role === 'owner', otherActiveAdultCount: 0, otherActiveChildCount: 0 });
const guardianshipRow = (familyId: string, childSubjectId: string): GuardianshipRow => ({ familyId,
  childSubjectId, soleGuardian: true, otherGuardianCount: 0, activeChildDeviceCount: 1 });
const impact = (families: FamilyRow[] = [], guardianships: GuardianshipRow[] = []): AccountDeletionImpact =>
  ({ subjectId, families, guardianships,
    activeChildDeviceCount: guardianships.reduce((total, entry) => total + entry.activeChildDeviceCount, 0) });

// Both rejection paths are asserted with their exact code and status: an input outside the shared
// contracts is a malformed request, while a well-formed input that contradicts the authoritative
// inventory is a dependency conflict that requires the caller to look at the current state again.
function refuses(impactValue: unknown, declared: unknown, code: string, status: number) {
  assert.throws(
    () => resolveAccountDeletionDisposition(impactValue as AccountDeletionImpact,
      declared as DeletionDependencyDisposition),
    (error: unknown) => error instanceof AuthError && error.code === code && error.status === status,
    `expected ${code} ${status} for ${JSON.stringify(declared)}`);
}
const dependencies = (impactValue: unknown, declared: unknown) =>
  refuses(impactValue, declared, 'AUTH_DELETION_DEPENDENCIES', 409);
const invalidRequest = (impactValue: unknown, declared: unknown) =>
  refuses(impactValue, declared, 'AUTH_INVALID_REQUEST', 400);

test('an inventory with no family or guardianship accepts only the explicit none', () => {
  const none = resolveAccountDeletionDisposition(impact(), { kind: 'none' });
  assert.equal(none.kind, 'none');
  assert.deepEqual(none.familyIds, []);
  assert.equal(none.familyChoices.size, 0);
  // Nothing may be settled for a family the caller is not affected by, and `none` is still the only
  // accepted answer once any dependency exists.
  for (const declared of [{ kind: 'per-family', families: [{ familyId: familyA, kind: 'end-family-access' }] },
    { kind: 'per-family', families: [{ familyId: familyA, kind: 'transfer', recipientSubjectId: recipient }] }])
    dependencies(impact(), declared);
  dependencies(impact([familyRow(familyA)]), { kind: 'none' });
  dependencies(impact([], [guardianshipRow(familyB, childX)]), { kind: 'none' });
});

test('each affected family is settled once and different families may choose differently', () => {
  const inventory = impact([familyRow(familyA), familyRow(familyB, 'member')],
    [guardianshipRow(familyA, childX)]);
  const declared = { kind: 'per-family', families: [
    { familyId: familyB, kind: 'end-family-access' },
    { familyId: familyA, kind: 'transfer', recipientSubjectId: recipient }] } as const;
  const plan = resolveAccountDeletionDisposition(inventory, declared);
  assert.equal(plan.kind, 'per-family');
  // The union is de-duplicated and normalized into inventory order, whatever order the caller used.
  assert.deepEqual(plan.familyIds, [familyA, familyB]);
  assert.deepEqual([...plan.familyChoices.keys()], [familyA, familyB]);
  assert.deepEqual(plan.familyChoices.get(familyA),
    { familyId: familyA, kind: 'transfer', recipientSubjectId: recipient });
  assert.deepEqual(plan.familyChoices.get(familyB),
    { familyId: familyB, kind: 'end-family-access' });
  // The plan is a parsed copy: it shares no entry object with the caller's input.
  assert.notEqual(plan.familyChoices.get(familyA), declared.families[1]);
});

test('a family reached only through a guardianship is affected and needs its own entry', () => {
  // The same guardian family may hold two children; the family is still one affected family, while
  // the family row list stays empty.
  const inventory = impact([], [guardianshipRow(familyB, childX), guardianshipRow(familyB, childY)]);
  const plan = resolveAccountDeletionDisposition(inventory,
    { kind: 'per-family', families: [{ familyId: familyB, kind: 'end-family-access' }] });
  assert.deepEqual(plan.familyIds, [familyB]);
  assert.equal(plan.familyChoices.size, 1);
  const mixed = impact([familyRow(familyA)], [guardianshipRow(familyB, childX)]);
  const both = resolveAccountDeletionDisposition(mixed,
    { kind: 'per-family', families: [{ familyId: familyB, kind: 'end-family-access' },
      { familyId: familyA, kind: 'transfer', recipientSubjectId: otherRecipient }] });
  assert.deepEqual(both.familyIds, [familyA, familyB]);
  dependencies(mixed, { kind: 'per-family', families: [{ familyId: familyA, kind: 'end-family-access' }] });
  dependencies(mixed, { kind: 'per-family', families: [{ familyId: familyB, kind: 'end-family-access' }] });
});

test('missing and extra families are refused instead of widened or narrowed', () => {
  const inventory = impact([familyRow(familyA), familyRow(familyB)], []);
  dependencies(inventory, { kind: 'per-family',
    families: [{ familyId: familyA, kind: 'end-family-access' }] });
  dependencies(inventory, { kind: 'per-family', families: [
    { familyId: familyA, kind: 'end-family-access' },
    { familyId: familyC, kind: 'end-family-access' }] });
  dependencies(inventory, { kind: 'per-family', families: [
    { familyId: familyA, kind: 'end-family-access' },
    { familyId: familyB, kind: 'end-family-access' },
    { familyId: familyC, kind: 'end-family-access' }] });
  dependencies(inventory, { kind: 'per-family',
    families: [{ familyId: familyC, kind: 'end-family-access' }] });
  dependencies(inventory, { kind: 'none' });
});

test('a repeated family id is a malformed request, not a dependency conflict', () => {
  const inventory = impact([familyRow(familyA)], []);
  invalidRequest(inventory, { kind: 'per-family', families: [
    { familyId: familyA, kind: 'end-family-access' },
    { familyId: familyA, kind: 'end-family-access' }] });
  invalidRequest(inventory, { kind: 'per-family', families: [
    { familyId: familyA, kind: 'transfer', recipientSubjectId: recipient },
    { familyId: familyA, kind: 'end-family-access' }] });
});

test('input outside the strict contracts is refused as an invalid request', () => {
  const inventory = impact([familyRow(familyA)], []);
  for (const declared of [
    { kind: 'end-family-access' }, { kind: 'transfer', recipientSubjectId: recipient },
    { kind: 'delete-everything' }, { kind: 'per-family' }, { kind: 'per-family', families: [] },
    { kind: 'per-family', families: 'family-a' },
    { kind: 'per-family', families: [{ familyId: familyA, kind: 'transfer' }] },
    { kind: 'per-family', families: [{ familyId: 'not-a-uuid', kind: 'end-family-access' }] },
    { kind: 'per-family', families: [{ familyId: familyA, kind: 'end-family-access', recipientSubjectId: recipient }] },
    { kind: 'none', families: [{ familyId: familyA, kind: 'end-family-access' }] },
    { kind: 'none', subjectId }, null, undefined,
  ]) invalidRequest(inventory, declared);
  for (const broken of [{ ...impact(), subjectId: 'not-a-uuid' },
    { ...impact(), families: undefined }, { ...impact(), guardianships: [{}] },
    { ...impact(), activeChildDeviceCount: -1 },
    { subjectId, families: [], guardianships: [], activeChildDeviceCount: 0, email: 'x@example.test' },
    null, undefined])
    invalidRequest(broken, { kind: 'none' });
});
