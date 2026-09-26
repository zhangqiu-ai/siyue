import { test,before,beforeEach,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture,password } from './email-fixture.mjs';
import { createMailWorker } from '../../dist/adapters/mail/outbox.js';
import { transaction } from '../../dist/adapters/postgres/database.js';
let db,fx;
before(async()=>{db=await startPostgresFixture();});
beforeEach(async()=>{
  await db.admin.query('TRUNCATE siyue.subjects,siyue.email_challenges,siyue.idempotency_records,siyue.rate_limit_buckets,siyue.outbox_jobs,siyue.security_events CASCADE');
  fx=await createEmailFixture(db);
});
after(async()=>{await db?.stop();});
const codeIs=code=>error=>error.code===code;

test('challenge stores MAC/secret digest only; same idempotency key recovers once, changed request conflicts',async()=>{
  const key=randomUUID();const input={email:' Test+tag@Example.test ',locale:'en-US'};
  const first=await fx.email.request('register',input,key,fx.context);
  const second=await fx.email.request('register',{...input,email:'test+tag@example.test'},key,fx.context);
  assert.deepEqual(first,second);
  const row=(await db.app.query('SELECT * FROM siyue.email_challenges')).rows[0];
  assert.equal(row.email_normalized,'test+tag@example.test');
  assert.notEqual(row.request_secret_hash,first.requestSecret);
  const job=(await db.app.query('SELECT * FROM siyue.outbox_jobs')).rows[0];
  assert.equal(job.status,'pending');
  const payload=fx.cipher.open(job.payload_ciphertext,`mail:${job.id}`);
  assert.match(payload.code,/^\d{6}$/);assert.notEqual(row.code_mac,payload.code);
  await assert.rejects(fx.email.request('register',{...input,email:'other@example.test'},key,fx.context),codeIs('AUTH_IDEMPOTENCY_CONFLICT'));
  assert.equal((await db.app.query('SELECT * FROM siyue.outbox_jobs')).rowCount,1);
  fx.advance(60_001);
  await assert.rejects(fx.email.request('register',input,key,fx.context),codeIs('AUTH_OPERATION_COMPLETED_LOGIN_REQUIRED'));
  await fx.email.cleanup();
  assert.equal((await db.app.query('SELECT response_ciphertext FROM siyue.idempotency_records')).rows[0].response_ciphertext,null);
});

test('concurrent registration issues exactly one subject/session, retry restores same credentials, rotation blocks stale restore',async()=>{
  const proof=await fx.request();const data=fx.registration(proof);const key=randomUUID();
  const results=await Promise.all(Array.from({length:8},()=>fx.email.register(data,key,fx.context)));
  for(const result of results) assert.deepEqual(result,results[0]);
  assert.equal((await db.app.query('SELECT * FROM siyue.subjects')).rowCount,1);
  assert.equal((await db.app.query('SELECT subject_id FROM siyue.email_challenges WHERE id=$1',[proof.challengeId])).rows[0].subject_id,results[0].session.subjectId);
  assert.equal((await db.app.query('SELECT * FROM siyue.auth_sessions')).rowCount,1);
  const encoded=(await db.app.query('SELECT password_hash FROM siyue.password_credentials')).rows[0].password_hash.split('$');
  assert.equal(encoded[1],'argon2id');assert.equal(encoded[2],'v=19');
  assert.deepEqual(Object.fromEntries(encoded[3].split(',').map(part=>part.split('='))),{m:'65536',p:'1',t:'3'});
  assert.deepEqual(await fx.service.verify(results[0].accessToken),results[0].session);
  await fx.service.refresh(results[0].refreshToken,randomUUID());
  await assert.rejects(fx.email.register(data,key,fx.context),codeIs('AUTH_OPERATION_COMPLETED_LOGIN_REQUIRED'));
});

test('expired email challenges are purged after their 24-hour retention window',async()=>{
  const proof=await fx.request('register');
  fx.advance(600_000+86_400_000-1);
  await fx.email.cleanup();
  assert.equal((await db.app.query('SELECT id FROM siyue.email_challenges WHERE id=$1',[proof.challengeId])).rowCount,1);
  fx.advance(1);
  await fx.email.cleanup();
  assert.equal((await db.app.query('SELECT id FROM siyue.email_challenges WHERE id=$1',[proof.challengeId])).rowCount,0);
});

