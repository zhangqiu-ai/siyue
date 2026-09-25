import { test,before,beforeEach,after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { accountLoginMethodsSchema } from '@siyue/contracts';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createEmailFixture } from './email-fixture.mjs';
import { transaction } from '../../dist/adapters/postgres/database.js';
import { createAppleIdentityStorage } from '../../dist/identities/apple/identity-storage.js';
import { createIdentitySummary, maskLoginEmail } from '../../dist/modules/auth/identities.js';

// Isolated temporary PostgreSQL only. The Apple identity is a synthetic exchange result, no
// provider is contacted, and every address is a reserved example.test value.
const namespace='app.siyue.synthetic';
let db,fx,summary,apples;
before(async()=>{db=await startPostgresFixture();});
beforeEach(async()=>{
  await db.admin.query('TRUNCATE siyue.subjects,siyue.email_challenges,siyue.idempotency_records,siyue.rate_limit_buckets,siyue.outbox_jobs,siyue.security_events CASCADE');
  fx=await createEmailFixture(db);
  summary=createIdentitySummary(db.app);
  apples=createAppleIdentityStorage(fx.cipher,namespace);
});
after(async()=>{await db?.stop();});

/** Adult subject created by the real Apple identity repository, then given an Apple session. */
async function appleOnly(){
  const identity=await transaction(db.app,client=>apples.resolve(client,{identity:{provider:'apple',subject:`synthetic-${randomUUID()}`,clientId:'app.siyue.synthetic'},refreshToken:`synthetic-refresh-${randomUUID()}`}));
  const tokens=await transaction(db.app,client=>fx.service.issue(client,identity.subjectId,randomUUID(),'apple'));
  return {...identity,tokens};
}
/** Real link flow: proves control of an address and creates the login email plus first password. */
async function linkEmail(who,address){
  const grant=await transaction(db.app,client=>fx.service.issueReauth(client,who.tokens.session.sessionId,'link-identity'));
  const proof=await fx.email.linkRequest(who.tokens.accessToken,{email:address,locale:'zh-CN',reauthGrant:grant.reauthGrant},randomUUID(),fx.context);
  const job=(await db.app.query('SELECT * FROM siyue.outbox_jobs WHERE aggregate_id=$1',[proof.challengeId])).rows[0];
  const code=fx.cipher.open(job.payload_ciphertext,`mail:${job.id}`).code;
  await fx.email.linkConfirm(who.tokens.accessToken,{challengeId:proof.challengeId,requestSecret:proof.requestSecret,code,newPassword:'  synthetic-si yue-pass-🌙  '},randomUUID(),fx.context);
  return address;
}
const row=async(sql,...params)=>(await db.app.query(sql,params.length===1&&Array.isArray(params[0])?params[0]:params)).rows[0];
const items=subjectId=>summary.list(subjectId).then(result=>result.items);

test('an Apple-only account lists one Apple method while a profile address without a password is not a method',async()=>{
  const who=await appleOnly();
  // Both rows are stored profile data without a password credential: neither is a login method.
  await db.app.query('INSERT INTO siyue.account_emails(id,subject_id,email_original,email_normalized,verified_at,login_enabled) VALUES($1,$2,$3,$4,now(),false)',[randomUUID(),who.subjectId,'disabled.profile@example.test','disabled.profile@example.test']);
  await db.app.query('INSERT INTO siyue.account_emails(id,subject_id,email_original,email_normalized,verified_at,is_primary) VALUES($1,$2,$3,$4,now(),false)',[randomUUID(),who.subjectId,'profile.only@example.test','profile.only@example.test']);
  assert.deepEqual(await items(who.subjectId),[{identityId:`apple:${who.identityId}`,kind:'apple',status:'active'}]);
  // A registered email account is one masked email method and one Apple method is absent from it.
  const registered=await fx.register('masked.login@example.test');
  const emailRow=await row('SELECT id FROM siyue.account_emails WHERE subject_id=$1',[registered.tokens.session.subjectId]);
  assert.deepEqual(await items(registered.tokens.session.subjectId),[
    {identityId:`email:${emailRow.id}`,kind:'email_password',status:'active',emailMask:'m•••@example.test'}]);
  assert.equal(JSON.stringify(await items(registered.tokens.session.subjectId)).includes('masked.login@example.test'),false);
});

