import { z } from 'zod';
import { refreshTokenSchema } from './auth.js';

// Account-deletion contracts (design chapter 13 and API table 14.2: deletion submission,
// preflight impact and receipt-only progress).
//
// This file models the impact preview, submission body, 202 restricted receipt and progress read that receipt
// authorizes. It deliberately does not model the job's internal state machine, the family
// transfer procedure, the Apple revocation policy, retention windows or the client's local-data
// cleanup. Those are not confirmed (design 13.2, 13.3), and the deletion endpoint must not decide
// them on a caller's behalf.

// Same opaque 32-byte base64url secret form as the other single-purpose proofs. The server keeps
// only a digest of the receipt secret, so this value is returned exactly once and can never be
// read back or used for anything but this one job's progress (design 13.3).
const opaqueSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
// Bounded snake_case code, the same shape as a run error code: a value the client may show, never a
// message body, stack or server secret.
const errorCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

// Family and child dependencies a deletion can affect. Design 13.2 fixes exactly two choices for a
// sole guardian/owner: hand management responsibility to a verified eligible adult, or explicitly
// end the caller's family access and revoke dependent child devices. Which adults are eligible, and
// the recorded human branch the design requires for shared works that no endpoint may attribute on
// its own, stay server-side and are not expressible as a caller-supplied value here. A sole manager
// choosing end-family-access for a family with remaining members requires a frozen family pending
// review; it never licenses automatic ownership reassignment or shared-work deletion.
//
// One account can be the sole owner or sole guardian in more than one family, and the two choices
// are not interchangeable between them, so the caller settles each impacted family on its own
// instead of naming one handling for the whole request. A subject with no family or child
// dependency states `{kind:'none'}` rather than leaving the server to assume it, and `families` is
// required nonempty with unique ids so "no dependencies" cannot be smuggled in as a per-family
// disposition with nothing in it. `familyId` names the family being settled and
// `recipientSubjectId` only names the chosen adult: verifying that the family really is impacted and
// that the adult is eligible stays a server rule, not something this contract lets the client
// assert.
export const deletionFamilyDispositionSchema = z.discriminatedUnion('kind', [
  z.object({familyId:z.uuid(),kind:z.literal('transfer'),recipientSubjectId:z.uuid()}).strict(),
  z.object({familyId:z.uuid(),kind:z.literal('end-family-access')}).strict(),
]);
export const deletionDependencyDispositionSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('none')}).strict(),
  z.object({kind:z.literal('per-family'),
    families:z.array(deletionFamilyDispositionSchema).min(1)
      .refine(families=>new Set(families.map(family=>family.familyId)).size===families.length,'duplicate_family')}).strict(),
]);

/** The caller's own deletion dependencies, read before the confirmation step. Other adults are
 * represented only by counts; family roles never imply guardianship. */
export const deletionImpactFamilySchema = z.object({
  familyId:z.uuid(),role:z.enum(['owner','admin','member']),soleActiveOwner:z.boolean(),
  otherActiveAdultCount:z.number().int().nonnegative(),otherActiveChildCount:z.number().int().nonnegative(),
}).strict();
export const deletionImpactGuardianshipSchema = z.object({
  familyId:z.uuid(),childSubjectId:z.uuid(),soleGuardian:z.boolean(),
  otherGuardianCount:z.number().int().nonnegative(),activeChildDeviceCount:z.number().int().nonnegative(),
}).strict();
export const accountDeletionImpactSchema = z.object({
  subjectId:z.uuid(),families:z.array(deletionImpactFamilySchema),
  guardianships:z.array(deletionImpactGuardianshipSchema),activeChildDeviceCount:z.number().int().nonnegative(),
}).strict();
export type AccountDeletionImpact = z.infer<typeof accountDeletionImpactSchema>;

/**
 * Body of `DELETE /me/account`: one action-bound single-use `delete-account` proof (design 12.2),
 * the explicit confirmation the route additionally requires, and the caller's declared handling of
 * family and child dependencies, either as the explicit "none" or as one handling per impacted
 * family. No subject, session or identity is self-reported: the route binds all of those to the
 * bearer and the grant, verifies the impacted family set and the transfer recipients itself, and a
 * bubble confirmation is never accepted as re-verification on its own.
 */
export const accountDeletionRequestSchema = z.object({
  reauthGrant: refreshTokenSchema,
  confirmation: z.literal(true),
  dependencyDisposition: deletionDependencyDispositionSchema,
}).strict();

/**
 * 202 acceptance payload and the only credential for `POST /account/deletion/status`. It carries the
 * deletion job and a receipt secret that reads that job's progress and nothing else: it cannot
 * restore the identity, sign in, or read any other subject data (design 13.3). `expiresAt` is
 * contract, the lifetime is not — the design only fixes that an expired receipt stops working.
 */
export const deletionReceiptSchema = z.object({
  deletionId: z.uuid(),
  receiptSecret: opaqueSecret,
  expiresAt: z.iso.datetime(),
}).strict();

/**
 * Body of `POST /account/deletion/status`. The receipt travels in the body, never a path or query
 * string, so it cannot leak through URLs, referrers or access logs.
 */
export const deletionStatusRequestSchema = z.object({
  deletionId: z.uuid(),
  receiptSecret: opaqueSecret,
}).strict();

/**
 * Minimal deletion progress for the receipt holder. The two cleanup dimensions are reported apart
 * for the reason design 13.3 gives: Siyue-controlled server data cleanup and pending provider
 * revocation must never be merged into one "all done" answer. This flag does not claim that the
 * caller's phone, tablet or other offline copies were erased. A false `providerRevocationPending` says only that no
 * provider revocation is outstanding — it is not a claim that revocation succeeded, which the
 * design reserves for a real provider result. The payload carries no email, profile, login method,
 * session or content field, and `completedAt` stays null until the job is actually finished.
 */
export const deletionStatusSchema = z.object({
  serverDataDeleted: z.boolean(),
  providerRevocationPending: z.boolean(),
  completedAt: z.iso.datetime().nullable(),
  lastErrorCode: errorCode.nullable(),
}).strict();

export type DeletionFamilyDisposition = z.infer<typeof deletionFamilyDispositionSchema>;
export type DeletionDependencyDisposition = z.infer<typeof deletionDependencyDispositionSchema>;
export type AccountDeletionRequest = z.infer<typeof accountDeletionRequestSchema>;
export type DeletionReceipt = z.infer<typeof deletionReceiptSchema>;
export type DeletionStatusRequest = z.infer<typeof deletionStatusRequestSchema>;
export type DeletionStatus = z.infer<typeof deletionStatusSchema>;

/** Public progress view: the receipt proof stays in platform-protected storage. */
export const accountDeletionProgressSchema=z.object({deletionId:z.uuid(),expiresAt:z.iso.datetime(),status:deletionStatusSchema}).strict();