test('different confirm keys race: only one consumes proof; registered email reveals conflict only after valid proof',async()=>{
  const address='race@example.test';const proof=await fx.request('register',address);const data=fx.registration(proof);
  const results=await Promise.allSettled([fx.email.register(data,randomUUID(),fx.context),fx.email.register(data,randomUUID(),fx.context)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await db.app.query('SELECT * FROM siyue.subjects')).rowCount,1);
  fx.advance(60_001);const again=await fx.request('register',address);
  await assert.rejects(fx.email.register({...fx.registration(again),code:again.code==='000000'?'000001':'000000'},randomUUID(),fx.context),codeIs('AUTH_CHALLENGE_INVALID'));
  await assert.rejects(fx.email.register(fx.registration(again),randomUUID(),fx.context),codeIs('AUTH_EMAIL_ALREADY_EXISTS'));
  assert.equal((await db.app.query('SELECT * FROM siyue.auth_sessions')).rowCount,1);
});

test('wrong codes commit attempts, idempotent error does not double count, fifth locks and resend supersedes',async()=>{
  const address='wrong@example.test';const proof=await fx.request('register',address);
  const data={...fx.registration(proof),code:proof.code==='000000'?'000001':'000000'};const key=randomUUID();
  for(let n=0;n<2;n++) await assert.rejects(fx.email.register(data,key,fx.context),codeIs('AUTH_CHALLENGE_INVALID'));
  assert.equal((await db.app.query('SELECT attempts FROM siyue.email_challenges WHERE id=$1',[proof.challengeId])).rows[0].attempts,1);
  for(let n=0;n<4;n++) await assert.rejects(fx.email.register(data,randomUUID(),fx.context),codeIs('AUTH_CHALLENGE_INVALID'));
  const row=(await db.app.query('SELECT attempts,status FROM siyue.email_challenges WHERE id=$1',[proof.challengeId])).rows[0];assert.deepEqual(row,{attempts:5,status:'locked'});
  await assert.rejects(fx.email.register(fx.registration(proof),randomUUID(),fx.context),codeIs('AUTH_CHALLENGE_INVALID'));
  await assert.rejects(fx.request('register',address),codeIs('AUTH_RATE_LIMITED'));
  fx.advance(60_001);const next=await fx.request('register',address);
  fx.advance(60_001);await fx.request('register',address);
  await assert.rejects(fx.email.register(fx.registration(next),randomUUID(),fx.context),codeIs('AUTH_CHALLENGE_INVALID'));
});

test('verification budget survives resend; expiry, request secret and purpose are enforced',async()=>{
  // Keep the five resend rounds inside one fixed hourly verification window.
  fx.advance(Math.floor(+fx.clock()/3_600_000)*3_600_000+60_000-+fx.clock());
  const address='budget@example.test';
  for(let round=0;round<4;round++) {
    const proof=await fx.request('register',address);const data={...fx.registration(proof),code:proof.code==='000000'?'000001':'000000'};
    for(let n=0;n<5;n++) await assert.rejects(fx.email.register(data,randomUUID(),fx.context),codeIs('AUTH_CHALLENGE_INVALID'));
    fx.advance(60_001);
  }
  const proof=await fx.request('register',address);
  await assert.rejects(fx.email.register(fx.registration(proof),randomUUID(),fx.context),codeIs('AUTH_RATE_LIMITED'));
  const other=await fx.request();
  await assert.rejects(fx.email.reset({challengeId:other.challengeId,requestSecret:other.requestSecret,code:other.code,newPassword:password},randomUUID(),fx.context),codeIs('AUTH_CHALLENGE_INVALID'));
  await assert.rejects(fx.email.register({...fx.registration(other),requestSecret:'x'.repeat(43)},randomUUID(),fx.context),codeIs('AUTH_CHALLENGE_INVALID'));
  fx.advance(600_000);
  await assert.rejects(fx.email.register(fx.registration(other),randomUUID(),fx.context),codeIs('AUTH_CHALLENGE_INVALID'));
});

