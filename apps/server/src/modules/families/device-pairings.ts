import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  devicePairingApproveRequestSchema, devicePairingCompleteRequestSchema, devicePairingCompleteResponseSchema,
  devicePairingCreateRequestSchema, devicePairingCreateResponseSchema, devicePairingStatusRequestSchema,
  devicePairingStatusResponseSchema, devicePairingPreviewRequestSchema, devicePairingPreviewResponseSchema,
  type DevicePairingPreviewRequest, type DevicePairingPreviewResponse,
  type DevicePairingApproveRequest, type DevicePairingCompleteRequest,
  type DevicePairingCompleteResponse, type DevicePairingCreateRequest, type DevicePairingCreateResponse,
  type DevicePairingStatus, type DevicePairingStatusRequest, type DevicePairingStatusResponse,
} from '@siyue/contracts';
import { transaction } from '../../adapters/postgres/database.js';
import type { RecoveryCipher } from '../../adapters/crypto/auth-crypto.js';
import { matchesDigest, parseOpaque } from '../../adapters/crypto/auth-crypto.js';
import { AuthError, type SessionService } from '../auth/sessions.js';
import { guardianshipConsentPurpose } from './guardianship.js';

const day = 86_400_000;
/** Design 16.3: the initial pairing window is five minutes and is polled no faster than every three. */
export const childDevicePairingTtlMs = 5 * 60_000;
export const childDevicePairingPollIntervalMs = 3_000;
/** Design 16.3: a grant is bounded to 30 days and a child refresh never outlives it. */
export const childDeviceGrantTtlMs = 30 * day;
/** Same-request recovery for one lost completion response, matching the refresh rotation window. */
export const childDevicePairingRecoveryMs = 60_000;
/** Audit rows are short-lived operational evidence; grants and pairing history are kept. */
const auditRetentionMs = 30 * day;
/**
 * Phase-one grant scopes (design 16.3): a grant is limited to invited rooms, authorized boards and the
 * personal operations it needs, and none of those layers is wired yet. The reviewed 0011 migration
 * accepts an empty array, so a fresh grant carries no capability at all rather than a placeholder name
 * that a later authorization check could mistake for a real scope.
 */
export const childDeviceGrantScopes: readonly string[] = [];

/**
 * A pairing refusal carries a stable public code. A throttled poll additionally carries how long the
 * caller must wait, so the route can answer with an honest `Retry-After` without leaking pairing state.
 */
export class ChildDevicePairingError extends AuthError {
  constructor(code: string, status: number, readonly retryAfterSeconds?: number) { super(code, status); }
}

/** Anonymous context: the caller has no session, so only its address and request id identify the call. */
export interface ChildDevicePairingCaller { ip: string; requestId: string; }

interface PairingRow {
  id: string; installation_id: string; platform: string | null; device_label: string | null;
  status: 'pending' | 'approved' | 'consumed' | 'expired';
  approved_by: string | null; child_subject_id: string | null; family_id: string | null;
  approved_guardian_version: number | null; approved_credential_version: number | null;
  created_at: Date; expires_at: Date; approved_at: Date | null; consumed_at: Date | null;
}
interface GuardianRow {
  family_id: string; relationship_version: number; guardian_credential_version: number; child_display_name: string;
}
interface CompleteRecordRow { resource_id: string | null; response_ciphertext: string | null; response_expires_at: Date | null; }
interface Budget { label: string; maximum: number; windowMs: number; }

/**
 * Refusals are values inside the transaction, so the audit row and the rate-limit budget a refusal
 * consumes survive it. Throwing inside the transaction would roll both back and let a refused caller
 * retry for free.
 */
type Outcome<T> = { ok: true; value: T } | { ok: false; code: string; status: number; retryAfterSeconds?: number };
const pass = <T>(value: T): Outcome<T> => ({ ok: true, value });
const refuse = (code: string, status: number, retryAfterSeconds?: number): Outcome<never> =>
  retryAfterSeconds === undefined ? { ok: false, code, status } : { ok: false, code, status, retryAfterSeconds };

const idSchema = z.uuid();
const requestIdSchema = z.string().min(1).max(200);
const addressSchema = z.string().min(1).max(64);

