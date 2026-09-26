import { z } from 'zod';
import { emailAddressSchema } from './auth-email.js';

/** Minimal family membership view; it grants no record, room or child-device access by itself. */
export const familySummarySchema = z.object({
  familyId: z.uuid(),
  ownerSubjectId: z.uuid(),
  role: z.enum(['owner', 'admin', 'member']),
  membershipVersion: z.number().int().positive(),
  familyVersion: z.number().int().positive(),
}).strict();
export const familyListSchema = z.object({items: z.array(familySummarySchema)}).strict();
export type FamilySummary = z.infer<typeof familySummarySchema>;
export type FamilyList = z.infer<typeof familyListSchema>;

/** Caller can target a verified sign-in email, or deliberately issue a bearer invitation. */
export const familyInvitationCreateRequestSchema = z.object({
  intendedEmail: emailAddressSchema.optional(),
  expectedMembershipVersion: z.number().int().positive(),
  expectedFamilyVersion: z.number().int().positive(),
}).strict();
export const familyInvitationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const familyInvitationCreatedSchema = z.object({
  invitationId: z.uuid(), token: familyInvitationTokenSchema, expiresAt: z.iso.datetime(),
}).strict();
export const familyInvitationAcceptRequestSchema = z.object({token: familyInvitationTokenSchema}).strict();
export type FamilyInvitationCreateRequest = z.infer<typeof familyInvitationCreateRequestSchema>;
export type FamilyInvitationCreated = z.infer<typeof familyInvitationCreatedSchema>;

/** Opaque lowercase SHA-256 digest of a server-computed child scope. It names no child and carries no
 * count or policy text, so it can travel and be stored without exposing anyone. The server recomputes
 * it inside the accepting transaction and compares, so a caller can only confirm the scope it was
 * shown and can never widen one. */
export const familyChildScopeDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Read by the accepting adult before a separate explicit confirmation. The child count explains
 * the breadth of responsibility without disclosing child identities to a member who is not yet a
 * guardian. The digest binds the displayed scope to the later acceptance request. */
export const familyManagementAcceptancePreviewSchema = z.object({
  familyId:z.uuid(),ownerSubjectId:z.uuid(),recipientSubjectId:z.uuid(),
  familyVersion:z.number().int().positive(),membershipVersion:z.number().int().positive(),
  ownerMembershipVersion:z.number().int().positive(),
  childScopeDigest:familyChildScopeDigestSchema,childCount:z.number().int().nonnegative(),
}).strict();

/**
 * Body of the family management acceptance route (POST /v1/families/:familyId/management-acceptance,
 * design 13.2). Before a deleting sole owner may hand a family over, the chosen adult accepts the family
 * management duty and the applicable guardianship duty, and that acceptance has to cover the family and
 * child scope the deletion is accepted against.
 *
 * The contract deliberately carries no subject, session, role, guardian flag or family id: the route
 * binds the recipient to the bearer and reads the family, both memberships and the child scope from its
 * own transaction, so calling this cannot make an ineligible adult eligible, cannot accept on someone
 * else's behalf, and cannot state who is handing the family over. The expected values are the state the
 * caller was shown; acceptance is refused and must be redone when the family, either membership or the
 * covered child scope has moved since, rather than being kept for a state it no longer describes. Both
 * duty fields are required true literals, so acceptance is never partial, defaulted or inferred from a
 * role, and the recorded acceptance always names what it covers. */
export const familyManagementAcceptanceRequestSchema = z.object({
  expectedFamilyVersion: z.number().int().positive(),
  expectedMembershipVersion: z.number().int().positive(),
  expectedOwnerMembershipVersion: z.number().int().positive(),
  expectedChildScopeDigest: familyChildScopeDigestSchema,
  acceptance: z.object({
    familyManagement: z.literal(true),
    guardianship: z.literal(true),
  }).strict(),
}).strict();

/**
 * Created acceptance record, returned to the accepting adult. Every field is server-derived: the
 * versions and the digest are what the server re-read and stored, and the two subjects are the adults
 * the server resolved, never a value the caller sent. expiresAt bounds how long a deletion acceptance
 * may still consume this record and consumedAt stays null until that happens; an expired or consumed
 * record authorizes nothing. The payload names no child and carries no profile field, so it stays safe
 * to display or log. */
export const familyManagementAcceptanceReceiptSchema = z.object({
  acceptanceId: z.uuid(),
  familyId: z.uuid(),
  recipientSubjectId: z.uuid(),
  ownerSubjectId: z.uuid(),
  familyVersion: z.number().int().positive(),
  membershipVersion: z.number().int().positive(),
  ownerMembershipVersion: z.number().int().positive(),
  childScopeDigest: familyChildScopeDigestSchema,
  acceptedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  consumedAt: z.iso.datetime().nullable(),
}).strict();

export type FamilyManagementAcceptanceRequest = z.infer<typeof familyManagementAcceptanceRequestSchema>;
export type FamilyManagementAcceptancePreview = z.infer<typeof familyManagementAcceptancePreviewSchema>;
export type FamilyManagementAcceptanceReceipt = z.infer<typeof familyManagementAcceptanceReceiptSchema>;
