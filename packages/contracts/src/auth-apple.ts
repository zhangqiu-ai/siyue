import { z } from 'zod';
import { refreshTokenSchema } from './auth.js';

// Sign in with Apple login-only request contracts (design section 10.2 / API section 14.2).
// login creates a Siyue session; reauth re-verifies an already linked Apple identity for one
// action-bound grant, because Apple-only accounts have no password to re-verify with. Both
// purposes are strict: unsupported fields are rejected instead of ignored.

// 32 random bytes encoded as unpadded base64url are exactly 43 characters.
const base64Url43 = /^[A-Za-z0-9_-]{43}$/;
// The flow service generates nonce and state from 32 random bytes as well.
const boundedBase64Url43 = z.string().regex(base64Url43);
const identityToken = z.string().max(16 * 1024).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

// Apple name components are optional, untrusted display data; they never identify the account.
const namePart = z.string().min(1).max(100);
export const appleFullNameSchema = z.object({
  givenName: namePart.optional(), familyName: namePart.optional(), middleName: namePart.optional(),
  nickname: namePart.optional(), namePrefix: namePart.optional(), nameSuffix: namePart.optional(),
}).strict();

// reauth is scoped to the actions an Apple-only account can prove without a password: linking
// its first login email, revoking one other device, revoking every session, approving one
// guardian child-device pairing or confirming account deletion. The database CHECK mirrors this list, the flow row
// binds the action at start, and the issued grant is only usable for that action; widening it
// needs a new review.
export const appleReauthActionSchema = z.enum(['link-identity','revoke-session','revoke-all-sessions','approve-child-device','delete-account']);

const startContext = {
  platform: z.literal('ios'),
  installationId: z.string().trim().min(1).max(200), deviceLabel: z.string().max(100).optional(),
};

export const appleLoginStartRequestSchema = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('login'), ...startContext }).strict(),
  // reauth start additionally requires the caller's current session as an Authorization
  // bearer; the server binds that verified session to the flow, not a client-supplied id.
  z.object({ purpose: z.literal('reauth'), action: appleReauthActionSchema, ...startContext }).strict(),
]);

export const appleLoginStartResponseSchema = z.object({
  flowId: z.uuid(), transactionSecret: z.string().regex(base64Url43),
  nonce: boundedBase64Url43, state: boundedBase64Url43, expiresAt: z.iso.datetime(),
}).strict();

export const appleLoginCompleteRequestSchema = z.object({
  flowId: z.uuid(), transactionSecret: z.string().regex(base64Url43), state: boundedBase64Url43,
  identityToken, authorizationCode: z.string().min(1).max(2048), fullName: appleFullNameSchema.optional(),
}).strict();

// reauth completion issues one session-bound, one-time action grant instead of a session;
// the shape matches the password reauth response so clients handle both the same way.
export const appleReauthGrantSchema = z.object({
  reauthGrant: refreshTokenSchema, expiresAt: z.iso.datetime(),
}).strict();

export type AppleFullName = z.infer<typeof appleFullNameSchema>;
export type AppleReauthAction = z.infer<typeof appleReauthActionSchema>;
export type AppleReauthGrant = z.infer<typeof appleReauthGrantSchema>;
export type AppleLoginStartRequest = z.infer<typeof appleLoginStartRequestSchema>;
export type AppleLoginStartResponse = z.infer<typeof appleLoginStartResponseSchema>;
export type AppleLoginCompleteRequest = z.infer<typeof appleLoginCompleteRequestSchema>;
