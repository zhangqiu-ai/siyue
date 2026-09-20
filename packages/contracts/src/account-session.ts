import { z } from 'zod';

const identifier = z.string().min(1).max(200).refine((value) => value === value.trim());

/** Verified identity only. Roles, spaces and object permissions are deliberately absent. */
export const verifiedAccountSessionSchema = z.object({
  subjectId: identifier,
  subjectKind: z.enum(['adult', 'child']),
  sessionId: identifier,
  expiresAt: z.string().datetime(),
}).strict();

export type VerifiedAccountSession = z.infer<typeof verifiedAccountSessionSchema>;
