import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { familyManagementAcceptanceRequestSchema, frozenFamilyReviewAcceptanceReceiptSchema,
  frozenFamilyReviewScopeSchema, type FrozenFamilyReviewAcceptanceReceipt,
  type FrozenFamilyReviewScope } from '@siyue/contracts';
import { transaction } from '../../adapters/postgres/database.js';
import { AuthError, type SessionService } from './sessions.js';

/**
 * Closing a frozen family review (design 13.2 and the 2026-09-24 confirmed rules).
 *
 * A sole manager's accepted account deletion freezes a family that still has other members, because the
 * deletion may neither assign nor remove the members' shared work. The frozen family is then owed an
 * internal review, and only that review makes it active again. Two records carry the review:
 *
 *   * a recipient's own post-freeze acceptance (`family_review_acceptances`), recorded from the
 *     recipient's verified adult session by `createFrozenFamilyReviewService`. The live management
 *     acceptance cannot be used here: its scope reader requires an active family, and a frozen family is
 *     exactly the case where the recipient must accept the frozen family and the guardianship that comes
 *     with taking it over. The acceptance is current for the same 24-hour validity window the live
 *     management acceptance uses and for nothing longer; recording one never restores anything by itself.
 *   * the operator's closure (`family_review_resolutions`), written by `resolveFrozenFamilyReview` in the
 *     same transaction that consumes the acceptance, hands the family to the recipient and marks the
 *     pending review resolved.
 *
 * The operator entry point is `frozen-family-review-cli.ts`. There is no HTTP route, and no request field
 * names an operator: `verifyFrozenFamilyReviewOperator` reads `session_user`, `current_database()` and the
 * database's own environment marker from the connection, and `resolveFrozenFamilyReview` re-reads
 * `session_user` to refuse a caller that names a role the connection is not. That is a binding of the
 * designated operations identity to a database login role -- with an environment allowlist instead of a
 * claim in a payload -- and it is deliberately not described as human authentication: what an operator
 * may do still comes from that role's own database privileges.
 *
 * That role is provisioned least-privilege by the deployment, so this module asks for no write it does
 * not use: SELECT where it reads, INSERT only where it creates a row, UPDATE only on the tables whose
 * rows it writes or locks, and no DELETE and no TRUNCATE. PostgreSQL requires UPDATE privilege on a
 * table to take any row lock, so the subject rows this closure locks need a column-scoped UPDATE -- the
 * closure itself never writes a subject -- while the deletion job is only read, never locked, and
 * therefore never needs write privilege: deletion progress cannot be forged from the review path.
 *
 * A closure never restores an old child authorization and never reassigns shared work. It withdraws the
 * deleting adult's own guardianship declarations in that family (leaving them readable as withdrawn),
 * records a new consent for the recipient instead of reviving the old one, keeps every revoked device
 * grant, ended room, closed invitation and released seat revoked, and touches no row belonging to another
 * member. What happens to the deleting adult's own history afterwards stays with the cleanup path; this
 * module only makes the family review no longer pending.
 */

const uuid = z.uuid();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const versionSchema = z.number().int().positive();
const environmentSchema = z.enum(['development', 'test', 'staging', 'production']);
/** A PostgreSQL login role name. The database accepts lower-case, underscore-separated identifiers. */
const operatorRoleSchema = z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/);
/** The API's own runtime identity. A review closure must never run as the role the request path uses. */
export const runtimeRole = 'siyue_app';

/** What the operator manually checked about the frozen family's shared work, as a bounded result code. */
export const sharedWorkResultSchema = z.enum(['no_shared_work', 'separated', 'retained_for_review']);
export type FrozenFamilySharedWorkResult = z.infer<typeof sharedWorkResultSchema>;

/**
 * The shared-work results that may close a review. `retained_for_review` records that the operator found
 * shared work which still has to be kept and checked, so it is a refusal rather than a closure: the
 * family stays frozen and nothing is written until a later review records a result that closes it.
 */
export const closingSharedWorkResultSchema = z.enum(['no_shared_work', 'separated']);
export type FrozenFamilyClosingSharedWorkResult = z.infer<typeof closingSharedWorkResultSchema>;
export const isClosingSharedWorkResult = (value: string): value is FrozenFamilyClosingSharedWorkResult =>
  closingSharedWorkResultSchema.safeParse(value).success;

/** A bounded operations reference (a case or ticket id), never a description of a member. */
const reasonSchema = z.string().min(1).max(120).refine(value => value.trim() === value &&
  !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value));

/**
 * The recipient's own declaration over the frozen family, re-exported from the shared contract so the
 * service and the HTTP layer cannot drift apart on what a caller may send: the shared schema is strict,
 * the two duty fields are required true literals, and neither the recipient, the deleting adult, a child
 * nor a role can be asserted by the request.
 */
export const frozenFamilyReviewAcceptanceRequestSchema = familyManagementAcceptanceRequestSchema;

/**
 * The scope a recipient is shown and accepts, re-exported from the same contract. It carries a digest and a
 * count instead of child identities, so a preview can be displayed, logged or audited without exposing a
 * child, and it is the shape the response is validated against on both sides.
 */
export { frozenFamilyReviewScopeSchema };
export type { FrozenFamilyReviewScope };

/**
 * How long a recorded acceptance stays a current declaration. It is the same 24-hour validity window the
 * live family management acceptance applies (family-management-acceptance.ts): a period for which a consent
 * that was given is still current, not a retention period for the record. The table carries no expiry
 * column, so the window is computed from `accepted_at` -- an old record keeps its history and stops
 * counting as current, and the recipient accepts the frozen scope again instead of the previous
 * declaration being reused or quietly widened.
 */
export const frozenFamilyReviewAcceptanceLifetimeMs = 24 * 60 * 60 * 1000;
/** True while an acceptance recorded at `acceptedAt` may still close a review at `now`. */
const isCurrentAcceptance = (acceptedAt: Date, now: Date): boolean =>
  +acceptedAt + frozenFamilyReviewAcceptanceLifetimeMs > +now;

