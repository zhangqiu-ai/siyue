import type { Pool } from 'pg';
import { accountLoginMethodsSchema, appleLoginMethodId, emailLoginMethodId,
  type AccountLoginMethods } from '@siyue/contracts';
import { transaction } from '../../adapters/postgres/database.js';

/** Display mask for a login address: first local character, hidden middle, unchanged domain. */
export function maskLoginEmail(address: string): string {
  const at = address.lastIndexOf('@');
  const first = at > 0 ? [...address.slice(0, at)][0] : undefined;
  // Anything that is not a plain local@domain value (unreachable for an address that passed
  // email validation before it was stored) is hidden completely instead of partially echoed.
  return first && at < address.length - 1 ? `${first}•••@${address.slice(at + 1)}` : '••••';
}

/** Read-only adapter over existing identity tables. It writes nothing and owns no migration. */
export function createIdentitySummary(pool: Pool) {
  return {
    /**
     * Currently usable login methods of one already-verified subject. The filters mirror the
     * login paths instead of guessing: email login joins an account email with the subject's
     * password credential and requires the subject to stay active and adult, and external login
     * requires an active identity of an active adult subject. A disabled address, a revoked
     * identity, a profile address without a password and a blocked or deleted subject therefore
     * produce no entry.
     */
    async list(subjectId: string): Promise<AccountLoginMethods> {
      return transaction(pool, async client => {
        const emails = await client.query<{id: string; email_original: string}>(
          `SELECT e.id,e.email_original FROM siyue.account_emails e
             JOIN siyue.subjects s ON s.id=e.subject_id
             JOIN siyue.password_credentials c ON c.subject_id=e.subject_id
            WHERE e.subject_id=$1 AND e.login_enabled AND e.verified_at IS NOT NULL
              AND s.status='active' AND s.kind='adult'
            ORDER BY e.created_at,e.id`,
          [subjectId],
        );
        const apples = await client.query<{id: string}>(
          `SELECT i.id FROM siyue.external_identities i
             JOIN siyue.subjects s ON s.id=i.subject_id
             JOIN siyue.apple_provider_credentials c ON c.identity_id=i.id
            WHERE i.subject_id=$1 AND i.provider='apple' AND i.status='active'
              AND s.status='active' AND s.kind='adult' AND length(c.refresh_ciphertext)>0
            ORDER BY i.created_at,i.id`,
          [subjectId],
        );
        // Only the handle, the kind, availability and the masked address leave this boundary; the
        // strict contract parse rejects anything else before it can be serialized.
        return accountLoginMethodsSchema.parse({items: [
          ...emails.rows.map(row => ({identityId: emailLoginMethodId(row.id), kind: 'email_password' as const,
            status: 'active' as const, emailMask: maskLoginEmail(row.email_original)})),
          ...apples.rows.map(row => ({identityId: appleLoginMethodId(row.id), kind: 'apple' as const, status: 'active' as const})),
        ]});
      });
    },
  };
}
export type IdentitySummary = ReturnType<typeof createIdentitySummary>;
