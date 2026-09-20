import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_OFFLINE_LEASE_MS, type OfflineLeaseAccessRequest } from '@siyue/contracts';
import {
  anchorOfflineLease,
  createOfflineLeaseRevalidationCoordinator,
  evaluateOfflineLease,
} from './offline-lease.js';

const serverNowMs = Date.parse('2026-09-13T00:00:00.000Z');
const scope = {
  subjectId: 'adult-a',
  deviceId: 'device-a',
  familyId: 'family-a',
  sourceSpaceId: 'space-owner',
  recordId: 'goal-a',
  membershipVersion: 2,
  grantVersion: 3,
};
const clock = {bootId: 'boot-a', elapsedRealtimeMs: 5_000};
const grant = (overrides = {}) => ({
  ...scope,
  permission: 'edit',
  serverNow: new Date(serverNowMs).toISOString(),
  expiresAt: new Date(serverNowMs + MAX_OFFLINE_LEASE_MS).toISOString(),
  ...overrides,
});
const request = (overrides = {}): OfflineLeaseAccessRequest => ({...scope, action: 'edit', ...overrides});
const lease = () => anchorOfflineLease(grant(), clock);

test('offline access locks exactly at the 24 hour boundary without extending on use', () => {
  const anchored = lease();
  assert.deepEqual(evaluateOfflineLease(anchored, request(), {...clock, elapsedRealtimeMs: clock.elapsedRealtimeMs + MAX_OFFLINE_LEASE_MS - 1}), {allowed: true});
  assert.deepEqual(evaluateOfflineLease(anchored, request(), {...clock, elapsedRealtimeMs: clock.elapsedRealtimeMs + MAX_OFFLINE_LEASE_MS}), {allowed: false, reason: 'expired'});
  assert.equal(anchored.anchorElapsedRealtimeMs, clock.elapsedRealtimeMs);
});

test('every account, device, family and record binding is isolated', () => {
  for (const [key, value] of [
    ['subjectId', 'adult-b'], ['deviceId', 'device-b'], ['familyId', 'family-b'],
    ['sourceSpaceId', 'space-b'], ['recordId', 'goal-b'],
  ] as const) {
    assert.deepEqual(evaluateOfflineLease(lease(), request({[key]: value}), clock), {allowed: false, reason: 'scope_mismatch'});
  }
});

test('authorization versions and read-only permission cannot be bypassed', () => {
  assert.deepEqual(evaluateOfflineLease(lease(), request({membershipVersion: 1}), clock), {allowed: false, reason: 'stale_authorization'});
  assert.deepEqual(evaluateOfflineLease(lease(), request({grantVersion: 4}), clock), {allowed: false, reason: 'stale_authorization'});
  const readOnly = anchorOfflineLease(grant({permission: 'read'}), clock);
  assert.deepEqual(evaluateOfflineLease(readOnly, request(), clock), {allowed: false, reason: 'permission_denied'});
  assert.deepEqual(evaluateOfflineLease(readOnly, request({action: 'read'}), clock), {allowed: true});
});

test('known revocation wins over a locally unexpired lease', () => {
  assert.deepEqual(evaluateOfflineLease(lease(), request(), clock, {knownRevoked: true}), {allowed: false, reason: 'revoked'});
});

test('restart, elapsed time rollback and invalid clocks fail closed', () => {
  assert.deepEqual(evaluateOfflineLease(lease(), request(), {...clock, bootId: 'boot-b'}), {allowed: false, reason: 'untrusted_clock'});
  assert.deepEqual(evaluateOfflineLease(lease(), request(), {...clock, elapsedRealtimeMs: 4_999}), {allowed: false, reason: 'untrusted_clock'});
  assert.deepEqual(evaluateOfflineLease(lease(), request(), {...clock, elapsedRealtimeMs: Number.NaN}), {allowed: false, reason: 'invalid_input'});
});

test('reconnection blocks upload until the current verification succeeds', () => {
  const coordinator = createOfflineLeaseRevalidationCoordinator(lease());
  const ticket = coordinator.beginRevalidation();
  assert.equal(coordinator.canSubmit(request(), clock), false);
  assert.deepEqual(coordinator.completeRevalidation(ticket, {status: 'verified', grant: grant(), clock}), {status: 'verified'});
  assert.equal(coordinator.canSubmit(request(), clock), true);
  coordinator.markOffline();
  assert.equal(coordinator.canSubmit(request(), clock), false);
});

