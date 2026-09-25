import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { familyPolicySnapshotSchema, familySummarySchema, type FamilyPolicySnapshot, type FamilySummary } from '@siyue/contracts';
import { transaction } from '../../adapters/postgres/database.js';

export type { FamilySummary } from '@siyue/contracts';

/** Non-public diagnostics. An unknown family and a foreign family stay indistinguishable to callers. */
export type FamilyRepositoryFailure = 'FAMILY_INVALID_REQUEST' | 'FAMILY_SUBJECT_NOT_ELIGIBLE' | 'FAMILY_CREATE_CONFLICT';

export class FamilyRepositoryError extends Error {
  constructor(readonly code: FamilyRepositoryFailure) { super(code); }
}

interface SummaryRow {
  family_id: string; owner_subject_id: string; role: string;
  membership_version: number; family_version: number;
}
interface SnapshotRow {
  subject_id: string; kind: string; role: string; active: boolean; version: number; family_status: string;
}
interface SubjectRow { kind: string; status: string; }

// A family exists for a requester only while the family is active, their own membership is active and
// their subject is active. A blocked subject therefore reads nothing even with a stale membership.
const visibleFamily = `SELECT f.id AS family_id, f.owner_subject_id, f.version AS family_version, m.role, m.version AS membership_version
  FROM siyue.family_memberships m JOIN siyue.families f ON f.id = m.family_id
    JOIN siyue.subjects p ON p.id = m.subject_id
  WHERE m.active AND f.status = 'active' AND p.status = 'active'`;
const toSummary = (row: SummaryRow): FamilySummary => familySummarySchema.parse({
  familyId: row.family_id, ownerSubjectId: row.owner_subject_id, role: row.role,
  membershipVersion: row.membership_version, familyVersion: row.family_version,
});
const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === '23505';
/** Ids are uuids in every contract; a malformed id is refused before it can reach a typed column. */
const uuid = z.uuid();
function requireId(value: unknown): string {
  if (typeof value !== 'string' || !uuid.safeParse(value).success) throw new FamilyRepositoryError('FAMILY_INVALID_REQUEST');
  return value;
}
/** The idempotency key is a caller-computed sha256 hex digest, matching refresh/reauth secret hashes. */
function requireKeyHash(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new FamilyRepositoryError('FAMILY_INVALID_REQUEST');
  return value;
}

/**
 * Trusted family repository over the shared application pool.
 *
 * `create` and `snapshot` run inside a caller-owned transaction, because the caller owns the verified
 * session, the subject lock and the atomic write. `list`/`get` are read-only and open their own
 * read transaction. Every returned value is read back from the database: no method accepts a role,
 * a version or a snapshot from the client, and no method mutates a membership or a family version.
 */
