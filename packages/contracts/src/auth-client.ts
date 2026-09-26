import { z } from 'zod';
import {familyManagementAcceptanceRequestSchema} from './family-api.js';
import {deletionDependencyDispositionSchema} from './auth-deletion.js';
import { refreshTokenSchema } from './auth.js';
import { emailChallengeRequestSchema,emailRegisterConfirmSchema,emailLoginSchema,emailPasswordResetConfirmSchema,accountPasswordSchema } from './auth-email.js';
import { verifiedAccountSessionSchema } from './account-session.js';
import { emailLoginMethodIdSchema } from './auth-identities.js';

export const authEnvironmentSchema=z.enum(['production','staging','development','test']);
export const authClientErrorCodeSchema=z.enum(['invalid_config','invalid_request','invalid_credentials','challenge_invalid','email_exists','email_already_linked',
  'password_policy','rate_limited','operation_completed','reauth_required','network','unavailable','timeout','cancelled','invalid_response',
  'apple_restart_required','storage_unavailable','storage_corrupt','busy','revocation_queue_full',
  // Removing the last usable login method and removing a method the caller does not have are
  // distinct outcomes: one keeps the account reachable and tells the user to add another way to
  // sign in first, the other means the handle is not (or is no longer) a method of this subject.
  'last_method_required','identity_not_found','deletion_dependencies','deletion_receipt_unrecoverable',
  'deletion_outcome_unknown','deletion_request_conflict','adult_required',
  // The released registration documents changed under an in-flight attempt, or the deployment closed
  // sign-up. Both are decided refusals, not outages: the screen re-reads the public policy and asks for
  // consent again, and a closed deployment answers new requests without a network write.
  'policy_changed','registration_closed']);
export const accountReferenceSchema=z.object({subjectId:z.uuid(),subjectKind:z.enum(['adult','child']),sessionId:z.uuid()}).strict();
export const authRecoverySchema=z.object({
  ...accountReferenceSchema.shape,refreshToken:refreshTokenSchema,refreshExpiresAt:z.iso.datetime(),absoluteExpiresAt:z.iso.datetime(),
  pendingRotationId:z.uuid().nullable(),pendingSince:z.iso.datetime().nullable(),
}).strict().refine(value=>(value.pendingRotationId===null)===(value.pendingSince===null),'incomplete_rotation');
export const authRevocationSchema=z.object({refreshToken:refreshTokenSchema,sessionId:z.uuid(),expiresAt:z.iso.datetime()}).strict();
export const authVaultRecordSchema=z.object({schemaVersion:z.literal(1),environment:authEnvironmentSchema,apiBaseUrl:z.string().url().max(200),
  installationId:z.uuid(),active:authRecoverySchema.nullable(),revocations:z.array(authRevocationSchema).max(4)}).strict();
export const authClientStateSchema=z.object({
  status:z.enum(['bootstrapping','anonymous','authenticating','authenticated','refreshing','offline-available','service-unavailable','reauth-required','secure-storage-unavailable','logging-out']),
  generation:z.number().int().nonnegative(),session:verifiedAccountSessionSchema.nullable(),account:accountReferenceSchema.nullable(),
  error:authClientErrorCodeSchema.nullable(),pendingRevocations:z.number().int().min(0).max(4),passwordChangePending:z.boolean().optional(),deletionPending:z.boolean().optional(),
}).strict().refine(value=>value.status==='authenticated'?value.session!==null:value.session===null,'session_state_mismatch');
export const emailChallengeResponseSchema=z.object({challengeId:z.uuid(),requestSecret:z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt:z.iso.datetime(),resendAfterSeconds:z.number().int().min(0).max(3600)}).strict();
export const authProvidersSchema=z.object({emailPassword:z.object({enabled:z.boolean()}).strict(),apple:z.object({enabled:z.boolean(),platforms:z.array(z.literal('ios')).max(1)}).strict()}).strict();
export type AuthEnvironment=z.infer<typeof authEnvironmentSchema>;
export type AuthClientErrorCode=z.infer<typeof authClientErrorCodeSchema>;
export type AccountReference=z.infer<typeof accountReferenceSchema>;
export type AuthRecovery=z.infer<typeof authRecoverySchema>;
export type AuthVaultRecord=z.infer<typeof authVaultRecordSchema>;
export type AuthClientState=z.infer<typeof authClientStateSchema>;
export type EmailChallengeResponse=z.infer<typeof emailChallengeResponseSchema>;