/**
 * The receipt of one recorded acceptance, re-exported from the shared contract. Its validity is the window
 * above, counted from `acceptedAt`; everything in it is server-derived.
 */
export { frozenFamilyReviewAcceptanceReceiptSchema };
export type { FrozenFamilyReviewAcceptanceReceipt };

export interface ResolveFrozenFamilyReviewInput {
  reviewId: string;
  recipientSubjectId: string;
  acceptanceId: string;
  expectedFamilyVersion: number;
  expectedRecipientMembershipVersion: number;
  expectedOwnerMembershipVersion: number;
  expectedChildScopeDigest: string;
  /** What the operator checked. Only a closing result closes: `retained_for_review` is refused. */
  sharedWorkResult: FrozenFamilySharedWorkResult;
  sharedWorkCheckedAt: Date;
  reason: string;
  idempotencyKeyHash: string;
  /** The operations role the connection was verified to be. Re-read from `session_user` before any write. */
  operatorRole: string;
}

export interface FrozenFamilyReviewResolution {
  resolutionId: string;
  reviewId: string;
  familyId: string;
  recipientSubjectId: string;
  acceptanceId: string;
  operatorRole: string;
  sharedWorkResult: FrozenFamilySharedWorkResult;
  sharedWorkCheckedAt: string;
  childCount: number;
  closedAt: string;
  /** True when this call returned an earlier closure of the same review instead of writing a new one. */
  replayed: boolean;
}

export interface FrozenFamilyReviewOperatorExpectation {
  /** The environment's designated review operator roles, bound to the actual database login role. */
  operators: readonly string[];
  database: string;
  environment: z.infer<typeof environmentSchema>;
}

interface FamilyRow { owner_subject_id: string; status: string; version: number; }
interface MemberRow { subject_id: string; role: string; active: boolean; version: number; kind: string; status: string; }
interface ChildRow {
  child_subject_id: string; relationship_version: number; consent_record_id: string;
  child_membership_version: number; policy_version: string;
}
interface AcceptanceRow {
  id: string; family_id: string; recipient_subject_id: string;
  // The deleting adult's own link is the one column a later redaction may clear (a closed row keeps the
  // other adult's acceptance, the operator's record and the idempotency evidence instead of being deleted).
  // This module never writes it and only requires it to equal the marker's deleting subject, so a redacted
  // NULL simply refuses as FAMILY_REVIEW_STALE rather than being reused or silently widened.
  deleting_subject_id: string | null;
  family_version: number; recipient_membership_version: number; owner_membership_version: number;
  child_scope_digest: string; accepted_at: Date; consumed_at: Date | null; superseded_at: Date | null;
}
interface ReviewRow {
  id: string; deletion_id: string; family_id: string;
  // Migration 0026 clears the deleting adult's own link on a *resolved* marker (with its own stamp), so a
  // resolved row read back here may carry NULL. A pending row may not: the schema ties a cleared link to
  // `state='resolved'`, and the closure below refuses a pending review whose link is gone instead of
  // closing a handover with nobody to hand the family from.
  deleting_subject_id: string | null;
  state: string; opened_at: Date; resolved_at: Date | null;
}
interface ResolutionRow {
  id: string; review_id: string; acceptance_id: string; family_id: string; recipient_subject_id: string;
  operator_role: string; shared_work_result: string; shared_work_checked_at: Date; reason: string;
  idempotency_key_hash: string; family_version: number; recipient_membership_version: number;
  owner_membership_version: number; child_scope_digest: string; child_count: number; closed_at: Date;
}
interface InternalScope {
  familyId: string; deletingSubjectId: string; recipientSubjectId: string;
  family: FamilyRow; owner: MemberRow; recipient: MemberRow;
  children: ChildRow[]; childScopeDigest: string;
}

const reviewColumns = 'id,deletion_id,family_id,deleting_subject_id,state,opened_at,resolved_at';
const resolutionColumns = `id,review_id,acceptance_id,family_id,recipient_subject_id,operator_role,
  shared_work_result,shared_work_checked_at,reason,idempotency_key_hash,family_version,
  recipient_membership_version,owner_membership_version,child_scope_digest,child_count,closed_at`;

/**
 * The children whose guardianship the frozen family's current owner holds. This is the same set the live
 * management acceptance digests: a live relationship whose recorded consent is still un-withdrawn, whose
 * child membership in this family is active and whose child subject is an active child.
 */
const ownerChildScopeSql = `SELECT r.child_subject_id,r.version AS relationship_version,
    r.consent_record_id,cm.version AS child_membership_version,c.policy_version
  FROM siyue.guardian_relationships r
    JOIN siyue.consent_records c ON c.id=r.consent_record_id
      AND c.actor_subject_id=r.guardian_subject_id AND c.subject_id=r.child_subject_id
      AND c.purpose='child-guardianship' AND c.withdrawn_at IS NULL
    JOIN siyue.family_memberships cm ON cm.family_id=r.family_id
      AND cm.subject_id=r.child_subject_id AND cm.active
    JOIN siyue.subjects child ON child.id=r.child_subject_id
      AND child.kind='child' AND child.status='active'
  WHERE r.family_id=$1 AND r.guardian_subject_id=$2 AND r.active
  ORDER BY r.child_subject_id FOR UPDATE OF r,c,cm,child`;

/**
 * The definition of the accepted child scope, applied to the frozen family. The keys and tuple order
 * mirror the live management acceptance's server-side digest, so the same family state yields the same
 * digest in both records and a later unification cannot silently change what a recipient accepted. Only
 * the family's status and the owner's subject status differ, and neither is part of the digest.
 */
function childScopeDigest(familyId: string, ownerSubjectId: string, children: readonly ChildRow[]): string {
  return createHash('sha256').update(JSON.stringify({ familyId, ownerSubjectId,
    children: children.map(row => [row.child_subject_id, row.relationship_version, row.consent_record_id,
      row.child_membership_version, row.policy_version]) })).digest('hex');
}

