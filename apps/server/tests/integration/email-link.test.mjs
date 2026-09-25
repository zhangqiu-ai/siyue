import { test,before,beforeEach,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';

// Isolated temporary PostgreSQL cluster only. Addresses are synthetic and mail never leaves the
// encrypted outbox; the Apple identity below is a synthetic subject row, no provider is contacted.
let db,fx;
before(async()=>{db=await startPostgresFixture();});
beforeEach(async()=>{
  await db.admin.query('TRUNCATE siyue.subjects,siyue.email_challenges,siyue.idempotency_records,siyue.rate_limit_buckets,siyue.outbox_jobs,siyue.security_events CASCADE');
  fx=await createEmailFixture(db);
});
after(async()=>{await db?.stop();});
const codeIs=code=>error=>error.code===code;
const linkPassword='  synthetic-apple-only-🌙-account-pass  ';
const count=(sql,...params)=>db.app.query(sql,params.length===1&&Array.isArray(params[0])?params[0]:params).then(result=>Number(result.rows[0].n));

/** Adult subject with an Apple-issued session and no login email or password yet. */
async function appleOnly() {
  const subjectId=randomUUID();
  await db.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'adult','Synthetic Apple-only')",[subjectId]);
  const tokens=await transaction(db.app,client=>fx.service.issue(client,subjectId,randomUUID(),'apple'));
  return {subjectId,tokens};
}
const issueGrant=(who,action='link-identity')=>transaction(db.app,client=>fx.service.issueReauth(client,who.tokens.session.sessionId,action));
const challengeRow=async id=>(await db.app.query('SELECT * FROM siyue.email_challenges WHERE id=$1',[id])).rows[0];
const jobRow=async id=>(await db.app.query('SELECT * FROM siyue.outbox_jobs WHERE aggregate_id=$1',[id])).rows[0];
const grantRow=async id=>(await db.app.query('SELECT * FROM siyue.reauth_grants WHERE id=$1',[id])).rows[0];
async function requestLink(who,address=`${randomUUID()}@example.test`,grant) {
  const issued=grant??await issueGrant(who);
  const key=randomUUID();
  const response=await fx.email.linkRequest(who.tokens.accessToken,{email:address,locale:'zh-CN',reauthGrant:issued.reauthGrant},key,fx.context);
  const job=await jobRow(response.challengeId);
  const payload=job?.payload_ciphertext?fx.cipher.open(job.payload_ciphertext,`mail:${job.id}`):undefined;
  return {...response,address,key,grant:issued,code:payload?.code,job};
}
const confirmInput=(proof,overrides={})=>({challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:proof.code,newPassword:linkPassword,...overrides});
const confirm=(who,proof,overrides={},key=randomUUID())=>fx.email.linkConfirm(who.tokens.accessToken,confirmInput(proof,overrides),key,fx.context);

