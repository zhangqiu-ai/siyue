import { test, expect } from 'playwright/test';
import { randomBytes, randomUUID } from 'node:crypto';
import { startPostgresFixture } from '../../apps/server/tests/integration/postgres-fixture.mjs';
import { createEmailFixture } from '../../apps/server/tests/integration/email-fixture.mjs';
import { createRuntimeApp } from '../../apps/server/dist/runtime-app.js';
import { createFamilyInvitationService } from '../../apps/server/dist/modules/families/invitations.js';
import { transaction } from '../../apps/server/dist/adapters/postgres/database.js';

// Real Fastify + isolated PostgreSQL. No account, household or mail leaves this fixture.
let db,fx,app,address;
test.beforeAll(async()=>{
  db=await startPostgresFixture();fx=await createEmailFixture(db);
  const familyInvitations=createFamilyInvitationService(db.app,fx.service,fx.cipher,randomBytes(32),fx.clock);
  app=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email,familyInvitations});
  address=await app.listen({host:'127.0.0.1',port:0});
});
test.afterAll(async()=>{await app?.close();await db?.stop();});
const headers=(token,key)=>({authorization:`Bearer ${token}`,...(key?{'idempotency-key':key}:{})});
async function createFamily(request,token){
  const response=await request.post(address+'/v1/families',{headers:headers(token,randomUUID())});
  expect(response.status()).toBe(201);
  return (await response.json()).data;
}

test('an adult creates a family once, reads only their membership and cannot forge role in the request',async({request})=>{
  const mine=await fx.register(`family-${randomUUID()}@example.test`);
  const other=await fx.register(`family-${randomUUID()}@example.test`);
  const key=randomUUID(),token=mine.tokens.accessToken;
  const forged=await request.post(address+'/v1/families',{headers:headers(token,randomUUID()),data:{role:'owner',subjectKind:'adult'}});
  expect(forged.status()).toBe(400);
  const created=await request.post(address+'/v1/families',{headers:headers(token,key)});
  expect(created.status()).toBe(201);
  const family=(await created.json()).data;
  expect(family).toEqual({familyId:expect.any(String),ownerSubjectId:mine.tokens.session.subjectId,role:'owner',membershipVersion:1,familyVersion:1});
  expect((await request.post(address+'/v1/families',{headers:headers(token,key)})).status()).toBe(201);
  const replay=(await (await request.post(address+'/v1/families',{headers:headers(token,key)})).json()).data;
  expect(replay).toEqual(family);
  expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.families WHERE owner_subject_id=$1',[mine.tokens.session.subjectId])).rows[0].n).toBe(1);
  const own=(await (await request.get(address+'/v1/families',{headers:headers(token)})).json()).data;
  expect(own).toEqual({items:[family]});
  const detail=(await (await request.get(address+`/v1/families/${family.familyId}`,{headers:headers(token)})).json()).data;
  expect(detail).toEqual(family);
  const foreign=await request.get(address+`/v1/families/${family.familyId}`,{headers:headers(other.tokens.accessToken)});
  expect(foreign.status()).toBe(404);
  expect((await (await request.get(address+'/v1/families',{headers:headers(other.tokens.accessToken)})).json()).data.items).toEqual([]);
  expect(JSON.stringify(await foreign.json())).not.toContain(mine.tokens.session.subjectId);
});

test('family creation requires one valid session and one idempotency key; a revoked session cannot read',async({request})=>{
  const who=await fx.register(`family-${randomUUID()}@example.test`),token=who.tokens.accessToken;
  expect((await request.post(address+'/v1/families',{headers:headers(token)})).status()).toBe(400);
  expect((await request.post(address+'/v1/families',{headers:headers(token,'bad-key')})).status()).toBe(400);
  expect((await request.post(address+'/v1/families',{headers:{'idempotency-key':randomUUID()}})).status()).toBe(400);
  expect((await request.post(address+'/v1/families?role=owner',{headers:headers(token,randomUUID())})).status()).toBe(400);
  const key=randomUUID();
  const responses=await Promise.all(Array.from({length:2},()=>request.post(address+'/v1/families',{headers:headers(token,key)})));
  expect(responses.map(item=>item.status())).toEqual([201,201]);
  expect((await responses[0].json()).data.familyId).toBe((await responses[1].json()).data.familyId);
  await db.app.query('UPDATE siyue.auth_sessions SET revoked_at=now() WHERE id=$1',[who.tokens.session.sessionId]);
  expect((await request.get(address+'/v1/families',{headers:headers(token)})).status()).toBe(401);
});

