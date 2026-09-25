import { z } from 'zod';
import { reauthActionSchema, refreshTokenSchema } from './auth.js';

export const emailAddressSchema = z.string().trim().max(254).email();
export const normalizeLoginEmail = (email: string) => emailAddressSchema.parse(email).toLowerCase();
export const accountPasswordSchema = z.string().max(256).refine(value => {
  const size = [...value].length;
  return size >= 15 && size <= 128 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}, 'password_length_or_unicode');
export const emailChallengeRequestSchema = z.object({email:emailAddressSchema,locale:z.enum(['zh-CN','en-US'])}).strict();
const proof = {challengeId:z.uuid(),requestSecret:z.string().regex(/^[A-Za-z0-9_-]{43}$/),code:z.string().regex(/^\d{6}$/)};
const device = {installationId:z.string().trim().min(1).max(200),platform:z.enum(['ios','android','desktop']),deviceLabel:z.string().max(100).optional()};
export const emailRegisterConfirmSchema = z.object({...proof,...device,password:accountPasswordSchema,
  displayName:z.string().max(100).optional(),termsVersion:z.string().min(1).max(80),privacyVersion:z.string().min(1).max(80)}).strict();
// The published registration policy a client may act on. The server offers one terms document and
// one privacy document, each with its own version and public link, and enables registration only
// while both are released. A version is never minted, defaulted or remembered by a client, and an
// unpublished set stays absent instead of being presented as the effective policy.
const httpsDocumentUrl = z.string().max(300).refine(value => {
  // The same rule the server applies to its published configuration: encrypted transport only, no
  // embedded credentials and no fragment that could hide what is actually opened.
  try { const url = new URL(value); return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === ''; }
  catch { return false; }
}, 'https_document_url_required');
export const registrationPolicyDocumentSchema = z.object({version:z.string().trim().min(1).max(80),url:httpsDocumentUrl}).strict();
export const registrationPolicySchema = z.object({enabled:z.boolean(),terms:registrationPolicyDocumentSchema.nullable(),
  privacy:registrationPolicyDocumentSchema.nullable()}).strict()
  // `enabled` is exactly the statement that both released documents are present, and the pair is
  // all or nothing: a half published set cannot read as enabled, and an unpublished version cannot
  // reach a client inside a response it should ignore.
  .refine(value => (value.terms === null) === (value.privacy === null) && value.enabled === (value.terms !== null),'policy_incomplete');
export const emailLoginSchema = z.object({email:emailAddressSchema,password:accountPasswordSchema,...device}).strict();
export const emailPasswordResetConfirmSchema = z.object({...proof,newPassword:accountPasswordSchema}).strict();
// Adding a first login email to an existing subject: the request is bound to a fresh
// link-identity reauth grant, the confirm proves control of the new address and sets the
// account's first password. Both are strict; no subject/kind/role fields are accepted.
export const emailLinkRequestSchema = z.object({email:emailAddressSchema,locale:z.enum(['zh-CN','en-US']),reauthGrant:refreshTokenSchema}).strict();
export const emailLinkConfirmSchema = z.object({...proof,newPassword:accountPasswordSchema}).strict();
export const passwordReauthSchema = z.object({password:accountPasswordSchema,action:reauthActionSchema}).strict();
export const passwordReauthResponseSchema = z.object({reauthGrant:refreshTokenSchema,expiresAt:z.iso.datetime()}).strict();
export const passwordChangeSchema = z.object({newPassword:accountPasswordSchema,reauthGrant:refreshTokenSchema}).strict();
export const accountDeviceSessionSchema = z.object({sessionId:z.uuid(),platform:z.enum(['ios','android','desktop']).nullable(),deviceLabel:z.string().max(100).nullable(),
  authMethod:z.enum(['email','apple','child']),authenticatedAt:z.iso.datetime(),lastSeenAt:z.iso.datetime(),expiresAt:z.iso.datetime(),current:z.boolean()}).strict();
export const accountDeviceSessionsPageSchema = z.object({items:z.array(accountDeviceSessionSchema).max(25),nextCursor:z.uuid().nullable()}).strict();
export type AccountDeviceSession=z.infer<typeof accountDeviceSessionSchema>;
export type AccountDeviceSessionsPage=z.infer<typeof accountDeviceSessionsPageSchema>;
export type EmailChallengeRequest = z.infer<typeof emailChallengeRequestSchema>;
export type EmailRegisterConfirm = z.infer<typeof emailRegisterConfirmSchema>;
export type RegistrationPolicyDocument = z.infer<typeof registrationPolicyDocumentSchema>;
export type RegistrationPolicy = z.infer<typeof registrationPolicySchema>;
export type EmailLogin = z.infer<typeof emailLoginSchema>;
export type EmailPasswordResetConfirm = z.infer<typeof emailPasswordResetConfirmSchema>;
export type EmailLinkRequest = z.infer<typeof emailLinkRequestSchema>;
export type EmailLinkConfirm = z.infer<typeof emailLinkConfirmSchema>;
