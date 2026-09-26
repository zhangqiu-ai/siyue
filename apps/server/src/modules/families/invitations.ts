import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { familyInvitationCreateRequestSchema, familyInvitationCreatedSchema, familyInvitationTokenSchema,
  familySummarySchema, normalizeLoginEmail, type FamilySummary } from '@siyue/contracts';
import { evaluateFamilyPolicy, type FamilyPolicyDenial } from '@siyue/domain';
import { transaction } from '../../adapters/postgres/database.js';
import type { RecoveryCipher } from '../../adapters/crypto/auth-crypto.js';
import { AuthError, type SessionService } from '../auth/sessions.js';
import { createFamilyRepository } from './repository.js';

const day = 86_400_000;
/** Design 8.2B/16.4: a controlled one-time member invitation lives at most 24 hours. */
export const familyInvitationTtlMs = day;
/** The design keeps an idempotent credential response recoverable for a short window only (11). */
export const familyInvitationRecoveryMs = 60_000;
/** Recorded on every row so a later invite policy change cannot silently reinterpret old invitations. */
export const familyInvitationPolicyVersion = 'family-invitation-v1';

/** The shared create contract plus the family the path already carries; no role, kind or snapshot. */
const createRequestSchema = familyInvitationCreateRequestSchema.extend({ familyId: z.uuid() }).strict();
const requestKeySchema = z.uuid();

export interface FamilyInvitationCreateInput {
  familyId: string;
  intendedEmail?: string | undefined;
  expectedMembershipVersion: number;
  expectedFamilyVersion: number;
}
export interface FamilyInvitationCreated { invitationId: string; token: string; expiresAt: string; }

interface InvitationRow {
  id: string; family_id: string; inviter_id: string; intended_email: string | null;
  status: 'pending' | 'accepted' | 'expired' | 'revoked'; inviter_membership_version: number; family_version: number;
  token_ciphertext: string | null; token_ciphertext_expires_at: Date | null; expires_at: Date;
}
interface FamilyRow { id: string; status: string; version: number; owner_subject_id: string; }
interface MembershipRow { family_id: string; subject_id: string; role: string; active: boolean; version: number; }
interface IdempotencyRow { resource_id: string | null; response_ciphertext: string | null; response_expires_at: Date | null; }
interface SummaryRow { family_id: string; owner_subject_id: string; role: string; membership_version: number; family_version: number; }
/** Trusted inviter state of one invitation: usable, no longer authorized, or gone with its family. */
type InviterAuthority = 'authorized' | 'ineligible' | 'missing';

/** Refusals are values inside the transaction, so state a refusal must commit (expiry, audit) survives. */
type Outcome<T> = { ok: true; value: T } | { ok: false; code: string; status: number };
const pass = <T>(value: T): Outcome<T> => ({ ok: true, value });
const refuse = (code: string, status: number): Outcome<never> => ({ ok: false, code, status });

/** A family exists for a requester only while the family, their membership and their subject are active. */
const visibleMembership = `SELECT f.id AS family_id, f.owner_subject_id, f.version AS family_version, m.role, m.version AS membership_version
  FROM siyue.family_memberships m JOIN siyue.families f ON f.id = m.family_id JOIN siyue.subjects p ON p.id = m.subject_id
  WHERE m.active AND f.status = 'active' AND p.status = 'active'`;
const toSummary = (row: SummaryRow): FamilySummary => familySummarySchema.parse({
  familyId: row.family_id, ownerSubjectId: row.owner_subject_id, role: row.role,
  membershipVersion: row.membership_version, familyVersion: row.family_version,
});

/**
 * Controlled family invitation service (SA-08, design 8.2B/16.4, spec "Controlled one-time family
 * invitation"). It owns storage and transactions for one-time member invitations; the HTTP layer is
 * a separate adapter and no mail transport is involved here.
 *
 * `create` accepts only a verified adult session that is a current family owner/admin at the exact
 * membership and family versions the caller last read, re-evaluates the existing domain invite policy
 * against a trusted snapshot and stores a 32-byte random token as a keyed digest plus one short-lived
 * sealed response for same-request recovery. `accept` re-checks the invitation, the inviter's current
 * authority, the family state, the token deadline and the acceptor identity before inserting exactly
 * one plain `member` membership and consuming the invitation. Roles, subject kinds, versions and
 * policy snapshots never come from the client, and no path can produce an admin, owner, guardian or
 * room credential. The invitation token is a controlled secret: it is returned only to the inviter
 * and the stored response ciphertext is destroyed on acceptance, on expiry and by cleanup.
 */