// Host commands are explicit; there is no URL, token read, storage path or arbitrary fetch operation.
const message={version:z.literal(1),requestId:z.uuid(),generation:z.number().int().nonnegative()};
const keyed={key:z.uuid()};
export const authHostRequestSchema=z.discriminatedUnion('operation',[
  z.object({...message,operation:z.literal('state'),payload:z.object({}).strict()}).strict(),
  z.object({...message,operation:z.literal('restore'),payload:z.object({}).strict()}).strict(),
  z.object({...message,operation:z.literal('providers'),payload:z.object({}).strict()}).strict(),
  // The released terms/privacy versions are a public read: the client renders them and passes the
  // server's own version strings back on confirmation, so this command carries no input at all.
  z.object({...message,operation:z.literal('registration-policy'),payload:z.object({}).strict()}).strict(),
  z.object({...message,operation:z.literal('session'),payload:z.object({}).strict()}).strict(),
  z.object({...message,operation:z.literal('login-methods'),payload:z.object({}).strict()}).strict(),
  z.object({...message,operation:z.literal('deletion-recipients'),payload:z.object({familyId:z.uuid()}).strict()}).strict(),
  z.object({...message,operation:z.literal('family-responsibilities'),payload:z.object({}).strict()}).strict(),
  z.object({...message,operation:z.literal('frozen-family-preview'),payload:z.object({familyId:z.uuid()}).strict()}).strict(),
  z.object({...message,operation:z.literal('accept-frozen-family'),payload:z.object({familyId:z.uuid(),input:familyManagementAcceptanceRequestSchema}).strict()}).strict(),
  z.object({...message,operation:z.literal('family-management-preview'),payload:z.object({familyId:z.uuid()}).strict()}).strict(),
  z.object({...message,operation:z.literal('accept-family-management'),payload:z.object({familyId:z.uuid(),input:familyManagementAcceptanceRequestSchema}).strict()}).strict(),
  z.object({...message,operation:z.literal('deletion-impact'),payload:z.object({}).strict()}).strict(),
  z.object({...message,operation:z.literal('deletion-status'),payload:z.object({}).strict()}).strict(),
  z.object({...message,operation:z.literal('submit-deletion'),payload:z.object({currentPassword:accountPasswordSchema,dependencyDisposition:deletionDependencyDispositionSchema}).strict()}).strict(),
  z.object({...message,operation:z.literal('retry-deletion'),payload:z.object({}).strict()}).strict(),
  z.object({...message,operation:z.literal('logout'),payload:z.object({}).strict()}).strict(),
  z.object({...message,operation:z.literal('login'),payload:emailLoginSchema.omit({installationId:true,platform:true})}).strict(),
  z.object({...message,operation:z.literal('register'),payload:z.object({...keyed,input:emailRegisterConfirmSchema.omit({installationId:true,platform:true})}).strict()}).strict(),
  z.object({...message,operation:z.literal('request-registration'),payload:z.object({...keyed,input:emailChallengeRequestSchema}).strict()}).strict(),
  z.object({...message,operation:z.literal('request-reset'),payload:z.object({...keyed,input:emailChallengeRequestSchema}).strict()}).strict(),
  z.object({...message,operation:z.literal('confirm-reset'),payload:z.object({...keyed,input:emailPasswordResetConfirmSchema}).strict()}).strict(),
  z.object({...message,operation:z.literal('change-password'),payload:z.object({currentPassword:z.string().max(256),newPassword:z.string().max(256),key:z.uuid()}).strict()}).strict(),
  z.object({...message,operation:z.literal('retry-password-change'),payload:z.object({}).strict()}).strict(),
  z.object({...message,operation:z.literal('device-sessions'),payload:z.object({cursor:z.uuid().optional()}).strict()}).strict(),
  z.object({...message,operation:z.literal('revoke-device-session'),payload:z.object({sessionId:z.uuid(),currentPassword:z.string().max(256).optional()}).strict()}).strict(),
  z.object({...message,operation:z.literal('revoke-all-device-sessions'),payload:z.object({currentPassword:z.string().max(256)}).strict()}).strict(),
  // Unbinding one login method is the write counterpart of `login-methods`: the caller sends back the
  // strict `email:` handle that read returned, plus its own current password. The password
  // re-verification, the single-use `unlink-identity` grant and the bearer all stay inside the
  // controller, so no URL, token, grant, subject, address or idempotency key can be attached to this
  // call — and an unknown DELETE outcome is never repeated, so there is nothing to key either.
  z.object({...message,operation:z.literal('unlink-identity'),
    payload:z.object({identityId:emailLoginMethodIdSchema,currentPassword:accountPasswordSchema}).strict()}).strict(),
]);
export type AuthHostRequest=z.infer<typeof authHostRequestSchema>;
