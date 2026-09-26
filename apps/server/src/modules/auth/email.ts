import type {RegistrationPolicy} from '../../registration-policy.js';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { normalizeLoginEmail, emailChallengeRequestSchema, emailRegisterConfirmSchema, emailLoginSchema,
  emailPasswordResetConfirmSchema, emailLinkRequestSchema, emailLinkConfirmSchema, passwordReauthSchema, passwordChangeSchema,
  type EmailChallengeRequest, type EmailRegisterConfirm, type EmailLinkRequest, type EmailLinkConfirm,
  type EmailLogin, type EmailPasswordResetConfirm, type SessionTokens, type ReauthAction } from '@siyue/contracts';
import { digest, matchesDigest, type RecoveryCipher } from '../../adapters/crypto/auth-crypto.js';
import { transaction } from '../../adapters/postgres/database.js';
import { enqueueMail } from '../../adapters/mail/outbox.js';
import { AuthError, type SessionService } from './sessions.js';
import { createEmailStorage, failure, hour, day } from './email-storage.js';
import type { SecurityNotices } from './identity-unlink.js';
import type { PasswordService } from './passwords.js';

type Purpose='register'|'password-reset'|'link-email';
export interface RequestContext {ip:string;requestId:string;}
export interface ChallengeResponse {challengeId:string;requestSecret:string;expiresAt:string;resendAfterSeconds:number;}
interface ChallengeRow {id:string;purpose:Purpose;email_original:string;email_normalized:string;locale:'zh-CN'|'en-US';
  subject_id:string|null;initiating_session_id:string|null;credential_version:number|null;code_mac:string;request_secret_hash:string;status:string;expires_at:Date;attempts:number;}
type Proof={challengeId:string;requestSecret:string;code:string};
/** Link challenges additionally prove the caller is the session that started the binding. */
type ChallengeBinding=(ref:ChallengeRow)=>Promise<{subjectId:string;sessionId:string}>;
const invalidChallenge=()=>failure('AUTH_CHALLENGE_INVALID');
/** Sending budgets are keyed by the address, the caller address and a global envelope. */
const sendBudgets=(email:string,ip:string)=>[
  {key:`send-email-hour:${email}`,window:hour,maximum:5},
  {key:`send-email-day:${email}`,window:day,maximum:10},
  {key:`send-ip:${ip}`,window:hour,maximum:20},
  {key:'send-global',window:hour,maximum:100},
];
/** Authenticated link requests add a subject envelope: one valid account must not spray many
 *  addresses while changing client address, leaving the per-address budgets untouched. */
const linkSendBudgets=(email:string,ip:string,subjectId:string)=>[...sendBudgets(email,ip),
  {key:`send-subject-hour:${subjectId}`,window:hour,maximum:5},
  {key:`send-subject-day:${subjectId}`,window:day,maximum:10}];
