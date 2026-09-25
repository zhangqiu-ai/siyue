import { createHmac, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { childCreateRequestSchema, childSummarySchema, type ChildSummary } from '@siyue/contracts';
import { evaluateFamilyPolicy, type FamilyPolicyDenial } from '@siyue/domain';
import { transaction } from '../../adapters/postgres/database.js';
import { AuthError, type SessionService } from '../auth/sessions.js';
import { createFamilyRepository } from './repository.js';

const day = 86_400_000;

/** Fixed server purpose of a guardian consent record. Never supplied by the client. */
export const guardianshipConsentPurpose = 'child-guardianship';
/**
 * A created child subject is durable state, so its request key stays replayable far longer than a
 * one-time token: a client that lost the response can still recover the same summary. The window is
 * still bounded, so the idempotency table does not grow without limit.
 */
export const guardianshipKeyRetentionMs = 90 * day;
/** Audit rows are short-lived operational evidence, matching the session and reauth retention. */
const auditRetentionMs = 30 * day;

/** The shared create contract plus the family the path already carries; no role, kind or snapshot. */
const createRequestSchema = childCreateRequestSchema.extend({ familyId: z.uuid() }).strict();
const requestKeySchema = z.uuid();
const familyIdSchema = z.uuid();

export interface GuardianshipCreateInput {
  familyId: string;
  displayName: string;
  consentPolicyVersion: string;
  consentConfirmed: true;
  expectedMembershipVersion: number;
  expectedFamilyVersion: number;
}

interface FamilyRow { id: string; status: string; version: number; owner_subject_id: string; }
interface MembershipRow { family_id: string; subject_id: string; role: string; active: boolean; version: number; }
/** Only the created resource id is read back on replay; the response itself is re-derived. */
interface IdempotencyRow { resource_id: string | null; }
interface SummaryRow {
  child_subject_id: string; family_id: string; guardian_subject_id: string;
  relationship_version: number; family_version: number; display_name: string;
}

/** Refusals are values inside the transaction, so state a refusal must commit survives the rollback. */
type Outcome<T> = { ok: true; value: T } | { ok: false; code: string; status: number };
const pass = <T>(value: T): Outcome<T> => ({ ok: true, value });
const refuse = (code: string, status: number): Outcome<never> => ({ ok: false, code, status });

/**
 * A relationship exists for its guardian only while the relationship, the consent behind it, the
 * child's own membership and subject, the guardian's own membership and subject and the family are all
 * still live. One revoked, withdrawn or deactivated part hides the whole relationship, so no read path
 * can resurrect it and a family role alone never contributes one.
 */
const visibleRelationship = `SELECT r.family_id, r.guardian_subject_id, r.child_subject_id,
    r.version AS relationship_version, f.version AS family_version, p.display_name
  FROM siyue.guardian_relationships r
    JOIN siyue.families f ON f.id = r.family_id
    JOIN siyue.subjects p ON p.id = r.child_subject_id
    JOIN siyue.subjects g ON g.id = r.guardian_subject_id
    JOIN siyue.family_memberships m ON m.family_id = r.family_id AND m.subject_id = r.child_subject_id
    JOIN siyue.family_memberships gm ON gm.family_id = r.family_id AND gm.subject_id = r.guardian_subject_id
    JOIN siyue.consent_records c ON c.id = r.consent_record_id AND c.actor_subject_id = r.guardian_subject_id
      AND c.subject_id = r.child_subject_id AND c.purpose = 'child-guardianship'
  WHERE r.active AND f.status = 'active' AND m.active AND gm.active AND p.kind = 'child' AND p.status = 'active'
    AND g.kind = 'adult' AND g.status = 'active' AND c.withdrawn_at IS NULL`;
const toSummary = (row: SummaryRow): ChildSummary => childSummarySchema.parse({
  childSubjectId: row.child_subject_id, familyId: row.family_id, guardianSubjectId: row.guardian_subject_id,
  relationshipVersion: row.relationship_version, familyVersion: row.family_version, displayName: row.display_name,
});

/**
 * Guardianship service (SA-08 9.3; design 8.2B consent_records/guardian_relationships and API table
 * 16.4 POST /families/{id}/children). It creates one supervised child subject for an adult who is
 * currently a family owner/admin, records that adult's explicit consent, links the two with an active
 * guardian relationship and bumps the family version, all in one transaction.
 *
 * The client never supplies an identity: no role, subject kind, snapshot, stored version or consent
 * record comes from the request. The caller states the membership and family versions it last read and
 * the server compares them with the locked rows plus a snapshot assembled from trusted database state
 * that the existing domain policy decides. Roles come from the stored membership only, so an
 * owner/admin role never grants guardianship by itself and a child session can never create one.
 */
export function createGuardianshipService(pool: Pool, sessions: SessionService, pepper: Buffer,
  clock: () => Date = () => new Date()) {
  if (pepper.length !== 32) throw new Error('invalid_pepper');
  const families = createFamilyRepository(pool);
  /** Domain-separated keyed digests. Raw request keys never reach a column, a log or an audit row. */
  const mac = (label: string, ...parts: unknown[]) =>
    createHmac('sha256', pepper).update(JSON.stringify([label, ...parts])).digest('hex');
  const createScope = (familyId: string) => `family-children:${familyId}`;
  /** Single account-wide advisory namespace for one (scope, key): identical retries serialize here. */
  async function lock(client: PoolClient, scope: string, keyHash: string) {
    const derived = mac('advisory-lock', scope, keyHash);
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)',
      [BigInt.asIntN(64, BigInt(`0x${derived.slice(0, 16)}`)).toString()]);
  }
  /** Minimal audit trail: who acted, from which session, about which child. Never a secret. */
  async function audit(client: PoolClient, event: string, subjectId: string, sessionId: string, requestId: string,
    now: Date, metadata: { familyId: string; childSubjectId: string }) {
    await client.query(`INSERT INTO siyue.security_events(id,event_type,subject_id,session_id,request_id,outcome,redacted_metadata,occurred_at,expires_at)
      VALUES($1,$2,$3,$4,$5,'success',jsonb_build_object('familyId',$6::uuid,'childSubjectId',$7::uuid),$8,$9)`,
    [randomUUID(), event, subjectId, sessionId, requestId, metadata.familyId, metadata.childSubjectId, now,
      new Date(+now + auditRetentionMs)]);
  }
  /**
   * Idempotency decision for one request key. An expired record is dropped first, so a key becomes
   * usable again only after its own window closed; a different payload under the same key is a
   * conflict and never reaches the work function.
   */
  async function claim(client: PoolClient, scope: string, keyHash: string, requestMac: string, now: Date) {
    await client.query('DELETE FROM siyue.idempotency_records WHERE scope=$1 AND key_hash=$2 AND expires_at<=$3',
      [scope, keyHash, now]);
    const row = (await client.query<{ request_mac: string } & IdempotencyRow>(
      'SELECT request_mac,resource_id FROM siyue.idempotency_records WHERE scope=$1 AND key_hash=$2',
      [scope, keyHash])).rows[0];
    if (!row) return { kind: 'fresh' as const, row: undefined };
    if (row.request_mac !== requestMac) return { kind: 'conflict' as const, row };
    return { kind: 'replay' as const, row };
  }
  async function lockFamily(client: PoolClient, familyId: string) {
    return (await client.query<FamilyRow>(
      'SELECT id,status,version,owner_subject_id FROM siyue.families WHERE id=$1 FOR UPDATE', [familyId])).rows[0];
  }
  async function lockMembership(client: PoolClient, familyId: string, subjectId: string) {
    return (await client.query<MembershipRow>(
      'SELECT family_id,subject_id,role,active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2 FOR UPDATE',
      [familyId, subjectId])).rows[0];
  }
  async function readSummary(client: PoolClient, familyId: string, guardianSubjectId: string, childSubjectId: string) {
    const row = (await client.query<SummaryRow>(
      `${visibleRelationship} AND r.family_id=$1 AND r.guardian_subject_id=$2 AND r.child_subject_id=$3`,
      [familyId, guardianSubjectId, childSubjectId])).rows[0];
    return row ? toSummary(row) : null;
  }
  /** Family-management denials become stable public codes; a refusal discloses no resource state. */
  function refusalFor(reason: FamilyPolicyDenial) {
    switch (reason) {
      case 'inactive_family': return new AuthError('FAMILY_CHILD_FAMILY_INACTIVE', 409);
      case 'stale_authorization': return new AuthError('FAMILY_STALE_AUTHORIZATION', 409);
      case 'child_management': return new AuthError('FAMILY_ADULT_REQUIRED', 403);
      // A non-member and an unknown family must stay indistinguishable to the caller.
      case 'not_member': case 'scope_mismatch': return new AuthError('FAMILY_NOT_FOUND', 404);
      default: return new AuthError('FAMILY_CHILD_FORBIDDEN', 403);
    }
  }
  async function run<T>(work: (client: PoolClient) => Promise<Outcome<T>>): Promise<T> {
    const outcome = await transaction(pool, work);
    if (!outcome.ok) throw new AuthError(outcome.code, outcome.status);
    return outcome.value;
  }
  /**
   * Replay of a create key re-derives the summary from the live relationship instead of replaying a
   * stored copy, so a relationship that was revoked, whose consent was withdrawn or whose child was
   * removed from the family refuses here and is never restored by the original key.
   */
  async function replay(client: PoolClient, record: IdempotencyRow | undefined, familyId: string,
    guardianSubjectId: string): Promise<Outcome<ChildSummary>> {
    if (!record?.resource_id) return refuse('FAMILY_CHILD_RECOVERY_EXPIRED', 409);
    const created = await readSummary(client, familyId, guardianSubjectId, record.resource_id);
    return created ? pass(created) : refuse('FAMILY_CHILD_RELATIONSHIP_INACTIVE', 409);
  }

  return {
    /**
     * POST /v1/families/{id}/children behind a verified adult session: one explicit guardian consent
     * plus one supervised child subject, membership and relationship in a single transaction. The
     * caller must still hold the owner/admin membership and family versions it read; anything stale,
     * revoked or unreachable is refused before a row is written. The same request key returns the same
     * summary while the key is retained and the relationship is still live, and a different payload
     * under the same key is a conflict.
     */
    async create(accessToken: string, input: GuardianshipCreateInput, requestKey: string): Promise<ChildSummary> {
      const parsed = createRequestSchema.safeParse(input);
      if (!parsed.success || !requestKeySchema.safeParse(requestKey).success) throw new AuthError('FAMILY_INVALID_REQUEST', 400);
      const data = parsed.data;
      // The durable consent row stores the policy version under the migration's ^[a-z0-9._-]{1,40}$
      // constraint, so a version that could not be recorded is refused here instead of failing at commit.
      if (!/^[a-z0-9._-]{1,40}$/.test(data.consentPolicyVersion)) throw new AuthError('FAMILY_INVALID_REQUEST', 400);
      return run(async client => {
        const session = await sessions.verifyForMutation(client, accessToken);
        if (session.subjectKind !== 'adult') throw new AuthError('FAMILY_ADULT_REQUIRED', 403);
        // The key belongs to one guardian and one family, so another guardian may reuse the same value.
        const scope = createScope(data.familyId);
        const keyHash = mac('child-create-key', session.subjectId, data.familyId, requestKey);
        const requestMac = mac('child-create-request', session.subjectId, data.familyId, data.displayName,
          data.consentPolicyVersion, data.expectedMembershipVersion, data.expectedFamilyVersion);
        await lock(client, scope, keyHash);
        const now = clock();
        const claimed = await claim(client, scope, keyHash, requestMac, now);
        if (claimed.kind === 'conflict') return refuse('FAMILY_CHILD_CONFLICT', 409);
        // Order: subject/session (verifyForMutation) -> family -> membership -> the new child rows.
        const family = await lockFamily(client, data.familyId);
        if (!family) throw new AuthError('FAMILY_NOT_FOUND', 404);
        const membership = await lockMembership(client, data.familyId, session.subjectId);
        if (!membership || !membership.active) throw new AuthError('FAMILY_NOT_FOUND', 404);
        const snapshot = await families.snapshot(client, session.subjectId, data.familyId);
        if (!snapshot) throw new AuthError('FAMILY_NOT_FOUND', 404);
        // Child creation is family management. The existing decision is reused instead of a new policy
        // action being invented: it gates owner/admin from trusted roles and denies child sessions.
        const decision = evaluateFamilyPolicy(snapshot, { kind: 'family', familyId: data.familyId, action: 'invite',
          expectedMembershipVersion: data.expectedMembershipVersion });
        if (!decision.allowed) throw refusalFor(decision.reason);
        // Everything above is the guardian's current authority, so a demoted, removed, blocked or
        // withdrawn guardian cannot recover the child with the original key either.
        if (claimed.kind === 'replay') return await replay(client, claimed.row, data.familyId, session.subjectId);
        // Only a fresh request is bound to the family version it read; the write itself advances it.
        if (family.version !== data.expectedFamilyVersion) throw new AuthError('FAMILY_STALE_AUTHORIZATION', 409);
        const childSubjectId = randomUUID(), consentRecordId = randomUUID();
        await client.query("INSERT INTO siyue.subjects(id,kind,status,display_name) VALUES($1,'child','active',$2)",
          [childSubjectId, data.displayName]);
        await client.query(`INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version,recorded_at)
          VALUES($1,$2,$3,$4,$5,$6)`,
        [consentRecordId, session.subjectId, childSubjectId, guardianshipConsentPurpose, data.consentPolicyVersion, now]);
        await client.query(`INSERT INTO siyue.family_memberships(family_id,subject_id,role,active,version)
          VALUES($1,$2,'member',true,1)`, [data.familyId, childSubjectId]);
        await client.query(`INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,active,version,consent_record_id,created_at)
          VALUES($1,$2,$3,true,1,$4,$5)`, [data.familyId, session.subjectId, childSubjectId, consentRecordId, now]);
        // The family version is bumped in the same transaction, so a reader that saw version N knows a
        // child was added by the time it sees N+1.
        const bumped = await client.query('UPDATE siyue.families SET version=version+1 WHERE id=$1 AND version=$2',
          [data.familyId, family.version]);
        if (bumped.rowCount !== 1) throw new AuthError('FAMILY_STALE_AUTHORIZATION', 409);
        // The record points at the child subject; nothing else about the response is copied into storage.
        await client.query(`INSERT INTO siyue.idempotency_records(scope,key_hash,request_mac,subject_id,resource_id,status,expires_at)
          VALUES($1,$2,$3,$4,$5,'complete',$6)`,
        [scope, keyHash, requestMac, session.subjectId, childSubjectId, new Date(+now + guardianshipKeyRetentionMs)]);
        await audit(client, 'family.child.create', session.subjectId, session.sessionId,
          `child-create:${keyHash}`, now, { familyId: data.familyId, childSubjectId });
        const created = await readSummary(client, data.familyId, session.subjectId, childSubjectId);
        if (!created) throw new AuthError('FAMILY_CHILD_CREATE_CONFLICT', 409);
        return pass(created);
      });
    },

    /**
     * GET /v1/families/{id}/children behind a verified adult session: the caller's own live guardian
     * relationships in one family, as minimal child views. The read is driven from the stored
     * guardianships only, never from the caller's role, so an owner or admin reads no other adult's
     * child and an adult who guards nobody in the family receives an empty list. The caller must first
     * see the family at all, so an unknown, foreign or dissolved family stays a 404 instead of becoming
     * an empty list, and no row is written by this path.
     */
    async list(accessToken: string, familyId: string): Promise<ChildSummary[]> {
      if (!familyIdSchema.safeParse(familyId).success) throw new AuthError('FAMILY_INVALID_REQUEST', 400);
      const session = await sessions.verify(accessToken);
      if (session.subjectKind !== 'adult') throw new AuthError('FAMILY_ADULT_REQUIRED', 403);
      return transaction(pool, async client => {
        // The same reachability rule the family read uses: an inactive subject, an inactive membership
        // and a missing family are indistinguishable, and a dissolved family is not readable either.
        const snapshot = await families.snapshot(client, session.subjectId, familyId);
        if (!snapshot?.family?.active) throw new AuthError('FAMILY_NOT_FOUND', 404);
        const rows = (await client.query<SummaryRow>(
          `${visibleRelationship} AND r.family_id=$1 AND r.guardian_subject_id=$2 ORDER BY r.created_at, r.child_subject_id`,
          [familyId, session.subjectId])).rows;
        return rows.map(toSummary);
      });
    },

    /**
     * Periodic maintenance, safe on several instances: drops this module's expired create keys so the
     * retention window above really ends a row's life instead of leaving it behind forever. Only the
     * `family-children:` scope is touched, so the invitation, pairing, email and password idempotency
     * scopes keep their own retention and no other business is swept by this cleanup.
     */
    async cleanupExpired(): Promise<void> {
      await transaction(pool, async client => {
        await client.query("DELETE FROM siyue.idempotency_records WHERE expires_at<=$1 AND scope LIKE 'family-children:%'", [clock()]);
      });
    },
  };
}
export type GuardianshipService = ReturnType<typeof createGuardianshipService>;
