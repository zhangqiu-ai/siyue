import type { Pool, PoolClient } from 'pg';
import { accountDeletionImpactSchema, type AccountDeletionImpact } from '@siyue/contracts';
import { transaction } from '../../adapters/postgres/database.js';
import { AuthError, type SessionService } from './sessions.js';

// Read-only dependency inventory behind the "settings -> account -> delete account" confirmation
// (design chapter 13, DEL-04). Design 13.2 fixes what a subject must be able to see before choosing a
// disposition: the families and restricted child devices a deletion would affect, and whether the
// caller is the only owner or the only guardian. This module answers exactly that and nothing else:
// it is not a deletion and it writes no row. The runtime exposes only this read-only preview.
//
// Deliberate limits of the payload:
// - Only ids and counts. No display name, address, login method, provider identity or session/token
//   material of the caller or of anybody else is returned; a family member or co-guardian appears as
//   a count, never as an id.
// - Guardianship is read from `guardian_relationships` together with its recorded consent. An
//   owner/admin/member family role never contributes a guardianship, so a family owner who guards
//   nobody gets `guardianships: []` while the family itself is still reported.
// - Every entry is the caller's own current dependency: an inactive subject, a dissolved family, an
//   inactive membership, a revoked relationship, a withdrawn consent or a dead child device is
//   absent instead of reported as a stale entry.

export {accountDeletionImpactSchema} from '@siyue/contracts';
export type {AccountDeletionImpact} from '@siyue/contracts';

interface FamilyRow {
  family_id: string; role: string; active_owner_count: number;
  other_active_adult_count: number; other_active_child_count: number;
}
interface GuardianshipRow {
  family_id: string; child_subject_id: string;
  other_guardian_count: number; active_child_device_count: number;
}

// Same reachability rule the family and guardianship reads use: the family must be active and the
// caller's own membership must be active. Their subject state is re-checked inside this read
// transaction, so a subject that stopped being active after the token was verified reads nothing.
const visibleFamilies = `SELECT f.id AS family_id, m.role AS role,
    (SELECT count(*)::int FROM siyue.family_memberships owner_row
      WHERE owner_row.family_id = f.id AND owner_row.role = 'owner' AND owner_row.active) AS active_owner_count,
    (SELECT count(*)::int FROM siyue.family_memberships other_member
      JOIN siyue.subjects other_subject ON other_subject.id = other_member.subject_id
      WHERE other_member.family_id = f.id AND other_member.active AND other_member.subject_id <> $1
        AND other_subject.status = 'active' AND other_subject.kind = 'adult') AS other_active_adult_count,
    (SELECT count(*)::int FROM siyue.family_memberships child_member
      JOIN siyue.subjects child_subject ON child_subject.id = child_member.subject_id
      WHERE child_member.family_id = f.id AND child_member.active AND child_member.subject_id <> $1
        AND child_subject.status = 'active' AND child_subject.kind = 'child') AS other_active_child_count
  FROM siyue.families f
    JOIN siyue.family_memberships m ON m.family_id = f.id AND m.subject_id = $1 AND m.active
  WHERE f.status = 'active'
  ORDER BY f.created_at, f.id`;