test('a revoked identity or a disabled address drops out while both usable methods list deterministically',async()=>{
  const who=await appleOnly();
  await linkEmail(who,'both.methods@example.test');
  const emailRow=await row('SELECT id,login_enabled FROM siyue.account_emails WHERE subject_id=$1',[who.subjectId]);
  const listed=await items(who.subjectId);
  assert.deepEqual(listed,[
    {identityId:`email:${emailRow.id}`,kind:'email_password',status:'active',emailMask:'b•••@example.test'},
    {identityId:`apple:${who.identityId}`,kind:'apple',status:'active'}]);
  // Disabling the address is not a deletion, but it is no longer a way to sign in.
  await db.app.query('UPDATE siyue.account_emails SET login_enabled=false WHERE subject_id=$1',[who.subjectId]);
  assert.deepEqual(await items(who.subjectId),[{identityId:`apple:${who.identityId}`,kind:'apple',status:'active'}]);
  await db.app.query('UPDATE siyue.account_emails SET login_enabled=true WHERE subject_id=$1',[who.subjectId]);
  // An active identity without its provider credential cannot actually complete Apple login.
  await db.app.query('DELETE FROM siyue.apple_provider_credentials WHERE identity_id=$1',[who.identityId]);
  assert.deepEqual(await items(who.subjectId),[{identityId:`email:${emailRow.id}`,kind:'email_password',status:'active',emailMask:'b•••@example.test'}]);
  await db.app.query("UPDATE siyue.external_identities SET status='revoked' WHERE id=$1",[who.identityId]);
  assert.deepEqual(await items(who.subjectId),[{identityId:`email:${emailRow.id}`,kind:'email_password',status:'active',emailMask:'b•••@example.test'}]);
  // A blocked, deleted or child subject has no usable login method of its own.
  for(const status of ['blocked','deletion_pending','deleted']){
    await db.app.query('UPDATE siyue.subjects SET status=$2 WHERE id=$1',[who.subjectId,status]);
    assert.deepEqual(await items(who.subjectId),[],`status ${status} must not list methods`);
  }
  await db.app.query("UPDATE siyue.subjects SET status='active',kind='child' WHERE id=$1",[who.subjectId]);
  assert.deepEqual(await items(who.subjectId),[]);
});

test('another subject never sees foreign handles and an invalid handle or full address cannot be serialized',async()=>{
  const mine=await appleOnly(),other=await appleOnly();
  await linkEmail(mine,'mine.only@example.test');
  const listed=await items(mine.subjectId);
  assert.equal(listed.some(item=>item.identityId.includes(other.identityId)),false);
  assert.deepEqual((await items(other.subjectId)).map(item=>item.identityId),[`apple:${other.identityId}`]);
  assert.equal(new Set(listed.map(item=>item.identityId)).size,listed.length);
  // Masking keeps the first local character and the domain and never echoes the address.
  assert.equal(maskLoginEmail('moon@example.test'),'m•••@example.test');
  assert.equal(maskLoginEmail('🌙moon@example.test'),'🌙•••@example.test');
  for(const malformed of ['not-an-address','@example.test','local@','']) assert.equal(maskLoginEmail(malformed),'••••');
  // The strict contract is the last boundary: a full address, a provider detail or a duplicate
  // handle is rejected instead of being serialized to the client.
  const handle=`apple:${randomUUID()}`;
  const valid={items:[{identityId:handle,kind:'apple',status:'active'}]};
  assert.equal(accountLoginMethodsSchema.safeParse(valid).success,true);
  for(const invalid of [
    {items:[{...valid.items[0],namespace}]},
    {items:[{identityId:`email:${randomUUID()}`,kind:'email_password',status:'active',emailMask:'moon@example.test'}]},
    {items:[{identityId:`email:${randomUUID()}`,kind:'email_password',status:'active',emailMask:'m•••@example.test',verifiedAt:new Date().toISOString()}]},
    {items:[{identityId:handle.toUpperCase(),kind:'apple',status:'active'}]},
    {items:[valid.items[0],valid.items[0]]},
    {items:[{identityId:`email:${randomUUID()}`,kind:'email_password',status:'revoked',emailMask:'m•••@example.test'}]},
  ]) assert.equal(accountLoginMethodsSchema.safeParse(invalid).success,false);
});