/**
 * Child-device pairing service (SA-08 9.3, design 16.3/16.4, `device_pairing_requests`/`device_grants`).
 *
 * A child device that holds no adult credential starts a five-minute pending request and receives two
 * independent 32-byte base64url secrets: a `requestToken` the guardian can read from a QR code, and a
 * `pollSecret` that never leaves the initiating device. Only keyed HMAC digests of both reach the
 * database, they are never equal, and neither one is a credential by itself. A guardian approves with a
 * verified adult session, a current guardian relationship at the version it last read and a single-use
 * `approve-child-device` reauth grant; the request records the approving adult, target child and family.
 * The initiating device then consumes the request once with its own poll secret, and the same
 * transaction creates the 30-day device grant and the restricted child session. No path hands a child
 * device a guardian access or refresh token, and no read path returns adult identity: status is the
 * lifecycle plus the deadline, a guardian's preview is the device description, the deadline and the
 * intended child, and completion is the child session plus the grant id.
 */
export function createChildDevicePairingService(pool: Pool, sessions: SessionService, cipher: RecoveryCipher,
  pepper: Buffer, clock: () => Date = () => new Date()) {
  if (pepper.length !== 32) throw new Error('invalid_pepper');
  /** Domain-separated keyed digests. Raw secrets, addresses and identifiers never reach a column. */
  const mac = (label: string, ...parts: unknown[]) => createHmac('sha256', pepper).update(JSON.stringify([label, ...parts])).digest('hex');
  const requestTokenDigest = (token: string) => mac('child-device-request-token', token);
  const pollSecretDigest = (secret: string) => mac('child-device-poll-secret', secret);
  const completeScope = (pairingId: string) => `child-device-pairing-complete:${pairingId}`;
  const completeContext = (pairingId: string) => `child-device-pairing:${pairingId}`;
  const createBudgets = (ip: string, installationId: string): Budget[] => [
    { label: 'create:global', maximum: 60, windowMs: 60_000 },
    { label: `create:ip:${ip}`, maximum: 5, windowMs: 60_000 },
    { label: `create:installation:${installationId}`, maximum: 3, windowMs: 300_000 },
  ];
  const statusBudgets = (ip: string): Budget[] => [
    { label: 'status:global', maximum: 300, windowMs: 60_000 },
    { label: `status:ip:${ip}`, maximum: 120, windowMs: 60_000 },
  ];
  const completeBudgets = (ip: string): Budget[] => [
    { label: 'complete:global', maximum: 120, windowMs: 60_000 },
    { label: `complete:ip:${ip}`, maximum: 30, windowMs: 60_000 },
  ];
  /** Caller identity for an anonymous request, validated before it is hashed into a bucket key. */
  function callerOf(caller: ChildDevicePairingCaller): ChildDevicePairingCaller {
    if (!addressSchema.safeParse(caller?.ip).success || !requestIdSchema.safeParse(caller?.requestId).success)
      throw new ChildDevicePairingError('CHILD_DEVICE_PAIRING_INVALID_REQUEST', 400);
    return caller;
  }
  /** One account-wide advisory namespace: identical retries serialize here instead of racing a read. */
  async function lock(client: PoolClient, label: string, ...parts: unknown[]) {
    const derived = mac('child-device-advisory-lock', label, ...parts);
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [BigInt.asIntN(64, BigInt(`0x${derived.slice(0, 16)}`)).toString()]);
  }
  /** Minimal audit trail: who acted, from which session, and which request. Never a secret. */
  async function audit(client: PoolClient, event: string, requestId: string, outcome: string,
    metadata: { pairingId?: string; reason?: string; subjectId?: string; sessionId?: string }, now: Date) {
    await client.query(`INSERT INTO siyue.security_events(id,event_type,subject_id,session_id,request_id,outcome,redacted_metadata,occurred_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,jsonb_strip_nulls(jsonb_build_object('pairingId',$7::uuid,'reason',$8::text)),$9,$10)`,
    [randomUUID(), event, metadata.subjectId ?? null, metadata.sessionId ?? null, requestId, outcome,
      metadata.pairingId ?? null, metadata.reason ?? null, now, new Date(+now + auditRetentionMs)]);
  }
  /**
   * Fixed-window budget in the shared rate-limit table, matching the existing provider gate: keys are
   * keyed digests, refusals consume budget too, and every window is read in a stable order.
   */
  async function admit(client: PoolClient, budget: Budget, now: Date): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const start = new Date(Math.floor(+now / budget.windowMs) * budget.windowMs);
    const expires = new Date(+start + budget.windowMs);
    const row = (await client.query<{ count: number }>(`INSERT INTO siyue.rate_limit_buckets(bucket_key_hash,window_start,count,expires_at)
      VALUES($1,$2,1,$3) ON CONFLICT(bucket_key_hash,window_start)
      DO UPDATE SET count=LEAST(siyue.rate_limit_buckets.count+1,1000000),expires_at=$3 RETURNING count`,
    [mac('child-device-rate', budget.label), start, expires])).rows[0]!;
    return { allowed: row.count <= budget.maximum, retryAfterSeconds: Math.max(1, Math.ceil((+expires - +now) / 1000)) };
  }
  async function admitAll(client: PoolClient, budgets: Budget[], now: Date) {
    let verdict = { allowed: true, retryAfterSeconds: 1 };
    for (const budget of budgets) {
      const result = await admit(client, budget, now);
      if (!result.allowed && verdict.allowed) verdict = result;
    }
    return verdict;
  }
  /**
   * The initiating device may read or claim its pending request at most once per three seconds
   * (design 16.3). An expired throttle row is dropped first, so one live row per pairing is the
   * invariant and the refusal can state the remaining wait without disclosing any pairing state.
   */
  async function pacePoll(client: PoolClient, pairingId: string, now: Date) {
    const key = mac('child-device-poll-pace', pairingId);
    await lock(client, 'poll-pace', pairingId);
    await client.query('DELETE FROM siyue.rate_limit_buckets WHERE bucket_key_hash=$1 AND expires_at<=$2', [key, now]);
    const live = (await client.query<{ expires_at: Date }>(
      'SELECT expires_at FROM siyue.rate_limit_buckets WHERE bucket_key_hash=$1 ORDER BY expires_at DESC LIMIT 1', [key])).rows[0];
    if (live && +live.expires_at > +now)
      return { allowed: false as const, retryAfterSeconds: Math.max(1, Math.ceil((+live.expires_at - +now) / 1000)) };
    await client.query(`INSERT INTO siyue.rate_limit_buckets(bucket_key_hash,window_start,count,expires_at) VALUES($1,$2,1,$3)
      ON CONFLICT(bucket_key_hash,window_start) DO UPDATE SET count=siyue.rate_limit_buckets.count+1,expires_at=$3`,
    [key, now, new Date(+now + childDevicePairingPollIntervalMs)]);
    return { allowed: true as const, retryAfterSeconds: 0 };
  }
  /**
   * Live guardianship as the database sees it now: an active relationship whose consent is not
   * withdrawn, an active family, an active child subject that is a member of that family, and an active
   * adult guardian who is also still a member. The consent is bound, not merely present: it has to be
   * the relationship's own record, recorded by this guardian about this child for the guardianship
   * purpose. A missing part hides the whole relationship, so a refused pairing is never explained by
   * which part is gone and no unrelated consent record can authorize a device.
   */
  async function liveGuardianship(client: PoolClient, familyId: string | null, guardianId: string, childId: string): Promise<GuardianRow[]> {
    return (await client.query<GuardianRow>(`SELECT r.family_id,r.version AS relationship_version,
        guardian.credential_version AS guardian_credential_version,child.display_name AS child_display_name
      FROM siyue.guardian_relationships r
        JOIN siyue.consent_records c ON c.id=r.consent_record_id
          AND c.actor_subject_id=r.guardian_subject_id AND c.subject_id=r.child_subject_id
          AND c.purpose=$4 AND c.withdrawn_at IS NULL
        JOIN siyue.families f ON f.id=r.family_id
        JOIN siyue.subjects child ON child.id=r.child_subject_id
        JOIN siyue.subjects guardian ON guardian.id=r.guardian_subject_id
        JOIN siyue.family_memberships guardian_member ON guardian_member.family_id=r.family_id AND guardian_member.subject_id=r.guardian_subject_id
        JOIN siyue.family_memberships child_member ON child_member.family_id=r.family_id AND child_member.subject_id=r.child_subject_id
      WHERE r.guardian_subject_id=$1 AND r.child_subject_id=$2 AND ($3::uuid IS NULL OR r.family_id=$3)
        AND r.active AND f.status='active'
        AND child.kind='child' AND child.status='active' AND guardian.kind='adult' AND guardian.status='active'
        AND guardian_member.active AND child_member.active
      ORDER BY r.family_id FOR UPDATE OF r`, [guardianId, childId, familyId, guardianshipConsentPurpose])).rows;
  }
  /** A terminal pairing is reported as it stands: consumption is the stronger, more specific fact. */
  const statusOf = (row: PairingRow, now: Date): DevicePairingStatus =>
    row.status === 'consumed' ? 'consumed' : row.status === 'expired' ? 'expired'
      : +row.expires_at <= +now ? 'expired' : row.status;
  /**
   * Expiry is committed as state instead of only being derived, so a later cheap read cannot report a
   * request as pending once its window closed. A consumed request keeps its consumption.
   */
  async function expire(client: PoolClient, pairingId: string) {
    await client.query("UPDATE siyue.device_pairing_requests SET status='expired' WHERE id=$1 AND status IN ('pending','approved')", [pairingId]);
  }
  const statusResponse = (status: DevicePairingStatus, expiresAt: Date): DevicePairingStatusResponse =>
    devicePairingStatusResponseSchema.parse({ status, expiresAt: expiresAt.toISOString() });
  /**
   * Controlled recovery of one completed request: the same poll secret gets the same sealed response
   * while its window is open, but only while the grant it describes is still live and the guardianship
   * behind it still holds. A revoked grant, an expired relationship or a closed window refuses instead
   * of repeating credentials that no longer work.
   */
  async function recover(client: PoolClient, row: PairingRow, digest: string, caller: ChildDevicePairingCaller, now: Date)
    : Promise<Outcome<DevicePairingCompleteResponse>> {
    const record = (await client.query<CompleteRecordRow>(
      'SELECT resource_id,response_ciphertext,response_expires_at FROM siyue.idempotency_records WHERE scope=$1 AND key_hash=$2',
      [completeScope(row.id), digest])).rows[0];
    const sealed = record?.response_ciphertext, deadline = record?.response_expires_at, grantId = record?.resource_id;
    if (!grantId || !sealed || !deadline || +deadline <= +now) {
      await audit(client, 'child.device.pairing.complete', caller.requestId, 'rejected',
        { pairingId: row.id, reason: 'recovery_window_closed' }, now);
      return refuse('CHILD_DEVICE_PAIRING_CONSUMED', 409);
    }
    const grant = (await client.query<{guardian_relationship_version:number;guardian_credential_version:number}>(
      'SELECT guardian_relationship_version,guardian_credential_version FROM siyue.device_grants WHERE id=$1 AND revoked_at IS NULL AND expires_at>$2',
      [grantId, now])).rows[0];
    if (!grant) {
      await audit(client, 'child.device.pairing.complete', caller.requestId, 'rejected',
        { pairingId: row.id, reason: 'grant_not_live' }, now);
      return refuse('CHILD_DEVICE_PAIRING_CONSUMED', 409);
    }
    if (!row.family_id || !row.approved_by || !row.child_subject_id) throw new Error('child_device_pairing_state_invalid');
    const guardianship = (await liveGuardianship(client, row.family_id, row.approved_by, row.child_subject_id))[0];
    if (!guardianship || guardianship.relationship_version !== grant.guardian_relationship_version ||
        guardianship.guardian_credential_version !== grant.guardian_credential_version) {
      await audit(client, 'child.device.pairing.complete', caller.requestId, 'rejected',
        { pairingId: row.id, reason: 'guardian_ineligible' }, now);
      return refuse('CHILD_DEVICE_PAIRING_GUARDIAN_INELIGIBLE', 409);
    }
    const response = devicePairingCompleteResponseSchema.parse(cipher.open(sealed, completeContext(row.id)));
    // A sealed retry response is not a licence to resurrect a logged-out or already-rotated refresh
    // credential. Verify the exact original session and refresh proof before returning it again.
    const proof = parseOpaque(response.sessionTokens.refreshToken);
    const current = (await client.query<{secret_hash:string}>(`SELECT rt.secret_hash FROM siyue.auth_sessions s
      JOIN siyue.subjects child ON child.id=s.subject_id
      JOIN siyue.refresh_tokens rt ON rt.session_id=s.id AND rt.id=$2
      WHERE s.id=$1 AND s.device_grant_id=$3 AND s.subject_id=$4 AND s.auth_method='child'
        AND s.revoked_at IS NULL AND s.credential_version=child.credential_version
        AND s.idle_expires_at>$5 AND s.absolute_expires_at>$5 AND s.grant_expires_at>$5
        AND rt.used_at IS NULL AND rt.revoked_at IS NULL AND rt.expires_at>$5`,
    [response.sessionTokens.session.sessionId, proof.id, grantId, row.child_subject_id, now])).rows[0];
    if (response.deviceGrantId !== grantId || !current || !matchesDigest(proof.secret, current.secret_hash)) {
      await audit(client, 'child.device.pairing.complete', caller.requestId, 'rejected',
        { pairingId: row.id, reason: 'session_not_recoverable' }, now);
      return refuse('CHILD_DEVICE_PAIRING_CONSUMED', 409);
    }
    await audit(client, 'child.device.pairing.complete', caller.requestId, 'recovered', { pairingId: row.id }, now);
    return pass(response);
  }

  async function run<T>(work: (client: PoolClient) => Promise<Outcome<T>>): Promise<T> {
    const outcome = await transaction(pool, work);
    if (!outcome.ok) throw new ChildDevicePairingError(outcome.code, outcome.status, outcome.retryAfterSeconds);
    return outcome.value;
  }

  return {
    /**
     * `POST /v1/device-pairings` without any session: one strongly rate-limited pending request. The two
     * secrets are generated here, only their keyed digests are stored, and the response is the only place
     * the child device ever sees them. Extra or adult-shaped input is refused by the strict contract.
     */
    async create(input: DevicePairingCreateRequest, caller: ChildDevicePairingCaller): Promise<DevicePairingCreateResponse> {
      const context = callerOf(caller);
      const parsed = devicePairingCreateRequestSchema.safeParse(input);
      if (!parsed.success) throw new ChildDevicePairingError('CHILD_DEVICE_PAIRING_INVALID_REQUEST', 400);
      const requestToken = randomBytes(32).toString('base64url'), pollSecret = randomBytes(32).toString('base64url');
      return run(async client => {
        const now = clock();
        const verdict = await admitAll(client, createBudgets(context.ip, parsed.data.installationId), now);
        if (!verdict.allowed) {
          await audit(client, 'child.device.pairing.create', context.requestId, 'rate_limited', {}, now);
          return refuse('CHILD_DEVICE_PAIRING_RATE_LIMITED', 429, verdict.retryAfterSeconds);
        }
        const pairingId = randomUUID(), expiresAt = new Date(+now + childDevicePairingTtlMs);
        await client.query(`INSERT INTO siyue.device_pairing_requests(id,request_token_hash,poll_secret_hash,installation_id,
            platform,device_label,status,created_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8)`,
        [pairingId, requestTokenDigest(requestToken), pollSecretDigest(pollSecret), parsed.data.installationId,
          parsed.data.platform, parsed.data.deviceLabel ?? null, now, expiresAt]);
        await audit(client, 'child.device.pairing.create', context.requestId, 'success', { pairingId }, now);
        return pass(devicePairingCreateResponseSchema.parse({ pairingId, requestToken, pollSecret, expiresAt: expiresAt.toISOString() }));
      });
    },

    /**
     * `POST /v1/device-pairings/{id}/status` with the initiating device's own poll secret. The answer is
     * the lifecycle and the deadline and nothing else: no approving adult, no child subject, no family and
     * no approval detail. Polls closer than three seconds are refused before any state is disclosed.
     */
    async status(pairingId: string, input: DevicePairingStatusRequest, caller: ChildDevicePairingCaller): Promise<DevicePairingStatusResponse> {
      const context = callerOf(caller);
      const id = idSchema.safeParse(pairingId), parsed = devicePairingStatusRequestSchema.safeParse(input);
      if (!id.success || !parsed.success) throw new ChildDevicePairingError('CHILD_DEVICE_PAIRING_INVALID_REQUEST', 400);
      const digest = pollSecretDigest(parsed.data.pollSecret);
      return run(async client => {
        const now = clock();
        const row = (await client.query<PairingRow>('SELECT * FROM siyue.device_pairing_requests WHERE id=$1 AND poll_secret_hash=$2',
          [id.data, digest])).rows[0];
        // The budget is charged even when the secret is wrong, so a wrong secret cannot be used to poll
        // for free; the row lookup still comes first, so only the secret holder can spend the pace budget.
        const admission = await admitAll(client, statusBudgets(context.ip), now);
        if (!admission.allowed) {
          await audit(client, 'child.device.pairing.status', context.requestId, 'rate_limited',
            { ...(row ? { pairingId: row.id } : {}) }, now);
          return refuse('CHILD_DEVICE_PAIRING_RATE_LIMITED', 429, admission.retryAfterSeconds);
        }
        // An unknown id and a wrong secret share one answer, so status cannot be used to confirm pairing ids.
        if (!row) return refuse('CHILD_DEVICE_PAIRING_NOT_FOUND', 404);
        const pace = await pacePoll(client, row.id, now);
        if (!pace.allowed)
          return refuse('CHILD_DEVICE_PAIRING_POLL_TOO_SOON', 429, pace.retryAfterSeconds);
        const status = statusOf(row, now);
        if (status === 'expired' && row.status !== 'expired') await expire(client, row.id);
        return pass(statusResponse(status, row.expires_at));
      });
    },

    /**
     * `POST /v1/device-pairings/{id}/preview` behind an adult session that is a current guardian of the
     * named child (design 16.3: the guardian scans the request and sees the requesting device and the
     * child that would be authorized). The preview is a read, so it needs no reauth grant, spends none
     * and changes no state. The answer is the device's own description, the deadline and the child's
     * minimal summary; the approving adult, the family and every secret stay out of it, including the
     * `pollSecret`, which only the initiating device may ever hold.
     */
    async preview(accessToken: string, pairingId: string, input: DevicePairingPreviewRequest, requestId: string)
      : Promise<DevicePairingPreviewResponse> {
      const id = idSchema.safeParse(pairingId), parsed = devicePairingPreviewRequestSchema.safeParse(input);
      if (!id.success || !parsed.success || !requestIdSchema.safeParse(requestId).success)
        throw new ChildDevicePairingError('CHILD_DEVICE_PAIRING_INVALID_REQUEST', 400);
      const digest = requestTokenDigest(parsed.data.requestToken);
      return run(async client => {
        const session = await sessions.verifyForMutation(client, accessToken);
        if (session.subjectKind !== 'adult') throw new ChildDevicePairingError('CHILD_DEVICE_PAIRING_GUARDIAN_REQUIRED', 403);
        const now = clock();
        const row = (await client.query<PairingRow>('SELECT * FROM siyue.device_pairing_requests WHERE request_token_hash=$1 FOR UPDATE',
          [digest])).rows[0];
        // The token lookup comes first and answers an unknown token and a real token under another path id
        // with one 404, so a stranger's refusal never distinguishes the two.
        if (!row || row.id !== id.data) return refuse('CHILD_DEVICE_PAIRING_NOT_FOUND', 404);
        if (row.status === 'consumed') return refuse('CHILD_DEVICE_PAIRING_NOT_PENDING', 409);
        if (row.status === 'expired' || +row.expires_at <= +now) {
          if (row.status !== 'expired') await expire(client, row.id);
          return refuse('CHILD_DEVICE_PAIRING_EXPIRED', 409);
        }
        const guardianships = await liveGuardianship(client, null, session.subjectId, parsed.data.childSubjectId);
        if (guardianships.length === 0) {
          await audit(client, 'child.device.pairing.preview', requestId, 'rejected',
            { pairingId: row.id, reason: 'guardian_required', subjectId: session.subjectId, sessionId: session.sessionId }, now);
          return refuse('CHILD_DEVICE_PAIRING_GUARDIAN_REQUIRED', 403);
        }
        // The same ambiguity approval refuses: one child in two families under this guardian has no single
        // target family, so the preview must not show a child that could not be approved on this request.
        if (guardianships.length > 1) {
          await audit(client, 'child.device.pairing.preview', requestId, 'rejected',
            { pairingId: row.id, reason: 'ambiguous_guardianship', subjectId: session.subjectId, sessionId: session.sessionId }, now);
          return refuse('CHILD_DEVICE_PAIRING_CONFLICT', 409);
        }
        if (row.platform === null) throw new Error('child_device_pairing_state_invalid');
        // Reading its own pending request is not an act on data, so a successful preview stays out of the
        // audit ledger; only a refused relationship is recorded there.
        return pass(devicePairingPreviewResponseSchema.parse({
          deviceLabel: row.device_label, platform: row.platform, expiresAt: row.expires_at.toISOString(),
          child: { childSubjectId: parsed.data.childSubjectId, displayName: guardianships[0]!.child_display_name },
        }));
      });
    },

    /**
     * `POST /v1/device-pairings/{id}/approve` behind an adult session that is a current guardian of the
     * named child, at the relationship version the caller last read, proven again by a single-use
     * `approve-child-device` reauth grant. Approval only records the approving adult, the child and the
     * family on the request: no grant and no session exist before the child claims the result itself.
     */
    async approve(accessToken: string, pairingId: string, input: DevicePairingApproveRequest, requestId: string)
      : Promise<DevicePairingStatusResponse> {
      const id = idSchema.safeParse(pairingId), parsed = devicePairingApproveRequestSchema.safeParse(input);
      if (!id.success || !parsed.success || !requestIdSchema.safeParse(requestId).success)
        throw new ChildDevicePairingError('CHILD_DEVICE_PAIRING_INVALID_REQUEST', 400);
      const digest = requestTokenDigest(parsed.data.requestToken);
      return run(async client => {
        // Subject/session locks come from the session service, so approval never trusts a client identity.
        const session = await sessions.verifyForMutation(client, accessToken);
        if (session.subjectKind !== 'adult') throw new ChildDevicePairingError('CHILD_DEVICE_PAIRING_GUARDIAN_REQUIRED', 403);
        const now = clock();
        const row = (await client.query<PairingRow>('SELECT * FROM siyue.device_pairing_requests WHERE request_token_hash=$1 FOR UPDATE',
          [digest])).rows[0];
        // The request token is only known from the pairing ceremony, so a mismatch is not a search oracle.
        if (!row || row.id !== id.data) return refuse('CHILD_DEVICE_PAIRING_NOT_FOUND', 404);
        if (row.status === 'expired' || +row.expires_at <= +now) {
          if (row.status !== 'expired' && row.status !== 'consumed') await expire(client, row.id);
          return refuse('CHILD_DEVICE_PAIRING_EXPIRED', 409);
        }
        if (row.status === 'approved' && row.approved_by === session.subjectId &&
            row.child_subject_id === parsed.data.childSubjectId) {
          // Same guardian, same child, same request: a repeat confirms the recorded approval but still has
          // to prove the action again, so a replayed request cannot skip the reverification.
          const current = row.family_id && (await liveGuardianship(client, row.family_id, session.subjectId, parsed.data.childSubjectId))[0];
          if (!current || current.relationship_version !== row.approved_guardian_version ||
              current.guardian_credential_version !== row.approved_credential_version ||
              current.relationship_version !== parsed.data.expectedGuardianVersion)
            return refuse('CHILD_DEVICE_PAIRING_GUARDIAN_INELIGIBLE', 409);
          await sessions.consumeReauth(client, session.sessionId, parsed.data.reauthGrant, 'approve-child-device');
          return pass(statusResponse('approved', row.expires_at));
        }
        if (row.status !== 'pending') {
          return refuse('CHILD_DEVICE_PAIRING_NOT_PENDING', 409);
        }
        const guardianships = await liveGuardianship(client, null, session.subjectId, parsed.data.childSubjectId);
        if (guardianships.length === 0) {
          await audit(client, 'child.device.pairing.approve', requestId, 'rejected',
            { pairingId: row.id, reason: 'guardian_required', subjectId: session.subjectId, sessionId: session.sessionId }, now);
          return refuse('CHILD_DEVICE_PAIRING_GUARDIAN_REQUIRED', 403);
        }
        // One child in two families under the same guardian would make the target family ambiguous, and
        // the approve contract carries no family, so the request is refused instead of guessed.
        if (guardianships.length > 1) {
          await audit(client, 'child.device.pairing.approve', requestId, 'rejected',
            { pairingId: row.id, reason: 'ambiguous_guardianship', subjectId: session.subjectId, sessionId: session.sessionId }, now);
          return refuse('CHILD_DEVICE_PAIRING_CONFLICT', 409);
        }
        const guardianship = guardianships[0]!;
        if (guardianship.relationship_version !== parsed.data.expectedGuardianVersion) {
          await audit(client, 'child.device.pairing.approve', requestId, 'rejected',
            { pairingId: row.id, reason: 'stale_guardian_version', subjectId: session.subjectId, sessionId: session.sessionId }, now);
          return refuse('CHILD_DEVICE_PAIRING_STALE_GUARDIAN_VERSION', 409);
        }
        await sessions.consumeReauth(client, session.sessionId, parsed.data.reauthGrant, 'approve-child-device');
        const approved = await client.query(`UPDATE siyue.device_pairing_requests
          SET status='approved',approved_by=$2,child_subject_id=$3,family_id=$4,approved_at=$5,
              approved_guardian_version=$6,approved_credential_version=$7 WHERE id=$1 AND status='pending'`,
        [row.id, session.subjectId, parsed.data.childSubjectId, guardianship.family_id, now,
          guardianship.relationship_version, guardianship.guardian_credential_version]);
        if (approved.rowCount !== 1) throw new Error('child_device_pairing_approval_conflict');
        await audit(client, 'child.device.pairing.approve', requestId, 'success',
          { pairingId: row.id, subjectId: session.subjectId, sessionId: session.sessionId }, now);
        return pass(statusResponse('approved', row.expires_at));
      });
    },

    /**
     * `POST /v1/device-pairings/{id}/complete` with the initiating device's own poll secret. One
     * consumption creates the bounded device grant and the restricted child session in this transaction;
     * a concurrent or repeated claim returns that same result for the short recovery window, or is
     * refused. The response carries the child session and the grant id, never a guardian credential.
     */
    async complete(pairingId: string, input: DevicePairingCompleteRequest, caller: ChildDevicePairingCaller)
      : Promise<DevicePairingCompleteResponse> {
      const context = callerOf(caller);
      const id = idSchema.safeParse(pairingId), parsed = devicePairingCompleteRequestSchema.safeParse(input);
      if (!id.success || !parsed.success) throw new ChildDevicePairingError('CHILD_DEVICE_PAIRING_INVALID_REQUEST', 400);
      const digest = pollSecretDigest(parsed.data.pollSecret);
      return run(async client => {
        const now = clock();
        const admission = await admitAll(client, completeBudgets(context.ip), now);
        if (!admission.allowed) {
          await audit(client, 'child.device.pairing.complete', context.requestId, 'rate_limited', {}, now);
          return refuse('CHILD_DEVICE_PAIRING_RATE_LIMITED', 429, admission.retryAfterSeconds);
        }
        // Locking the request before deciding makes competing claims strictly sequential: the loser reads
        // the committed consumption instead of creating a second grant.
        const row = (await client.query<PairingRow>('SELECT * FROM siyue.device_pairing_requests WHERE id=$1 AND poll_secret_hash=$2 FOR UPDATE',
          [id.data, digest])).rows[0];
        if (!row) return refuse('CHILD_DEVICE_PAIRING_NOT_FOUND', 404);
        if (row.status === 'consumed') return await recover(client, row, digest, context, now);
        if (row.status === 'expired' || +row.expires_at <= +now) {
          if (row.status !== 'expired') await expire(client, row.id);
          return refuse('CHILD_DEVICE_PAIRING_EXPIRED', 409);
        }
        if (row.status !== 'approved') return refuse('CHILD_DEVICE_PAIRING_NOT_APPROVED', 409);
        if (!row.family_id || !row.approved_by || !row.child_subject_id || row.platform === null)
          throw new Error('child_device_pairing_state_invalid');
        const guardianships = await liveGuardianship(client, row.family_id, row.approved_by, row.child_subject_id);
        if (guardianships.length !== 1 || guardianships[0]!.relationship_version !== row.approved_guardian_version ||
            guardianships[0]!.guardian_credential_version !== row.approved_credential_version)
          return refuse('CHILD_DEVICE_PAIRING_GUARDIAN_INELIGIBLE', 409);
        const guardianship = guardianships[0]!;
        const grantId = randomUUID(), expiresAt = new Date(+now + childDeviceGrantTtlMs);
        await client.query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,platform,
            device_label,guardian_relationship_version,guardian_credential_version,scopes,version,created_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12)`,
        [grantId, row.child_subject_id, row.approved_by, row.family_id, row.installation_id, row.platform,
          row.device_label, guardianship.relationship_version, guardianship.guardian_credential_version,
          [...childDeviceGrantScopes], now, expiresAt]);
        const sessionTokens = await sessions.issueChild(client, grantId);
        const response = devicePairingCompleteResponseSchema.parse({ sessionTokens, deviceGrantId: grantId });
        const consumed = await client.query("UPDATE siyue.device_pairing_requests SET status='consumed',consumed_at=$2 WHERE id=$1 AND status='approved'",
          [row.id, now]);
        if (consumed.rowCount !== 1) throw new Error('child_device_pairing_consumption_conflict');
        await client.query(`INSERT INTO siyue.idempotency_records(scope,key_hash,request_mac,subject_id,resource_id,status,
            response_ciphertext,response_expires_at,expires_at)
          VALUES($1,$2,$3,$4,$5,'complete',$6,$7,$7)`,
        [completeScope(row.id), digest, mac('child-device-complete-request', row.id), row.child_subject_id, grantId,
          cipher.seal(response, completeContext(row.id)), new Date(+now + childDevicePairingRecoveryMs)]);
        await audit(client, 'child.device.pairing.complete', context.requestId, 'success', { pairingId: row.id }, now);
        return pass(response);
      });
    },

    /**
     * Periodic maintenance, safe on several instances: closes pairing requests past their deadline and
     * drops this module's closed recovery windows and expired rate-limit rows. Grants, sessions and
     * pairing history are never touched.
     */
    async cleanupExpired(): Promise<void> {
      await transaction(pool, async client => {
        const now = clock();
        await client.query("UPDATE siyue.device_pairing_requests SET status='expired' WHERE status IN ('pending','approved') AND expires_at<=$1", [now]);
        await client.query("DELETE FROM siyue.idempotency_records WHERE expires_at<=$1 AND scope LIKE 'child-device-pairing-complete:%'", [now]);
        await client.query('DELETE FROM siyue.rate_limit_buckets WHERE expires_at<=$1', [now]);
      });
    },
  };
}
export type ChildDevicePairingService = ReturnType<typeof createChildDevicePairingService>;
