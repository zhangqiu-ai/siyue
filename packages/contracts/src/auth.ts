import { z } from 'zod';
import { verifiedAccountSessionSchema } from './account-session.js';

export const refreshTokenSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/)
  .refine(value=>z.uuid().safeParse(value.slice(0,36)).success);
export const refreshRequestSchema = z.object({refreshToken: refreshTokenSchema, rotationId: z.uuid()}).strict();
export const sessionTokensSchema = z.object({
  tokenType: z.literal('Bearer'), accessToken: z.string().min(1).max(4096),
  accessExpiresAt: z.iso.datetime(), refreshToken: refreshTokenSchema,
  refreshExpiresAt: z.iso.datetime(), sessionAbsoluteExpiresAt: z.iso.datetime(),
  session: verifiedAccountSessionSchema,
}).strict();
export const reauthActionSchema = z.enum(['link-identity','unlink-identity','change-email','change-password',
  'revoke-session','revoke-all-sessions','delete-account','approve-child-device']);
export type SessionTokens = z.infer<typeof sessionTokensSchema>;
export type ReauthAction = z.infer<typeof reauthActionSchema>;
