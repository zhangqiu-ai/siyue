import { test, expect } from 'playwright/test';
import { randomUUID } from 'node:crypto';
import { startPostgresFixture } from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createAuthApiClient,createAuthController} from '../../packages/adapters/dist/index.js';
import { createEmailFixture,password } from '../../apps/server/tests/integration/email-fixture.mjs';
import { createRuntimeApp } from '../../apps/server/dist/runtime-app.js';

let db,fx,app,address;
test.beforeAll(async()=>{
  db=await startPostgresFixture();
  fx=await createEmailFixture(db);
  app=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email});
  address=await app.listen({host:'127.0.0.1',port:0});
});
test.afterAll(async()=>{await app?.close();await db?.stop();});
const headers=token=>({authorization:`Bearer ${token}`});
const body=scope=>({expectedFamilyVersion:scope.familyVersion,
  expectedMembershipVersion:scope.membershipVersion,
  expectedOwnerMembershipVersion:scope.ownerMembershipVersion,
  expectedChildScopeDigest:scope.childScopeDigest,
  acceptance:{familyManagement:true,guardianship:true}});
async function scene(request){
  const owner=await fx.register(`owner-${randomUUID()}@example.test`);
  const recipient=await fx.register(`recipient-${randomUUID()}@example.test`);
  const outsider=await fx.register(`outsider-${randomUUID()}@example.test`);
  const created=await request.post(address+'/v1/families',{
    headers:{...headers(owner.tokens.accessToken),'idempotency-key':randomUUID()}});
  expect(created.status()).toBe(201);
  const family=(await created.json()).data;
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",
    [family.familyId,recipient.tokens.session.subjectId]);
  return {owner,recipient,outsider,family};
}

test('recipient previews and explicitly accepts only their own family responsibility over real HTTP',async({request})=>{
  const {owner,recipient,outsider,family}=await scene(request);
  const url=`${address}/v1/families/${family.familyId}/management-acceptance`;
  const previewResponse=await request.get(url+'/preview',{headers:headers(recipient.tokens.accessToken)});
  expect(previewResponse.status()).toBe(200);
  const preview=(await previewResponse.json()).data;
  expect(preview).toMatchObject({familyId:family.familyId,
    ownerSubjectId:owner.tokens.session.subjectId,
    recipientSubjectId:recipient.tokens.session.subjectId,childCount:0});
  expect((await request.get(url+'/preview',{headers:headers(outsider.tokens.accessToken)})).status()).toBe(404);
  expect((await request.get(url+'/preview',{headers:headers(owner.tokens.accessToken)})).status()).toBe(404);
  const accepted=await request.post(url,{headers:headers(recipient.tokens.accessToken),data:body(preview)});
  expect(accepted.status()).toBe(201);
  const receipt=(await accepted.json()).data;
  expect(receipt).toMatchObject({familyId:family.familyId,
    ownerSubjectId:owner.tokens.session.subjectId,
    recipientSubjectId:recipient.tokens.session.subjectId,
    childScopeDigest:preview.childScopeDigest,consumedAt:null});
  const replay=await request.post(url,{headers:headers(recipient.tokens.accessToken),data:body(preview)});
  expect(replay.status()).toBe(201);
  expect((await replay.json()).data).toEqual(receipt);
  expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.family_management_acceptances WHERE id=$1',
    [receipt.acceptanceId])).rows[0].n).toBe(1);
  expect((await db.app.query('SELECT owner_subject_id FROM siyue.families WHERE id=$1',
    [family.familyId])).rows[0].owner_subject_id).toBe(owner.tokens.session.subjectId);
  expect((await request.delete(address+'/v1/me/account',{headers:headers(owner.tokens.accessToken),
    data:{reauthGrant:'invalid',confirmation:true,dependencyDisposition:{kind:'none'}}})).status()).toBe(404);
});

test('scope changes and forged identities cannot create a usable acceptance',async({request})=>{
  const {recipient,family}=await scene(request);
  const url=`${address}/v1/families/${family.familyId}/management-acceptance`;
  const preview=(await (await request.get(url+'/preview',{
    headers:headers(recipient.tokens.accessToken)})).json()).data;
  for(const forged of [{...body(preview),recipientSubjectId:randomUUID()},
    {...body(preview),acceptance:{familyManagement:true,guardianship:false}}]) {
    expect((await request.post(url,{headers:headers(recipient.tokens.accessToken),data:forged})).status()).toBe(400);
  }
  expect((await request.post(url+'?role=owner',{headers:headers(recipient.tokens.accessToken),
    data:body(preview)})).status()).toBe(400);
  await db.app.query('UPDATE siyue.families SET version=version+1 WHERE id=$1',[family.familyId]);
  const stale=await request.post(url,{headers:headers(recipient.tokens.accessToken),data:body(preview)});
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error.code).toBe('FAMILY_STALE_AUTHORIZATION');
  expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.family_management_acceptances WHERE family_id=$1',
    [family.familyId])).rows[0].n).toBe(0);
});


test('recipient controller binds explicit responsibility acceptance to its displayed scope over real HTTP',async({request})=>{
 const {owner,recipient,family}=await scene(request);let saved=null;
 const api=createAuthApiClient({environment:'test',apiBaseUrl:address+'/v1',fetcher:fetch});
 const controller=createAuthController({api,newId:randomUUID,now:()=>+fx.clock(),vault:{read:async()=>saved,write:async value=>{saved=value;}}});
 try {
  await controller.bootstrap();await controller.login({email:recipient.address,password,platform:'desktop'});
  const scope=await controller.familyManagementPreview(family.familyId);
  expect(scope.recipientSubjectId).toBe(recipient.tokens.session.subjectId);
  await expect(controller.acceptFamilyManagement(family.familyId,{...body(scope),expectedChildScopeDigest:'b'.repeat(64)})).rejects.toMatchObject({code:'invalid_request'});
  const accepted=await controller.acceptFamilyManagement(family.familyId,body(scope));
  expect(accepted).toMatchObject({familyId:family.familyId,recipientSubjectId:recipient.tokens.session.subjectId,consumedAt:null});
  expect((await db.app.query('SELECT owner_subject_id FROM siyue.families WHERE id=$1',[family.familyId])).rows[0].owner_subject_id).toBe(owner.tokens.session.subjectId);
  expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.family_management_acceptances WHERE id=$1',[accepted.acceptanceId])).rows[0].n).toBe(1);
 } finally {await controller.dispose();}
});
