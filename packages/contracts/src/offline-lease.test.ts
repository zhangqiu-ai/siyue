import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_OFFLINE_LEASE_MS,
  offlineLeaseAccessRequestSchema,
  verifiedOfflineLeaseGrantSchema,
} from './offline-lease.js';

const base = {
  subjectId: 'adult-a',
  deviceId: 'device-a',
  familyId: 'family-a',
  sourceSpaceId: 'space-owner',
  recordId: 'goal-a',
  membershipVersion: 2,
  grantVersion: 3,
};

test('verified offline grant accepts the confirmed 24 hour boundary', () => {
  const serverNow = Date.parse('2026-09-13T00:00:00.000Z');
  assert.equal(verifiedOfflineLeaseGrantSchema.safeParse({
    ...base,
    permission: 'edit',
    serverNow: new Date(serverNow).toISOString(),
    expiresAt: new Date(serverNow + MAX_OFFLINE_LEASE_MS).toISOString(),
  }).success, true);
});

test('verified offline grant rejects expired, oversized and extra authority fields', () => {
  const serverNow = Date.parse('2026-09-13T00:00:00.000Z');
  for (const duration of [0, -1, MAX_OFFLINE_LEASE_MS + 1]) {
    assert.equal(verifiedOfflineLeaseGrantSchema.safeParse({
      ...base,
      permission: 'read',
      serverNow: new Date(serverNow).toISOString(),
      expiresAt: new Date(serverNow + duration).toISOString(),
    }).success, false);
  }
  assert.equal(verifiedOfflineLeaseGrantSchema.safeParse({
    ...base,
    permission: 'read',
    serverNow: new Date(serverNow).toISOString(),
    expiresAt: new Date(serverNow + 1_000).toISOString(),
    role: 'owner',
  }).success, false);
});

test('offline access request requires every identity, resource and version binding', () => {
  const valid = {...base, action: 'read'};
  assert.equal(offlineLeaseAccessRequestSchema.safeParse(valid).success, true);
  for (const key of Object.keys(base)) {
    const incomplete = {...valid};
    delete incomplete[key as keyof typeof incomplete];
    assert.equal(offlineLeaseAccessRequestSchema.safeParse(incomplete).success, false);
  }
});
