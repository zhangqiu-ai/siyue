import { z } from 'zod';

export const MAX_OFFLINE_LEASE_MS = 24 * 60 * 60 * 1_000;

const id = z.string().min(1).max(200).refine((value) => value === value.trim());
const version = z.number().int().positive();

const offlineLeaseScopeFields = {
  subjectId: id,
  deviceId: id,
  familyId: id,
  sourceSpaceId: id,
  recordId: id,
  membershipVersion: version,
  grantVersion: version,
};

/** Parsed only after the server identity and signature boundary has verified the grant. */
export const verifiedOfflineLeaseGrantSchema = z.object({
  ...offlineLeaseScopeFields,
  permission: z.enum(['read', 'edit']),
  serverNow: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict().superRefine((grant, context) => {
  const duration = Date.parse(grant.expiresAt) - Date.parse(grant.serverNow);
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_OFFLINE_LEASE_MS) {
    context.addIssue({code: 'custom', message: 'Lease duration must be within 24 hours'});
  }
});

export const offlineLeaseClockSchema = z.object({
  bootId: id,
  elapsedRealtimeMs: z.number().finite().nonnegative(),
}).strict();

export const anchoredOfflineLeaseSchema = z.object({
  ...offlineLeaseScopeFields,
  permission: z.enum(['read', 'edit']),
  bootId: id,
  anchorElapsedRealtimeMs: z.number().finite().nonnegative(),
  remainingMs: z.number().int().positive().max(MAX_OFFLINE_LEASE_MS),
}).strict();

export const offlineLeaseAccessRequestSchema = z.object({
  ...offlineLeaseScopeFields,
  action: z.enum(['read', 'edit']),
}).strict();

export type VerifiedOfflineLeaseGrant = z.infer<typeof verifiedOfflineLeaseGrantSchema>;
export type OfflineLeaseClock = z.infer<typeof offlineLeaseClockSchema>;
export type AnchoredOfflineLease = Readonly<z.infer<typeof anchoredOfflineLeaseSchema>>;
export type OfflineLeaseAccessRequest = z.infer<typeof offlineLeaseAccessRequestSchema>;
