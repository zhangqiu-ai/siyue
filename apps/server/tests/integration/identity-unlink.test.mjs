import { test,before,beforeEach,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createAppleIdentityStorage } from '../../dist/identities/apple/identity-storage.js';
import { createIdentityUnlinkService } from '../../dist/modules/auth/identity-unlink.js';

// Isolated temporary PostgreSQL only. Apple identities come from the real repository with a
// synthetic exchange result, no provider or mailbox is contacted, and every address is a
// reserved example.test value.
const namespace='app.siyue.synthetic.unlink';
const linkedPassword='  synthetic-unlink-🌙-pass  ';
let db,fx,apples,unlink;
before(async()=>{db=await startPostgresFixture();});
beforeEach(async()=>{
  await db.admin.query('TRUNCATE siyue.subjects,siyue.email_challenges,siyue.idempotency_records,siyue.rate_limit_buckets,siyue.outbox_jobs,siyue.security_events CASCADE');
  fx=await createEmailFixture(db);
  apples=createAppleIdentityStorage(fx.cipher,namespace);
  // The production notice port: the unbind transaction writes a real sealed outbox job.
  unlink=createIdentityUnlinkService(db.app,fx.service,fx.email.securityNotice,fx.clock);
});
after(async()=>{await db?.stop();});

const rows=(sql,...params)=>db.app.query(sql,params).then(result=>result.rows);
const count=(sql,...params)=>rows(sql,...params).then(result=>Number(result[0].n));
const code=(expected,status)=>error=>error.code===expected && (status===undefined||error.status===status);

/** Adult subject created by the real Apple identity repository, then given an Apple session. */
async function appleAccount(){
  const identity=await transaction(db.app,client=>apples.resolve(client,{identity:{provider:'apple',subject:`synthetic-${randomUUID()}`,clientId:'app.siyue.synthetic'},refreshToken:`synthetic-refresh-${randomUUID()}`}));
  const tokens=await transaction(db.app,client=>fx.service.issue(client,identity.subjectId,randomUUID(),'apple'));
  return {...identity,tokens};
}
/** Real link flow: proves control of an address and creates the login email plus first password. */
async function linkEmail(who,address=`${randomUUID()}@example.test`){
  const grant=await transaction(db.app,client=>fx.service.issueReauth(client,who.tokens.session.sessionId,'link-identity'));
  const proof=await fx.email.linkRequest(who.tokens.accessToken,{email:address,locale:'zh-CN',reauthGrant:grant.reauthGrant},randomUUID(),fx.context);
  const job=(await rows('SELECT * FROM siyue.outbox_jobs WHERE aggregate_id=$1',proof.challengeId))[0];
  const secret=fx.cipher.open(job.payload_ciphertext,`mail:${job.id}`).code;
  await fx.email.linkConfirm(who.tokens.accessToken,{challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:secret,newPassword:linkedPassword},randomUUID(),fx.context);
  const row=(await rows('SELECT id FROM siyue.account_emails WHERE subject_id=$1',who.subjectId))[0];
  return {address,rowId:row.id,handle:`email:${row.id}`};
}
const grantFor=(who,action='unlink-identity')=>transaction(db.app,client=>fx.service.issueReauth(client,who.tokens.session.sessionId,action));
const unlinkCall=(who,identityId,reauthGrant,requestId='synthetic-unlink')=>unlink.unlinkEmailLoginMethod({accessToken:who.tokens.accessToken,identityId,reauthGrant,requestId});

