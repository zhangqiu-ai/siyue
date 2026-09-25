import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { parseEmailLoginMethodId } from '@siyue/contracts';
import { transaction } from '../../adapters/postgres/database.js';
import { AuthError, type SessionService } from './sessions.js';

const day = 86_400_000;

/** Notice sent to the address that loses the login method. */
export interface EmailUnlinkedNotice {to: string; locale: 'zh-CN' | 'en-US';}

/**
 * Security-notice port of the unbind transaction. The caller owns the transaction, so the notice
 * commits with the removal or not at all, and this module never talks to a transport itself.
 */
export interface SecurityNotices {
  emailUnlinked(client: PoolClient, notice: EmailUnlinkedNotice, subjectId: string, now: Date, expires: Date): Promise<void>;
}

export interface UnlinkEmailLoginMethodInput {
  /** Current access bearer: subject, session and credential version come from it, never the body. */
  accessToken: string;
  /** Strict `email:<row id>` handle from `GET /me/identities`. */
  identityId: string;
  /** Single-use, action-bound `unlink-identity` proof owned by the calling session. */
  reauthGrant: string;
  requestId: string;
}

/**
 * Safety logic behind `DELETE /me/identities/{identityId}` for the one method this slice supports:
 * the calling subject's own verified email plus password login (design 12.1/12.3, API table 14.2).
 * Apple unbind is deliberately absent, so an `apple:` handle is not a request this service serves.
 *
 * The decision and every side effect run in one transaction under the subject row lock that
 * `verifyForMutation` takes. Two concurrent unbinds therefore cannot each conclude that a method
 * remains, and the subject can never end up without a usable way to sign in:
 * - the subject must keep a login method that really works, which today means an active Apple
 *   identity whose provider credential is still stored. Otherwise nothing is removed and the
 *   caller gets `AUTH_LAST_METHOD_REQUIRED`;
 * - refusals are decided before the single-use grant is spent, so a refused or failed attempt
 *   leaves the grant usable and the account exactly as it was;
 * - a successful removal deletes only this subject's address row, drops the shared password
 *   credential when no other login address remains, queues the security notice to the removed
 *   address, increases `credential_version`, revokes every session, refresh token and other
 *   reauth grant of the subject, supersedes the pending challenges of that subject and address
 *   with their queued mail, and records one minimal audit event.
 *
 * Nothing here merges accounts or deletes a subject. A refresh credential, the external identity,
 * the provider namespace and the provider client id are never touched on this path.
 */