/**
 * Reads the frozen family under the caller's transaction and locks everything the scope depends on: the
 * family row, both memberships and each in-scope child's relationship, consent and membership, so a
 * concurrent freeze, membership change or guardianship change cannot land between the read and a write.
 * An ineligible recipient, an unfrozen family or a family whose owner is somebody else reads as
 * `FAMILY_NOT_FOUND`, so an ordinary member cannot tell an ineligible family from a missing one.
 */
async function readFrozenScope(client: PoolClient, familyId: string, recipientId: string): Promise<InternalScope> {
  const family = (await client.query<FamilyRow>(`SELECT owner_subject_id,status,version
    FROM siyue.families WHERE id=$1 FOR UPDATE`, [familyId])).rows[0];
  if (!family || family.status !== 'frozen' || family.owner_subject_id === recipientId)
    throw new AuthError('FAMILY_NOT_FOUND', 404);
  const members = (await client.query<MemberRow>(`SELECT m.subject_id,m.role,m.active,m.version,s.kind,s.status
    FROM siyue.family_memberships m JOIN siyue.subjects s ON s.id=m.subject_id
    WHERE m.family_id=$1 AND m.subject_id=ANY($2::uuid[]) ORDER BY m.subject_id FOR UPDATE OF m,s`,
  [familyId, [family.owner_subject_id, recipientId]])).rows;
  const owner = members.find(row => row.subject_id === family.owner_subject_id);
  const recipient = members.find(row => row.subject_id === recipientId);
  // The deleting adult's own subject is `deletion_pending` by the time the family is frozen: the freeze
  // happens inside the accepted deletion, which is why this reads a different status than the live
  // acceptance. A frozen family whose owner is anybody else is not a state this path may act on.
  if (!owner?.active || owner.role !== 'owner' || owner.kind !== 'adult' || owner.status !== 'deletion_pending' ||
      !recipient?.active || recipient.kind !== 'adult' || recipient.status !== 'active')
    throw new AuthError('FAMILY_NOT_FOUND', 404);
  const children = (await client.query<ChildRow>(ownerChildScopeSql,
    [familyId, family.owner_subject_id])).rows;
  return { familyId, deletingSubjectId: family.owner_subject_id, recipientSubjectId: recipientId,
    family, owner, recipient, children, childScopeDigest: childScopeDigest(familyId, family.owner_subject_id, children) };
}

const toAcceptanceReceipt = (row: AcceptanceRow, childCount: number): FrozenFamilyReviewAcceptanceReceipt =>
  frozenFamilyReviewAcceptanceReceiptSchema.parse({
    acceptanceId: row.id, familyId: row.family_id, deletingSubjectId: row.deleting_subject_id,
    recipientSubjectId: row.recipient_subject_id, familyVersion: row.family_version,
    membershipVersion: row.recipient_membership_version, ownerMembershipVersion: row.owner_membership_version,
    childScopeDigest: row.child_scope_digest, childCount,
    acceptedAt: row.accepted_at.toISOString(), consumedAt: row.consumed_at?.toISOString() ?? null,
  });

const toResolution = (row: ResolutionRow, replayed: boolean): FrozenFamilyReviewResolution => ({
  resolutionId: row.id, reviewId: row.review_id, familyId: row.family_id,
  recipientSubjectId: row.recipient_subject_id, acceptanceId: row.acceptance_id,
  operatorRole: row.operator_role,
  sharedWorkResult: sharedWorkResultSchema.parse(row.shared_work_result),
  sharedWorkCheckedAt: row.shared_work_checked_at.toISOString(), childCount: row.child_count,
  closedAt: row.closed_at.toISOString(), replayed,
});

/**
 * The scope a recipient may be shown, without child identities. This is the reader a frozen-family
 * acceptance preview needs; it is also what the closure re-reads before it writes.
 */
export async function readFrozenFamilyReviewScope(client: PoolClient, familyId: string,
  recipientId: string): Promise<FrozenFamilyReviewScope> {
  const scope = await readFrozenScope(client, familyId, recipientId);
  return frozenFamilyReviewScopeSchema.parse({
    familyId: scope.familyId, deletingSubjectId: scope.deletingSubjectId,
    recipientSubjectId: scope.recipientSubjectId, familyVersion: scope.family.version,
    membershipVersion: scope.recipient.version, ownerMembershipVersion: scope.owner.version,
    childScopeDigest: scope.childScopeDigest, childCount: scope.children.length,
  });
}

/**
 * The recipient acts in their own verified adult session. Recording an acceptance changes no ownership,
 * guardianship, device grant or family status: the closure still has to be run by a designated operator,
 * and it is the only path that consumes this record.
 */