test('removing the email method keeps the Apple login and clears sessions, proofs, challenges and mail at once',async()=>{
  const who=await appleAccount(),email=await linkEmail(who);
  // An unfinished challenge for the same address must not survive as a usable binding.
  fx.advance(61_000);
  const pending=await fx.request('password-reset',email.address);
  const version=(await rows('SELECT credential_version FROM siyue.subjects WHERE id=$1',who.subjectId))[0].credential_version;
  const grant=await grantFor(who);
  await unlinkCall(who,email.handle,grant.reauthGrant);

  // Only this subject's email + password login method is gone.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',who.subjectId),0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE email_normalized=$1',email.address),0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',who.subjectId),0);
  const subject=(await rows('SELECT kind,status,credential_version FROM siyue.subjects WHERE id=$1',who.subjectId))[0];
  assert.deepEqual([subject.kind,subject.status,subject.credential_version],['adult','active',version+1]);

  // The Apple method is untouched: identity, status and stored provider credential survive.
  assert.equal((await rows('SELECT status FROM siyue.external_identities WHERE id=$1',who.identityId))[0].status,'active');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.apple_provider_credentials WHERE identity_id=$1',who.identityId),1);

  // Every session of the subject, the calling one included, is revoked with one reason.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1 AND revoked_at IS NULL',who.subjectId),0);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1 AND revoke_reason='identity_unlinked'",who.subjectId),1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.refresh_tokens t JOIN siyue.auth_sessions s ON s.id=t.session_id
    WHERE s.subject_id=$1 AND (t.revoked_at IS NULL OR t.retry_ciphertext IS NOT NULL)`,who.subjectId),0);
  await assert.rejects(fx.service.verify(who.tokens.accessToken));
  // No other reauth proof of the subject survives, so nothing can be replayed from another device.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.reauth_grants WHERE subject_id=$1 AND consumed_at IS NULL',who.subjectId),0);

  // The unfinished challenge is superseded and the mail queued for it is cancelled and emptied.
  assert.equal((await rows('SELECT status FROM siyue.email_challenges WHERE id=$1',pending.challengeId))[0].status,'superseded');
  const cancelled=(await rows('SELECT status,payload_ciphertext FROM siyue.outbox_jobs WHERE aggregate_id=$1',pending.challengeId))[0];
  assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.payload_ciphertext,null);

  // One minimal audit event, bound to the calling session, without address or provider detail.
  const events=await rows("SELECT * FROM siyue.security_events WHERE subject_id=$1 AND event_type='identity.unlink-email'",who.subjectId);
  assert.equal(events.length,1);
  assert.deepEqual([events[0].outcome,events[0].redacted_metadata,events[0].session_id,events[0].request_id],
    ['success',{kind:'email_password'},who.tokens.session.sessionId,'synthetic-unlink']);
  assert.equal(JSON.stringify(events[0]).includes(email.address),false);
});

test('the removed address receives its own unlink notice with no misleading template',async()=>{
  const who=await appleAccount(),email=await linkEmail(who,'unlink.notice@example.test');
  const grant=await grantFor(who);
  await unlinkCall(who,email.handle,grant.reauthGrant,'synthetic-notice');
  const jobs=await rows("SELECT * FROM siyue.outbox_jobs WHERE kind='security-notice' AND aggregate_id=$1",who.subjectId);
  assert.equal(jobs.length,1);
  assert.deepEqual(fx.cipher.open(jobs[0].payload_ciphertext,`mail:${jobs[0].id}`),
    {template:'email-unlinked',to:'unlink.notice@example.test',locale:'zh-CN'});
  assert.ok(+jobs[0].expires_at>+fx.clock());
});

test('an account whose only method would disappear is refused, audited and left untouched',async()=>{
  // An email-only account has no other method at all.
  const registered=await fx.register('unlink.email-only@example.test');
  const subjectId=registered.tokens.session.subjectId;
  const rowId=(await rows('SELECT id FROM siyue.account_emails WHERE subject_id=$1',subjectId))[0].id;
  const version=(await rows('SELECT credential_version FROM siyue.subjects WHERE id=$1',subjectId))[0].credential_version;
  const grant=await transaction(db.app,client=>fx.service.issueReauth(client,registered.tokens.session.sessionId,'unlink-identity'));
  await assert.rejects(unlink.unlinkEmailLoginMethod({accessToken:registered.tokens.accessToken,identityId:`email:${rowId}`,
    reauthGrant:grant.reauthGrant,requestId:'synthetic-last'}),code('AUTH_LAST_METHOD_REQUIRED',409));
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',subjectId),1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',subjectId),1);
  assert.equal((await rows('SELECT credential_version FROM siyue.subjects WHERE id=$1',subjectId))[0].credential_version,version);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1 AND revoked_at IS NULL',subjectId),1);
  assert.deepEqual((await rows("SELECT outcome,redacted_metadata FROM siyue.security_events WHERE subject_id=$1 AND event_type='identity.unlink-email'",subjectId))
    .map(entry=>[entry.outcome,entry.redacted_metadata]),[['rejected',{reason:'last_method_required'}]]);
  // The refusal does not spend the proof: the same grant still works once a real Apple method exists.
  const identityId=randomUUID();
  await db.app.query(`INSERT INTO siyue.external_identities(id,subject_id,provider,provider_namespace,provider_subject,client_id,issuer)
    VALUES($1,$2,'apple',$3,$4,'app.siyue.synthetic','https://appleid.apple.com')`,[identityId,subjectId,namespace,`synthetic-${randomUUID()}`]);
  await db.app.query('INSERT INTO siyue.apple_provider_credentials(identity_id,refresh_ciphertext) VALUES($1,$2)',
    [identityId,fx.cipher.seal({refreshToken:'synthetic-refresh'},`apple-identity:${identityId}:${namespace}`)]);
  await unlink.unlinkEmailLoginMethod({accessToken:registered.tokens.accessToken,identityId:`email:${rowId}`,
    reauthGrant:grant.reauthGrant,requestId:'synthetic-retry'});
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',subjectId),0);
});

test('a revoked identity or a missing provider credential is not a usable remaining method',async()=>{
  for(const damage of ['revoked','no-credential']){
    const who=await appleAccount(),email=await linkEmail(who);
    if(damage==='revoked')await db.app.query("UPDATE siyue.external_identities SET status='revoked' WHERE id=$1",[who.identityId]);
    else await db.app.query('DELETE FROM siyue.apple_provider_credentials WHERE identity_id=$1',[who.identityId]);
    const grant=await grantFor(who);
    await assert.rejects(unlinkCall(who,email.handle,grant.reauthGrant),code('AUTH_LAST_METHOD_REQUIRED',409),damage);
    assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',who.subjectId),1,damage);
    assert.equal(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',who.subjectId),1,damage);
    assert.equal(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1 AND revoked_at IS NULL',who.subjectId),1,damage);
  }
});

test('another subject’s handle, an unknown handle and an Apple handle never touch either account',async()=>{
  const mine=await appleAccount(),mineEmail=await linkEmail(mine,'unlink.mine@example.test');
  const other=await appleAccount(),otherEmail=await linkEmail(other,'unlink.other@example.test');
  const grant=await grantFor(mine);
  await assert.rejects(unlinkCall(mine,otherEmail.handle,grant.reauthGrant),code('AUTH_IDENTITY_NOT_FOUND',404));
  await assert.rejects(unlinkCall(mine,`email:${randomUUID()}`,grant.reauthGrant),code('AUTH_IDENTITY_NOT_FOUND',404));
  // An Apple handle is not a request this slice serves and must not reach the email removal path.
  for(const refused of [`apple:${mine.identityId}`,`email:${mineEmail.rowId.toUpperCase()}`,`email:${mineEmail.rowId} `,mineEmail.rowId,'email:not-a-uuid'])
    await assert.rejects(unlinkCall(mine,refused,grant.reauthGrant),code('AUTH_INVALID_REQUEST',400),refused);
  // Nothing changed anywhere: both subjects keep their methods and no audit was written.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',mine.subjectId),1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',other.subjectId),1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',other.subjectId),1);
  assert.equal((await rows('SELECT status FROM siyue.external_identities WHERE id=$1',mine.identityId))[0].status,'active');
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE subject_id=$1 AND event_type='identity.unlink-email'",mine.subjectId),0);
  // None of the refusals spent the single-use proof: the same grant still removes the real method.
  await unlinkCall(mine,mineEmail.handle,grant.reauthGrant);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',mine.subjectId),0);
});

test('a stored profile address that is not a login method cannot be removed through the login-method endpoint',async()=>{
  const who=await appleAccount();
  const profileId=randomUUID();
  await db.app.query('INSERT INTO siyue.account_emails(id,subject_id,email_original,email_normalized,verified_at,login_enabled) VALUES($1,$2,$3,$4,now(),false)',
    [profileId,who.subjectId,'profile.unlink@example.test','profile.unlink@example.test']);
  const grant=await grantFor(who);
  await assert.rejects(unlinkCall(who,`email:${profileId}`,grant.reauthGrant),code('AUTH_IDENTITY_NOT_FOUND',404));
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE id=$1',profileId),1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.reauth_grants WHERE subject_id=$1 AND consumed_at IS NULL',who.subjectId),1);
});

test('a grant bound to another action or another session is refused without spending it',async()=>{
  const who=await appleAccount(),email=await linkEmail(who);
  const wrongAction=await grantFor(who,'change-password');
  await assert.rejects(unlinkCall(who,email.handle,wrongAction.reauthGrant),code('AUTH_REAUTH_REQUIRED',401));
  // A grant issued to another session of the same subject is not this caller's proof.
  const second=await transaction(db.app,client=>fx.service.issue(client,who.subjectId,randomUUID(),'apple'));
  const secondGrant=await transaction(db.app,client=>fx.service.issueReauth(client,second.session.sessionId,'unlink-identity'));
  await assert.rejects(unlinkCall(who,email.handle,secondGrant.reauthGrant),code('AUTH_REAUTH_REQUIRED',401));
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',who.subjectId),1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',who.subjectId),1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.reauth_grants WHERE subject_id=$1 AND consumed_at IS NULL',who.subjectId),2);
});

test('an expired grant is refused and a completed unlink cannot be replayed',async()=>{
  const who=await appleAccount(),email=await linkEmail(who);
  const expired=await grantFor(who);
  fx.advance(300_001);
  await assert.rejects(unlinkCall(who,email.handle,expired.reauthGrant),code('AUTH_REAUTH_REQUIRED',401));
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',who.subjectId),1);
  // A fresh proof completes the removal once...
  const fresh=await grantFor(who);
  await unlinkCall(who,email.handle,fresh.reauthGrant,'synthetic-first');
  // ...the whole subject was signed out, so the same bearer and grant are refused as invalid...
  await assert.rejects(unlinkCall(who,email.handle,fresh.reauthGrant,'synthetic-repeat'),code('AUTH_SESSION_INVALID',401));
  // ...and a session the account can still open finds no method with that handle at all.
  const reopened=await transaction(db.app,client=>fx.service.issue(client,who.subjectId,randomUUID(),'apple'));
  const replay=await transaction(db.app,client=>fx.service.issueReauth(client,reopened.session.sessionId,'unlink-identity'));
  await assert.rejects(unlink.unlinkEmailLoginMethod({accessToken:reopened.accessToken,identityId:email.handle,
    reauthGrant:replay.reauthGrant,requestId:'synthetic-replay'}),code('AUTH_IDENTITY_NOT_FOUND',404));
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',who.subjectId),0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',who.subjectId),0);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE subject_id=$1 AND event_type='identity.unlink-email' AND outcome='success'",who.subjectId),1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.outbox_jobs j JOIN siyue.subjects s ON s.id=j.aggregate_id
    WHERE s.id=$1 AND j.kind='security-notice'`,who.subjectId),1);
});

