import {z} from 'zod';
import {familyManagementAcceptanceRequestSchema} from './family-api.js';

export const deletionRecipientSchema=z.object({subjectId:z.uuid(),label:z.string().min(1).max(120),
  membership:z.literal('active'),management:z.enum(['accepted','pending']),
  guardianship:z.enum(['accepted','pending','none'])}).strict();
export const deletionRecipientsSchema=z.array(deletionRecipientSchema);
export const familyResponsibilityListSchema=z.array(z.object({familyId:z.uuid(),
  status:z.enum(['active','frozen'])}).strict());
export const frozenFamilyReviewAcceptanceRequestSchema=familyManagementAcceptanceRequestSchema;
export const frozenFamilyReviewScopeSchema=z.object({familyId:z.uuid(),deletingSubjectId:z.uuid(),
  recipientSubjectId:z.uuid(),familyVersion:z.number().int().positive(),membershipVersion:z.number().int().positive(),
  ownerMembershipVersion:z.number().int().positive(),childScopeDigest:z.string().regex(/^[0-9a-f]{64}$/),
  childCount:z.number().int().nonnegative()}).strict();
export const frozenFamilyReviewAcceptanceReceiptSchema=frozenFamilyReviewScopeSchema.extend({acceptanceId:z.uuid(),
  acceptedAt:z.iso.datetime(),consumedAt:z.iso.datetime().nullable()}).strict();
export type FrozenFamilyReviewScope=z.infer<typeof frozenFamilyReviewScopeSchema>;
export type FrozenFamilyReviewAcceptanceReceipt=z.infer<typeof frozenFamilyReviewAcceptanceReceiptSchema>;