test('link request consumes the session-bound grant and creates the challenge in one transaction',async()=>{
  const who=await appleOnly(),other=await appleOnly();
  const address='  Bound.Address+tag@Example.test  ';
  // A grant issued for another action, another subject or already-consumed session creates nothing.
  const wrongAction=await issueGrant(who,'change-password');
  await assert.rejects(fx.email.linkRequest(who.tokens.accessToken,{email:address,locale:'zh-CN',reauthGrant:wrongAction.reauthGrant},randomUUID(),fx.context),codeIs('AUTH_REAUTH_REQUIRED'));
  const foreign=(await issueGrant(other));
  await assert.rejects(fx.email.linkRequest(who.tokens.accessToken,{email:address,locale:'zh-CN',reauthGrant:foreign.reauthGrant},randomUUID(),fx.context),codeIs('AUTH_REAUTH_REQUIRED'));
  const own=await issueGrant(who);
  await assert.rejects(fx.email.linkRequest(other.tokens.accessToken,{email:address,locale:'zh-CN',reauthGrant:own.reauthGrant},randomUUID(),fx.context),codeIs('AUTH_REAUTH_REQUIRED'));
  await assert.rejects(fx.email.linkRequest('not-a-token',{email:address,locale:'zh-CN',reauthGrant:own.reauthGrant},randomUUID(),fx.context),codeIs('AUTH_ACCESS_INVALID'));
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.email_challenges'),0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.outbox_jobs'),0);
  // Rejected attempts leave every untouched grant usable, and revoking the session ends the flow.
  assert.equal((await grantRow(wrongAction.reauthGrant.split('.')[0])).consumed_at,null);
  const proof=await requestLink(who,address,own);
  const row=await challengeRow(proof.challengeId);
  assert.deepEqual([row.purpose,row.subject_id,row.initiating_session_id,row.credential_version,row.status,row.email_normalized],
    ['link-email',who.subjectId,who.tokens.session.sessionId,1,'pending','bound.address+tag@example.test']);
  assert.equal(row.email_original,address.trim());
  assert.notEqual(row.request_secret_hash,proof.requestSecret);
  assert.equal(JSON.stringify(row).includes(proof.requestSecret),false);
  assert.equal(row.code_mac.includes(proof.code),false);
  assert.notEqual((await grantRow(own.reauthGrant.split('.')[0])).consumed_at,null);
  // The verification mail is queued encrypted for this challenge only.
  assert.equal(proof.job.kind,'verification-email');
  assert.equal(proof.job.payload_ciphertext.includes(address.trim().toLowerCase()),false);
  assert.match(proof.code,/^\d{6}$/);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='email.link-email.request' AND outcome='accepted' AND subject_id=$1",who.subjectId),1);
  // The same one-time grant cannot be replayed for another address.
  await assert.rejects(fx.email.linkRequest(who.tokens.accessToken,{email:'replay@example.test',locale:'zh-CN',reauthGrant:own.reauthGrant},randomUUID(),fx.context),codeIs('AUTH_REAUTH_REQUIRED'));
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.email_challenges'),1);
  await fx.service.logoutAccess(who.tokens.accessToken);
  await assert.rejects(fx.email.linkRequest(who.tokens.accessToken,{email:'revoked@example.test',locale:'zh-CN',reauthGrant:(await issueGrant(other)).reauthGrant},randomUUID(),fx.context),codeIs('AUTH_SESSION_INVALID'));
});

test('confirm creates one verified login email and Argon2id password for the same subject',async()=>{
  const who=await appleOnly(),proof=await requestLink(who);
  const before={subjects:await count('SELECT count(*)::int AS n FROM siyue.subjects'),sessions:await count('SELECT count(*)::int AS n FROM siyue.auth_sessions')};
  assert.deepEqual(await confirm(who,proof),{emailLinked:true});
  const linked=(await db.app.query('SELECT * FROM siyue.account_emails WHERE subject_id=$1',[who.subjectId])).rows[0];
  assert.equal(linked.subject_id,who.subjectId);
  assert.equal(linked.email_normalized,proof.address.toLowerCase());
  assert.equal(linked.is_primary,true);
  assert.equal(linked.login_enabled,true);
  assert.notEqual(linked.verified_at,null);
  const credential=(await db.app.query('SELECT * FROM siyue.password_credentials WHERE subject_id=$1',[who.subjectId])).rows[0];
  assert.match(credential.password_hash,/^\$argon2id\$/);
  assert.equal(await fx.passwords.verify(linkPassword,credential.password_hash),true);
  assert.equal((await challengeRow(proof.challengeId)).status,'consumed');
  assert.deepEqual((await db.app.query('SELECT status,payload_ciphertext FROM siyue.outbox_jobs WHERE aggregate_id=$1',[proof.challengeId])).rows[0],{status:'cancelled',payload_ciphertext:null});
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='email.link-email' AND outcome='success' AND subject_id=$1",who.subjectId),1);
  // No subject, session or account merge is created by completion; the existing session survives.
  assert.deepEqual({subjects:await count('SELECT count(*)::int AS n FROM siyue.subjects'),sessions:await count('SELECT count(*)::int AS n FROM siyue.auth_sessions')},before);
  assert.deepEqual(await fx.service.verify(who.tokens.accessToken),who.tokens.session);
  assert.equal((await db.app.query('SELECT credential_version FROM siyue.subjects WHERE id=$1',[who.subjectId])).rows[0].credential_version,1);
  // The new credential signs in on another platform as the same subject.
  const login=await fx.email.login({email:proof.address.trim(),password:linkPassword,installationId:'android-device',platform:'android'},fx.context);
  assert.equal(login.session.subjectId,who.subjectId);
  assert.notEqual(login.session.sessionId,who.tokens.session.sessionId);
});

