import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { sessionTokensSchema, reauthActionSchema, type SessionTokens, type ReauthAction, type VerifiedAccountSession } from '@siyue/contracts';
import { transaction } from '../../adapters/postgres/database.js';
import { digest, matchesDigest, opaqueToken, parseOpaque, type AccessSigner, type RecoveryCipher } from '../../adapters/crypto/auth-crypto.js';
import type { LoginDecision } from '../../account-deletion-ledger/login-gate.js';

export class AuthError extends Error {
  constructor(readonly code: string, readonly status = 401) { super(code); }
}
/**
 * Optional per-subject login gate over the independent deletion anti-revival ledger. It is injected,
 * so the session service has no storage dependency on the ledger and existing callers that omit it
 * keep the previous behavior. `loginDecision` must be read-only: this seam rejects; it never deletes
 * data or mutates the ledger.
 */
export interface SessionLoginGate {
  loginDecision(subjectId: string): Promise<LoginDecision>;
}
export interface SessionServiceDependencies {
  loginGate?: SessionLoginGate;
}
interface SessionRow {
  id: string; subject_id: string; kind: 'adult' | 'child'; status: string;
  credential_version: number; current_version: number;
  idle_expires_at: Date; absolute_expires_at: Date; grant_expires_at: Date | null; revoked_at: Date | null;
  installation_id: string; auth_method: 'email' | 'apple' | 'child'; device_grant_id: string | null;
  device_grant_child_id: string | null; device_grant_installation_id: string | null;
  device_grant_expires_at: Date | null; device_grant_revoked_at: Date | null;
  device_grant_guardian_version: number | null; device_grant_guardian_credential_version: number | null;
  guardian_relationship_active: boolean | null; guardian_relationship_version: number | null;
  guardian_status: string | null; guardian_kind: string | null; guardian_current_credential_version: number | null;
  guardian_consent_id: string | null; guardian_consent_withdrawn_at: Date | null;
  grant_family_status: string | null; child_membership_active: boolean | null; guardian_membership_active: boolean | null;
}
const day = 86_400_000;
const denied = () => new AuthError('AUTH_SESSION_INVALID');
const loginBlocked = () => new AuthError('AUTH_SESSION_INVALID');
const loginUnavailable = () => new AuthError('AUTH_TEMPORARILY_UNAVAILABLE', 503);
const limit = (row: SessionRow) => Math.min(+row.idle_expires_at, +row.absolute_expires_at,
  row.grant_expires_at ? +row.grant_expires_at : Infinity,
  row.device_grant_expires_at ? +row.device_grant_expires_at : Infinity);