test('known/unknown login failures share error; exact Unicode/spaces preserved and common passwords rejected',async()=>{
  await assert.rejects(fx.passwords.hash('password'),codeIs('AUTH_PASSWORD_TOO_COMMON'));
  const {address}=await fx.register();
  for(const email of [address,'missing@example.test']) await assert.rejects(fx.email.login({email,password:'wrong-but-long-password',installationId:'test',platform:'desktop'},fx.context),codeIs('AUTH_INVALID_CREDENTIALS'));
  await assert.rejects(fx.email.login({email:address,password:password.trim(),installationId:'test',platform:'android'},fx.context),codeIs('AUTH_INVALID_CREDENTIALS'));
  const tokens=await fx.email.login({email:address.toUpperCase(),password,installationId:'test',platform:'android'},fx.context);
  assert.equal((await fx.service.verify(tokens.accessToken)).subjectKind,'adult');
  assert.equal((await db.app.query('SELECT platform FROM siyue.auth_sessions WHERE id=$1',[tokens.session.sessionId])).rows[0].platform,'android');
});

test('reset commits password/version and revokes every token/grant; replay does not repeat or auto-login',async()=>{
  const {tokens,address}=await fx.register();
  const other=await fx.email.login({email:address,password,installationId:'second',platform:'desktop'},fx.context);
  const grant=await fx.email.reauth(tokens.accessToken,{password,action:'change-password'},fx.context);
  fx.advance(60_001);const proof=await fx.request('password-reset',address);
  const data={challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:proof.code,newPassword:'New 私有 🌙 pass 2026'};const key=randomUUID();
  assert.deepEqual(await fx.email.reset(data,key,fx.context),{passwordChanged:true});
  assert.deepEqual(await fx.email.reset(data,key,fx.context),{passwordChanged:true});
  assert.equal((await db.app.query('SELECT credential_version FROM siyue.subjects')).rows[0].credential_version,2);
  assert.equal((await db.app.query('SELECT * FROM siyue.auth_sessions WHERE revoked_at IS NULL')).rowCount,0);
  for(const session of [tokens,other]) {
    await assert.rejects(fx.service.verify(session.accessToken));await assert.rejects(fx.service.refresh(session.refreshToken,randomUUID()));
  }
  await assert.rejects(transaction(db.app,c=>fx.service.consumeReauth(c,tokens.session.sessionId,grant.reauthGrant,'change-password')));
  await assert.rejects(fx.email.login({email:address,password,installationId:'test',platform:'ios'},fx.context),codeIs('AUTH_INVALID_CREDENTIALS'));
  const fresh=await fx.email.login({email:address,password:data.newPassword,installationId:'test',platform:'ios'},fx.context);
  assert.equal(fresh.session.subjectId,tokens.session.subjectId);
});

test('unknown reset request has same public keys; cannot become registration or create account',async()=>{
  const proof=await fx.request('password-reset','unknown@example.test');
  assert.equal(proof.code,undefined);
  await assert.rejects(fx.email.reset({challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:'000000',newPassword:password},randomUUID(),fx.context),codeIs('AUTH_CHALLENGE_INVALID'));
  assert.equal((await db.app.query('SELECT * FROM siyue.subjects')).rowCount,0);
});

