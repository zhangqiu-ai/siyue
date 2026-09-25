import type { PoolClient } from 'pg';
import { AuthError } from './sessions.js';

interface FamilyRow { owner_subject_id: string; status: string; }
interface OwnerRow { role: string; active: boolean; kind: string; status: string; }
interface DependencyCounts {
  other_memberships: number; foreign_create_requests: number; invitations: number;
  guardianships: number; consents: number; pairing_requests: number; device_grants: number;
  rooms: number; room_seats: number; management_acceptances: number; family_reviews: number;
}

// Every table that carries a foreign key to the family is counted by name, so a family this step is
// about to remove can never be judged empty while a row of one of those tables still points at it. The
// two rows this step does remove are counted too, and `family_memberships` deliberately counts inactive
// history: a member who left still makes the family something other people once belonged to, and the
// member rule below is "never had anyone else", not "nobody else right now". `family_create_requests`
// is split the same way, because a request belonging to another subject is that subject's record and
// must refuse this step instead of being deleted on the owner's behalf.
//
// The consent count is the family-scoped one: a live consent cited by a guardianship of this family.
// A consent with no relationship in this family belongs to whatever family its child actually lives in,
// so it is left to that family's own disposition rather than being guessed at or withdrawn here.
const dependencyCounts = `SELECT
    (SELECT count(*)::int FROM siyue.family_memberships m
      WHERE m.family_id=$1 AND m.subject_id<>$2) AS other_memberships,
    (SELECT count(*)::int FROM siyue.family_create_requests r
      WHERE r.family_id=$1 AND r.subject_id<>$2) AS foreign_create_requests,
    (SELECT count(*)::int FROM siyue.family_invitations i WHERE i.family_id=$1) AS invitations,
    (SELECT count(*)::int FROM siyue.guardian_relationships g WHERE g.family_id=$1) AS guardianships,
    (SELECT count(*)::int FROM siyue.guardian_relationships g
      JOIN siyue.consent_records c ON c.id=g.consent_record_id AND c.withdrawn_at IS NULL
      WHERE g.family_id=$1) AS consents,
    (SELECT count(*)::int FROM siyue.device_pairing_requests p WHERE p.family_id=$1) AS pairing_requests,
    (SELECT count(*)::int FROM siyue.device_grants d WHERE d.family_id=$1) AS device_grants,
    (SELECT count(*)::int FROM siyue.rooms r WHERE r.family_id=$1) AS rooms,
    (SELECT count(*)::int FROM siyue.room_seats s JOIN siyue.rooms r ON r.id=s.room_id
      WHERE r.family_id=$1) AS room_seats,
    (SELECT count(*)::int FROM siyue.family_management_acceptances a WHERE a.family_id=$1) AS management_acceptances,
    (SELECT count(*)::int FROM siyue.account_deletion_family_reviews v WHERE v.family_id=$1) AS family_reviews`;

/**
 * Internal step of a future deletion acceptance transaction: a sole owner ends a family that never had
 * anyone else and holds nothing shared. The caller owns the transaction and the deleting subject's row
 * lock, and passes one family from the server-checked per-family disposition. This step commits nothing
 * by itself, so a deletion that fails later restores the family, its membership and its create request
 * exactly as they were.
 *
 * The step accepts only the caller's own current, active ownership of a still-active family, and only a
 * family that is genuinely empty: every member row other than the owner's own -- including inactive
 * history -- and every invitation, guardianship, live guardianship consent, child device grant, pairing
 * request, room, released or live room seat, management acceptance and pending family review refuses the
 * step instead of being swept, reassigned or deleted. Nothing outside the owner's own family-scoped rows
 * is ever removed, so another subject's family, membership, consent or shared work cannot be touched by
 * a mistake here.
 *
 * On a family that passed that scan the step removes the family's create-request idempotency rows, the
 * owner's own membership and the family row itself, which is what leaves no `families.owner_subject_id`
 * pointing at the deleting subject. Nothing is stamped, so the step takes no clock: every row it settles
 * is deleted outright.
 */
export async function dissolveEmptyOwnedFamilyForDeletion(client: PoolClient, subjectId: string,
  familyId: string): Promise<void> {
  // The family lock serializes this step with every other family mutation, which reads this row first:
  // freeze, transfer, member exit, invitation acceptance, room creation and guardianship changes all do.
  const family = (await client.query<FamilyRow>(
    'SELECT owner_subject_id,status FROM siyue.families WHERE id=$1 FOR UPDATE', [familyId])).rows[0];
  if (!family || family.status !== 'active' || family.owner_subject_id !== subjectId)
    throw new AuthError('AUTH_DELETION_DEPENDENCIES', 409);
  // The caller already holds the deleting subject's own lock; locking the subject here too makes that
  // precondition harmless to restate and keeps the adult/active read from going stale.
  const owner = (await client.query<OwnerRow>(`SELECT m.role,m.active,s.kind,s.status
    FROM siyue.family_memberships m JOIN siyue.subjects s ON s.id=m.subject_id
    WHERE m.family_id=$1 AND m.subject_id=$2 FOR UPDATE OF m,s`, [familyId, subjectId])).rows[0];
  if (!owner?.active || owner.role !== 'owner' || owner.kind !== 'adult' || owner.status !== 'active')
    throw new AuthError('AUTH_DELETION_DEPENDENCIES', 409);
  // Read after both locks, so a family another transaction is changing is decided on the committed
  // state. A row inserted concurrently after this scan by a writer that took the family lock would be
  // serialized before it; one that bypassed the family row is still refused by the foreign keys on the
  // deletes below, which abort the whole caller transaction instead of leaving a half-emptied family.
  const counts = (await client.query<DependencyCounts>(dependencyCounts, [familyId, subjectId])).rows[0];
  if (!counts || Object.values(counts).some(count => count !== 0))
    throw new AuthError('AUTH_DELETION_DEPENDENCIES', 409);

  // The create request references the family, so it is deleted first. Only the owner's own idempotency
  // rows are deleted; the scan above already refused any row of another subject.
  await client.query('DELETE FROM siyue.family_create_requests WHERE family_id=$1 AND subject_id=$2',
    [familyId, subjectId]);
  // The membership row goes before the family it points at, and is required to exist exactly once: a
  // family that had already lost its owner row is a state this step must not silently finish.
  const membership = await client.query(`DELETE FROM siyue.family_memberships
    WHERE family_id=$1 AND subject_id=$2 AND role='owner' AND active`, [familyId, subjectId]);
  if (membership.rowCount !== 1) throw new AuthError('AUTH_DELETION_DEPENDENCIES', 409);
  // Guarded on the same ownership and status the step read under the lock, so a family that changed in
  // between is refused rather than deleted, and the caller's transaction rolls every delete back.
  const removed = await client.query(`DELETE FROM siyue.families
    WHERE id=$1 AND owner_subject_id=$2 AND status='active'`, [familyId, subjectId]);
  if (removed.rowCount !== 1) throw new AuthError('AUTH_DELETION_DEPENDENCIES', 409);
}
