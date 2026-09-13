import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorVerifiedLease, mayUseOffline, maxLeaseMs } from './offline-lease.mjs';

const identity = { subjectId: 'adult-a', spaceId: 'family-1' };
const clock = { elapsedMs: 500, processId: 'process-1' };
const grant = { ...identity, serverNowMs: 1_000_000, expiresAtMs: 1_000_000 + maxLeaseMs };
const lease = () => anchorVerifiedLease(grant, clock);

test('24h boundary locks exactly at expiration', () => {
  const l = lease();
  assert.equal(mayUseOffline(l, identity, { ...clock, elapsedMs: 500 + maxLeaseMs - 1 }), true);
  assert.equal(mayUseOffline(l, identity, { ...clock, elapsedMs: 500 + maxLeaseMs }), false);
});
test('wall-clock rollback and repeated edits cannot extend grant', () => {
  const l = lease();
  for (const wallNowMs of [0, -1e12, 1e12]) {
    assert.equal(mayUseOffline(l, identity, { ...clock, wallNowMs, elapsedMs: 500 + maxLeaseMs }), false);
  }
  assert.equal(l.anchorMs, 500);
  assert.equal(l.remainingMs, maxLeaseMs);
});
test('restart, monotonic rollback, and invalid clock fail closed', () => {
  for (const c of [{ ...clock, processId: 'process-2' }, { ...clock, elapsedMs: 499 },
    { ...clock, elapsedMs: NaN }]) assert.equal(mayUseOffline(lease(), identity, c), false);
});
test('account or space switch cannot reuse authorization', () => {
  for (const scope of [{ ...identity, subjectId: 'adult-b' }, { ...identity, spaceId: 'family-2' }]) {
    assert.equal(mayUseOffline(lease(), scope, clock), false);
  }
});
test('server-shortened grant is honored; expired and oversized grants rejected', () => {
  const short = anchorVerifiedLease({ ...grant, expiresAtMs: grant.serverNowMs + 100 }, clock);
  assert.equal(mayUseOffline(short, identity, { ...clock, elapsedMs: 600 }), false);
  for (const duration of [0, -1, maxLeaseMs + 1, NaN, Infinity]) {
    assert.throws(() => anchorVerifiedLease({ ...grant, expiresAtMs: grant.serverNowMs + duration }, clock), /invalid_lease/);
  }
});
