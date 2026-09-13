// Isolated feasibility model: no production credentials or persisted grants.
// A process-local monotonic anchor cannot prove validity after process restart.
export const maxLeaseMs = 24 * 60 * 60 * 1000;

export function anchorVerifiedLease({ subjectId, spaceId, serverNowMs, expiresAtMs }, clock) {
  const remaining = expiresAtMs - serverNowMs;
  if (!subjectId || !spaceId || !Number.isFinite(remaining) || remaining <= 0 ||
      remaining > maxLeaseMs || !Number.isFinite(clock.elapsedMs) || !clock.processId) {
    throw new Error('invalid_lease');
  }
  return Object.freeze({ subjectId, spaceId, remainingMs: remaining,
    anchorMs: clock.elapsedMs, processId: clock.processId });
}

export function mayUseOffline(lease, { subjectId, spaceId }, clock) {
  if (!lease || lease.subjectId !== subjectId || lease.spaceId !== spaceId ||
      lease.processId !== clock.processId || !Number.isFinite(clock.elapsedMs)) return false;
  const elapsed = clock.elapsedMs - lease.anchorMs;
  return elapsed >= 0 && elapsed < lease.remainingMs;
}