function valid(row: SessionRow | undefined, now: Date): row is SessionRow {
  if (!row || row.status !== 'active' || row.revoked_at !== null || row.credential_version !== row.current_version || limit(row) <= +now)
    return false;
  if (row.kind !== 'child') return row.device_grant_id === null && row.auth_method !== 'child';
  // The session's grant-expiry copy is only a ceiling. Every request and refresh reads the current
  // device grant, guardian relationship and family state so a revoked grant cannot keep working
  // until the access token's 15-minute expiry.
  return row.auth_method === 'child' && row.grant_expires_at !== null && row.device_grant_id !== null && row.device_grant_child_id === row.subject_id &&
    row.device_grant_installation_id === row.installation_id && row.device_grant_revoked_at === null &&
    row.device_grant_expires_at !== null && +row.device_grant_expires_at > +now &&
    row.device_grant_guardian_version === row.guardian_relationship_version && row.guardian_relationship_active === true &&
    row.device_grant_guardian_credential_version === row.guardian_current_credential_version && row.guardian_status === 'active' && row.guardian_kind === 'adult' &&
    row.guardian_consent_id !== null && row.guardian_consent_withdrawn_at === null &&
    row.grant_family_status === 'active' && row.child_membership_active === true && row.guardian_membership_active === true;
}
async function getSession(client: PoolClient, id: string, lock: boolean): Promise<SessionRow | undefined> {
  if (lock) {
    // All mutations use subject -> session -> token/grant order.
    const ref = (await client.query('SELECT subject_id FROM siyue.auth_sessions WHERE id=$1', [id])).rows[0];
    if (!ref) return undefined;
    await client.query('SELECT id FROM siyue.subjects WHERE id=$1 FOR UPDATE', [ref.subject_id]);
  }
  const result = await client.query<SessionRow>(`SELECT s.*, p.kind, p.status, p.credential_version AS current_version,
      g.child_subject_id AS device_grant_child_id, g.installation_id AS device_grant_installation_id,
      g.expires_at AS device_grant_expires_at, g.revoked_at AS device_grant_revoked_at,
      g.guardian_relationship_version AS device_grant_guardian_version,
      g.guardian_credential_version AS device_grant_guardian_credential_version,
      r.active AS guardian_relationship_active, r.version AS guardian_relationship_version,
      guardian.status AS guardian_status, guardian.kind AS guardian_kind,
      guardian.credential_version AS guardian_current_credential_version,
      consent.id AS guardian_consent_id, consent.withdrawn_at AS guardian_consent_withdrawn_at,
      f.status AS grant_family_status, member.active AS child_membership_active,
      guardian_member.active AS guardian_membership_active
    FROM siyue.auth_sessions s JOIN siyue.subjects p ON p.id=s.subject_id
    LEFT JOIN siyue.device_grants g ON g.id=s.device_grant_id
    LEFT JOIN siyue.guardian_relationships r ON r.family_id=g.family_id AND r.child_subject_id=g.child_subject_id AND r.guardian_subject_id=g.guardian_id
    LEFT JOIN siyue.subjects guardian ON guardian.id=g.guardian_id
    LEFT JOIN siyue.consent_records consent ON consent.id=r.consent_record_id
      AND consent.actor_subject_id=r.guardian_subject_id AND consent.subject_id=r.child_subject_id
      AND consent.purpose='child-guardianship'
    LEFT JOIN siyue.families f ON f.id=g.family_id
    LEFT JOIN siyue.family_memberships member ON member.family_id=g.family_id AND member.subject_id=g.child_subject_id
    LEFT JOIN siyue.family_memberships guardian_member ON guardian_member.family_id=g.family_id AND guardian_member.subject_id=g.guardian_id
    WHERE s.id=$1 ${lock ? 'FOR UPDATE OF s' : ''}`, [id]);
  return result.rows[0];
}
export function createSessionService(pool: Pool, signer: AccessSigner, cipher: RecoveryCipher,
  clock = () => new Date(), dependencies: SessionServiceDependencies = {}) {
  async function tokens(row: SessionRow, refreshToken: string, refreshExpiresAt: Date, now: Date): Promise<SessionTokens> {
    const expires = new Date(Math.floor(Math.min(+now+900_000, limit(row))/1000)*1000);
    return sessionTokensSchema.parse({tokenType:'Bearer',
      accessToken:await signer.sign(row.subject_id,row.id,row.credential_version,now,expires),
      accessExpiresAt:expires.toISOString(), refreshToken, refreshExpiresAt:refreshExpiresAt.toISOString(),
      sessionAbsoluteExpiresAt:row.absolute_expires_at.toISOString(),
      session:{subjectId:row.subject_id,subjectKind:row.kind,sessionId:row.id,expiresAt:expires.toISOString()}});
  }
  async function revoke(client: PoolClient, sessionId: string, reason: string, now: Date) {
    await client.query('UPDATE siyue.auth_sessions SET revoked_at=COALESCE(revoked_at,$2), revoke_reason=COALESCE(revoke_reason,$3) WHERE id=$1', [sessionId,now,reason]);
    await client.query('UPDATE siyue.refresh_tokens SET revoked_at=COALESCE(revoked_at,$2), retry_ciphertext=NULL, retry_expires_at=NULL WHERE session_id=$1', [sessionId,now]);
    await client.query('UPDATE siyue.reauth_grants SET consumed_at=COALESCE(consumed_at,$2) WHERE session_id=$1', [sessionId,now]);
  }
  /**
   * Per-subject deletion-ledger check. Called before an issuance/refresh transaction may write, and
   * from `verify` only after its read transaction has closed. A known deletion or unresolved deletion
   * is a non-retryable rejection; an unreadable or unreachable ledger is deliberately temporary so
   * callers can retry instead of treating it as a credential failure. Omitting the gate is a no-op.
   */
  async function assertLoginAllowed(subjectId: string): Promise<void> {
    const loginGate = dependencies.loginGate;
    if (!loginGate) return;
    let decision: LoginDecision;
    try { decision = await loginGate.loginDecision(subjectId); }
    catch { throw loginUnavailable(); }
    // Trust only the one allow shape. Anything unrecognised, including a thrown or malformed answer,
    // fails closed; infrastructure-shaped answers stay retryable.
    if (decision && decision.allow === true && decision.reason === 'ledger_clear') return;
    if (decision && decision.allow === false &&
        (decision.reason === 'deletion_accepted' || decision.reason === 'deletion_prepared_unresolved' ||
         decision.reason === 'invalid_subject')) throw loginBlocked();
    throw loginUnavailable();
  }
  const service = {
    /** Internal adapter seam: caller must have verified the login method. No HTTP fixture login. */
    async issue(client: PoolClient, subjectId: string, installationId: string, authMethod: 'email' | 'apple') {
      if (!installationId.trim() || installationId.length > 200) throw new AuthError('AUTH_INVALID_REQUEST');
      const now = clock();
      const subject = (await client.query("SELECT * FROM siyue.subjects WHERE id=$1 FOR UPDATE", [subjectId])).rows[0];
      if (!subject || subject.status !== 'active' || subject.kind !== 'adult') throw denied();
      await assertLoginAllowed(subjectId);
      const id = randomUUID(); const refresh = opaqueToken();
      const absolute = new Date(+now+180*day); const idle = new Date(+now+30*day);
      await client.query(`INSERT INTO siyue.auth_sessions(id,subject_id,installation_id,auth_method,credential_version,
        authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at) VALUES($1,$2,$3,$4,$5,$6,$6,$6,$7,$8)`,
      [id,subjectId,installationId,authMethod,subject.credential_version,now,idle,absolute]);
      await client.query('INSERT INTO siyue.refresh_tokens(id,session_id,secret_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,$5)', [refresh.id,id,refresh.hash,now,idle]);
      const row = await getSession(client,id,false);
      if (!valid(row,now)) throw denied();
      return tokens(row,refresh.value,idle,now);
    },
    /** Internal only: called in the same transaction that consumes an approved pairing and creates its grant. */
    async issueChild(client: PoolClient, grantId: string) {
      const now = clock();
      const ref = (await client.query<{child_subject_id:string}>(
        'SELECT child_subject_id FROM siyue.device_grants WHERE id=$1', [grantId])).rows[0];
      if (!ref) throw denied();
      await client.query('SELECT id FROM siyue.subjects WHERE id=$1 FOR UPDATE', [ref.child_subject_id]);
      const grant = (await client.query<{id:string;child_subject_id:string;installation_id:string;expires_at:Date}>(
        'SELECT id,child_subject_id,installation_id,expires_at FROM siyue.device_grants WHERE id=$1 FOR UPDATE', [grantId])).rows[0];
      if (!grant) throw denied();
      await assertLoginAllowed(grant.child_subject_id);
      const id = randomUUID(), refresh = opaqueToken();
      const expires = new Date(Math.min(+now + 30 * day, +grant.expires_at));
      await client.query(`INSERT INTO siyue.auth_sessions(id,subject_id,installation_id,auth_method,device_grant_id,credential_version,
        authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at,grant_expires_at)
        SELECT $1,p.id,$2,'child',$3,p.credential_version,$4,$4,$4,$5,$5,$6 FROM siyue.subjects p WHERE p.id=$7 AND p.kind='child' AND p.status='active'`,
      [id,grant.installation_id,grant.id,now,expires,grant.expires_at,grant.child_subject_id]);
      const row = await getSession(client,id,false);
      if (!valid(row,now)) throw denied();
      await client.query('INSERT INTO siyue.refresh_tokens(id,session_id,secret_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,$5)',
        [refresh.id,id,refresh.hash,now,expires]);
      return tokens(row,refresh.value,expires,now);
    },
    async verify(accessToken: string, signal?: AbortSignal): Promise<VerifiedAccountSession> {
      if (signal?.aborted) throw denied();
      const now = clock();
      let claims;
      try { claims = await signer.verify(accessToken,now); } catch { throw new AuthError('AUTH_ACCESS_INVALID'); }
      const verified = await transaction(pool, async client => {
        const row = await getSession(client,claims.sid,false);
        if (signal?.aborted || !valid(row,clock()) || claims.sub !== row.subject_id || claims.cv !== row.current_version) throw denied();
        return {subjectId:row.subject_id,subjectKind:row.kind,sessionId:row.id,
          expiresAt:new Date(Math.min(claims.exp*1000,limit(row))).toISOString()};
      });
      // The signed token and the subject are resolved first; the ledger read happens after the
      // read-only transaction closes so no row lock is held during it.
      await assertLoginAllowed(verified.subjectId);
      if (signal?.aborted) throw denied();
      return verified;
    },
    /** Verify and lock the subject/session inside a caller-owned mutation transaction. */
    async verifyForMutation(client:PoolClient,accessToken:string):Promise<VerifiedAccountSession> {
      const now=clock();let claims;
      try {claims=await signer.verify(accessToken,now);} catch {throw new AuthError('AUTH_ACCESS_INVALID');}
      const row=await getSession(client,claims.sid,true);
      if(!valid(row,clock())||claims.sub!==row.subject_id||claims.cv!==row.current_version)throw denied();
      // Caller-owned mutation transaction: a denial throws before the caller may write, so its whole
      // transaction rolls back rather than committing a mutation for a blocked subject.
      await assertLoginAllowed(row.subject_id);
      return {subjectId:row.subject_id,subjectKind:row.kind,sessionId:row.id,expiresAt:new Date(Math.min(claims.exp*1000,limit(row))).toISOString()};
    },
    async refresh(value: string, rotationId: string): Promise<SessionTokens> {
      let proof;
      try { proof = parseOpaque(value); } catch { throw denied(); }
      const requestHash = digest(rotationId);
      const result = await transaction(pool, async client => {
        const ref = (await client.query('SELECT session_id FROM siyue.refresh_tokens WHERE id=$1', [proof.id])).rows[0];
        if (!ref) throw denied();
        const row = await getSession(client,ref.session_id,true);
        const token = (await client.query('SELECT * FROM siyue.refresh_tokens WHERE id=$1 FOR UPDATE', [proof.id])).rows[0];
        const now = clock();
        if (!valid(row,now) || !token || !matchesDigest(proof.secret,token.secret_hash) || token.revoked_at) throw denied();
        // Before rotation or replay revocation: a blocked subject must not commit either write.
        await assertLoginAllowed(row.subject_id);
        if (token.used_at) {
          if (token.rotation_request_hash !== requestHash) {
            await revoke(client,row.id,'refresh_replay',now);
            return new AuthError('AUTH_REFRESH_REPLAYED');
          }
          if (!token.retry_ciphertext || !token.retry_expires_at || +token.retry_expires_at <= +now) return new AuthError('AUTH_REFRESH_RECOVERY_EXPIRED');
          const successor = (await client.query('SELECT used_at,revoked_at,expires_at FROM siyue.refresh_tokens WHERE id=$1', [token.replaced_by])).rows[0];
          if (!successor || successor.used_at || successor.revoked_at || +successor.expires_at <= +now) return new AuthError('AUTH_REFRESH_RECOVERY_EXPIRED');
          return sessionTokensSchema.parse(cipher.open(token.retry_ciphertext, `refresh:${token.id}:${requestHash}`));
        }
        if (+token.expires_at <= +now) throw denied();
        const successor = opaqueToken();
        const expires = new Date(Math.min(+now+30*day,+row.absolute_expires_at,row.grant_expires_at ? +row.grant_expires_at : Infinity));
        await client.query('INSERT INTO siyue.refresh_tokens(id,session_id,secret_hash,issued_at,expires_at) VALUES($1,$2,$3,$4,$5)', [successor.id,row.id,successor.hash,now,expires]);
        await client.query('UPDATE siyue.auth_sessions SET idle_expires_at=$2,last_seen_at=$3 WHERE id=$1', [row.id,expires,now]);
        row.idle_expires_at = expires;
        const response = await tokens(row,successor.value,expires,now);
        await client.query(`UPDATE siyue.refresh_tokens SET used_at=$2,replaced_by=$3,rotation_request_hash=$4,retry_ciphertext=$5,retry_expires_at=$6 WHERE id=$1`,
          [token.id,now,successor.id,requestHash,cipher.seal(response,`refresh:${token.id}:${requestHash}`),new Date(+now+60_000)]);
        return response;
      });
      // Throw outside transaction so replay revocation remains committed.
      if (result instanceof AuthError) throw result;
      return result;
    },
    async logoutRefresh(value: string) {
      let proof;
      try { proof = parseOpaque(value); } catch { throw denied(); }
      await transaction(pool, async client => {
        const ref = (await client.query('SELECT session_id FROM siyue.refresh_tokens WHERE id=$1', [proof.id])).rows[0];
        if (!ref) throw denied();
        const row = await getSession(client,ref.session_id,true);
        const token = (await client.query('SELECT secret_hash FROM siyue.refresh_tokens WHERE id=$1 FOR UPDATE', [proof.id])).rows[0];
        if (!row || !token || !matchesDigest(proof.secret,token.secret_hash)) throw denied();
        await revoke(client,row.id,'logout',clock());
      });
    },
    async logoutAccess(value: string) {
      const verified = await service.verify(value);
      await transaction(pool, async client => {
        const row = await getSession(client,verified.sessionId,true);
        if (!valid(row,clock()) || row.subject_id !== verified.subjectId) throw denied();
        await revoke(client,row.id,'logout',clock());
      });
    },
    async listDeviceSessions(accessToken:string,cursor?:string,pageSize=25) {
      if(!Number.isInteger(pageSize)||pageSize<1||pageSize>25)throw new AuthError('AUTH_INVALID_REQUEST',400);
      const verified=await service.verify(accessToken);
      const now=clock();
      return transaction(pool,async client=>{
        let before:Date|undefined;
        if(cursor!==undefined){
          const row=(await client.query<{created_at:Date}>('SELECT created_at FROM siyue.auth_sessions WHERE id=$1 AND subject_id=$2',[cursor,verified.subjectId])).rows[0];
          if(!row)throw new AuthError('AUTH_INVALID_REQUEST',400);
          before=row.created_at;
        }
        const result=await client.query<{id:string;platform:string|null;device_label:string|null;auth_method:'email'|'apple'|'child';authenticated_at:Date;last_seen_at:Date;expires_at:Date}>(
          `SELECT s.id,s.platform,s.device_label,s.auth_method,s.authenticated_at,s.last_seen_at,
             LEAST(s.idle_expires_at,s.absolute_expires_at,COALESCE(s.grant_expires_at,'infinity'::timestamptz)) AS expires_at
           FROM siyue.auth_sessions s JOIN siyue.subjects p ON p.id=s.subject_id
           WHERE s.subject_id=$1 AND s.revoked_at IS NULL AND s.idle_expires_at>$2 AND s.absolute_expires_at>$2
             AND (s.grant_expires_at IS NULL OR s.grant_expires_at>$2) AND s.credential_version=p.credential_version
             AND ($3::timestamptz IS NULL OR (s.created_at,s.id)<($3,$4::uuid))
           ORDER BY s.created_at DESC,s.id DESC LIMIT $5`,[verified.subjectId,now,before??null,cursor??null,pageSize+1]);
        const hasMore=result.rows.length>pageSize,rows=result.rows.slice(0,pageSize);
        return {items:rows.map(row=>({sessionId:row.id,platform:row.platform,deviceLabel:row.device_label,authMethod:row.auth_method,
          authenticatedAt:row.authenticated_at.toISOString(),lastSeenAt:row.last_seen_at.toISOString(),expiresAt:row.expires_at.toISOString(),current:row.id===verified.sessionId})),
          nextCursor:hasMore?rows.at(-1)!.id:null};
      });
    },
    async revokeDeviceSession(accessToken:string,targetSessionId:string,reauthGrant?:string,requestId='session-revoke') {
      await transaction(pool,async client=>{
        const verified=await service.verifyForMutation(client,accessToken),now=clock();
        const target=(await client.query<{id:string;revoked_at:Date|null}>('SELECT id,revoked_at FROM siyue.auth_sessions WHERE id=$1 AND subject_id=$2 FOR UPDATE',[targetSessionId,verified.subjectId])).rows[0];
        if(!target)throw new AuthError('AUTH_SESSION_INVALID');
        if(target.revoked_at!==null)return;
        if(target.id!==verified.sessionId){if(!reauthGrant)throw new AuthError('AUTH_REAUTH_REQUIRED');await service.consumeReauth(client,verified.sessionId,reauthGrant,'revoke-session');}
        await revoke(client,target.id,'user_revoked',now);
        await client.query(`INSERT INTO siyue.security_events(id,event_type,subject_id,session_id,request_id,outcome,redacted_metadata,occurred_at,expires_at)
          VALUES($1,'session.revoke',$2,$3,$4,'success',jsonb_build_object('targetSessionId',$5::uuid),$6,$7)`,
          [randomUUID(),verified.subjectId,verified.sessionId,requestId,target.id,now,new Date(+now+30*day)]);
      });
    },
    async revokeAllDeviceSessions(accessToken:string,reauthGrant:string,requestId='sessions-revoke-all') {
      await transaction(pool,async client=>{
        const verified=await service.verifyForMutation(client,accessToken),now=clock();
        await service.consumeReauth(client,verified.sessionId,reauthGrant,'revoke-all-sessions');
        const ids=(await client.query<{id:string}>('SELECT id FROM siyue.auth_sessions WHERE subject_id=$1 AND revoked_at IS NULL FOR UPDATE',[verified.subjectId])).rows;
        for(const row of ids)await revoke(client,row.id,'user_revoked',now);
        await client.query(`INSERT INTO siyue.security_events(id,event_type,subject_id,session_id,request_id,outcome,occurred_at,expires_at)
          VALUES($1,'session.revoke_all',$2,$3,$4,'success',$5,$6)`,[randomUUID(),verified.subjectId,verified.sessionId,requestId,now,new Date(+now+30*day)]);
      });
    },
    /** Call only after fresh verification of this subject's existing credential. */
    async issueReauth(client: PoolClient, sessionId: string, action: ReauthAction) {
      reauthActionSchema.parse(action);
      const row = await getSession(client,sessionId,true); const now = clock();
      if (!valid(row,now)) throw denied();
      const grant = opaqueToken(); const expires = new Date(Math.min(+now+300_000,limit(row)));
      await client.query(`INSERT INTO siyue.reauth_grants(id,subject_id,session_id,action,credential_version,secret_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [grant.id,row.subject_id,row.id,action,row.current_version,grant.hash,expires]);
      return {reauthGrant:grant.value,expiresAt:expires.toISOString()};
    },
    async consumeReauth(client: PoolClient, sessionId: string, value: string, action: ReauthAction) {
      let proof;
      try {proof=parseOpaque(value);} catch {throw new AuthError('AUTH_REAUTH_REQUIRED');}
      reauthActionSchema.parse(action);
      const row = await getSession(client,sessionId,true); const now = clock();
      if (!valid(row,now)) throw denied();
      const grant = (await client.query('SELECT * FROM siyue.reauth_grants WHERE id=$1 FOR UPDATE', [proof.id])).rows[0];
      if (!grant || grant.subject_id !== row.subject_id || grant.session_id !== row.id || grant.action !== action ||
          grant.credential_version !== row.current_version || grant.consumed_at || +grant.expires_at <= +now || !matchesDigest(proof.secret,grant.secret_hash)) throw new AuthError('AUTH_REAUTH_REQUIRED');
      await client.query('UPDATE siyue.reauth_grants SET consumed_at=$2 WHERE id=$1', [grant.id,now]);
    },
    async clearExpiredRecovery() {
      await pool.query('UPDATE siyue.refresh_tokens SET retry_ciphertext=NULL,retry_expires_at=NULL WHERE retry_expires_at <= $1', [clock()]);
    },
  };
  return service;
}
export type SessionService = ReturnType<typeof createSessionService>;
