import { z } from 'zod';
import { refreshTokenSchema } from './auth.js';

// Strict read-only summary of the login methods an authenticated subject can use right now
// (design section 12.1 / API table 14.2 `GET /me/identities`). It answers one question for the
// account UI — which ways can this account still sign in with — and is deliberately not a
// binding inventory: a revoked external identity, an address with login disabled, a stored
// profile address without a password or a subject that is no longer active simply is not a
// usable login method and is absent from this payload.
//
// No provider secret, refresh credential, full address, external provider subject, provider
// namespace or provider client id belongs here. Namespace and client id are internal provider
// routing detail, and the provider subject is the identifier the design forbids returning; a
// method handle is stable, non-secret correlation data that a client may display and later
// present to `DELETE /me/identities/{identityId}`.

// One lowercase UUID per kind-prefixed handle. The prefix keeps the handle unambiguous for the
// future unbind route, because email/password and external identities live in separate tables,
// and it keeps a handle from ever being a row id without a type.
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const methodHandleSchema = (kind: 'email' | 'apple') => z.string().regex(new RegExp(`^${kind}:${uuidPattern}$`));
const methodHandle = (kind: 'email' | 'apple', rowId: string) => methodHandleSchema(kind).parse(`${kind}:${rowId}`);

/** Stable handle for the subject's email/password login method. */
export const emailLoginMethodId = (rowId: string) => methodHandle('email', rowId);
/** Stable handle for one active external Apple identity of the subject. */
export const appleLoginMethodId = (rowId: string) => methodHandle('apple', rowId);

// `DELETE /me/identities/{identityId}` receives the same handle this summary returned. This slice
// implements exactly one kind of removal: the caller's own verified email plus password login. The
// handle stays strict — one lower-case `email:` UUID and nothing else — so an Apple handle, a bare
// row id or a differently cased value can never be routed into the email unbind path by accident.
export const emailLoginMethodIdSchema = methodHandleSchema('email');
/** Row id behind an email handle, or null when the value is not exactly `email:<lower-case uuid>`. */
export function parseEmailLoginMethodId(value: string): string | null {
  return emailLoginMethodIdSchema.safeParse(value).success ? value.slice('email:'.length) : null;
}

/** Body of the unbind request: one action-bound single-use proof, and no self-reported identity. */
export const unlinkIdentityRequestSchema = z.object({reauthGrant: refreshTokenSchema}).strict();

// Masked address rule, not a formatting convention: the first local character and the domain are
// kept, everything between them is hidden, and a masked value can never contain a second `@`.
// The `u` flag keeps an astral first character (for example an emoji address) one code point, so a
// mask built from that character still matches instead of failing on a lone surrogate.
export const maskedAccountEmailSchema = z.string().max(300).regex(/^([^@\s]•••@[^@\s]+|••••)$/u);

// `status` is part of the contract so a client renders availability instead of inferring it from
// presence. Only currently usable methods are listed, so it is always `active`; a future
// non-active state must be added here deliberately rather than guessed by a client.
const activeStatus = z.literal('active');

export const accountEmailLoginMethodSchema = z.object({
  identityId: methodHandleSchema('email'),
  kind: z.literal('email_password'),
  status: activeStatus,
  emailMask: maskedAccountEmailSchema,
}).strict();

export const accountAppleLoginMethodSchema = z.object({
  identityId: methodHandleSchema('apple'),
  kind: z.literal('apple'),
  status: activeStatus,
}).strict();

export const accountLoginMethodSchema = z.discriminatedUnion('kind', [
  accountEmailLoginMethodSchema, accountAppleLoginMethodSchema,
]);

/** An empty list is a truthful answer (for example a child subject), so it is not an error. */
export const accountLoginMethodsSchema = z.object({
  items: z.array(accountLoginMethodSchema).max(20),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.items.map((item) => item.identityId)).size !== value.items.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate login method handle' });
});

export type AccountEmailLoginMethod = z.infer<typeof accountEmailLoginMethodSchema>;
export type AccountAppleLoginMethod = z.infer<typeof accountAppleLoginMethodSchema>;
export type AccountLoginMethod = z.infer<typeof accountLoginMethodSchema>;
export type AccountLoginMethods = z.infer<typeof accountLoginMethodsSchema>;
export type UnlinkIdentityRequest = z.infer<typeof unlinkIdentityRequestSchema>;
