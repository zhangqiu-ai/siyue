import {
  anchoredOfflineLeaseSchema,
  offlineLeaseAccessRequestSchema,
  offlineLeaseClockSchema,
  verifiedOfflineLeaseGrantSchema,
  type AnchoredOfflineLease,
  type OfflineLeaseAccessRequest,
  type OfflineLeaseClock,
} from '@siyue/contracts';

export type OfflineLeaseDenial =
  | 'invalid_input'
  | 'scope_mismatch'
  | 'stale_authorization'
  | 'permission_denied'
  | 'revoked'
  | 'untrusted_clock'
  | 'expired';

export type OfflineLeaseDecision = {allowed: true} | {allowed: false; reason: OfflineLeaseDenial};

const scopeKeys = ['subjectId', 'deviceId', 'familyId', 'sourceSpaceId', 'recordId'] as const;

/** Anchors an already verified server grant to a host-provided elapsed realtime and boot identity. */
export function anchorOfflineLease(grantInput: unknown, clockInput: unknown): AnchoredOfflineLease {
  const grant = verifiedOfflineLeaseGrantSchema.safeParse(grantInput);
  const clock = offlineLeaseClockSchema.safeParse(clockInput);
  if (!grant.success || !clock.success) throw new Error('invalid_offline_lease');
  const remainingMs = Date.parse(grant.data.expiresAt) - Date.parse(grant.data.serverNow);
  return Object.freeze({
    subjectId: grant.data.subjectId,
    deviceId: grant.data.deviceId,
    familyId: grant.data.familyId,
    sourceSpaceId: grant.data.sourceSpaceId,
    recordId: grant.data.recordId,
    membershipVersion: grant.data.membershipVersion,
    grantVersion: grant.data.grantVersion,
    permission: grant.data.permission,
    bootId: clock.data.bootId,
    anchorElapsedRealtimeMs: clock.data.elapsedRealtimeMs,
    remainingMs,
  });
}

/** Local eligibility only. It never verifies signatures and never authorizes an upload. */
export function evaluateOfflineLease(
  leaseInput: unknown,
  requestInput: unknown,
  clockInput: unknown,
  options: {knownRevoked?: boolean} = {},
): OfflineLeaseDecision {
  const lease = anchoredOfflineLeaseSchema.safeParse(leaseInput);
  const request = offlineLeaseAccessRequestSchema.safeParse(requestInput);
  const clock = offlineLeaseClockSchema.safeParse(clockInput);
  if (!lease.success || !request.success || !clock.success) return {allowed: false, reason: 'invalid_input'};
  if (scopeKeys.some((key) => lease.data[key] !== request.data[key])) return {allowed: false, reason: 'scope_mismatch'};
  if (lease.data.membershipVersion !== request.data.membershipVersion || lease.data.grantVersion !== request.data.grantVersion) {
    return {allowed: false, reason: 'stale_authorization'};
  }
  if (options.knownRevoked) return {allowed: false, reason: 'revoked'};
  if (request.data.action === 'edit' && lease.data.permission !== 'edit') return {allowed: false, reason: 'permission_denied'};
  if (lease.data.bootId !== clock.data.bootId || clock.data.elapsedRealtimeMs < lease.data.anchorElapsedRealtimeMs) {
    return {allowed: false, reason: 'untrusted_clock'};
  }
  if (clock.data.elapsedRealtimeMs - lease.data.anchorElapsedRealtimeMs >= lease.data.remainingMs) {
    return {allowed: false, reason: 'expired'};
  }
  return {allowed: true};
}

export type OfflineLeaseRevalidationTicket = Readonly<{generation: number; attemptId: number}>;
type RevalidationResult =
  | {status: 'verified'; grant: unknown; clock: OfflineLeaseClock}
  | {status: 'revoked'};

/** Prevents delayed revalidation results from unlocking a replaced account, device or grant. */
export function createOfflineLeaseRevalidationCoordinator(initialLeaseInput: unknown) {
  const parsed = anchoredOfflineLeaseSchema.safeParse(initialLeaseInput);
  if (!parsed.success) throw new Error('invalid_offline_lease');
  let lease: AnchoredOfflineLease = Object.freeze(parsed.data);
  let generation = 0;
  let attemptId = 0;
  let state: 'offline' | 'revalidating' | 'online-verified' | 'locked' = 'offline';
  let lockReason: OfflineLeaseDenial | null = null;

  return {
    getState: () => ({state, lockReason, generation, lease}),
    canSubmit(requestInput: unknown, clockInput: unknown) {
      if (state !== 'online-verified') return false;
      const request = offlineLeaseAccessRequestSchema.safeParse(requestInput);
      if (!request.success || request.data.action !== 'edit') return false;
      return evaluateOfflineLease(lease, request.data, clockInput).allowed;
    },
    beginRevalidation(): OfflineLeaseRevalidationTicket {
      state = 'revalidating';
      return Object.freeze({generation, attemptId: ++attemptId});
    },
    completeRevalidation(ticket: OfflineLeaseRevalidationTicket, result: RevalidationResult) {
      if (ticket.generation !== generation || ticket.attemptId !== attemptId || state !== 'revalidating') return {status: 'stale'} as const;
      if (result.status === 'revoked') {
        state = 'locked';
        lockReason = 'revoked';
        return {status: 'locked'} as const;
      }
      let renewed: AnchoredOfflineLease;
      try {
        renewed = anchorOfflineLease(result.grant, result.clock);
      } catch {
        state = 'locked';
        lockReason = 'invalid_input';
        return {status: 'locked'} as const;
      }
      if (scopeKeys.some((key) => renewed[key] !== lease[key])) {
        state = 'locked';
        lockReason = 'scope_mismatch';
        return {status: 'locked'} as const;
      }
      if (renewed.membershipVersion < lease.membershipVersion || renewed.grantVersion < lease.grantVersion) {
        state = 'locked';
        lockReason = 'stale_authorization';
        return {status: 'locked'} as const;
      }
      lease = renewed;
      state = 'online-verified';
      lockReason = null;
      return {status: 'verified'} as const;
    },
    markOffline() {
      generation += 1;
      attemptId += 1;
      if (lockReason !== null) {
        state = 'locked';
        return;
      }
      state = 'offline';
    },
    replaceLease(nextLeaseInput: unknown) {
      const next = anchoredOfflineLeaseSchema.safeParse(nextLeaseInput);
      if (!next.success) throw new Error('invalid_offline_lease');
      lease = Object.freeze(next.data);
      generation += 1;
      attemptId += 1;
      state = 'offline';
      lockReason = null;
    },
    revoke() {
      generation += 1;
      attemptId += 1;
      state = 'locked';
      lockReason = 'revoked';
    },
  };
}