test('concurrent attempts remove the method once and never leave the subject without a login method',async()=>{
  const who=await appleAccount(),email=await linkEmail(who);
  const second=await transaction(db.app,client=>fx.service.issue(client,who.subjectId,randomUUID(),'apple'));
  const [firstProof,secondProof]=await Promise.all([
    transaction(db.app,client=>fx.service.issueReauth(client,who.tokens.session.sessionId,'unlink-identity')),
    transaction(db.app,client=>fx.service.issueReauth(client,second.session.sessionId,'unlink-identity')),
  ]);
  const results=await Promise.allSettled([
    unlink.unlinkEmailLoginMethod({accessToken:who.tokens.accessToken,identityId:email.handle,reauthGrant:firstProof.reauthGrant,requestId:'synthetic-concurrent-a'}),
    unlink.unlinkEmailLoginMethod({accessToken:second.accessToken,identityId:email.handle,reauthGrant:secondProof.reauthGrant,requestId:'synthetic-concurrent-b'}),
  ]);
  assert.equal(results.filter(entry=>entry.status==='fulfilled').length,1);
  const failed=results.find(entry=>entry.status==='rejected');
  assert.ok(['AUTH_SESSION_INVALID','AUTH_IDENTITY_NOT_FOUND','AUTH_REAUTH_REQUIRED'].includes(failed.reason.code),failed.reason.code);
  // The address is gone exactly once, and the subject still has a working Apple method.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',who.subjectId),0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',who.subjectId),0);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.external_identities WHERE subject_id=$1 AND status='active'",who.subjectId),1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.apple_provider_credentials c JOIN siyue.external_identities i ON i.id=c.identity_id
    WHERE i.subject_id=$1`,who.subjectId),1);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE subject_id=$1 AND event_type='identity.unlink-email' AND outcome='success'",who.subjectId),1);
  assert.equal(await count(`SELECT count(*)::int AS n FROM siyue.outbox_jobs j JOIN siyue.subjects s ON s.id=j.aggregate_id
    WHERE s.id=$1 AND j.kind='security-notice'`,who.subjectId),1);
});

test('a failure after the grant is spent rolls the whole removal back and keeps the proof usable',async()=>{
  const who=await appleAccount(),email=await linkEmail(who);
  const grant=await grantFor(who);
  const version=(await rows('SELECT credential_version FROM siyue.subjects WHERE id=$1',who.subjectId))[0].credential_version;
  // The injected failure lands after the proof is consumed and after the writes, so only a real
  // rollback can leave the account unchanged and the grant unspent.
  const broken={async connect(){const client=await db.app.connect();return new Proxy(client,{get(target,property){
    if(property==='query')return(text,params)=>(typeof text==='string'&&text.includes('SET credential_version=credential_version+1')
      ?Promise.reject(new Error('synthetic_unlink_failure')):target.query(text,params));
    if(property==='release')return target.release.bind(target);
    const value=target[property];return typeof value==='function'?value.bind(target):value;
  }});}};
  const failing=createIdentityUnlinkService(broken,fx.service,fx.email.securityNotice,fx.clock);
  await assert.rejects(failing.unlinkEmailLoginMethod({accessToken:who.tokens.accessToken,identityId:email.handle,reauthGrant:grant.reauthGrant,requestId:'synthetic-rollback'}),/synthetic_unlink_failure/);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',who.subjectId),1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',who.subjectId),1);
  assert.equal((await rows('SELECT credential_version FROM siyue.subjects WHERE id=$1',who.subjectId))[0].credential_version,version);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1 AND revoked_at IS NULL',who.subjectId),1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.reauth_grants WHERE subject_id=$1 AND consumed_at IS NULL',who.subjectId),1);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.outbox_jobs WHERE kind='security-notice'"),0);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='identity.unlink-email'"),0);
  // The same proof still completes the removal on a healthy connection.
  await unlinkCall(who,email.handle,grant.reauthGrant,'synthetic-after-rollback');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',who.subjectId),0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1 AND revoked_at IS NULL',who.subjectId),0);
});

test('removing one of several stored addresses keeps the shared password credential for the others',async()=>{
  const who=await appleAccount(),first=await linkEmail(who,'unlink.first@example.test');
  await db.app.query('INSERT INTO siyue.account_emails(id,subject_id,email_original,email_normalized,verified_at,is_primary) VALUES($1,$2,$3,$4,now(),false)',
    [randomUUID(),who.subjectId,'unlink.second@example.test','unlink.second@example.test']);
  const grant=await grantFor(who);
  await unlinkCall(who,first.handle,grant.reauthGrant);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',who.subjectId),1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',who.subjectId),1);
});
