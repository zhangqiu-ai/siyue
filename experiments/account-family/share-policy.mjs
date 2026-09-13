// Isolated policy fixture, not a network authorization boundary.
// All inputs represent a fresh, trusted server transaction snapshot.
export function mayAccessRecord({ actorId, record, action, familyId, memberships, grants }) {
  if (!actorId || !record?.id || !record?.spaceId || !record?.ownerId) return false;
  if (!['read', 'edit', 'share', 'revoke', 'delete'].includes(action)) return false;
  if (actorId === record.ownerId) return true;
  if (action !== 'read' && action !== 'edit') return false;
  const member = memberships.some(m => m.actorId === actorId && m.familyId === familyId && m.active);
  return member && grants.some(g => g.familyId === familyId && g.recordId === record.id &&
    g.sourceSpaceId === record.spaceId && g.active &&
    (g.permission === 'edit' || (action === 'read' && g.permission === 'read')));
}