test('revalidation denial locks without changing the lease or enabling upload', () => {
  const coordinator = createOfflineLeaseRevalidationCoordinator(lease());
  const before = coordinator.getState().lease;
  const ticket = coordinator.beginRevalidation();
  assert.deepEqual(coordinator.completeRevalidation(ticket, {status: 'revoked'}), {status: 'locked'});
  assert.equal(coordinator.canSubmit(request(), clock), false);
  assert.deepEqual(coordinator.getState(), {state: 'locked', lockReason: 'revoked', generation: 0, lease: before});
  coordinator.markOffline();
  assert.equal(coordinator.getState().state, 'locked');
  assert.equal(coordinator.getState().lockReason, 'revoked');
});

test('a delayed result cannot unlock a replaced A to B to A lease generation', () => {
  const original = lease();
  const coordinator = createOfflineLeaseRevalidationCoordinator(original);
  const oldTicket = coordinator.beginRevalidation();
  const accountB = anchorOfflineLease(grant({subjectId: 'adult-b'}), clock);
  coordinator.replaceLease(accountB);
  coordinator.replaceLease(original);
  assert.deepEqual(coordinator.completeRevalidation(oldTicket, {status: 'verified', grant: grant(), clock}), {status: 'stale'});
  assert.equal(coordinator.canSubmit(request(), clock), false);
});

test('a verification response for another resource locks instead of changing scope', () => {
  const coordinator = createOfflineLeaseRevalidationCoordinator(lease());
  const ticket = coordinator.beginRevalidation();
  assert.deepEqual(coordinator.completeRevalidation(ticket, {status: 'verified', grant: grant({recordId: 'goal-b'}), clock}), {status: 'locked'});
  assert.equal(coordinator.getState().lockReason, 'scope_mismatch');
  assert.equal(coordinator.canSubmit(request(), clock), false);
});

test('local revocation invalidates any in-flight verification ticket', () => {
  const coordinator = createOfflineLeaseRevalidationCoordinator(lease());
  const ticket = coordinator.beginRevalidation();
  coordinator.revoke();
  assert.deepEqual(coordinator.completeRevalidation(ticket, {status: 'verified', grant: grant(), clock}), {status: 'stale'});
  assert.deepEqual(coordinator.getState().state, 'locked');
});

test('revocation survives a failed revalidation attempt followed by disconnect', () => {
  const coordinator = createOfflineLeaseRevalidationCoordinator(lease());
  coordinator.revoke();
  coordinator.beginRevalidation();
  coordinator.markOffline();
  assert.equal(coordinator.getState().state, 'locked');
  assert.equal(coordinator.getState().lockReason, 'revoked');
  assert.equal(coordinator.canSubmit(request(), clock), false);
});

test('submission rechecks edit permission, current versions and lease time', () => {
  const readOnly = anchorOfflineLease(grant({permission: 'read'}), clock);
  const coordinator = createOfflineLeaseRevalidationCoordinator(readOnly);
  const ticket = coordinator.beginRevalidation();
  assert.deepEqual(coordinator.completeRevalidation(ticket, {status: 'verified', grant: grant({permission: 'read'}), clock}), {status: 'verified'});
  assert.equal(coordinator.canSubmit(request(), clock), false);

  const editable = createOfflineLeaseRevalidationCoordinator(lease());
  const editTicket = editable.beginRevalidation();
  assert.deepEqual(editable.completeRevalidation(editTicket, {status: 'verified', grant: grant(), clock}), {status: 'verified'});
  assert.equal(editable.canSubmit(request({grantVersion: 4}), clock), false);
  assert.equal(editable.canSubmit(request(), {...clock, elapsedRealtimeMs: clock.elapsedRealtimeMs + MAX_OFFLINE_LEASE_MS}), false);
});

test('revalidation cannot downgrade a current authorization version', () => {
  const coordinator = createOfflineLeaseRevalidationCoordinator(lease());
  const ticket = coordinator.beginRevalidation();
  assert.deepEqual(coordinator.completeRevalidation(ticket, {
    status: 'verified',
    grant: grant({membershipVersion: 1, grantVersion: 2}),
    clock,
  }), {status: 'locked'});
  assert.equal(coordinator.getState().lockReason, 'stale_authorization');
  assert.equal(coordinator.canSubmit(request(), clock), false);
});

test('published coordinator state cannot mutate its internal lease scope', () => {
  const coordinator = createOfflineLeaseRevalidationCoordinator(lease());
  const published = coordinator.getState().lease;
  assert.equal(Object.isFrozen(published), true);
  assert.equal(Reflect.set(published, 'recordId', 'goal-b'), false);
  assert.equal(coordinator.getState().lease.recordId, 'goal-a');
});