export function createEmailService(pool:Pool,sessions:SessionService,passwords:PasswordService,cipher:RecoveryCipher,pepper:Buffer,clock=()=>new Date(),options:{registrationPolicy?:RegistrationPolicy}={}) {
  const storage=createEmailStorage(pool,cipher,pepper,clock);
  async function challenge(client:PoolClient,proof:Proof,purpose:Purpose,context:RequestContext,bind?:ChallengeBinding):Promise<{row:ChallengeRow}|{error:{code:string;status:number}}> {
    // Read ref first; no challenge lock ahead of subject lock (same order as session operations).
    const ref=(await client.query<ChallengeRow>('SELECT * FROM siyue.email_challenges WHERE id=$1',[proof.challengeId])).rows[0];
    if(!ref) return invalidChallenge() as {error:{code:string;status:number}};
    await storage.lock(client,`email:${ref.email_normalized}`);
    // The link flow proves the calling session while the email lock is already held and before
    // any subject row lock, so every path keeps the same email -> subject -> challenge order.
    const bound=bind?await bind(ref):undefined;
    if(ref.subject_id) await client.query('SELECT id FROM siyue.subjects WHERE id=$1 FOR UPDATE',[ref.subject_id]);
    const row=(await client.query<ChallengeRow>('SELECT * FROM siyue.email_challenges WHERE id=$1 FOR UPDATE',[proof.challengeId])).rows[0]!;
    const fail=(code='AUTH_CHALLENGE_INVALID',status=400)=>({error:{code,status}});
    if(row.purpose!==purpose || row.status!=='pending' || !matchesDigest(proof.requestSecret,row.request_secret_hash)) return fail();
    if(bound && (row.subject_id!==bound.subjectId || row.initiating_session_id!==bound.sessionId)) return fail();
    if(+row.expires_at<=+clock()) {
      await client.query("UPDATE siyue.email_challenges SET status='expired' WHERE id=$1",[row.id]);return fail();
    }
    // These budgets are keyed by email/IP, never reset by creating another challenge.
    const emailAllowed=await storage.count(client,`verify-email:${row.email_normalized}`,hour,20);
    const ipAllowed=await storage.count(client,`verify-ip:${context.ip}`,hour,100);
    if(!emailAllowed || !ipAllowed) return fail('AUTH_RATE_LIMITED',429);
    if(!storage.equals(storage.mac('code',row.id,purpose,proof.code),row.code_mac)) {
      await client.query("UPDATE siyue.email_challenges SET attempts=attempts+1,status=CASE WHEN attempts+1>=5 THEN 'locked' ELSE status END WHERE id=$1",[row.id]);
      await storage.audit(client,`email.${purpose}`,context.requestId,'invalid_code');return fail();
    }
    return {row};
  }
  async function consume(client:PoolClient,row:ChallengeRow) {
    await client.query("UPDATE siyue.email_challenges SET status='consumed',consumed_at=$2 WHERE id=$1",[row.id,clock()]);
    await client.query("UPDATE siyue.outbox_jobs SET status='cancelled',payload_ciphertext=NULL,completed_at=$2 WHERE aggregate_id=$1 AND status='pending'",[row.id,clock()]);
  }
  async function device(client:PoolClient,tokens:SessionTokens,input:{platform:string;deviceLabel?:string | undefined}) {
    await client.query('UPDATE siyue.auth_sessions SET platform=$2,device_label=$3 WHERE id=$1',[tokens.session.sessionId,input.platform,input.deviceLabel??null]);
  }
  async function revokeSubject(client:PoolClient,subjectId:string,now:Date) {
    await client.query("UPDATE siyue.auth_sessions SET revoked_at=COALESCE(revoked_at,$2),revoke_reason=COALESCE(revoke_reason,'password_changed') WHERE subject_id=$1",[subjectId,now]);
    await client.query(`UPDATE siyue.refresh_tokens SET revoked_at=COALESCE(revoked_at,$2),retry_ciphertext=NULL,retry_expires_at=NULL
      WHERE session_id IN(SELECT id FROM siyue.auth_sessions WHERE subject_id=$1)`,[subjectId,now]);
    await client.query('UPDATE siyue.reauth_grants SET consumed_at=COALESCE(consumed_at,$2) WHERE subject_id=$1',[subjectId,now]);
    await client.query("UPDATE siyue.email_challenges SET status='superseded' WHERE subject_id=$1 AND status='pending'",[subjectId]);
    await client.query(`UPDATE siyue.outbox_jobs SET status='cancelled',payload_ciphertext=NULL,completed_at=$2
      WHERE status='pending' AND aggregate_id IN(SELECT id FROM siyue.email_challenges WHERE subject_id=$1)`,[subjectId,now]);
  }
  async function credentialBudget(email:string,context:RequestContext) {
    const allowed=await transaction(pool,async client=>{
      const a=await storage.count(client,`login-email:${email}`,hour,10);
      const b=await storage.count(client,`login-ip:${context.ip}`,hour,30);
      const c=await storage.count(client,'login-global',hour,300);
      return a&&b&&c;
    });
    if(!allowed) throw new AuthError('AUTH_RATE_LIMITED',429);
  }
  /** Security-notice port used by the identity-unbind transaction; the caller owns that transaction. */
  const securityNotice:SecurityNotices={
    async emailUnlinked(client,notice,subjectId,now,expires) {
      await enqueueMail(client,cipher,{template:'email-unlinked',to:notice.to,locale:notice.locale},subjectId,now,expires);
    },
  };
  return {
    cleanup:storage.cleanup,
    securityNotice,
    async request(purpose:Purpose,input:EmailChallengeRequest,key:string,context:RequestContext):Promise<ChallengeResponse> {
      if(purpose==='register'&&options.registrationPolicy&&!options.registrationPolicy.enabled)throw new AuthError('AUTH_REGISTRATION_UNAVAILABLE',503);
      input=emailChallengeRequestSchema.parse(input);const email=normalizeLoginEmail(input.email);
      return storage.idempotent('email-request',key,{purpose,email,locale:input.locale},async client=>{
        await storage.lock(client,`email:${email}`);
        const now=clock();
        const recent=(await client.query('SELECT created_at FROM siyue.email_challenges WHERE email_normalized=$1 ORDER BY created_at DESC LIMIT 1',[email])).rows[0];
        if(recent && +recent.created_at+60_000>+now) return failure('AUTH_RATE_LIMITED',429);
        const allowed=await storage.reserveSend(client,sendBudgets(email,context.ip));
        if(!allowed) return failure('AUTH_RATE_LIMITED',429);
        const account=(await client.query(`SELECT e.subject_id,p.credential_version FROM siyue.account_emails e
          JOIN siyue.subjects p ON p.id=e.subject_id JOIN siyue.password_credentials c ON c.subject_id=p.id
          WHERE e.email_normalized=$1 AND e.login_enabled AND p.status='active' AND p.kind='adult' FOR UPDATE OF p`,[email])).rows[0];
        await client.query(`UPDATE siyue.outbox_jobs SET status='cancelled',payload_ciphertext=NULL,completed_at=$3
          WHERE status='pending' AND aggregate_id IN(SELECT id FROM siyue.email_challenges WHERE email_normalized=$1 AND purpose=$2 AND status='pending')`,[email,purpose,now]);
        await client.query("UPDATE siyue.email_challenges SET status='superseded' WHERE email_normalized=$1 AND purpose=$2 AND status='pending'",[email,purpose]);
        const id=randomUUID();const secret=randomBytes(32).toString('base64url');const code=randomInt(0,1_000_000).toString().padStart(6,'0');
        const expires=new Date(+now+600_000);
        await client.query(`INSERT INTO siyue.email_challenges(id,purpose,email_original,email_normalized,locale,subject_id,credential_version,code_mac,request_secret_hash,expires_at,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,purpose,input.email,email,input.locale,account?.subject_id??null,account?.credential_version??null,
          storage.mac('code',id,purpose,code),digest(secret),expires,now]);
        // Registration always sends the same template; reset for unknown accounts remains the same public response.
        if(purpose==='register' || account) await enqueueMail(client,cipher,{template:'verification',to:email,locale:input.locale,purpose,code},id,now,expires);
        await storage.audit(client,`email.${purpose}.request`,context.requestId,'accepted');
        return {data:{challengeId:id,requestSecret:secret,expiresAt:expires.toISOString(),resendAfterSeconds:60}};
      });
    },
    /** Adds a first login email to the calling subject: one verified link-identity grant and the
     *  challenge commit together, so a rejected request never burns the grant or sends mail. */
    async linkRequest(accessToken:string,input:EmailLinkRequest,key:string,context:RequestContext):Promise<ChallengeResponse> {
      input=emailLinkRequestSchema.parse(input);const email=normalizeLoginEmail(input.email);
      // Verify the caller once before the operation so retries can be scoped to the verified
      // session rather than the short-lived access token: after a lost 202 a client that refreshes
      // the same session and repeats the same key recovers the original challenge instead of
      // consuming another grant. The one-time grant is deliberately not part of the fingerprint,
      // so the original or a re-issued grant both recover the same operation.
      const verified=await sessions.verify(accessToken);
      const scope=`email-link-request:${storage.mac('link-request-session',verified.sessionId)}`;
      return storage.idempotent(scope,key,{email,locale:input.locale},async client=>{
        await storage.lock(client,`email:${email}`);
        const session=await sessions.verifyForMutation(client,accessToken),now=clock();
        const recent=(await client.query('SELECT created_at FROM siyue.email_challenges WHERE email_normalized=$1 ORDER BY created_at DESC LIMIT 1',[email])).rows[0];
        if(recent && +recent.created_at+60_000>+now) return failure('AUTH_RATE_LIMITED',429);
        // An account that already has a login email or password changes it instead of linking;
        // this is decided before any send budget or the grant is spent.
        const existing=await client.query(`SELECT (SELECT id FROM siyue.account_emails WHERE subject_id=$1) AS email_id,
          (SELECT subject_id FROM siyue.password_credentials WHERE subject_id=$1) AS credential_subject`,[session.subjectId]);
        if(existing.rows[0].email_id||existing.rows[0].credential_subject) return failure('AUTH_EMAIL_ALREADY_LINKED',409);
        const allowed=await storage.reserveSend(client,linkSendBudgets(email,context.ip,session.subjectId));
        if(!allowed) return failure('AUTH_RATE_LIMITED',429);
        // Wrong action, another subject's session, revoked session and replay all fail here.
        await sessions.consumeReauth(client,session.sessionId,input.reauthGrant,'link-identity');
        await client.query(`UPDATE siyue.outbox_jobs SET status='cancelled',payload_ciphertext=NULL,completed_at=$3
          WHERE status='pending' AND aggregate_id IN(SELECT id FROM siyue.email_challenges WHERE email_normalized=$1 AND purpose=$2 AND status='pending')`,[email,'link-email',now]);
        await client.query("UPDATE siyue.email_challenges SET status='superseded' WHERE email_normalized=$1 AND purpose=$2 AND status='pending'",[email,'link-email']);
        const subject=(await client.query('SELECT credential_version FROM siyue.subjects WHERE id=$1',[session.subjectId])).rows[0];
        const id=randomUUID();const secret=randomBytes(32).toString('base64url');const code=randomInt(0,1_000_000).toString().padStart(6,'0');
        const expires=new Date(+now+600_000);
        await client.query(`INSERT INTO siyue.email_challenges(id,purpose,email_original,email_normalized,locale,subject_id,initiating_session_id,credential_version,code_mac,request_secret_hash,expires_at,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[id,'link-email',input.email,email,input.locale,session.subjectId,session.sessionId,
          subject.credential_version,storage.mac('code',id,'link-email',code),digest(secret),expires,now]);
        await enqueueMail(client,cipher,{template:'verification',to:email,locale:input.locale,purpose:'link-email',code},id,now,expires);
        await storage.audit(client,'email.link-email.request',context.requestId,'accepted',session.subjectId);
        return {data:{challengeId:id,requestSecret:secret,expiresAt:expires.toISOString(),resendAfterSeconds:60}};
      });
    },
    /** Proves control of the new address and creates the login email plus the first password for
     *  the subject that already owns this account; it never resolves or merges another subject. */
    async linkConfirm(accessToken:string,input:EmailLinkConfirm,key:string,context:RequestContext):Promise<{emailLinked:true}> {
      input=emailLinkConfirmSchema.parse(input);passwords.validateNew(input.newPassword);
      return storage.idempotent(`email-link:${input.challengeId}`,key,input,async client=>{
        const checked=await challenge(client,input,'link-email',context,async()=>{
          const session=await sessions.verifyForMutation(client,accessToken);
          return {subjectId:session.subjectId,sessionId:session.sessionId};
        });
        if('error' in checked) return checked;
        const row=checked.row;
        // The initiating session, its subject and the credential version captured at request
        // time must all still hold; a logout or reset between request and confirm ends here.
        const subject=(await client.query('SELECT status,credential_version FROM siyue.subjects WHERE id=$1',[row.subject_id])).rows[0];
        if(!subject||subject.status!=='active'||subject.credential_version!==row.credential_version) {await consume(client,row);return invalidChallenge();}
        // One login email per subject; replacing it belongs to the change-email flow.
        const existing=await client.query(`SELECT (SELECT id FROM siyue.account_emails WHERE subject_id=$1) AS email_id,
          (SELECT subject_id FROM siyue.password_credentials WHERE subject_id=$1) AS credential_subject`,[row.subject_id]);
        if(existing.rows[0].email_id||existing.rows[0].credential_subject) {await consume(client,row);return failure('AUTH_EMAIL_ALREADY_LINKED',409);}
        // The address is claimed only after control of it is proven, and only if no other
        // subject still logs in with it. Never merge accounts that share an address.
        if((await client.query('SELECT id FROM siyue.account_emails WHERE email_normalized=$1',[row.email_normalized])).rowCount) {
          await consume(client,row);return failure('AUTH_EMAIL_ALREADY_EXISTS',409);
        }
        const passwordHash=await passwords.hash(input.newPassword),now=clock();
        await client.query('INSERT INTO siyue.account_emails(id,subject_id,email_original,email_normalized,verified_at,created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [randomUUID(),row.subject_id,row.email_original,row.email_normalized,now,now]);
        await client.query('INSERT INTO siyue.password_credentials(subject_id,password_hash,updated_at) VALUES($1,$2,$3)',[row.subject_id,passwordHash,now]);
        await consume(client,row);
        await storage.audit(client,'email.link-email',context.requestId,'success',row.subject_id??undefined);
        return {data:{emailLinked:true}};
      });
    },
    async register(input:EmailRegisterConfirm,key:string,context:RequestContext):Promise<SessionTokens> {
      input=emailRegisterConfirmSchema.parse(input);passwords.validateNew(input.password);
      return storage.idempotent(`register:${input.challengeId}`,key,input,async client=>{
        // Preserve recovery of an already accepted original request before checking a newer policy.
        const policy=options.registrationPolicy;
        if(policy&&(!policy.enabled||!policy.terms||!policy.privacy))return failure('AUTH_REGISTRATION_UNAVAILABLE',503);
        if(policy?.enabled&&(input.termsVersion!==policy.terms?.version||input.privacyVersion!==policy.privacy?.version))
          return failure('AUTH_POLICY_CHANGED',409);
        const checked=await challenge(client,input,'register',context);if('error' in checked) return checked;
        const row=checked.row;
        if((await client.query('SELECT id FROM siyue.account_emails WHERE email_normalized=$1',[row.email_normalized])).rowCount) {
          await consume(client,row);return failure('AUTH_EMAIL_ALREADY_EXISTS',409);
        }
        const passwordHash=await passwords.hash(input.password);const id=randomUUID();const now=clock();
        if(+row.expires_at<=+now) return invalidChallenge();
        await client.query("INSERT INTO siyue.subjects(id,kind,display_name,locale,created_at,updated_at) VALUES($1,'adult',$2,$3,$4,$4)",[id,input.displayName??'',row.locale,now]);
        await client.query('INSERT INTO siyue.account_emails(id,subject_id,email_original,email_normalized,verified_at,created_at) VALUES($1,$2,$3,$4,$5,$5)',[randomUUID(),id,row.email_original,row.email_normalized,now]);
        await client.query('INSERT INTO siyue.password_credentials(subject_id,password_hash,updated_at) VALUES($1,$2,$3)',[id,passwordHash,now]);
        await client.query('INSERT INTO siyue.account_consents(subject_id,terms_version,privacy_version,accepted_at) VALUES($1,$2,$3,$4)',[id,input.termsVersion,input.privacyVersion,now]);
        await consume(client,row);
        // The registration challenge is now proof for this subject, not an anonymous address
        // challenge. Cleanup can then remove it by subject without touching an earlier owner.
        await client.query('UPDATE siyue.email_challenges SET subject_id=$2 WHERE id=$1',[row.id,id]);
        const tokens=await sessions.issue(client,id,input.installationId,'email');await device(client,tokens,input);
        await storage.audit(client,'email.register',context.requestId,'success',id);
        return {data:tokens};
      });
    },
    async login(input:EmailLogin,context:RequestContext):Promise<SessionTokens> {
      input=emailLoginSchema.parse(input);const email=normalizeLoginEmail(input.email);
      await credentialBudget(email,context);
      const account=(await pool.query(`SELECT p.id,p.credential_version,p.status,p.kind,c.password_hash FROM siyue.account_emails e
        JOIN siyue.subjects p ON p.id=e.subject_id JOIN siyue.password_credentials c ON c.subject_id=p.id WHERE e.email_normalized=$1 AND e.login_enabled`,[email])).rows[0];
      const valid=await passwords.verify(input.password,account?.password_hash);
      const result=await transaction(pool,async client=>{
        if(!valid || !account || account.status!=='active' || account.kind!=='adult') {
          await storage.audit(client,'email.login',context.requestId,'invalid_credentials');return failure('AUTH_INVALID_CREDENTIALS',401);
        }
        const fresh=(await client.query(`SELECT p.credential_version,p.status,c.password_hash FROM siyue.subjects p JOIN siyue.password_credentials c ON c.subject_id=p.id
          WHERE p.id=$1 FOR UPDATE OF p`,[account.id])).rows[0];
        if(!fresh || fresh.status!=='active' || fresh.credential_version!==account.credential_version || fresh.password_hash!==account.password_hash) return failure('AUTH_INVALID_CREDENTIALS',401);
        if(passwords.needsRehash(fresh.password_hash)) await client.query('UPDATE siyue.password_credentials SET password_hash=$2,updated_at=$3 WHERE subject_id=$1',[account.id,await passwords.rehashVerified(input.password),clock()]);
        const tokens=await sessions.issue(client,account.id,input.installationId,'email');await device(client,tokens,input);
        await storage.audit(client,'email.login',context.requestId,'success',account.id);return {data:tokens};
      });
      if(result.error) throw new AuthError(result.error.code,result.error.status);return result.data as SessionTokens;
    },
    async reset(input:EmailPasswordResetConfirm,key:string,context:RequestContext):Promise<{passwordChanged:true}> {
      input=emailPasswordResetConfirmSchema.parse(input);passwords.validateNew(input.newPassword);
      return storage.idempotent(`password-reset:${input.challengeId}`,key,input,async client=>{
        const checked=await challenge(client,input,'password-reset',context);if('error' in checked) return checked;
        const row=checked.row;
        const account=(await client.query(`SELECT p.id,p.credential_version,p.status FROM siyue.subjects p JOIN siyue.account_emails e ON e.subject_id=p.id
          JOIN siyue.password_credentials c ON c.subject_id=p.id WHERE p.id=$1 AND e.email_normalized=$2 AND e.login_enabled`,[row.subject_id,row.email_normalized])).rows[0];
        if(!account || account.status!=='active' || account.credential_version!==row.credential_version) {await consume(client,row);return invalidChallenge();}
        const hashed=await passwords.hash(input.newPassword);const now=clock();
        if(+row.expires_at<=+now) return invalidChallenge();
        await client.query('UPDATE siyue.password_credentials SET password_hash=$2,updated_at=$3 WHERE subject_id=$1',[account.id,hashed,now]);
        await client.query('UPDATE siyue.subjects SET credential_version=credential_version+1,updated_at=$2 WHERE id=$1',[account.id,now]);
        await consume(client,row);await revokeSubject(client,account.id,now);
        await enqueueMail(client,cipher,{template:'password-changed',to:row.email_normalized,locale:row.locale},account.id,now,new Date(+now+day));
        await storage.audit(client,'email.password-reset',context.requestId,'success',account.id);return {data:{passwordChanged:true}};
      });
    },
    async reauth(accessToken:string,input:{password:string;action:ReauthAction},context:RequestContext) {
      input=passwordReauthSchema.parse(input);const session=await sessions.verify(accessToken);
      await credentialBudget(`subject:${session.subjectId}`,context);
      const prior=(await pool.query('SELECT password_hash FROM siyue.password_credentials WHERE subject_id=$1',[session.subjectId])).rows[0];
      const valid=await passwords.verify(input.password,prior?.password_hash);
      const result=await transaction(pool,async client=>{
        await client.query('SELECT id FROM siyue.subjects WHERE id=$1 FOR UPDATE',[session.subjectId]);
        const fresh=(await client.query('SELECT password_hash FROM siyue.password_credentials WHERE subject_id=$1',[session.subjectId])).rows[0];
        if(!valid || !fresh || fresh.password_hash!==prior.password_hash) {
          await storage.audit(client,'password.reauth',context.requestId,'invalid_credentials');return failure('AUTH_INVALID_CREDENTIALS',401);
        }
        const grant=await sessions.issueReauth(client,session.sessionId,input.action);
        await storage.audit(client,'password.reauth',context.requestId,'success',session.subjectId);return {data:grant};
      });
      if(result.error) throw new AuthError(result.error.code,result.error.status);return result.data;
    },
    async changePassword(accessToken:string,input:{newPassword:string;reauthGrant:string},key:string,context:RequestContext) {
      input=passwordChangeSchema.parse(input);passwords.validateNew(input.newPassword);
      // The token's keyed digest scopes cached retries to the same authenticated request
      // without putting the bearer credential in the idempotency namespace.
      const scope=`password-change:${storage.mac('password-change-access',accessToken)}`;
      return storage.idempotent(scope,key,input,async client=>{
        const session=await sessions.verifyForMutation(client,accessToken);
        // Consumption rolls back if hashing/storage fails; it commits with the password change.
        await sessions.consumeReauth(client,session.sessionId,input.reauthGrant,'change-password');
        const account=(await client.query(`SELECT e.email_normalized,p.locale FROM siyue.account_emails e JOIN siyue.subjects p ON p.id=e.subject_id
          JOIN siyue.password_credentials c ON c.subject_id=p.id WHERE e.subject_id=$1 AND e.login_enabled AND e.is_primary`,[session.subjectId])).rows[0];
        if(!account) throw new AuthError('AUTH_EMAIL_LOGIN_REQUIRED',409);
        const hashed=await passwords.hash(input.newPassword);const now=clock();
        await client.query('UPDATE siyue.password_credentials SET password_hash=$2,updated_at=$3 WHERE subject_id=$1',[session.subjectId,hashed,now]);
        await client.query('UPDATE siyue.subjects SET credential_version=credential_version+1,updated_at=$2 WHERE id=$1',[session.subjectId,now]);
        await revokeSubject(client,session.subjectId,now);
        await enqueueMail(client,cipher,{template:'password-changed',to:account.email_normalized,locale:account.locale},session.subjectId,now,new Date(+now+day));
        await storage.audit(client,'password.change',context.requestId,'success',session.subjectId);
        return {data:{passwordChanged:true}};
      });
    },
  };
}
export type EmailService=ReturnType<typeof createEmailService>;