export function createFamilyRepository(pool: Pool) {
  async function readSummary(client: PoolClient, subjectId: string, familyId: string): Promise<FamilySummary | null> {
    const result = await client.query<SummaryRow>(`${visibleFamily} AND m.subject_id = $1 AND f.id = $2`, [subjectId, familyId]);
    const row = result.rows[0];
    return row ? toSummary(row) : null;
  }
  return {
    /**
     * Create the owner family of one already-verified session. The caller verified the session and
     * locked the subject; the repository re-locks it, so concurrent creates for one subject serialize
     * here instead of relying on that caller. The idempotency key is checked after the lock is held,
     * which makes the replay read authoritative. Nothing is committed by this method.
     */
    async create(client: PoolClient, ownerSubjectId: string, keyHash: string): Promise<FamilySummary> {
      const owner = requireId(ownerSubjectId);
      const key = requireKeyHash(keyHash);
      const subject = (await client.query<SubjectRow>('SELECT kind, status FROM siyue.subjects WHERE id = $1 FOR UPDATE', [owner])).rows[0];
      // Independently of the caller: only an active adult subject may own a family.
      if (!subject || subject.status !== 'active' || subject.kind !== 'adult') throw new FamilyRepositoryError('FAMILY_SUBJECT_NOT_ELIGIBLE');
      const recorded = (await client.query<{ family_id: string }>('SELECT family_id FROM siyue.family_create_requests WHERE subject_id = $1 AND key_hash = $2', [owner, key])).rows[0];
      if (recorded) {
        // Replay of the same key. A family that was dissolved or removed in the meantime is reported
        // as a conflict instead of being resurrected or silently recreated under the same key.
        const existing = await readSummary(client, owner, recorded.family_id);
        if (!existing) throw new FamilyRepositoryError('FAMILY_CREATE_CONFLICT');
        return existing;
      }
      const familyId = randomUUID();
      try {
        await client.query("INSERT INTO siyue.families(id, status, owner_subject_id, version) VALUES($1, 'active', $2, 1)", [familyId, owner]);
        await client.query("INSERT INTO siyue.family_memberships(family_id, subject_id, role, active, version) VALUES($1, $2, 'owner', true, 1)", [familyId, owner]);
        await client.query('INSERT INTO siyue.family_create_requests(subject_id, key_hash, family_id) VALUES($1, $2, $3)', [owner, key, familyId]);
      } catch (error) {
        // The only reachable unique key here is the idempotency record: a concurrent create with the
        // same subject and key won, and the caller's retry replays that key.
        if (isUniqueViolation(error)) throw new FamilyRepositoryError('FAMILY_CREATE_CONFLICT');
        throw error;
      }
      const created = await readSummary(client, owner, familyId);
      if (!created) throw new FamilyRepositoryError('FAMILY_CREATE_CONFLICT');
      return created;
    },
    /** Active families of a subject where their own membership is active. Order is stable for clients. */
    async list(subjectId: string): Promise<FamilySummary[]> {
      const subject = requireId(subjectId);
      return transaction(pool, async client => {
        const result = await client.query<SummaryRow>(`${visibleFamily} AND m.subject_id = $1 ORDER BY f.created_at, f.id`, [subject]);
        return result.rows.map(toSummary);
      });
    },
    /** One visible family, or null. A foreign or unknown id is never distinguished from a missing one. */
    async get(subjectId: string, familyId: string): Promise<FamilySummary | null> {
      const subject = requireId(subjectId), family = requireId(familyId);
      return transaction(pool, client => readSummary(client, subject, family));
    },
    /**
     * Assemble the existing family policy contract from trusted database state only, for the caller's
     * own `evaluateFamilyPolicy` decision inside the same transaction. Record and grants stay empty in
     * this slice, so shared-record decisions deny until the sharing tables exist. Returns null when the
     * subject is inactive, is not an active member, or the family does not exist; a dissolved family
     * that the subject still belongs to returns the real `family.active` value instead of a fake one.
     */
    async snapshot(client: PoolClient, subjectId: string, familyId: string): Promise<FamilyPolicySnapshot | null> {
      const subject = requireId(subjectId), family = requireId(familyId);
      const subjectRow = (await client.query<SubjectRow>("SELECT kind, status FROM siyue.subjects WHERE id = $1 AND status = 'active'", [subject])).rows[0];
      if (!subjectRow) return null;
      const rows = (await client.query<SnapshotRow>(`SELECT m.subject_id, p.kind, m.role, m.active, m.version, f.status AS family_status
        FROM siyue.families f JOIN siyue.family_memberships m ON m.family_id = f.id JOIN siyue.subjects p ON p.id = m.subject_id
        WHERE f.id = $1 ORDER BY m.subject_id`, [family])).rows;
      const own = rows.find(row => row.subject_id === subject);
      if (!own || !own.active) return null;
      return familyPolicySnapshotSchema.parse({
        subject: { id: subject, kind: subjectRow.kind },
        family: { id: family, active: own.family_status === 'active' },
        record: null,
        memberships: rows.map(row => ({
          familyId: family, subjectId: row.subject_id, subjectKind: row.kind, role: row.role, active: row.active, version: row.version,
        })),
        grants: [],
      });
    },
  };
}
export type FamilyRepository = ReturnType<typeof createFamilyRepository>;