test('a lost 202 is recovered with the same key after refreshing the same session',async()=>{
  const who=await appleOnly(),address='refresh-retry@example.test',first=await requestLink(who,address);
  // The client lost the response, refreshed the same session and repeated the same operation key.
  const refreshed=await fx.service.refresh(who.tokens.refreshToken,randomUUID());
  assert.equal(refreshed.session.sessionId,who.tokens.session.sessionId);
  const spare=await issueGrant(who);
  const recovered=await fx.email.linkRequest(refreshed.accessToken,{email:address,locale:'zh-CN',reauthGrant:spare.reauthGrant},first.key,fx.context);
  assert.deepEqual(recovered,{challengeId:first.challengeId,requestSecret:first.requestSecret,expiresAt:first.expiresAt,resendAfterSeconds:60});
  // One challenge, one queued mail, no second grant spent, and the recovered proof still confirms.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.email_challenges'),1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.outbox_jobs'),1);
  assert.equal((await jobRow(first.challengeId)).id,first.job.id);
  assert.equal((await grantRow(spare.reauthGrant.split('.')[0])).consumed_at,null);
  assert.deepEqual(await fx.email.linkConfirm(refreshed.accessToken,confirmInput({...recovered,code:first.code}),randomUUID(),fx.context),{emailLinked:true});
});

test('authenticated link sends are bounded per subject across changed addresses and client addresses',async()=>{
  // Deterministic start away from fixed-window boundaries, without waiting in real time.
  fx.advance(Math.floor(+fx.clock()/86_400_000)*86_400_000+60_000-+fx.clock());
  const who=await appleOnly();
  const spray=async index=>{
    const grant=await issueGrant(who);
    const context={ip:`198.51.100.${index+1}`,requestId:randomUUID()};
    try {return {proof:await fx.email.linkRequest(who.tokens.accessToken,{email:`spray-${index}@example.test`,locale:'en-US',reauthGrant:grant.reauthGrant},randomUUID(),context),grant,error:null};}
    catch(error) {return {proof:null,grant,error};}
  };
  const results=[];
  for(let index=0;index<5;index++) results.push(await spray(index));
  assert.equal(results.filter(result=>result.error===null).length,5);
  // Every per-address and per-client-address budget is untouched, so only the subject envelope stops it.
  const denied=await spray(5);
  assert.equal(denied.error?.code,'AUTH_RATE_LIMITED');
  assert.equal(denied.error?.status,429);
  assert.equal((await grantRow(denied.grant.reauthGrant.split('.')[0])).consumed_at,null);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.email_challenges WHERE email_normalized='spray-5@example.test'"),0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.outbox_jobs'),5);
  // Another subject's own envelope is unaffected.
  const other=await appleOnly();
  const proof=await fx.email.linkRequest(other.tokens.accessToken,{email:'spray-other@example.test',locale:'en-US',reauthGrant:(await issueGrant(other)).reauthGrant},randomUUID(),{ip:'198.51.100.99',requestId:randomUUID()});
  assert.ok(proof.challengeId);
});

test('confirm rejects wrong code, wrong secret, replay and a concurrent second attempt',async()=>{
  const who=await appleOnly(),proof=await requestLink(who);
  await assert.rejects(confirm(who,proof,{code:proof.code==='000000'?'000001':'000000'}),codeIs('AUTH_CHALLENGE_INVALID'));
  assert.equal((await challengeRow(proof.challengeId)).attempts,1);
  await assert.rejects(confirm(who,proof,{requestSecret:'B'.repeat(43)}),codeIs('AUTH_CHALLENGE_INVALID'));
  // Two concurrent confirms with different keys: exactly one links, the other sees a used challenge.
  const second=await appleOnly(),otherProof=await requestLink(second);
  const settled=await Promise.allSettled([confirm(second,otherProof,{},randomUUID()),confirm(second,otherProof,{},randomUUID())]);
  assert.equal(settled.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(settled.find(result=>result.status==='rejected').reason.code,'AUTH_CHALLENGE_INVALID');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.email_challenges WHERE email_normalized=$1',[otherProof.address]),1);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',[second.subjectId]),1);
  // One delivery attempt only: replaying the same operation key restores the first outcome.
  const third=await appleOnly(),thirdProof=await requestLink(third);
  const key=randomUUID();
  assert.deepEqual(await fx.email.linkConfirm(third.tokens.accessToken,confirmInput(thirdProof),key,fx.context),{emailLinked:true});
  assert.deepEqual(await fx.email.linkConfirm(third.tokens.accessToken,confirmInput(thirdProof),key,fx.context),{emailLinked:true});
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',[third.subjectId]),1);
  await assert.rejects(fx.email.linkConfirm(third.tokens.accessToken,confirmInput(thirdProof),randomUUID(),fx.context),codeIs('AUTH_CHALLENGE_INVALID'));
  await assert.rejects(fx.email.linkConfirm(third.tokens.accessToken,confirmInput(thirdProof,{newPassword:linkPassword+'other'}),key,fx.context),codeIs('AUTH_IDEMPOTENCY_CONFLICT'));
});

