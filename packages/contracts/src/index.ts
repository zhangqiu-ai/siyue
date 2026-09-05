import { z } from 'zod';

export const schemaVersion = 1 as const;

export const commandEnvelopeSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  commandId: z.string().min(8),
  spaceId: z.string().min(1),
  expectedVersion: z.number().int().nonnegative().optional(),
  issuedAt: z.string().datetime(),
});

export const goalDraftSchema = z.object({
  title: z.string().trim().min(1).max(160),
  rationale: z.string().trim().max(1000).optional(),
  projectTitles: z.array(z.string().trim().min(1).max(160)).max(8).default([]),
  taskTitles: z.array(z.string().trim().min(1).max(240)).max(24).default([]),
});

export const actionDraftSchema = z.object({
  id: z.string().min(1),
  schemaVersion: z.literal(schemaVersion),
  kind: z.literal('goal-plan'),
  spaceId: z.string().min(1),
  payload: goalDraftSchema,
  status: z.enum(['draft', 'approved', 'rejected', 'expired']),
  expiresAt: z.string().datetime(),
});

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;
export type GoalDraft = z.infer<typeof goalDraftSchema>;
export type ActionDraft = z.infer<typeof actionDraftSchema>;