test('password change consumes correct action only and storage failure rolls back grant/password',async()=>{
  const {tokens,address}=await fx.register();
  const wrong=await fx.email.reauth(tokens.accessToken,{password,action:'delete-account'},fx.context);
  await assert.rejects(fx.email.changePassword(tokens.accessToken,{newPassword:password+'new',reauthGrant:wrong.reauthGrant},randomUUID(),fx.context),codeIs('AUTH_REAUTH_REQUIRED'));
  const grant=await fx.email.reauth(tokens.accessToken,{password,action:'change-password'},fx.context);
  await db.admin.query('REVOKE UPDATE ON siyue.password_credentials FROM siyue_app');
  try {await assert.rejects(fx.email.changePassword(tokens.accessToken,{newPassword:password+'new',reauthGrant:grant.reauthGrant},randomUUID(),fx.context));}
  finally {await db.admin.query('GRANT UPDATE ON siyue.password_credentials TO siyue_app');}
  assert.equal((await db.app.query('SELECT consumed_at FROM siyue.reauth_grants WHERE id=$1',[grant.reauthGrant.split('.')[0]])).rows[0].consumed_at,null);
  const key=randomUUID(),change={newPassword:password+'new',reauthGrant:grant.reauthGrant};
  assert.deepEqual(await fx.email.changePassword(tokens.accessToken,change,key,fx.context),{passwordChanged:true});
  assert.deepEqual(await fx.email.changePassword(tokens.accessToken,change,key,fx.context),{passwordChanged:true});
  await assert.rejects(fx.email.changePassword(tokens.accessToken,{...change,newPassword:password+'other'},key,fx.context),codeIs('AUTH_IDEMPOTENCY_CONFLICT'));
  await assert.rejects(fx.service.verify(tokens.accessToken));
  assert.equal((await db.app.query('SELECT credential_version FROM siyue.subjects WHERE id=$1',[tokens.session.subjectId])).rows[0].credential_version,2);
  assert.equal((await db.app.query("SELECT count(*) FROM siyue.outbox_jobs WHERE kind='security-notice' AND aggregate_id=$1",[tokens.session.subjectId])).rows[0].count,'1');
  assert.equal((await db.app.query("SELECT count(*) FROM siyue.security_events WHERE event_type='password.change' AND subject_id=$1",[tokens.session.subjectId])).rows[0].count,'1');
  await fx.email.login({email:address,password:password+'new',installationId:'test',platform:'ios'},fx.context);
});

test('worker leases prevent duplicate claims, retry pre-submit failure, uncertain result is never resent and payloads clear',async()=>{
  await fx.request();let sends=0;let release;
  const transport={send:async()=>{sends++;await new Promise(resolve=>{release=resolve;});return 'accepted';},close(){}};
  const first=createMailWorker(db.app,fx.cipher,transport,fx.clock);const second=createMailWorker(db.app,fx.cipher,transport,fx.clock);
  const pending=first.tick();
  while(!release) await new Promise(resolve=>setTimeout(resolve,5));
  await second.tick();assert.equal(sends,1);release();await pending;
  let row=(await db.app.query('SELECT status,payload_ciphertext FROM siyue.outbox_jobs')).rows[0];assert.deepEqual(row,{status:'sent',payload_ciphertext:null});
  await fx.request();let attempts=0;
  const retry=createMailWorker(db.app,fx.cipher,{send:async()=>{attempts++;return attempts===1?'retryable':'uncertain';},close(){}},fx.clock);
  await retry.tick();fx.advance(30_000);await retry.tick();fx.advance(90_000);await retry.tick();assert.equal(attempts,2);
  row=(await db.app.query("SELECT status,payload_ciphertext FROM siyue.outbox_jobs WHERE status<>'sent'")).rows[0];assert.deepEqual(row,{status:'uncertain',payload_ciphertext:null});
});

test('worker restart marks stale sending uncertain and pending expired; neither is dispatched',async()=>{
  await fx.request();await fx.request();
  const rows=(await db.app.query('SELECT id FROM siyue.outbox_jobs ORDER BY id')).rows;
  await db.app.query("UPDATE siyue.outbox_jobs SET status='sending',lease_id=$2,lease_until=$3 WHERE id=$1",[rows[0].id,randomUUID(),new Date(+fx.clock()-1)]);
  fx.advance(600_001);let sends=0;
  await createMailWorker(db.app,fx.cipher,{send:async()=>{sends++;return 'accepted';},close(){}},fx.clock).tick();
  assert.equal(sends,0);
  assert.deepEqual((await db.app.query('SELECT status FROM siyue.outbox_jobs ORDER BY status')).rows.map(r=>r.status),['expired','uncertain']);
  assert.equal((await db.app.query('SELECT * FROM siyue.outbox_jobs WHERE payload_ciphertext IS NOT NULL')).rowCount,0);
});

test('password hashing is bounded: excess concurrent requests reject, accepted work remains verifiable',async()=>{
  const settled=await Promise.allSettled(Array.from({length:10},()=>fx.passwords.hash(password)));
  assert.equal(settled.filter(r=>r.status==='fulfilled').length,6);
  assert.equal(settled.filter(r=>r.status==='rejected'&&r.reason.code==='AUTH_BUSY').length,4);
  const hash=settled.find(r=>r.status==='fulfilled').value;
  assert.equal(await fx.passwords.verify(password,hash),true);
});

