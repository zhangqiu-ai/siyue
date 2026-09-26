import { z } from 'zod';
import { refreshTokenSchema, sessionTokensSchema } from './auth.js';

// Child-device pairing contracts. A pairing request is anonymous: it carries no adult
// session, role, subject kind or guardian credential. Secrets reuse the existing opaque
// 32-byte base64url token form and must never be extended with parent material.
const opaqueSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const version = z.number().int().positive();
// Device text is stored in PostgreSQL `text`: a NUL byte fails at the wire encoding, so an anonymous
// pairing request carrying one would answer 5xx instead of refusing the caller, and CR/LF in a label
// would let a device name forge extra lines wherever a guardian previews it. C0 controls are otherwise
// never part of an installation id or a device name, while Chinese labels stay valid.
const controlCharacters = /[\u0000-\u001F]/;
const withoutControlCharacters = (value: string) => !controlCharacters.test(value);
const installationId = z.string().trim().min(1).max(200).refine(withoutControlCharacters, 'installation_id_control_characters');
const deviceLabel = z.string().max(100).refine(withoutControlCharacters, 'device_label_control_characters');
// The durable consent row stores the policy version under the migration's ^[a-z0-9._-]{1,40}$
// constraint, so the shared contract refuses a version this server could not persist.
const consentPolicyVersion = z.string().trim().regex(/^[a-z0-9._-]{1,40}$/, 'consent_policy_version_format');

export const childDevicePlatformSchema = z.enum(['ios', 'android', 'desktop']);

/** POST /families/{id}/children. A supervised child subject is only created with explicit consent. */
export const childCreateRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(100).refine(withoutControlCharacters, 'display_name_control_characters'),
  consentPolicyVersion,
  consentConfirmed: z.literal(true),
  expectedMembershipVersion: version,
  expectedFamilyVersion: version,
}).strict();

/** Minimal child view returned to the authorized adult; it grants no record, room or board access. */
export const childSummarySchema = z.object({
  childSubjectId: z.uuid(),
  familyId: z.uuid(),
  guardianSubjectId: z.uuid(),
  relationshipVersion: version,
  familyVersion: version,
  displayName: z.string().trim().min(1).max(100).refine(withoutControlCharacters, 'display_name_control_characters'),
}).strict();

/**
 * GET /families/{id}/children. Only the caller's own live guardian relationships in that family, each
 * as the same minimal child view the create response returns. A family owner/admin/member role never
 * contributes an entry, so an adult who guards nobody in the family receives an empty list; nothing
 * in this list grants record, room or board access.
 */
export const childListResponseSchema = z.object({items: z.array(childSummarySchema)}).strict();

/** POST /device-pairings. Anonymous, rate limited, and only able to create a pending request. */
export const devicePairingCreateRequestSchema = z.object({
  installationId,
  platform: childDevicePlatformSchema,
  deviceLabel: deviceLabel.optional(),
}).strict();

export const devicePairingCreateResponseSchema = z.object({
  pairingId: z.uuid(),
  requestToken: opaqueSecret,
  pollSecret: opaqueSecret,
  expiresAt: z.iso.datetime(),
}).strict();

export const devicePairingStatusSchema = z.enum(['pending', 'approved', 'consumed', 'expired']);

/** POST /device-pairings/{id}/status. Polled with the initiating device's own secret only. */
export const devicePairingStatusRequestSchema = z.object({pollSecret: opaqueSecret}).strict();

/** Minimal status: lifecycle only, never adult identity, guardian data or approval detail. */
export const devicePairingStatusResponseSchema = z.object({
  status: devicePairingStatusSchema,
  expiresAt: z.iso.datetime(),
}).strict();

/** POST /device-pairings/{id}/preview. Adult guardian checks the server's device description first. */
export const devicePairingPreviewRequestSchema = z.object({
  requestToken: opaqueSecret,
  childSubjectId: z.uuid(),
}).strict();
export const devicePairingPreviewResponseSchema = z.object({
  deviceLabel: deviceLabel.nullable(),
  platform: childDevicePlatformSchema,
  expiresAt: z.iso.datetime(),
  child: z.object({
    childSubjectId: z.uuid(),
    displayName: z.string().trim().min(1).max(100).refine(withoutControlCharacters, 'display_name_control_characters'),
  }).strict(),
}).strict();

/** POST /device-pairings/{id}/approve. The grant must be bound to the approve-child-device action. */
export const devicePairingApproveRequestSchema = z.object({
  requestToken: opaqueSecret,
  childSubjectId: z.uuid(),
  reauthGrant: refreshTokenSchema,
  expectedGuardianVersion: version,
}).strict();

/** POST /device-pairings/{id}/complete. One consumption; the poll secret proves the requester. */
export const devicePairingCompleteRequestSchema = z.object({pollSecret: opaqueSecret}).strict();

export const devicePairingCompleteResponseSchema = z.object({
  sessionTokens: sessionTokensSchema,
  deviceGrantId: z.uuid(),
}).strict().superRefine((result, ctx) => {
  if (result.sessionTokens.session.subjectKind !== 'child')
    ctx.addIssue({code: 'custom', message: 'Pairing completion must issue a restricted child session'});
});

export const childDeviceStatusSchema = z.enum(['active', 'revoked', 'expired']);

/** Minimal device grant view for the guardian: identity, lifecycle and revocation version. */
export const childDeviceSummarySchema = z.object({
  grantId: z.uuid(),
  childSubjectId: z.uuid(),
  installationId,
  platform: childDevicePlatformSchema,
  deviceLabel: deviceLabel.nullable(),
  status: childDeviceStatusSchema,
  version,
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
}).strict();

export const childDeviceListResponseSchema = z.object({items: z.array(childDeviceSummarySchema)}).strict();

/** DELETE /children/{id}/devices/{grantId} requires the version the caller last observed. */
export const childDeviceRevokeRequestSchema = z.object({expectedVersion: version}).strict();

export type ChildDevicePlatform = z.infer<typeof childDevicePlatformSchema>;
export type ChildCreateRequest = z.infer<typeof childCreateRequestSchema>;
export type ChildSummary = z.infer<typeof childSummarySchema>;
export type ChildListResponse = z.infer<typeof childListResponseSchema>;
export type DevicePairingCreateRequest = z.infer<typeof devicePairingCreateRequestSchema>;
export type DevicePairingCreateResponse = z.infer<typeof devicePairingCreateResponseSchema>;
export type DevicePairingStatus = z.infer<typeof devicePairingStatusSchema>;
export type DevicePairingStatusRequest = z.infer<typeof devicePairingStatusRequestSchema>;
export type DevicePairingStatusResponse = z.infer<typeof devicePairingStatusResponseSchema>;
export type DevicePairingPreviewRequest = z.infer<typeof devicePairingPreviewRequestSchema>;
export type DevicePairingPreviewResponse = z.infer<typeof devicePairingPreviewResponseSchema>;
export type DevicePairingApproveRequest = z.infer<typeof devicePairingApproveRequestSchema>;
export type DevicePairingCompleteRequest = z.infer<typeof devicePairingCompleteRequestSchema>;
export type DevicePairingCompleteResponse = z.infer<typeof devicePairingCompleteResponseSchema>;
export type ChildDeviceStatus = z.infer<typeof childDeviceStatusSchema>;
export type ChildDeviceSummary = z.infer<typeof childDeviceSummarySchema>;
export type ChildDeviceRevokeRequest = z.infer<typeof childDeviceRevokeRequestSchema>;