test('targeted family invitation requires the matching verified account and adds only a member once',async({request})=>{
  const owner=await fx.register(`owner-${randomUUID()}@example.test`);
  const invitedAddress=`invited-${randomUUID()}@example.test`;
  const invited=await fx.register(invitedAddress),stranger=await fx.register(`stranger-${randomUUID()}@example.test`);
  const family=await createFamily(request,owner.tokens.accessToken);
  const created=await request.post(address+`/v1/families/${family.familyId}/invitations`,{
    headers:headers(owner.tokens.accessToken,randomUUID()),
    data:{intendedEmail:invitedAddress,expectedMembershipVersion:family.membershipVersion,expectedFamilyVersion:family.familyVersion},
  });
  expect(created.status()).toBe(201);
  const invitation=(await created.json()).data;
  expect(invitation).toEqual({invitationId:expect.any(String),token:expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),expiresAt:expect.any(String)});
  const stored=(await db.app.query('SELECT * FROM siyue.family_invitations WHERE id=$1',[invitation.invitationId])).rows[0];
  expect(JSON.stringify(stored)).not.toContain(invitation.token);
  const denied=await request.post(address+'/v1/family-invitations/accept',{headers:headers(stranger.tokens.accessToken,randomUUID()),data:{token:invitation.token}});
  expect(denied.status()).toBe(403);
  const key=randomUUID();
  const accepted=await request.post(address+'/v1/family-invitations/accept',{headers:headers(invited.tokens.accessToken,key),data:{token:invitation.token}});
  expect(accepted.status()).toBe(200);
  expect((await accepted.json()).data).toEqual({familyId:family.familyId,ownerSubjectId:owner.tokens.session.subjectId,role:'member',membershipVersion:1,familyVersion:1});
  const replay=await request.post(address+'/v1/family-invitations/accept',{headers:headers(invited.tokens.accessToken,key),data:{token:invitation.token}});
  expect(replay.status()).toBe(200);
  expect((await replay.json()).data).toEqual((await accepted.json()).data);
  expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',[family.familyId,invited.tokens.session.subjectId])).rows[0].n).toBe(1);
  expect((await db.app.query("SELECT role FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2",[family.familyId,invited.tokens.session.subjectId])).rows[0].role).toBe('member');
  expect((await request.get(address+'/v1/families',{headers:headers(stranger.tokens.accessToken)})).status()).toBe(200);
  expect((await (await request.get(address+'/v1/families',{headers:headers(stranger.tokens.accessToken)})).json()).data.items).toEqual([]);
});

test('member cannot invite and an inviter version change blocks acceptance of an outstanding token',async({request})=>{
  const owner=await fx.register(`owner-${randomUUID()}@example.test`);
  const member=await fx.register(`member-${randomUUID()}@example.test`);
  const target=await fx.register(`target-${randomUUID()}@example.test`);
  const family=await createFamily(request,owner.tokens.accessToken);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",[family.familyId,member.tokens.session.subjectId]);
  const memberCreate=await request.post(address+`/v1/families/${family.familyId}/invitations`,{
    headers:headers(member.tokens.accessToken,randomUUID()),data:{expectedMembershipVersion:1,expectedFamilyVersion:1},
  });
  expect(memberCreate.status()).toBe(403);
  const invited=await request.post(address+`/v1/families/${family.familyId}/invitations`,{
    headers:headers(owner.tokens.accessToken,randomUUID()),data:{expectedMembershipVersion:1,expectedFamilyVersion:1},
  });
  expect(invited.status()).toBe(201);
  const token=(await invited.json()).data.token;
  await db.app.query('UPDATE siyue.family_memberships SET version=version+1 WHERE family_id=$1 AND subject_id=$2',[family.familyId,owner.tokens.session.subjectId]);
  const accept=await request.post(address+'/v1/family-invitations/accept',{headers:headers(target.tokens.accessToken,randomUUID()),data:{token}});
  expect(accept.status()).toBe(409);
  expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.family_memberships WHERE family_id=$1 AND subject_id=$2',[family.familyId,target.tokens.session.subjectId])).rows[0].n).toBe(0);
});

test('a child device session cannot read family summaries and never receives the owner identity',async({request})=>{
  const guardian=await fx.register(`guardian-${randomUUID()}@example.test`),guardianId=guardian.tokens.session.subjectId;
  const family=await createFamily(request,guardian.tokens.accessToken);
  const childId=randomUUID(),consentId=randomUUID(),grantId=randomUUID();
  // The preconditions owned by the neighbouring guardianship and pairing slices: an active child
  // membership, a recorded consent, a live guardian relationship and a real grant with scopes=[].
  await db.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'child','小禾')",[childId]);
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",[family.familyId,childId]);
  await db.app.query("INSERT INTO siyue.consent_records(id,actor_subject_id,subject_id,purpose,policy_version) VALUES($1,$2,$3,'child-guardianship','0.0.1')",[consentId,guardianId,childId]);
  await db.app.query('INSERT INTO siyue.guardian_relationships(family_id,guardian_subject_id,child_subject_id,consent_record_id) VALUES($1,$2,$3,$4)',[family.familyId,guardianId,childId,consentId]);
  await db.app.query(`INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,platform,device_label,
    guardian_relationship_version,guardian_credential_version,scopes,expires_at)
    VALUES($1,$2,$3,$4,$5,'ios','Synthetic iPad',1,1,ARRAY[]::text[],$6)`,
  [grantId,childId,guardianId,family.familyId,randomUUID(),new Date(+fx.clock()+30*86_400_000-1_000)]);
  const child=await transaction(db.app,client=>fx.service.issueChild(client,grantId));
  expect(child.session.subjectKind).toBe('child');
  expect((await db.app.query('SELECT scopes FROM siyue.device_grants WHERE id=$1',[grantId])).rows[0].scopes).toEqual([]);
  // The child session itself is live, so the refusal below is an authorization decision, not a dead token.
  const session=await request.get(address+'/v1/account/session',{headers:headers(child.accessToken)});
  expect(session.status()).toBe(200);
  expect((await session.json()).subjectKind).toBe('child');
  for(const url of ['/v1/families',`/v1/families/${family.familyId}`]){
    const response=await request.get(address+url,{headers:headers(child.accessToken)});
    expect(response.status()).toBe(403);
    const body=await response.json();
    expect(body.error.code).toBe('FAMILY_ADULT_REQUIRED');
    expect(JSON.stringify(body)).not.toContain(guardianId);
    expect(JSON.stringify(body)).not.toContain(family.familyId);
  }
  // The adult owner still reads the same family summary through both routes.
  expect((await (await request.get(address+'/v1/families',{headers:headers(guardian.tokens.accessToken)})).json()).data.items).toEqual([family]);
  expect((await (await request.get(address+`/v1/families/${family.familyId}`,{headers:headers(guardian.tokens.accessToken)})).json()).data).toEqual(family);
});