export function createIdentityUnlinkService(pool: Pool, sessions: SessionService, notices: SecurityNotices,
  clock: () => Date = () => new Date()) {
  /** The only other method type that exists today: active Apple identity with its provider credential. */
  async function usableAppleMethod(client: PoolClient, subjectId: string) {
    const remaining = await client.query(`SELECT 1
        FROM siyue.external_identities i
        JOIN siyue.subjects s ON s.id=i.subject_id
        JOIN siyue.apple_provider_credentials c ON c.identity_id=i.id
       WHERE i.subject_id=$1 AND i.provider='apple' AND i.status='active'
         AND s.status='active' AND s.kind='adult' AND length(c.refresh_ciphertext)>0
       LIMIT 1`, [subjectId]);
    return (remaining.rowCount ?? 0) > 0;
  }
  /** Minimal audit trail: who did it, from which session, and what happened. Never an address. */
  async function audit(client: PoolClient, subjectId: string, sessionId: string, requestId: string,
    outcome: 'success' | 'rejected', metadata: Record<string, string>, now: Date) {
    await client.query(`INSERT INTO siyue.security_events(id,event_type,subject_id,session_id,request_id,outcome,redacted_metadata,occurred_at,expires_at)
      VALUES($1,'identity.unlink-email',$2,$3,$4,$5,$6::jsonb,$7,$8)`,
    [randomUUID(), subjectId, sessionId, requestId, outcome, JSON.stringify(metadata), now, new Date(+now + 30 * day)]);
  }
  return {
    async unlinkEmailLoginMethod(input: UnlinkEmailLoginMethodInput): Promise<void> {
      const rowId = parseEmailLoginMethodId(input.identityId);
      // A malformed handle and an Apple handle are refused before any database work, so the Apple
      // unbind this slice does not implement cannot be reached through the email path.
      if (rowId === null) throw new AuthError('AUTH_INVALID_REQUEST', 400);
      const refusal = await transaction(pool, async client => {
        const session = await sessions.verifyForMutation(client, input.accessToken);
        const now = clock();
        const address = (await client.query<{id: string; email_normalized: string; locale: 'zh-CN' | 'en-US'}>(`SELECT e.id,e.email_normalized,s.locale
            FROM siyue.account_emails e JOIN siyue.subjects s ON s.id=e.subject_id
           WHERE e.id=$1 AND e.subject_id=$2 AND e.login_enabled AND e.verified_at IS NOT NULL
             AND EXISTS (SELECT 1 FROM siyue.password_credentials c WHERE c.subject_id=e.subject_id)
           FOR UPDATE OF e`, [rowId, session.subjectId])).rows[0];
        // Another subject's handle, an unknown handle and an already removed handle give the same
        // answer: this subject has no such method, and nothing is written.
        if (!address) throw new AuthError('AUTH_IDENTITY_NOT_FOUND', 404);
        // Design 12.3: the subject must keep at least one login method that really works. A
        // revoked identity, an identity without its stored provider credential, a blocked subject
        // and a child subject all fail this check, and the rejection is recorded before the grant
        // is spent so the caller can add another method and retry with the same proof.
        if (!await usableAppleMethod(client, session.subjectId)) {
          await audit(client, session.subjectId, session.sessionId, input.requestId, 'rejected', {reason: 'last_method_required'}, now);
          return {code: 'AUTH_LAST_METHOD_REQUIRED', status: 409};
        }
        // Wrong action, another session's grant, an expired or already spent grant fail here and
        // roll the transaction back, so a refused attempt leaves the proof usable.
        await sessions.consumeReauth(client, session.sessionId, input.reauthGrant, 'unlink-identity');
        // The notice is queued in the same transaction, on the address that is about to disappear.
        await notices.emailUnlinked(client, {to: address.email_normalized, locale: address.locale},
          session.subjectId, now, new Date(+now + day));
        // Only this subject's own address row is removed; a subject that shares its password
        // credential with another login address keeps that credential. No subject row is merged
        // or deleted, and the account keeps its identity, family and space ownership.
        const otherAddress = (await client.query(
          'SELECT 1 FROM siyue.account_emails WHERE subject_id=$1 AND id<>$2 AND login_enabled LIMIT 1',
          [session.subjectId, rowId])).rowCount;
        await client.query('DELETE FROM siyue.account_emails WHERE id=$1 AND subject_id=$2', [rowId, session.subjectId]);
        if (!otherAddress) await client.query('DELETE FROM siyue.password_credentials WHERE subject_id=$1', [session.subjectId]);
        // One credential version step and one sign-out of the whole subject: every existing access
        // token stops verifying, refresh chains are gone and other pending grants are spent.
        await client.query('UPDATE siyue.subjects SET credential_version=credential_version+1, updated_at=$2 WHERE id=$1', [session.subjectId, now]);
        await client.query("UPDATE siyue.auth_sessions SET revoked_at=COALESCE(revoked_at,$2), revoke_reason=COALESCE(revoke_reason,'identity_unlinked') WHERE subject_id=$1", [session.subjectId, now]);
        await client.query(`UPDATE siyue.refresh_tokens SET revoked_at=COALESCE(revoked_at,$2), retry_ciphertext=NULL, retry_expires_at=NULL
           WHERE session_id IN(SELECT id FROM siyue.auth_sessions WHERE subject_id=$1)`, [session.subjectId, now]);
        await client.query('UPDATE siyue.reauth_grants SET consumed_at=COALESCE(consumed_at,$2) WHERE subject_id=$1', [session.subjectId, now]);
        // Challenges of this subject or this address can no longer prove anything, and mail already
        // queued for them must not arrive after the method is gone. The notice above keeps its own
        // aggregate id, so this cleanup cannot cancel the notice that explains the removal.
        await client.query(`UPDATE siyue.outbox_jobs SET status='cancelled',payload_ciphertext=NULL,completed_at=$2
           WHERE status='pending' AND aggregate_id IN(SELECT id FROM siyue.email_challenges WHERE subject_id=$1 OR email_normalized=$3)`,
        [session.subjectId, now, address.email_normalized]);
        await client.query("UPDATE siyue.email_challenges SET status='superseded' WHERE status='pending' AND (subject_id=$1 OR email_normalized=$2)",
          [session.subjectId, address.email_normalized]);
        await audit(client, session.subjectId, session.sessionId, input.requestId, 'success', {kind: 'email_password'}, now);
        return null;
      });
      if (refusal) throw new AuthError(refusal.code, refusal.status);
    },
  };
}
export type IdentityUnlinkService = ReturnType<typeof createIdentityUnlinkService>;