export function createFamilyInvitationService(pool: Pool, sessions: SessionService, cipher: RecoveryCipher,
  pepper: Buffer, clock: () => Date = () => new Date()) {
  if (pepper.length !== 32) throw new Error('invalid_pepper');
  const families = createFamilyRepository(pool);
  /** Domain-separated keyed digests. Raw tokens, keys and addresses never reach a column or a log. */
  const mac = (label: string, ...parts: unknown[]) => createHmac('sha256', pepper).update(JSON.stringify([label, ...parts])).digest('hex');
  const tokenDigest = (token: string) => mac('invitation-token', token);
  const createScope = (familyId: string) => `family-invitation:${familyId}`;
  const acceptScope = (invitationId: string) => `family-invitation-accept:${invitationId}`;
  const idempotencyContext = (scope: string, keyHash: string) => `idem:${scope}:${keyHash}`;
  const responseContext = (invitationId: string) => `family-invitation-response:${invitationId}`;
  /** Single account-wide advisory namespace for one (scope, key): identical retries serialize here. */
  async function lock(client: PoolClient, scope: string, keyHash: string) {
    const derived = mac('advisory-lock', scope, keyHash);
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [BigInt.asIntN(64, BigInt(`0x${derived.slice(0, 16)}`)).toString()]);
  }
  /** Minimal audit trail: who acted, from which session, and which invitation. Never a secret. */
  async function audit(client: PoolClient, event: string, subjectId: string, sessionId: string, requestId: string,
    outcome: 'success' | 'rejected', metadata: { invitationId: string; reason?: string }, now: Date) {
    await client.query(`INSERT INTO siyue.security_events(id,event_type,subject_id,session_id,request_id,outcome,redacted_metadata,occurred_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,jsonb_build_object('invitationId',$7::uuid) || CASE WHEN $8::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('reason',$8::text) END,$9,$10)`,
    [randomUUID(), event, subjectId, sessionId, requestId, outcome, metadata.invitationId, metadata.reason ?? null, now, new Date(+now + 30 * day)]);
  }
  /**
   * Idempotency decision for one request key. An expired record is dropped first, so a key becomes
   * usable again only after its own window closed; a different payload under the same key is a
   * conflict and never reaches the work function.
   */
  async function claim(client: PoolClient, scope: string, keyHash: string, requestMac: string, now: Date) {
    await client.query('DELETE FROM siyue.idempotency_records WHERE scope=$1 AND key_hash=$2 AND expires_at<=$3', [scope, keyHash, now]);
    const row = (await client.query<{ request_mac: string } & IdempotencyRow>(
      'SELECT request_mac,resource_id,response_ciphertext,response_expires_at FROM siyue.idempotency_records WHERE scope=$1 AND key_hash=$2',
      [scope, keyHash])).rows[0];
    if (!row) return { kind: 'fresh' as const, row: undefined };
    if (row.request_mac !== requestMac) return { kind: 'conflict' as const, row };
    return { kind: 'replay' as const, row };
  }
  async function lockFamily(client: PoolClient, familyId: string) {
    return (await client.query<FamilyRow>('SELECT id,status,version,owner_subject_id FROM siyue.families WHERE id=$1 FOR UPDATE', [familyId])).rows[0];
  }
  async function readSummary(client: PoolClient, subjectId: string, familyId: string) {
    const row = (await client.query<SummaryRow>(`${visibleMembership} AND m.subject_id=$1 AND f.id=$2`, [subjectId, familyId])).rows[0];
    return row ? toSummary(row) : null;
  }
  /**
   * The inviter must still be an active adult owner/admin at exactly the membership and family
   * versions the invitation was issued under. Acceptance and same-key recovery of the sealed token
   * both depend on this, so a demoted, removed, replaced, deactivated or blocked inviter can never
   * hand out a live invitation again - neither by consuming it nor by recovering its token.
   */
  async function inviterAuthority(client: PoolClient, invitation: InvitationRow): Promise<InviterAuthority> {
    const family = await lockFamily(client, invitation.family_id);
    if (!family) return 'missing';
    if (family.status !== 'active' || family.version !== invitation.family_version) return 'ineligible';
    const inviter = (await client.query<MembershipRow & { kind: string; status: string }>(`SELECT m.family_id,m.subject_id,m.role,m.active,m.version,p.kind,p.status
      FROM siyue.family_memberships m JOIN siyue.subjects p ON p.id=m.subject_id
      WHERE m.family_id=$1 AND m.subject_id=$2 FOR UPDATE OF m`, [invitation.family_id, invitation.inviter_id])).rows[0];
    if (!inviter || !inviter.active || inviter.kind !== 'adult' || inviter.status !== 'active' ||
        inviter.version !== invitation.inviter_membership_version || (inviter.role !== 'owner' && inviter.role !== 'admin')) return 'ineligible';
    const decision = evaluateFamilyPolicy(await families.snapshot(client, invitation.inviter_id, invitation.family_id),
      { kind: 'family', familyId: invitation.family_id, action: 'invite', expectedMembershipVersion: invitation.inviter_membership_version });
    return decision.allowed ? 'authorized' : 'ineligible';
  }
  /** Invite-policy denials become stable public codes; no resource state is disclosed by a refusal. */
  function refusalFor(reason: FamilyPolicyDenial) {
    switch (reason) {
      case 'inactive_family': return new AuthError('FAMILY_INVITATION_FAMILY_INACTIVE', 409);
      case 'stale_authorization': return new AuthError('FAMILY_STALE_AUTHORIZATION', 409);
      case 'child_management': return new AuthError('FAMILY_ADULT_REQUIRED', 403);
      // A non-member and an unknown family must stay indistinguishable to the caller.
      case 'not_member': case 'scope_mismatch': return new AuthError('FAMILY_NOT_FOUND', 404);
      default: return new AuthError('FAMILY_INVITE_FORBIDDEN', 403);
    }
  }
  async function run<T>(work: (client: PoolClient) => Promise<Outcome<T>>): Promise<T> {
    const outcome = await transaction(pool, work);
    if (!outcome.ok) throw new AuthError(outcome.code, outcome.status);
    return outcome.value;
  }
  /**
   * Replay of a create key: the same invitation and the original response, or a stable refusal.
   * The sealed response is only opened and returned while the invitation belongs to this inviter and
   * that inviter still holds the authority it was issued under.
   */
  async function replayCreate(client: PoolClient, record: IdempotencyRow | undefined, inviterId: string,
    now: Date): Promise<Outcome<FamilyInvitationCreated>> {
    if (!record?.resource_id) return refuse('FAMILY_INVITATION_RECOVERY_EXPIRED', 409);
    const invitation = (await client.query<InvitationRow>('SELECT * FROM siyue.family_invitations WHERE id=$1', [record.resource_id])).rows[0];
    // Another inviter's invitation is never reachable through this key, whatever the record says.
    if (!invitation || invitation.inviter_id !== inviterId) return refuse('FAMILY_INVITATION_RECOVERY_EXPIRED', 409);
    if (invitation.status === 'accepted') return refuse('FAMILY_INVITATION_ALREADY_ACCEPTED', 409);
    if (invitation.status === 'revoked') return refuse('FAMILY_INVITATION_REVOKED', 409);
    const usable = invitation.status === 'pending' && +invitation.expires_at > +now;
    const sealed = invitation.token_ciphertext, deadline = invitation.token_ciphertext_expires_at;
    if (!usable || sealed === null || deadline === null || +deadline <= +now) {
      // A closed window destroys the sealed response now instead of waiting for the periodic job.
      if (sealed !== null) await client.query('UPDATE siyue.family_invitations SET token_ciphertext=NULL,token_ciphertext_expires_at=NULL WHERE id=$1', [invitation.id]);
      return usable ? refuse('FAMILY_INVITATION_RECOVERY_EXPIRED', 409) : refuse('FAMILY_INVITATION_EXPIRED', 409);
    }
    // The token stays recoverable for its whole window while authority is unchanged; losing that
    // authority refuses the replay instead of handing back a usable invitation.
    if (await inviterAuthority(client, invitation) !== 'authorized') return refuse('FAMILY_INVITATION_INVITER_INELIGIBLE', 409);
    // Parsing the strict create contract keeps a recovered response identical to a fresh one.
    return pass(familyInvitationCreatedSchema.parse(cipher.open(sealed, responseContext(invitation.id))));
  }

  return {
    /**
     * `POST /v1/families/{id}/invitations` behind a verified adult session: one controlled, one-time
     * 24-hour member invitation. The caller must pass the membership and family versions it last
     * read; a stale version or a lost role is refused before anything is written. The same request
     * key returns the same invitation while its response is recoverable, and a different payload
     * under the same key is a conflict.
     */
    async create(accessToken: string, input: FamilyInvitationCreateInput, requestKey: string): Promise<FamilyInvitationCreated> {
      const parsed = createRequestSchema.safeParse(input);
      if (!parsed.success || !requestKeySchema.safeParse(requestKey).success) throw new AuthError('FAMILY_INVALID_REQUEST', 400);
      const familyId = parsed.data.familyId;
      const intendedEmail = parsed.data.intendedEmail === undefined ? null : normalizeLoginEmail(parsed.data.intendedEmail);
      return run(async client => {
        const session = await sessions.verifyForMutation(client, accessToken);
        if (session.subjectKind !== 'adult') throw new AuthError('FAMILY_ADULT_REQUIRED', 403);
        // The key belongs to one inviter and one family, so another inviter may reuse the same value.
        const scope = createScope(familyId), keyHash = mac('invitation-key', session.subjectId, familyId, requestKey);
        const requestMac = mac('invitation-request', session.subjectId, familyId, intendedEmail,
          parsed.data.expectedMembershipVersion, parsed.data.expectedFamilyVersion);
        await lock(client, scope, keyHash);
        const now = clock();
        const claimed = await claim(client, scope, keyHash, requestMac, now);
        if (claimed.kind === 'conflict') return refuse('FAMILY_INVITATION_CONFLICT', 409);
        // Order: subject/session (verifyForMutation) -> family -> membership, shared with acceptance.
        const family = await lockFamily(client, familyId);
        if (!family) throw new AuthError('FAMILY_NOT_FOUND', 404);
        const membership = (await client.query<MembershipRow>(
          'SELECT family_id,subject_id,role,active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2 FOR UPDATE',
          [familyId, session.subjectId])).rows[0];
        if (!membership || !membership.active) throw new AuthError('FAMILY_NOT_FOUND', 404);
        const snapshot = await families.snapshot(client, session.subjectId, familyId);
        if (!snapshot) throw new AuthError('FAMILY_NOT_FOUND', 404);
        // Existing domain policy decides the invite; the caller's version comes from the request.
        const decision = evaluateFamilyPolicy(snapshot, { kind: 'family', familyId, action: 'invite',
          expectedMembershipVersion: parsed.data.expectedMembershipVersion });
        if (!decision.allowed) throw refusalFor(decision.reason);
        if (family.version !== parsed.data.expectedFamilyVersion) throw new AuthError('FAMILY_STALE_AUTHORIZATION', 409);
        // A previously authorized request must not reveal its sealed bearer token after the
        // inviter has lost the role, membership version or family version that issued it.
        if (claimed.kind === 'replay') return await replayCreate(client, claimed.row, session.subjectId, now);
        const invitationId = randomUUID();
        const token = randomBytes(32).toString('base64url');
        const expiresAt = new Date(+now + familyInvitationTtlMs);
        const created: FamilyInvitationCreated = familyInvitationCreatedSchema.parse({ invitationId, token, expiresAt: expiresAt.toISOString() });
        await client.query(`INSERT INTO siyue.family_invitations(id,family_id,inviter_id,intended_email,token_hash,status,policy_version,
            inviter_membership_version,family_version,token_ciphertext,token_ciphertext_expires_at,expires_at,created_at)
          VALUES($1,$2,$3,$4,$5,'pending',$6,$7,$8,$9,$10,$11,$12)`,
        [invitationId, familyId, session.subjectId, intendedEmail, tokenDigest(token), familyInvitationPolicyVersion,
          membership.version, family.version, cipher.seal(created, responseContext(invitationId)),
          new Date(+now + familyInvitationRecoveryMs), expiresAt, now]);
        // The record points at the invitation; the sealed response lives on the invitation row so
        // acceptance can destroy it. No response ciphertext is duplicated here.
        await client.query(`INSERT INTO siyue.idempotency_records(scope,key_hash,request_mac,subject_id,resource_id,status,expires_at)
          VALUES($1,$2,$3,$4,$5,'complete',$6)`, [scope, keyHash, requestMac, session.subjectId, invitationId, expiresAt]);
        await audit(client, 'family.invitation.create', session.subjectId, session.sessionId,
          `invitation-create:${keyHash}`, 'success', { invitationId }, now);
        return pass(created);
      });
    },

    /**
     * `POST /v1/family-invitations/accept` behind a verified adult session. The invitation row is
     * locked before any state change, so competing claimants cannot both join. A legitimate repeat
     * (same key, same actor) returns the same summary with no second membership; a different key or
     * a different actor is refused instead of silently joining or re-creating memberships.
     */
    async accept(accessToken: string, token: string, requestKey: string): Promise<FamilySummary> {
      if (!familyInvitationTokenSchema.safeParse(token).success || !requestKeySchema.safeParse(requestKey).success) throw new AuthError('FAMILY_INVALID_REQUEST', 400);
      const digest = tokenDigest(token);
      return run<FamilySummary>(async client => {
        const session = await sessions.verifyForMutation(client, accessToken);
        if (session.subjectKind !== 'adult') throw new AuthError('FAMILY_ADULT_REQUIRED', 403);
        const ref = (await client.query<{ id: string }>('SELECT id FROM siyue.family_invitations WHERE token_hash=$1', [digest])).rows[0];
        // An unknown token is the same answer as a token that never existed; nothing is disclosed.
        if (!ref) throw new AuthError('FAMILY_INVITATION_NOT_FOUND', 404);
        const scope = acceptScope(ref.id), keyHash = mac('invitation-accept-key', ref.id, session.subjectId, requestKey);
        const requestMac = mac('invitation-accept-request', ref.id, digest);
        await lock(client, scope, keyHash);
        const now = clock();
        const claimed = await claim(client, scope, keyHash, requestMac, now);
        if (claimed.kind === 'conflict') return refuse('FAMILY_INVITATION_CONFLICT', 409);
        if (claimed.kind === 'replay') {
          const record = claimed.row;
          if (!record.response_ciphertext || !record.response_expires_at || +record.response_expires_at <= +now)
            return refuse('FAMILY_INVITATION_ALREADY_ACCEPTED', 409);
          const cached = familySummarySchema.parse(cipher.open(record.response_ciphertext, idempotencyContext(scope, keyHash)));
          // A repeat never resurrects a membership that was removed or changed in the meantime.
          const current = await readSummary(client, session.subjectId, cached.familyId);
          return current && current.role === cached.role && current.membershipVersion === cached.membershipVersion &&
            current.familyVersion === cached.familyVersion ? pass(current) : refuse('FAMILY_INVITATION_ALREADY_ACCEPTED', 409);
        }
        const invitation = (await client.query<InvitationRow>('SELECT * FROM siyue.family_invitations WHERE id=$1 FOR UPDATE', [ref.id])).rows[0];
        if (!invitation) throw new AuthError('FAMILY_INVITATION_NOT_FOUND', 404);
        if (invitation.status === 'accepted') return refuse('FAMILY_INVITATION_ALREADY_ACCEPTED', 409);
        if (invitation.status === 'revoked') return refuse('FAMILY_INVITATION_REVOKED', 409);
        if (invitation.status === 'expired') return refuse('FAMILY_INVITATION_EXPIRED', 409);
        if (+invitation.expires_at <= +now) {
          // Committed on purpose: the deadline is over, so the token is dead and its recoverable
          // response is destroyed even though the caller only learns that the invitation expired.
          await client.query("UPDATE siyue.family_invitations SET status='expired',token_ciphertext=NULL,token_ciphertext_expires_at=NULL WHERE id=$1 AND status='pending'", [invitation.id]);
          return refuse('FAMILY_INVITATION_EXPIRED', 409);
        }
        // The inviter must still hold the authority and versions the invitation was issued under.
        const authority = await inviterAuthority(client, invitation);
        if (authority === 'missing') throw new AuthError('FAMILY_INVITATION_NOT_FOUND', 404);
        if (authority !== 'authorized') return refuse('FAMILY_INVITATION_INVITER_INELIGIBLE', 409);
        // No self-join and no duplicate member: an existing row is refused even when it is inactive,
        // because re-activating a membership is a separate, separately authorized operation.
        if (session.subjectId === invitation.inviter_id) return refuse('FAMILY_INVITATION_SELF_ACCEPT', 409);
        const existing = (await client.query<MembershipRow>('SELECT family_id,subject_id,role,active,version FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2 FOR UPDATE',
          [invitation.family_id, session.subjectId])).rows[0];
        if (existing) return refuse('FAMILY_ALREADY_MEMBER', 409);
        if (invitation.intended_email !== null) {
          // The acceptor must own that verified login address with a usable password credential.
          // A profile-only address, another subject's address or an address without a password fails.
          const match = (await client.query(`SELECT 1 FROM siyue.account_emails e JOIN siyue.password_credentials c ON c.subject_id=e.subject_id
            WHERE e.subject_id=$1 AND e.email_normalized=$2 AND e.verified_at IS NOT NULL AND e.login_enabled LIMIT 1`,
          [session.subjectId, invitation.intended_email])).rowCount;
          if (!match) {
            await audit(client, 'family.invitation.accept', session.subjectId, session.sessionId,
              `invitation-accept:${keyHash}`, 'rejected', { invitationId: invitation.id, reason: 'target_mismatch' }, now);
            return refuse('FAMILY_INVITATION_TARGET_MISMATCH', 403);
          }
        }
        await client.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role,active,version) VALUES($1,$2,'member',true,1)",
          [invitation.family_id, session.subjectId]);
        await client.query("UPDATE siyue.family_invitations SET status='accepted',accepted_by=$2,accepted_at=$3,token_ciphertext=NULL,token_ciphertext_expires_at=NULL WHERE id=$1",
          [invitation.id, session.subjectId, now]);
        const summary = await readSummary(client, session.subjectId, invitation.family_id);
        // The row was written in this transaction, so a missing summary is a bug and must roll back.
        if (!summary) throw new Error('family_invitation_membership_missing');
        const expires = new Date(+now + familyInvitationTtlMs);
        await client.query(`INSERT INTO siyue.idempotency_records(scope,key_hash,request_mac,subject_id,resource_id,status,response_ciphertext,response_expires_at,expires_at)
          VALUES($1,$2,$3,$4,$5,'complete',$6,$7,$7)`,
        [scope, keyHash, requestMac, session.subjectId, invitation.id, cipher.seal(summary, idempotencyContext(scope, keyHash)), expires]);
        await audit(client, 'family.invitation.accept', session.subjectId, session.sessionId,
          `invitation-accept:${keyHash}`, 'success', { invitationId: invitation.id }, now);
        return pass(summary);
      });
    },

    /**
     * Periodic maintenance, safe on several instances: destroys recoverable responses whose short
     * window closed or whose invitation can no longer be accepted, expires invitations past their
     * deadline, and drops this module's expired idempotency records. Accepted memberships and the
     * invitation history itself are never touched.
     */
    async cleanupExpired(): Promise<void> {
      await transaction(pool, async client => {
        const now = clock();
        await client.query(`UPDATE siyue.family_invitations
             SET token_ciphertext=NULL,token_ciphertext_expires_at=NULL,
                 status=CASE WHEN status='pending' AND expires_at<=$1 THEN 'expired' ELSE status END
           WHERE token_ciphertext IS NOT NULL AND (token_ciphertext_expires_at IS NULL OR token_ciphertext_expires_at<=$1 OR expires_at<=$1)`, [now]);
        await client.query("UPDATE siyue.family_invitations SET status='expired' WHERE status='pending' AND expires_at<=$1", [now]);
        await client.query("DELETE FROM siyue.idempotency_records WHERE expires_at<=$1 AND (scope LIKE 'family-invitation:%' OR scope LIKE 'family-invitation-accept:%')", [now]);
      });
    },
  };
}
export type FamilyInvitationService = ReturnType<typeof createFamilyInvitationService>;
