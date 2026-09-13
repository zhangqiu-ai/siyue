import { z } from 'zod';
const id = z.string().min(1).max(200).refine(value => value === value.trim());
const version = z.number().int().positive();
export const familyMembershipSchema = z.object({
  familyId: id, subjectId: id, subjectKind: z.enum(['adult', 'child']), role: z.enum(['owner', 'admin', 'member']), active: z.boolean(), version
}).strict();
export const familyShareGrantSchema = z.object({
  familyId: id, sourceSpaceId: id, recordId: id, permission: z.enum(['read', 'edit']), active: z.boolean(), version
}).strict();
/** Only a trusted transaction may assemble this snapshot. Parsing does not authenticate it. */
export const familyPolicySnapshotSchema = z.object({
  subject: z.object({
    id, kind: z.enum(['adult', 'child'])
  }).strict(),
  family: z.object({
    id, active: z.boolean()
  }).strict().nullable(),
  record: z.object({
    id, spaceId: id, ownerId: id
  }).strict().nullable(),
  memberships: z.array(familyMembershipSchema), grants: z.array(familyShareGrantSchema),
}).strict().superRefine((snapshot, ctx) => {
  const unique = (keys: string[]) => new Set(keys).size === keys.length;
  if (!unique(snapshot.memberships.map(m => JSON.stringify([m.familyId, m.subjectId]))) || !unique(snapshot.grants.map(g => JSON.stringify([g.familyId, g.sourceSpaceId, g.recordId]))))
    ctx.addIssue({
      code: 'custom', message: 'Duplicate policy identity'
    });
});
const recordFields = {
  kind: z.literal('record'), sourceSpaceId: id, recordId: id
};
const familyRecord = z.object({
  ...recordFields, context: z.literal('family'), familyId: id, action: z.enum(['read', 'edit']), expectedMembershipVersion: version.optional(), expectedGrantVersion: version.optional()
}).strict().superRefine((r, ctx) => {
  if (r.action === 'edit' && (r.expectedMembershipVersion === undefined || r.expectedGrantVersion === undefined))
    ctx.addIssue({
      code: 'custom', message: 'Shared edits require current authorization versions'
    });
});
const familyRequest = z.object({
  kind: z.literal('family'), familyId: id, action: z.enum(['invite', 'remove-member', 'transfer', 'dissolve']), targetSubjectId: id.optional(), expectedMembershipVersion: version
}).strict().superRefine((r, ctx) => {
  if ((r.action === 'remove-member' || r.action === 'transfer') !== (r.targetSubjectId !== undefined))
    ctx.addIssue({
      code: 'custom', message: 'Target is required only for removal or transfer'
    });
});
export const familyPolicyRequestSchema = z.union([
  z.object({
    ...recordFields, context: z.literal('personal'), action: z.enum(['read', 'edit', 'share', 'revoke', 'delete'])
  }).strict(), familyRecord, familyRequest,
]);
export type FamilyPolicySnapshot = z.infer<typeof familyPolicySnapshotSchema>;
export type FamilyPolicyRequest = z.infer<typeof familyPolicyRequestSchema>;
export type FamilyMembership = z.infer<typeof familyMembershipSchema>;
export type FamilyShareGrant = z.infer<typeof familyShareGrantSchema>;