test('reset storage failure after revocation rolls back password, consumed challenge, tokens and version',async()=>{
  const {tokens,address}=await fx.register();fx.advance(60_001);const proof=await fx.request('password-reset',address);
  const data={challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:proof.code,newPassword:password+'next'};const key=randomUUID();
  await db.admin.query('REVOKE INSERT ON siyue.outbox_jobs FROM siyue_app');
  try {await assert.rejects(fx.email.reset(data,key,fx.context));}
  finally {await db.admin.query('GRANT INSERT ON siyue.outbox_jobs TO siyue_app');}
  assert.deepEqual(await fx.service.verify(tokens.accessToken),tokens.session);
  assert.equal((await db.app.query('SELECT credential_version FROM siyue.subjects')).rows[0].credential_version,1);
  assert.equal((await db.app.query('SELECT status FROM siyue.email_challenges WHERE id=$1',[proof.challengeId])).rows[0].status,'pending');
  await fx.email.reset(data,key,fx.context);await assert.rejects(fx.service.verify(tokens.accessToken));
});

test('sending limits are per email/hour/day and per IP across email addresses',async()=>{
  // Deterministic start away from fixed-window boundaries, without waiting in real time.
  fx.advance(Math.floor(+fx.clock()/86_400_000)*86_400_000+60_000- +fx.clock());
  const address='limits@example.test';
  for(let i=0;i<5;i++){await fx.request('register',address);fx.advance(60_001);}
  await assert.rejects(fx.request('register',address),codeIs('AUTH_RATE_LIMITED'));
  fx.advance(3_600_000);
  for(let i=0;i<5;i++){await fx.request('register',address);fx.advance(60_001);}
  fx.advance(3_600_000);
  await assert.rejects(fx.request('register',address),codeIs('AUTH_RATE_LIMITED'));
  for(let i=0;i<20;i++) await fx.request('register');
  // Rejected email budgets do not consume a second, unrelated budget.
  await assert.rejects(fx.request('register'),codeIs('AUTH_RATE_LIMITED'));
});

test('login budget is committed for invalid credentials and shared across retry attempts',async()=>{
  for(let i=0;i<10;i++) await assert.rejects(fx.email.login({email:'nobody@example.test',password,installationId:'test',platform:'ios'},fx.context),codeIs('AUTH_INVALID_CREDENTIALS'));
  await assert.rejects(fx.email.login({email:'nobody@example.test',password,installationId:'test',platform:'ios'},fx.context),codeIs('AUTH_RATE_LIMITED'));
});

test('global mail budget prevents many IPs bypassing the envelope',async()=>{
  fx.advance(Math.floor(+fx.clock()/3_600_000)*3_600_000+60_000- +fx.clock());
  for(let i=0;i<100;i++) await fx.email.request('register',{email:`global-${i}@example.test`,locale:'en-US'},randomUUID(),{ip:`192.0.2.${i+1}`,requestId:randomUUID()});
  await assert.rejects(fx.email.request('register',{email:'over-global@example.test',locale:'en-US'},randomUUID(),{ip:'198.51.100.1',requestId:randomUUID()}),codeIs('AUTH_RATE_LIMITED'));
  assert.equal((await db.app.query('SELECT * FROM siyue.outbox_jobs')).rowCount,100);
});

test('credential rehash preserves an already valid legacy password rather than applying new-password denylist',async()=>{
  const {address,tokens}=await fx.register();
  const argon2=await import('argon2');const legacy='correct horse battery staple';
  const hash=await argon2.hash(legacy,{type:argon2.argon2id,memoryCost:19_456,timeCost:2,parallelism:1});
  await db.app.query('UPDATE siyue.password_credentials SET password_hash=$2 WHERE subject_id=$1',[tokens.session.subjectId,hash]);
  await fx.email.login({email:address,password:legacy,installationId:'test',platform:'desktop'},fx.context);
  const updated=(await db.app.query('SELECT password_hash FROM siyue.password_credentials WHERE subject_id=$1',[tokens.session.subjectId])).rows[0].password_hash;
  assert.notEqual(updated,hash);assert.equal(fx.passwords.needsRehash(updated),false);
});

