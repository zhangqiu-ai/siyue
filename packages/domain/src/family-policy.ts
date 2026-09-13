import { familyPolicyRequestSchema, familyPolicySnapshotSchema } from '@siyue/contracts';
export type FamilyPolicyDenial = 'invalid_input' | 'scope_mismatch' | 'inactive_family' | 'not_member' | 'not_owner' | 'grant_denied' | 'stale_authorization' | 'child_management' | 'role_denied' | 'target_denied';
export type FamilyPolicyDecision = {
  allowed: true;
} | {
  allowed: false;
  reason: FamilyPolicyDenial;
};
const deny = (reason: FamilyPolicyDenial): FamilyPolicyDecision => ({
  allowed: false, reason
});
const allow = (): FamilyPolicyDecision => ({
  allowed: true
});
/** Internal permission eligibility only. Use fresh trusted transaction inputs, never client snapshots.
* Caller must enforce authentication, atomic writes, object versions and lifecycle invariants.
* Denial reasons are internal diagnostics, not public resource-existence responses. */
export function evaluateFamilyPolicy(snapshot: unknown, request: unknown): FamilyPolicyDecision {
  const s = familyPolicySnapshotSchema.safeParse(snapshot), r = familyPolicyRequestSchema.safeParse(request);
  if (!s.success || !r.success)
    return deny('invalid_input');
  const state = s.data, req = r.data;
  if (req.kind === 'record') {
    if (!state.record || state.record.id !== req.recordId || state.record.spaceId !== req.sourceSpaceId)
      return deny('scope_mismatch');
    if (req.context === 'personal')
      return state.record.ownerId === state.subject.id ? allow() : deny('not_owner');
  }
  if (!state.family || state.family.id !== req.familyId)
    return deny('scope_mismatch');
  if (!state.family.active)
    return deny('inactive_family');
  const member = state.memberships.find(m => m.familyId === req.familyId && m.subjectId === state.subject.id);
  if (!member?.active || member.subjectKind !== state.subject.kind)
    return deny('not_member');
  if (req.expectedMembershipVersion !== undefined && member.version !== req.expectedMembershipVersion)
    return deny('stale_authorization');
  if (req.kind === 'record') {
    const grant = state.grants.find(g => g.familyId === req.familyId && g.sourceSpaceId === req.sourceSpaceId && g.recordId === req.recordId);
    if (!grant?.active || req.action === 'edit' && grant.permission !== 'edit')
      return deny('grant_denied');
    if (req.expectedGrantVersion !== undefined && grant.version !== req.expectedGrantVersion)
      return deny('stale_authorization');
    return allow();
  }
  if (state.subject.kind === 'child')
    return deny('child_management');
  if (member.role !== 'owner' && member.role !== 'admin')
    return deny('role_denied');
  if (req.action === 'invite')
    return allow();
  if ((req.action === 'transfer' || req.action === 'dissolve') && member.role !== 'owner')
    return deny('role_denied');
  if (req.action === 'dissolve')
    return allow();
  const target = state.memberships.find(m => m.familyId === req.familyId && m.subjectId === req.targetSubjectId);
  if (!target?.active || target.subjectId === state.subject.id)
    return deny('target_denied');
  if (req.action === 'remove-member')
    return target.role === 'member' ? allow() : deny('target_denied');
  return target.subjectKind === 'adult' && target.role !== 'owner' ? allow() : deny('target_denied');
}