test('confirm refuses an address another subject already logs in with, without merging accounts',async()=>{
  const {tokens:existing,address}=await fx.register('occupied@example.test');
  const who=await appleOnly();
  fx.advance(60_001);
  // The request does not disclose whether the address is already bound; only proof of control does.
  const proof=await requestLink(who,address);
  await assert.rejects(confirm(who,proof),codeIs('AUTH_EMAIL_ALREADY_EXISTS'));
  assert.equal((await challengeRow(proof.challengeId)).status,'consumed');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',[who.subjectId]),0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',[who.subjectId]),0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE email_normalized=$1',[address]),1);
  assert.equal((await db.app.query('SELECT subject_id FROM siyue.account_emails WHERE email_normalized=$1',[address])).rows[0].subject_id,existing.session.subjectId);
  const rejected=await fx.email.login({email:address,password:linkPassword,installationId:'other',platform:'ios'},fx.context).then(()=>null,error=>error);
  assert.equal(rejected.code,'AUTH_INVALID_CREDENTIALS');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.subjects'),2);
});

test('a subject with an existing login method is sent to change-email instead of linking again',async()=>{
  const who=await appleOnly(),first=await requestLink(who),other=await requestLink(who);
  assert.deepEqual(await confirm(who,first),{emailLinked:true});
  await assert.rejects(confirm(who,other),codeIs('AUTH_EMAIL_ALREADY_LINKED'));
  assert.equal((await challengeRow(other.challengeId)).status,'consumed');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',[who.subjectId]),1);
  // A later request never consumes its grant or sends mail once a login method exists.
  const grant=await issueGrant(who);
  const bucketsBefore=await count('SELECT count(*)::int AS n FROM siyue.rate_limit_buckets');
  await assert.rejects(fx.email.linkRequest(who.tokens.accessToken,{email:'third@example.test',locale:'zh-CN',reauthGrant:grant.reauthGrant},randomUUID(),fx.context),codeIs('AUTH_EMAIL_ALREADY_LINKED'));
  assert.equal((await grantRow(grant.reauthGrant.split('.')[0])).consumed_at,null);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.email_challenges'),2);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.outbox_jobs WHERE payload_ciphertext IS NOT NULL"),0);
  // A refused request spends no send budget for an address that will never receive a code.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.rate_limit_buckets'),bucketsBefore);
});

test('confirm ends when the initiating session is revoked or the captured credential moved',async()=>{
  const revoked=await appleOnly(),revokedProof=await requestLink(revoked);
  await fx.service.logoutAccess(revoked.tokens.accessToken);
  await assert.rejects(confirm(revoked,revokedProof),codeIs('AUTH_SESSION_INVALID'));
  assert.equal((await challengeRow(revokedProof.challengeId)).status,'pending');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',[revoked.subjectId]),0);
  // A reset or password change bumps the credential version: the session that started the binding
  // is refused outright, and a later session is not accepted as the initiating session either.
  const stale=await appleOnly(),staleProof=await requestLink(stale);
  await db.app.query('UPDATE siyue.subjects SET credential_version=credential_version+1 WHERE id=$1',[stale.subjectId]);
  await assert.rejects(confirm(stale,staleProof),codeIs('AUTH_SESSION_INVALID'));
  const fresh=await transaction(db.app,client=>fx.service.issue(client,stale.subjectId,randomUUID(),'apple'));
  await assert.rejects(fx.email.linkConfirm(fresh.accessToken,confirmInput(staleProof),randomUUID(),fx.context),codeIs('AUTH_CHALLENGE_INVALID'));
  // A caller that is not the initiating session is refused without burning the challenge.
  assert.equal((await challengeRow(staleProof.challengeId)).status,'pending');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',[stale.subjectId]),0);
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',[stale.subjectId]),0);
  // A challenge whose captured credential snapshot no longer matches its subject is consumed, not used.
  const drift=await appleOnly(),driftProof=await requestLink(drift);
  await db.app.query('UPDATE siyue.email_challenges SET credential_version=credential_version+1 WHERE id=$1',[driftProof.challengeId]);
  await assert.rejects(confirm(drift,driftProof),codeIs('AUTH_CHALLENGE_INVALID'));
  assert.equal((await challengeRow(driftProof.challengeId)).status,'consumed');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',[drift.subjectId]),0);
});