test('login verified before reset cannot issue a new session after credential version changes',async()=>{
  const {address,tokens}=await fx.register();fx.advance(60_001);const proof=await fx.request('password-reset',address);
  const {createEmailService}=await import('../../dist/modules/auth/email.js');
  const {randomBytes}=await import('node:crypto');
  let release,verified;
  const seen=new Promise(resolve=>{verified=resolve;});
  const gate=new Promise(resolve=>{release=resolve;});
  const email=createEmailService(db.app,fx.service,{...fx.passwords,async verify(value,hash){const result=await fx.passwords.verify(value,hash);verified();await gate;return result;}},fx.cipher,randomBytes(32),fx.clock);
  const pending=email.login({email:address,password,installationId:'racing-login',platform:'ios'},fx.context);
  const denied=assert.rejects(pending,codeIs('AUTH_INVALID_CREDENTIALS'));
  await seen;
  try {await fx.email.reset({challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:proof.code,newPassword:password+'new'},randomUUID(),fx.context);}
  finally {release();}
  await denied;
  assert.equal((await db.app.query('SELECT * FROM siyue.auth_sessions WHERE revoked_at IS NULL')).rowCount,0);
  await assert.rejects(fx.service.verify(tokens.accessToken));
});

test('two distinct reset submissions consume a challenge once and increase version once',async()=>{
  const {address}=await fx.register();fx.advance(60_001);const proof=await fx.request('password-reset',address);
  const data={challengeId:proof.challengeId,requestSecret:proof.requestSecret,code:proof.code,newPassword:password+'next'};
  const results=await Promise.allSettled([fx.email.reset(data,randomUUID(),fx.context),fx.email.reset(data,randomUUID(),fx.context)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await db.app.query('SELECT credential_version FROM siyue.subjects')).rows[0].credential_version,2);
  assert.equal((await db.app.query("SELECT * FROM siyue.outbox_jobs WHERE kind='security-notice'")).rowCount,1);
});

test('worker caps explicit retry at three and fails corrupted payload without dispatch',async()=>{
  await fx.request();let sends=0;
  const worker=createMailWorker(db.app,fx.cipher,{send:async()=>{sends++;return 'retryable';},close(){}},fx.clock);
  for(let i=0;i<4;i++) {await worker.tick();fx.advance(30_000);}
  assert.equal(sends,3);
  assert.deepEqual((await db.app.query('SELECT status,attempts,payload_ciphertext FROM siyue.outbox_jobs')).rows[0],{status:'failed',attempts:3,payload_ciphertext:null});
  await fx.request();await db.app.query("UPDATE siyue.outbox_jobs SET payload_ciphertext='corrupted' WHERE status='pending'");
  await worker.tick();assert.equal(sends,3);
  assert.equal((await db.app.query('SELECT * FROM siyue.outbox_jobs WHERE payload_ciphertext IS NOT NULL')).rowCount,0);
});

test('request waits for subject change before replacing challenges, preserving subject-first lock order',async()=>{
  const {address,tokens}=await fx.register();fx.advance(60_001);
  const holder=await db.app.connect();await holder.query('BEGIN');
  await holder.query('SELECT id FROM siyue.subjects WHERE id=$1 FOR UPDATE',[tokens.session.subjectId]);
  const pending=fx.request('password-reset',address);
  try {
    let waiting=false;
    for(let i=0;i<100;i++) {
      const row=(await db.admin.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename='siyue_app' AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF p%'")).rows[0];
      if(row.n>0){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.equal(waiting,true);
    assert.equal((await db.app.query("SELECT * FROM siyue.email_challenges WHERE purpose='password-reset'")).rowCount,0);
    await holder.query('UPDATE siyue.subjects SET credential_version=credential_version+1 WHERE id=$1',[tokens.session.subjectId]);
    await holder.query('COMMIT');
    const proof=await pending;
    assert.equal((await db.app.query('SELECT credential_version FROM siyue.email_challenges WHERE id=$1',[proof.challengeId])).rows[0].credential_version,2);
  } finally {await holder.query('ROLLBACK');holder.release();await pending.catch(()=>{});}
});