export function createFrozenFamilyReviewService(pool: Pool, sessions: SessionService,
  clock: () => Date = () => new Date()) {
  return {
    async preview(accessToken: string, familyId: string): Promise<FrozenFamilyReviewScope> {
      if (!uuid.safeParse(familyId).success) throw new AuthError('FAMILY_INVALID_REQUEST', 400);
      return transaction(pool, async client => {
        const session = await sessions.verifyForMutation(client, accessToken);
        if (session.subjectKind !== 'adult') throw new AuthError('FAMILY_ADULT_REQUIRED', 403);
        return readFrozenFamilyReviewScope(client, familyId, session.subjectId);
      });
    },
    async accept(accessToken: string, familyId: string,
      input: unknown): Promise<FrozenFamilyReviewAcceptanceReceipt> {
      const parsed = frozenFamilyReviewAcceptanceRequestSchema.safeParse(input);
      if (!uuid.safeParse(familyId).success || !parsed.success)
        throw new AuthError('FAMILY_INVALID_REQUEST', 400);
      return transaction(pool, async client => {
        const session = await sessions.verifyForMutation(client, accessToken);
        if (session.subjectKind !== 'adult') throw new AuthError('FAMILY_ADULT_REQUIRED', 403);
        const scope = await readFrozenScope(client, familyId, session.subjectId);
        const request = parsed.data;
        if (request.expectedFamilyVersion !== scope.family.version ||
            request.expectedMembershipVersion !== scope.recipient.version ||
            request.expectedOwnerMembershipVersion !== scope.owner.version ||
            request.expectedChildScopeDigest !== scope.childScopeDigest)
          throw new AuthError('FAMILY_STALE_AUTHORIZATION', 409);
        const now = clock();
        const prior = (await client.query<AcceptanceRow>(`SELECT id,family_id,deleting_subject_id,
            recipient_subject_id,family_version,recipient_membership_version,owner_membership_version,
            child_scope_digest,accepted_at,consumed_at,superseded_at
          FROM siyue.family_review_acceptances
          WHERE family_id=$1 AND recipient_subject_id=$2 AND consumed_at IS NULL AND superseded_at IS NULL
          FOR UPDATE`, [familyId, session.subjectId])).rows[0];
        // The same state submitted twice inside the validity window returns the same record instead of
        // accumulating declarations. A declaration that is no longer current is not reused: the same
        // request records a fresh acceptance and supersedes the old row, so an expired declaration can
        // never be presented as the recipient's current consent.
        if (prior && isCurrentAcceptance(prior.accepted_at, now) &&
            prior.deleting_subject_id === scope.deletingSubjectId &&
            prior.family_version === scope.family.version &&
            prior.recipient_membership_version === scope.recipient.version &&
            prior.owner_membership_version === scope.owner.version &&
            prior.child_scope_digest === scope.childScopeDigest)
          return toAcceptanceReceipt(prior, scope.children.length);
        const acceptanceId = randomUUID();
        await client.query(`UPDATE siyue.family_review_acceptances SET superseded_at=GREATEST($3,accepted_at)
          WHERE family_id=$1 AND recipient_subject_id=$2 AND consumed_at IS NULL AND superseded_at IS NULL`,
        [familyId, session.subjectId, now]);
        await client.query(`INSERT INTO siyue.family_review_acceptances
          (id,family_id,deleting_subject_id,recipient_subject_id,family_version,
           recipient_membership_version,owner_membership_version,child_scope_digest,accepted_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [acceptanceId, familyId, scope.deletingSubjectId, session.subjectId, scope.family.version,
          scope.recipient.version, scope.owner.version, scope.childScopeDigest, now]);
        // The event keeps the existing security-event window. The acceptance record carries no retention
        // column and no expiry column: how long it stays current is the 24-hour window above, counted from
        // `accepted_at`, so no second date is invented here.
        await client.query(`INSERT INTO siyue.security_events
          (id,event_type,subject_id,session_id,request_id,outcome,redacted_metadata,occurred_at,expires_at)
          VALUES($1,'family.review.accept',$2,$3,$4,'success',
            jsonb_build_object('familyId',$5::uuid),$6,$7)`,
        [randomUUID(), session.subjectId, session.sessionId, acceptanceId, familyId, now,
          new Date(+now + 30 * 86_400_000)]);
        return toAcceptanceReceipt({ id: acceptanceId, family_id: familyId,
          deleting_subject_id: scope.deletingSubjectId, recipient_subject_id: session.subjectId,
          family_version: scope.family.version, recipient_membership_version: scope.recipient.version,
          owner_membership_version: scope.owner.version, child_scope_digest: scope.childScopeDigest,
          accepted_at: now, consumed_at: null, superseded_at: null }, scope.children.length);
      });
    },
  };
}

/**
 * Verifies that this connection is the operations identity the environment designated, and returns it.
 * The three facts are read from the connection itself: `session_user` (a login role the client cannot
 * assert), `current_database()` and the database's own environment marker. An empty allowlist, an
 * allowlist naming the API's runtime role, a mismatch or an unreadable environment marker all refuse, so
 * a review is never closed by accident and never by an ordinary request path.
 */
export async function verifyFrozenFamilyReviewOperator(client: PoolClient,
  expected: FrozenFamilyReviewOperatorExpectation): Promise<{ operatorRole: string }> {
  const operators = [...new Set(expected.operators.map(role => role.trim()).filter(Boolean))];
  if (!operators.length || operators.includes(runtimeRole))
    throw new AuthError('FAMILY_REVIEW_OPERATOR_REQUIRED', 403);
  if (!operators.every(role => operatorRoleSchema.safeParse(role).success))
    throw new AuthError('FAMILY_REVIEW_OPERATOR_REQUIRED', 403);
  const row = (await client.query<{ database: string; role: string; environment: string | null }>(
    `SELECT current_database() AS database, session_user AS role,
      (SELECT environment FROM siyue.server_metadata WHERE singleton) AS environment`)).rows[0];
  if (!row || row.database !== expected.database || row.environment !== expected.environment ||
      row.role === runtimeRole || !operators.includes(row.role))
    throw new AuthError('FAMILY_REVIEW_OPERATOR_REJECTED', 403);
  return { operatorRole: row.role };
}

export interface PendingFrozenFamilyReview {
  reviewId: string;
  familyId: string;
  /** NULL only after the deleted owner's link was redacted from an already resolved marker (0026). */
  deletingSubjectId: string | null;
  openedAt: string;
  familyStatus: string | null;
  familyVersion: number | null;
  liveAcceptanceCount: number;
}

interface PendingReviewRow {
  review_id: string; deletion_id: string; family_id: string; deleting_subject_id: string | null;
  state: string; opened_at: Date; resolved_at: Date | null;
  family_status: string | null; family_version: number | null; live_acceptances: number;
}

const toPendingReview = (row: PendingReviewRow): PendingFrozenFamilyReview => ({
  reviewId: row.review_id, familyId: row.family_id, deletingSubjectId: row.deleting_subject_id,
  openedAt: row.opened_at.toISOString(), familyStatus: row.family_status,
  familyVersion: row.family_version, liveAcceptanceCount: Number(row.live_acceptances),
});

/** The oldest `accepted_at` an acceptance may have and still be current at `now`. */
const acceptanceCutoff = (now: Date): Date => new Date(+now - frozenFamilyReviewAcceptanceLifetimeMs);

/**
 * The pending-review projection. `live_acceptances` counts only acceptances that are still inside the
 * validity window, so an operator sees the declarations that could actually close the review and an
 * expired one is never presented as a current consent. The expired rows stay in the table as history.
 * The cutoff is a bound parameter, so one clock decides both the kernel and these views.
 */
const pendingReviewSql = (cutoffParam: string) => `SELECT r.id AS review_id,r.deletion_id,r.family_id,r.deleting_subject_id,
    r.state,r.opened_at,r.resolved_at,
    f.status AS family_status,f.version AS family_version,
    (SELECT count(*)::int FROM siyue.family_review_acceptances a
      WHERE a.family_id=r.family_id AND a.consumed_at IS NULL AND a.superseded_at IS NULL
        AND a.accepted_at > ${cutoffParam}) AS live_acceptances
  FROM siyue.account_deletion_family_reviews r
    LEFT JOIN siyue.families f ON f.id=r.family_id`;

/**
 * Read-only operations view of the reviews still owed. Bounded, and it names no member or child. `now`
 * decides which acceptances still count as current; the default is the wall clock.
 */
export async function listPendingFrozenFamilyReviews(client: PoolClient,
  limit: number, now: Date = new Date()): Promise<PendingFrozenFamilyReview[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new AuthError('FAMILY_REVIEW_INVALID_REQUEST', 400);
  return (await client.query<PendingReviewRow>(`${pendingReviewSql('$1')}
    WHERE r.state='pending' ORDER BY r.opened_at,r.id LIMIT $2`,
  [acceptanceCutoff(now), limit])).rows.map(toPendingReview);
}

export interface FrozenFamilyReviewAcceptanceSummary {
  acceptanceId: string; recipientSubjectId: string; familyVersion: number;
  recipientMembershipVersion: number; ownerMembershipVersion: number;
  childScopeDigest: string; acceptedAt: string;
}

export interface FrozenFamilyReviewDetail {
  review: PendingFrozenFamilyReview & { state: string; resolvedAt: string | null; deletionId: string };
  acceptances: FrozenFamilyReviewAcceptanceSummary[];
}

/**
 * Everything one closure decision needs, for an operator to read before it writes. `now` decides which
 * acceptances are still current: an expired declaration stays in the table as history and is not listed
 * as something an operator could close the review with.
 */
export async function readFrozenFamilyReview(client: PoolClient,
  reviewId: string, now: Date = new Date()): Promise<FrozenFamilyReviewDetail | null> {
  if (!uuid.safeParse(reviewId).success) throw new AuthError('FAMILY_REVIEW_INVALID_REQUEST', 400);
  const row = (await client.query<PendingReviewRow>(`${pendingReviewSql('$1')}
    WHERE r.id=$2`, [acceptanceCutoff(now), reviewId])).rows[0];
  if (!row) return null;
  const acceptances = (await client.query<{ id: string; recipient_subject_id: string; family_version: number;
      recipient_membership_version: number; owner_membership_version: number; child_scope_digest: string;
      accepted_at: Date }>(`SELECT id,recipient_subject_id,family_version,recipient_membership_version,
      owner_membership_version,child_scope_digest,accepted_at
    FROM siyue.family_review_acceptances
    WHERE family_id=$1 AND consumed_at IS NULL AND superseded_at IS NULL AND accepted_at > $2
    ORDER BY accepted_at,id`,
  [row.family_id, acceptanceCutoff(now)])).rows;
  return {
    review: { ...toPendingReview(row), state: row.state,
      resolvedAt: row.resolved_at?.toISOString() ?? null, deletionId: row.deletion_id },
    acceptances: acceptances.map(entry => ({ acceptanceId: entry.id,
      recipientSubjectId: entry.recipient_subject_id, familyVersion: entry.family_version,
      recipientMembershipVersion: entry.recipient_membership_version,
      ownerMembershipVersion: entry.owner_membership_version, childScopeDigest: entry.child_scope_digest,
      acceptedAt: entry.accepted_at.toISOString() })),
  };
}
export const frozenFamilyReviewIdempotencyKeyHash = (key: string): string =>
  createHash('sha256').update(key).digest('hex');

async function readResolution(client: PoolClient, reviewId: string): Promise<ResolutionRow | undefined> {
  return (await client.query<ResolutionRow>(`SELECT ${resolutionColumns}
    FROM siyue.family_review_resolutions WHERE review_id=$1`, [reviewId])).rows[0];
}

/**
 * A second attempt is answered from the stored record only when it is the same operation, bound
 * parameter by parameter. The stored record keeps every parameter the closure consumed -- the operator
 * role, the instant of the shared-work check, the acceptance, the recipient, the result, the reason, the
 * versions and the child scope -- so a retry that reuses a key with any of them changed is a conflict
 * instead of silently replaying a decision that was made for different input. Only the key's own digest
 * identifies the operation: a different key never re-closes the review, and a repeated key that asks for
 * exactly what was recorded returns that same closure.
 */
async function replayResolution(client: PoolClient, review: ReviewRow,
  input: ResolveFrozenFamilyReviewInput): Promise<FrozenFamilyReviewResolution> {
  const stored = await readResolution(client, review.id);
  if (!stored) throw new AuthError('FAMILY_REVIEW_STATE_INVALID', 409);
  if (stored.idempotency_key_hash !== input.idempotencyKeyHash)
    throw new AuthError('FAMILY_REVIEW_ALREADY_RESOLVED', 409);
  if (stored.acceptance_id !== input.acceptanceId ||
      stored.operator_role !== input.operatorRole ||
      +stored.shared_work_checked_at !== +input.sharedWorkCheckedAt ||
      stored.recipient_subject_id !== input.recipientSubjectId ||
      stored.shared_work_result !== input.sharedWorkResult ||
      stored.reason !== input.reason ||
      stored.family_version !== input.expectedFamilyVersion ||
      stored.recipient_membership_version !== input.expectedRecipientMembershipVersion ||
      stored.owner_membership_version !== input.expectedOwnerMembershipVersion ||
      stored.child_scope_digest !== input.expectedChildScopeDigest)
    throw new AuthError('FAMILY_REVIEW_IDEMPOTENCY_CONFLICT', 409);
  return toResolution(stored, true);
}

/**
 * Closes one pending review inside the caller's transaction. The caller owns the transaction and the
 * operator identity check; this kernel writes everything or nothing.
 *
 * Lock order is the one every other auth mutation uses -- the subject row first, then the family and its
 * memberships -- so a concurrent cleanup pass (which also takes the subject row lock before it touches
 * the job) and a concurrent family mutation (family and memberships) can never leave this closure
 * holding a lock the other waits for. The deletion job itself is read, not locked: every writer of that
 * row holds the deletion subject's row lock for its whole transaction and this closure holds that same
 * subject lock, so the subject lock is the serialization that matters and the job needs no write
 * privilege of its own.
 *
 * Refusals are typed and never partial: the runtime role naming itself an operator, a retained shared-work
 * result, a stale scope, an already consumed or superseded acceptance, an acceptance past its validity
 * window, a family that is no longer frozen, a job whose local data is already deleted, an unknown review,
 * a repeated call whose key or parameters describe another operation, and a role that does not match the
 * connection are all refused before the first write.
 */
export async function resolveFrozenFamilyReview(client: PoolClient,
  input: ResolveFrozenFamilyReviewInput, now: Date): Promise<FrozenFamilyReviewResolution> {
  if (!uuid.safeParse(input.reviewId).success || !uuid.safeParse(input.recipientSubjectId).success ||
      !uuid.safeParse(input.acceptanceId).success ||
      !versionSchema.safeParse(input.expectedFamilyVersion).success ||
      !versionSchema.safeParse(input.expectedRecipientMembershipVersion).success ||
      !versionSchema.safeParse(input.expectedOwnerMembershipVersion).success ||
      !digestSchema.safeParse(input.expectedChildScopeDigest).success ||
      !sharedWorkResultSchema.safeParse(input.sharedWorkResult).success ||
      !digestSchema.safeParse(input.idempotencyKeyHash).success ||
      !operatorRoleSchema.safeParse(input.operatorRole).success ||
      !reasonSchema.safeParse(input.reason).success ||
      !(input.sharedWorkCheckedAt instanceof Date) || !Number.isFinite(+input.sharedWorkCheckedAt))
    throw new AuthError('FAMILY_REVIEW_INVALID_REQUEST', 400);
  // A result that keeps the shared work retained is a refusal, not a closure: the family stays frozen,
  // the acceptance stays live and nothing is written until a review records a result that closes it.
  if (!isClosingSharedWorkResult(input.sharedWorkResult))
    throw new AuthError('FAMILY_REVIEW_SHARED_WORK_RETAINED', 409);
  // The API's runtime role can never close a review, and the kernel refuses it here by name rather than
  // only through the caller's allowlist: passing that role in the input field cannot turn the request
  // path's own identity into a review operator, even if a future route reaches this kernel.
  if (input.operatorRole === runtimeRole) throw new AuthError('FAMILY_REVIEW_OPERATOR_REJECTED', 403);
  // The role is re-read here, so a caller cannot close a review by naming a role this connection is not.
  const operator = (await client.query<{ role: string }>('SELECT session_user AS role')).rows[0];
  if (operator?.role !== input.operatorRole || operator.role === runtimeRole)
    throw new AuthError('FAMILY_REVIEW_OPERATOR_REJECTED', 403);

  const preliminary = (await client.query<ReviewRow>(`SELECT ${reviewColumns}
    FROM siyue.account_deletion_family_reviews WHERE id=$1`, [input.reviewId])).rows[0];
  if (!preliminary) throw new AuthError('FAMILY_REVIEW_NOT_FOUND', 404);
  if (preliminary.state !== 'pending') return replayResolution(client, preliminary, input);
  // A pending review always names the adult whose accepted deletion froze the family: a cleared link is
  // only ever written on a resolved marker. If it is missing here the review is not closed as asked.
  const deletingSubjectId = preliminary.deleting_subject_id;
  if (deletingSubjectId === null) throw new AuthError('FAMILY_REVIEW_STATE_INVALID', 409);

  const subject = (await client.query<{ id: string; status: string }>(
    'SELECT id,status FROM siyue.subjects WHERE id=$1 FOR UPDATE',
    [deletingSubjectId])).rows[0];
  if (!subject || subject.status !== 'deletion_pending')
    throw new AuthError('FAMILY_REVIEW_STATE_INVALID', 409);
  // Read without a lock: every writer of this row holds the deletion subject's row lock for its whole
  // transaction (the cleanup kernel, the acceptance transaction and the ledger replay all run subject
  // first), and this closure holds that same subject lock above, so it is already serialized with a
  // concurrent cleanup. That is why the deletion job table needs no write privilege here.
  const job = (await client.query<{ id: string; local_data_deleted: boolean }>(`SELECT id,local_data_deleted
    FROM siyue.account_deletion_jobs WHERE id=$1 AND subject_id=$2`,
  [preliminary.deletion_id, deletingSubjectId])).rows[0];
  if (!job || job.local_data_deleted) throw new AuthError('FAMILY_REVIEW_STATE_INVALID', 409);

  const review = (await client.query<ReviewRow>(`SELECT ${reviewColumns}
    FROM siyue.account_deletion_family_reviews WHERE id=$1 FOR UPDATE`, [input.reviewId])).rows[0];
  if (!review || review.state !== 'pending' || review.family_id !== preliminary.family_id ||
      review.deletion_id !== preliminary.deletion_id ||
      review.deleting_subject_id !== preliminary.deleting_subject_id)
    throw new AuthError('FAMILY_REVIEW_CONFLICT', 409);
  if (review.deleting_subject_id === null) throw new AuthError('FAMILY_REVIEW_STATE_INVALID', 409);
  // Times this module stamps come from the caller's clock while `opened_at` is the database's own, so the
  // two are never compared to each other: a shared-work result later than the operation itself is refused
  // here, and every write that touches a database timestamp keeps its `GREATEST` guard instead.
  if (+input.sharedWorkCheckedAt > +now)
    throw new AuthError('FAMILY_REVIEW_INVALID_REQUEST', 400);

  // The frozen family, both memberships, every in-scope child and the family lock itself are read and
  // locked here. A family that stopped being frozen, an owner that changed or an ineligible recipient is
  // a conflict for an operator, not a "not found": the review cannot be closed as asked.
  let scope: InternalScope;
  try { scope = await readFrozenScope(client, review.family_id, input.recipientSubjectId); }
  catch (error) {
    if (error instanceof AuthError) throw new AuthError('FAMILY_REVIEW_STALE', 409);
    throw error;
  }
  if (scope.family.version !== input.expectedFamilyVersion ||
      scope.recipient.version !== input.expectedRecipientMembershipVersion ||
      scope.owner.version !== input.expectedOwnerMembershipVersion ||
      scope.childScopeDigest !== input.expectedChildScopeDigest)
    throw new AuthError('FAMILY_REVIEW_STALE', 409);

  const acceptance = (await client.query<AcceptanceRow>(`SELECT id,family_id,deleting_subject_id,
      recipient_subject_id,family_version,recipient_membership_version,owner_membership_version,
      child_scope_digest,accepted_at,consumed_at,superseded_at
    FROM siyue.family_review_acceptances WHERE id=$1 FOR UPDATE`, [input.acceptanceId])).rows[0];
  if (!acceptance || acceptance.consumed_at !== null || acceptance.superseded_at !== null ||
      acceptance.family_id !== review.family_id ||
      acceptance.recipient_subject_id !== input.recipientSubjectId ||
      acceptance.deleting_subject_id !== review.deleting_subject_id ||
      acceptance.family_version !== scope.family.version ||
      acceptance.recipient_membership_version !== scope.recipient.version ||
      acceptance.owner_membership_version !== scope.owner.version ||
      acceptance.child_scope_digest !== scope.childScopeDigest)
    throw new AuthError('FAMILY_REVIEW_STALE', 409);
  // A declaration is current only for the validity window the live management acceptance uses. Past it
  // the review cannot be closed with that record at all: the recipient accepts the frozen scope again,
  // and that fresh declaration is what makes the consent current rather than merely preserved.
  if (!isCurrentAcceptance(acceptance.accepted_at, now))
    throw new AuthError('FAMILY_REVIEW_ACCEPTANCE_EXPIRED', 409);

  const ownerId = review.deleting_subject_id;
  const recipientId = input.recipientSubjectId;
  const familyId = review.family_id;
  // The recipient's own guardianship consent is recorded per in-scope child, never revived from the
  // deleting adult's declaration. A relationship that exists but is inactive or withdrawn refuses the
  // closure instead of being silently reactivated, exactly as the live transfer path does.
  for (const child of scope.children) {
    const existing = (await client.query<{ active: boolean; withdrawn_at: Date | null }>(`
      SELECT r.active,c.withdrawn_at FROM siyue.guardian_relationships r
      JOIN siyue.consent_records c ON c.id=r.consent_record_id
        AND c.actor_subject_id=r.guardian_subject_id AND c.subject_id=r.child_subject_id
        AND c.purpose='child-guardianship'
      WHERE r.family_id=$1 AND r.guardian_subject_id=$2 AND r.child_subject_id=$3 FOR UPDATE OF r,c`,
    [familyId, recipientId, child.child_subject_id])).rows[0];
    if (existing?.active && existing.withdrawn_at === null) continue;
    if (existing) throw new AuthError('FAMILY_REVIEW_STALE', 409);
    const consentId = randomUUID();
    await client.query(`INSERT INTO siyue.consent_records
      (id,actor_subject_id,subject_id,purpose,policy_version,recorded_at)
      VALUES($1,$2,$3,'child-guardianship',$4,$5)`,
    [consentId, recipientId, child.child_subject_id, child.policy_version, now]);
    await client.query(`INSERT INTO siyue.guardian_relationships
      (family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)`,
    [familyId, recipientId, child.child_subject_id, consentId]);
  }
  // Hand the family to the recipient: demote before promoting, which is the order the one-active-owner
  // index requires. Each write is guarded by the state it was read from, so a change that landed in
  // between refuses the closure instead of leaving half a transfer.
  const oldMembership = await client.query(`UPDATE siyue.family_memberships
    SET active=false,role='member',version=version+1
    WHERE family_id=$1 AND subject_id=$2 AND active AND role='owner'`, [familyId, ownerId]);
  if (oldMembership.rowCount !== 1) throw new AuthError('FAMILY_REVIEW_STALE', 409);
  const nextMembership = await client.query(`UPDATE siyue.family_memberships
    SET role='owner',version=version+1
    WHERE family_id=$1 AND subject_id=$2 AND active AND role<>'owner'`, [familyId, recipientId]);
  if (nextMembership.rowCount !== 1) throw new AuthError('FAMILY_REVIEW_STALE', 409);
  const family = await client.query(`UPDATE siyue.families
    SET status='active',owner_subject_id=$3,version=version+1
    WHERE id=$1 AND owner_subject_id=$2 AND status='frozen'`, [familyId, ownerId, recipientId]);
  if (family.rowCount !== 1) throw new AuthError('FAMILY_REVIEW_STALE', 409);
  // The deleting adult's own guardianship in this family is ended and their consent withdrawn -- the old
  // authorization stays revoked -- while a consent shared with another family's own disposition is left
  // to that family.
  await client.query(`UPDATE siyue.guardian_relationships SET active=false,version=version+1
    WHERE family_id=$1 AND guardian_subject_id=$2 AND active`, [familyId, ownerId]);
  await client.query(`UPDATE siyue.consent_records SET withdrawn_at=GREATEST($2,recorded_at)
    WHERE id IN (SELECT consent_record_id FROM siyue.guardian_relationships
      WHERE family_id=$1 AND guardian_subject_id=$3) AND withdrawn_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM siyue.guardian_relationships other
        WHERE other.consent_record_id=siyue.consent_records.id
          AND NOT (other.family_id=$1 AND other.guardian_subject_id=$3))`, [familyId, now, ownerId]);
  // The freeze already revoked this family's device authority, ended its rooms and closed its pending
  // invitations. These statements repeat the deleting adult's own part of that revocation in this
  // transaction, so a closure can never leave a live grant, session, invitation, pairing or seat behind.
  // They touch only rows the deleting adult owns: no other member's work, room, grant or consent is
  // modified, and nothing revoked here is revived.
  await client.query(`UPDATE siyue.device_grants
    SET revoked_at=GREATEST($3,created_at),version=version+1
    WHERE family_id=$1 AND guardian_id=$2 AND revoked_at IS NULL`, [familyId, ownerId, now]);
  await client.query(`UPDATE siyue.auth_sessions
    SET revoked_at=COALESCE(revoked_at,$3),revoke_reason=COALESCE(revoke_reason,'family_review_closed')
    WHERE device_grant_id IN (SELECT id FROM siyue.device_grants WHERE family_id=$1 AND guardian_id=$2)`,
  [familyId, ownerId, now]);
  await client.query(`UPDATE siyue.refresh_tokens
    SET revoked_at=COALESCE(revoked_at,$3),retry_ciphertext=NULL,retry_expires_at=NULL
    WHERE session_id IN (SELECT s.id FROM siyue.auth_sessions s JOIN siyue.device_grants g
      ON g.id=s.device_grant_id WHERE g.family_id=$1 AND g.guardian_id=$2)`, [familyId, ownerId, now]);
  await client.query(`UPDATE siyue.device_pairing_requests SET status='expired'
    WHERE family_id=$1 AND approved_by=$2 AND status='approved'`, [familyId, ownerId]);
  await client.query(`UPDATE siyue.family_invitations
    SET status='revoked',token_ciphertext=NULL,token_ciphertext_expires_at=NULL
    WHERE family_id=$1 AND inviter_id=$2 AND status='pending'`, [familyId, ownerId]);
  await client.query(`UPDATE siyue.rooms SET status='ended',ended_at=GREATEST($3,created_at),version=version+1
    WHERE family_id=$1 AND created_by_subject_id=$2 AND status='open'`, [familyId, ownerId, now]);
  await client.query(`UPDATE siyue.room_invitations i SET status='revoked',revoked_at=GREATEST($2,i.created_at)
    FROM siyue.rooms r WHERE i.room_id=r.id AND r.family_id=$1 AND i.status='pending'`, [familyId, now]);
  await client.query(`UPDATE siyue.room_seats SET released_at=GREATEST($3,claimed_at)
    WHERE subject_id=$2 AND room_id IN (SELECT id FROM siyue.rooms WHERE family_id=$1) AND released_at IS NULL`,
  [familyId, ownerId, now]);

  const consumed = await client.query(`UPDATE siyue.family_review_acceptances SET consumed_at=GREATEST($2,accepted_at)
    WHERE id=$1 AND consumed_at IS NULL AND superseded_at IS NULL`, [acceptance.id, now]);
  if (consumed.rowCount !== 1) throw new AuthError('FAMILY_REVIEW_STALE', 409);
  const resolutionId = randomUUID();
  await client.query(`INSERT INTO siyue.family_review_resolutions
    (id,review_id,acceptance_id,family_id,recipient_subject_id,operator_role,shared_work_result,
     shared_work_checked_at,reason,idempotency_key_hash,family_version,recipient_membership_version,
     owner_membership_version,child_scope_digest,child_count,closed_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
  [resolutionId, review.id, acceptance.id, familyId, recipientId, input.operatorRole,
    input.sharedWorkResult, input.sharedWorkCheckedAt, input.reason, input.idempotencyKeyHash,
    scope.family.version, scope.recipient.version, scope.owner.version, scope.childScopeDigest,
    scope.children.length, now]);
  // The marker is closed last: the review is resolved only when everything it required has committed.
  const resolved = await client.query(`UPDATE siyue.account_deletion_family_reviews
    SET state='resolved',resolved_at=GREATEST($2,opened_at) WHERE id=$1 AND state='pending'`,
  [review.id, now]);
  if (resolved.rowCount !== 1) throw new AuthError('FAMILY_REVIEW_CONFLICT', 409);
  await client.query(`INSERT INTO siyue.security_events
    (id,event_type,subject_id,session_id,request_id,outcome,redacted_metadata,occurred_at,expires_at)
    VALUES($1,'family.review.resolve',$2,NULL,$3,'success',
      jsonb_build_object('familyId',$4::uuid,'sharedWorkResult',$5::text),$6,$7)`,
  [randomUUID(), ownerId, resolutionId, familyId, input.sharedWorkResult, now,
    new Date(+now + 30 * 86_400_000)]);
  return toResolution({ id: resolutionId, review_id: review.id, acceptance_id: acceptance.id,
    family_id: familyId, recipient_subject_id: recipientId, operator_role: input.operatorRole,
    shared_work_result: input.sharedWorkResult, shared_work_checked_at: input.sharedWorkCheckedAt,
    reason: input.reason, idempotency_key_hash: input.idempotencyKeyHash,
    family_version: scope.family.version, recipient_membership_version: scope.recipient.version,
    owner_membership_version: scope.owner.version, child_scope_digest: scope.childScopeDigest,
    child_count: scope.children.length, closed_at: now }, false);
}