test('link confirm rolls back completely when the password write fails, then succeeds on retry',async()=>{
  const who=await appleOnly(),proof=await requestLink(who),key=randomUUID();
  await db.admin.query('REVOKE INSERT ON siyue.password_credentials FROM siyue_app');
  try {await assert.rejects(fx.email.linkConfirm(who.tokens.accessToken,confirmInput(proof),key,fx.context));}
  finally {await db.admin.query('GRANT INSERT ON siyue.password_credentials TO siyue_app');}
  assert.equal((await challengeRow(proof.challengeId)).status,'pending');
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',[who.subjectId]),0);
  assert.equal((await jobRow(proof.challengeId)).status,'pending');
  assert.deepEqual(await fx.email.linkConfirm(who.tokens.accessToken,confirmInput(proof),key,fx.context),{emailLinked:true});
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',[who.subjectId]),1);
});

test('link challenges expire, respect per-address send budgets and keep codes out of stored rows',async()=>{
  // Two subjects: the expired challenge must not spend the send envelope of the budget subject.
  const expiredWho=await appleOnly(),who=await appleOnly(),address='budget@example.test';
  const expired=await requestLink(expiredWho,'expired@example.test');
  fx.advance(600_001);
  await assert.rejects(confirm(expiredWho,expired),codeIs('AUTH_CHALLENGE_INVALID'));
  assert.equal((await challengeRow(expired.challengeId)).status,'expired');
  // Five sends per address and hour, all-or-none; the sixth is refused and its grant stays unused.
  // Keep the whole sequence within one hourly bucket regardless of the wall clock minute at test start.
  const intoHour=fx.clock().getTime()%3_600_000;
  if(intoHour)fx.advance(3_600_000-intoHour);
  // A session minted now keeps this about the address budget, not the access token lifetime.
  const fresh=await transaction(db.app,client=>fx.service.issue(client,who.subjectId,randomUUID(),'apple'));
  const sender={subjectId:who.subjectId,tokens:fresh};
  const proofs=[];
  for(let attempt=0;attempt<5;attempt++) {proofs.push(await requestLink(sender,address));fx.advance(60_001);}
  const grant=await issueGrant(sender);
  await assert.rejects(fx.email.linkRequest(sender.tokens.accessToken,{email:address,locale:'zh-CN',reauthGrant:grant.reauthGrant},randomUUID(),fx.context),codeIs('AUTH_RATE_LIMITED'));
  assert.equal((await grantRow(grant.reauthGrant.split('.')[0])).consumed_at,null);
  // One pending challenge per address and purpose; superseded attempts keep none of their payload.
  assert.equal(await count('SELECT count(*)::int AS n FROM siyue.email_challenges WHERE email_normalized=$1',[address]),5);
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.email_challenges WHERE email_normalized=$1 AND status='superseded'",[address]),4);
  const last=proofs.at(-1),row=await challengeRow(last.challengeId);
  assert.notEqual(row.request_secret_hash,last.requestSecret);
  assert.equal(row.code_mac.includes(last.code),false);
  assert.equal(JSON.stringify(await jobRow(last.challengeId)).includes(address),false);
  assert.equal(JSON.stringify(await jobRow(last.challengeId)).includes(last.code),false);
  // Only the pending link challenge and the still-pending expired one keep an encrypted payload.
  assert.equal(await count("SELECT count(*)::int AS n FROM siyue.outbox_jobs WHERE status='pending' AND payload_ciphertext IS NOT NULL"),2);
});
