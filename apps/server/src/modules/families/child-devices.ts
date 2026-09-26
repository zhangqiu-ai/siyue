import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { childDeviceListResponseSchema, childDeviceSummarySchema, type ChildDeviceSummary } from '@siyue/contracts';
import { transaction } from '../../adapters/postgres/database.js';
import { AuthError, type SessionService } from '../auth/sessions.js';

interface GrantRow {
  id: string; child_subject_id: string; installation_id: string; platform: string;
  device_label: string | null; version: number; expires_at: Date; revoked_at: Date | null;
}
const idSchema = z.uuid();
const versionSchema = z.number().int().positive();
const day = 86_400_000;
const toSummary = (row: GrantRow, now: Date): ChildDeviceSummary => childDeviceSummarySchema.parse({
  grantId: row.id, childSubjectId: row.child_subject_id, installationId: row.installation_id,
  platform: row.platform, deviceLabel: row.device_label,
  status: row.revoked_at ? 'revoked' : +row.expires_at <= +now ? 'expired' : 'active',
  version: row.version, expiresAt: row.expires_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null,
});

/** Explicit guardianship is separate from the family's owner/admin/member role. */
const guardianScope = `SELECT r.family_id FROM siyue.guardian_relationships r
  JOIN siyue.consent_records c ON c.id=r.consent_record_id AND c.actor_subject_id=r.guardian_subject_id
    AND c.subject_id=r.child_subject_id AND c.purpose='child-guardianship'
  JOIN siyue.families f ON f.id=r.family_id
  JOIN siyue.subjects child ON child.id=r.child_subject_id
  JOIN siyue.family_memberships guardian_member ON guardian_member.family_id=r.family_id AND guardian_member.subject_id=r.guardian_subject_id
  JOIN siyue.family_memberships child_member ON child_member.family_id=r.family_id AND child_member.subject_id=r.child_subject_id
  WHERE r.child_subject_id=$1 AND r.guardian_subject_id=$2 AND r.active AND c.withdrawn_at IS NULL
    AND f.status='active' AND child.kind='child' AND child.status='active' AND guardian_member.active AND child_member.active`;

export function createChildDeviceService(pool: Pool, sessions: SessionService, clock: () => Date = () => new Date()) {
  async function authorizedFamilies(client: PoolClient, childId: string, guardianId: string): Promise<string[]> {
    return (await client.query<{family_id:string}>(guardianScope, [childId, guardianId])).rows.map(row => row.family_id);
  }
  return {
    /** A guardian sees only grants for a child in a family where their own current relationship applies. */
    async list(accessToken: string, childId: string) {
      if (!idSchema.safeParse(childId).success) throw new AuthError('CHILD_DEVICE_INVALID_REQUEST', 400);
      const session = await sessions.verify(accessToken);
      if (session.subjectKind !== 'adult') throw new AuthError('CHILD_DEVICE_GUARDIAN_REQUIRED', 403);
      return transaction(pool, async client => {
        const families = await authorizedFamilies(client, childId, session.subjectId);
        if (families.length === 0) throw new AuthError('CHILD_NOT_FOUND', 404);
        const rows = (await client.query<GrantRow>(`SELECT g.id,g.child_subject_id,g.installation_id,g.platform,g.device_label,g.version,g.expires_at,g.revoked_at
          FROM siyue.device_grants g WHERE g.child_subject_id=$1 AND g.family_id=ANY($2::uuid[])
          ORDER BY g.created_at DESC,g.id DESC`, [childId, families])).rows;
        return childDeviceListResponseSchema.parse({items: rows.map(row => toSummary(row, clock()))});
      });
    },
    /** Revocation and child session invalidation commit together; the next verify/refresh also reads the grant. */
    async revoke(accessToken: string, childId: string, grantId: string, expectedVersion: number): Promise<ChildDeviceSummary> {
      if (!idSchema.safeParse(childId).success || !idSchema.safeParse(grantId).success ||
          !versionSchema.safeParse(expectedVersion).success) throw new AuthError('CHILD_DEVICE_INVALID_REQUEST', 400);
      return transaction(pool, async client => {
        const session = await sessions.verifyForMutation(client, accessToken);
        if (session.subjectKind !== 'adult') throw new AuthError('CHILD_DEVICE_GUARDIAN_REQUIRED', 403);
        const families = await authorizedFamilies(client, childId, session.subjectId);
        if (families.length === 0) throw new AuthError('CHILD_NOT_FOUND', 404);
        const grant = (await client.query<GrantRow>(`SELECT g.id,g.child_subject_id,g.installation_id,g.platform,g.device_label,g.version,g.expires_at,g.revoked_at
          FROM siyue.device_grants g WHERE g.id=$1 AND g.child_subject_id=$2 AND g.family_id=ANY($3::uuid[]) FOR UPDATE`,
        [grantId, childId, families])).rows[0];
        if (!grant) throw new AuthError('CHILD_DEVICE_NOT_FOUND', 404);
        if (grant.revoked_at) return toSummary(grant, clock());
        if (grant.version !== expectedVersion) throw new AuthError('CHILD_DEVICE_STALE_VERSION', 409);
        const now = clock();
        const changed = (await client.query<GrantRow>(`UPDATE siyue.device_grants SET revoked_at=GREATEST($2,created_at),version=version+1 WHERE id=$1
          RETURNING id,child_subject_id,installation_id,platform,device_label,version,expires_at,revoked_at`, [grantId, now])).rows[0];
        if (!changed) throw new Error('child_device_revoke_missing');
        await client.query("UPDATE siyue.auth_sessions SET revoked_at=COALESCE(revoked_at,$2),revoke_reason=COALESCE(revoke_reason,'guardian_revoked') WHERE device_grant_id=$1", [grantId, now]);
        await client.query(`UPDATE siyue.refresh_tokens SET revoked_at=COALESCE(revoked_at,$2),retry_ciphertext=NULL,retry_expires_at=NULL
          WHERE session_id IN (SELECT id FROM siyue.auth_sessions WHERE device_grant_id=$1)`, [grantId, now]);
        await client.query(`INSERT INTO siyue.security_events(id,event_type,subject_id,session_id,request_id,outcome,redacted_metadata,occurred_at,expires_at)
          VALUES($1,'child.device.revoke',$2,$3,$4,'success',jsonb_build_object('grantId',$5::uuid),$6,$7)`,
        [randomUUID(), session.subjectId, session.sessionId, `child-device-revoke:${grantId}`, grantId, now, new Date(+now + 30 * day)]);
        return toSummary(changed, now);
      });
    },
  };
}
export type ChildDeviceService = ReturnType<typeof createChildDeviceService>;