// A guardianship exists for the caller only while the relationship, its recorded consent, the child,
// the caller, both memberships and the family are all still live. The `soleGuardian` count applies
// the same rule to the *other* guardians of the child without restricting them to this family, so the
// caller is never reported as a child's only remaining guardian while another family still supervises
// that child. Child devices stay scoped to this family and to the caller's own grants.
const visibleGuardianships = `SELECT r.family_id, r.child_subject_id,
    (SELECT count(*)::int FROM siyue.guardian_relationships other
      JOIN siyue.consent_records other_consent ON other_consent.id = other.consent_record_id
        AND other_consent.actor_subject_id = other.guardian_subject_id
        AND other_consent.subject_id = other.child_subject_id AND other_consent.purpose = 'child-guardianship'
        AND other_consent.withdrawn_at IS NULL
      JOIN siyue.subjects other_guardian ON other_guardian.id = other.guardian_subject_id
        AND other_guardian.kind = 'adult' AND other_guardian.status = 'active'
      JOIN siyue.subjects other_child ON other_child.id = other.child_subject_id
        AND other_child.kind = 'child' AND other_child.status = 'active'
      JOIN siyue.families other_family ON other_family.id = other.family_id AND other_family.status = 'active'
      JOIN siyue.family_memberships other_guardian_member ON other_guardian_member.family_id = other.family_id
        AND other_guardian_member.subject_id = other.guardian_subject_id AND other_guardian_member.active
      JOIN siyue.family_memberships other_child_member ON other_child_member.family_id = other.family_id
        AND other_child_member.subject_id = other.child_subject_id AND other_child_member.active
      WHERE other.child_subject_id = r.child_subject_id AND other.active AND other.guardian_subject_id <> $1)
      AS other_guardian_count,
    (SELECT count(*)::int FROM siyue.device_grants grant_row
      WHERE grant_row.child_subject_id = r.child_subject_id AND grant_row.family_id = r.family_id
        AND grant_row.guardian_id = $1 AND grant_row.revoked_at IS NULL AND grant_row.expires_at > $2
        AND grant_row.guardian_relationship_version = r.version
        AND grant_row.guardian_credential_version = self.credential_version) AS active_child_device_count
  FROM siyue.guardian_relationships r
    JOIN siyue.consent_records consent ON consent.id = r.consent_record_id
      AND consent.actor_subject_id = r.guardian_subject_id AND consent.subject_id = r.child_subject_id
      AND consent.purpose = 'child-guardianship' AND consent.withdrawn_at IS NULL
    JOIN siyue.subjects self ON self.id = r.guardian_subject_id AND self.kind = 'adult' AND self.status = 'active'
    JOIN siyue.subjects child ON child.id = r.child_subject_id AND child.kind = 'child' AND child.status = 'active'
    JOIN siyue.families f ON f.id = r.family_id AND f.status = 'active'
    JOIN siyue.family_memberships guardian_member ON guardian_member.family_id = r.family_id
      AND guardian_member.subject_id = r.guardian_subject_id AND guardian_member.active
    JOIN siyue.family_memberships child_member ON child_member.family_id = r.family_id
      AND child_member.subject_id = r.child_subject_id AND child_member.active
  WHERE r.guardian_subject_id = $1 AND r.active
  ORDER BY r.created_at, r.family_id, r.child_subject_id`;

/**
 * Read-only impact inventory of one already-authenticated subject. The caller supplies only the
 * current access bearer: `verifyForMutation` locks and rechecks the session and subject in the same
 * transaction as the inventory read. Revocation or a credential change cannot land between a
 * successful verification and the returned dependency list.
 *
 * The returned document is assembled from the database and parsed through the strict schema above, so
 * a field that is not part of the confirmation contract cannot reach a caller. Nothing is written by
 * this path, and no deletion decision is taken or implied.
 */
export function createAccountDeletionImpactService(pool: Pool, sessions: SessionService,
  clock: () => Date = () => new Date()) {
  async function inspectLocked(client: PoolClient, subjectId: string, now: Date): Promise<AccountDeletionImpact> {
    const families = (await client.query<FamilyRow>(visibleFamilies, [subjectId])).rows;
    const guardianships = (await client.query<GuardianshipRow>(visibleGuardianships,
      [subjectId, now])).rows;
    const mappedGuardianships = guardianships.map(row => ({
      familyId: row.family_id, childSubjectId: row.child_subject_id,
      soleGuardian: row.other_guardian_count === 0, otherGuardianCount: row.other_guardian_count,
      activeChildDeviceCount: row.active_child_device_count,
    }));
    return accountDeletionImpactSchema.parse({
      subjectId,
      families: families.map(row => ({
        familyId: row.family_id, role: row.role,
        soleActiveOwner: row.role === 'owner' && row.active_owner_count === 1,
        otherActiveAdultCount: row.other_active_adult_count,
        otherActiveChildCount: row.other_active_child_count,
      })),
      guardianships: mappedGuardianships,
      activeChildDeviceCount: mappedGuardianships.reduce((total, entry) => total + entry.activeChildDeviceCount, 0),
    });
  }
  return {
    /** Internal caller must already hold the subject row lock and have verified an adult session. */
    inspectLocked,
    async inspect(accessToken: string): Promise<AccountDeletionImpact> {
      return transaction(pool, async client => {
        const session = await sessions.verifyForMutation(client, accessToken);
        if (session.subjectKind !== 'adult') throw new AuthError('AUTH_ADULT_REQUIRED', 403);
        return inspectLocked(client, session.subjectId, clock());
      });
    },
  };
}
export type AccountDeletionImpactService = ReturnType<typeof createAccountDeletionImpactService>;
