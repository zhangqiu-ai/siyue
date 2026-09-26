import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {FamilyManagementAcceptancePreview,FamilyManagementAcceptanceReceipt,SessionTokens} from '@siyue/contracts';
import {createAuthController} from './auth-controller.js';
import {AuthClientError,type AuthApiClient} from './auth-api-client.js';

const baseUrl='http://127.0.0.1:8787/v1';
const password='synthetic-password-1';
const uuid=()=>randomUUID();
const at=(offsetMs:number)=>new Date(Date.now()+offsetMs).toISOString();
const refreshSecret=()=>`${uuid()}.${'r'.repeat(43)}`;
const childScopeDigest='c'.repeat(64);

/** One issued session per call, so a test can tell whose bearer a request carried and which account a
 *  switch installed. */
function session(subjectKind:'adult'|'child'):SessionTokens {
  const access=at(600_000),absolute=at(30*24*60*60*1000);
  return {tokenType:'Bearer',accessToken:`access-${uuid()}`,accessExpiresAt:access,refreshToken:refreshSecret(),
    refreshExpiresAt:absolute,sessionAbsoluteExpiresAt:absolute,
    session:{subjectId:uuid(),subjectKind,sessionId:uuid(),expiresAt:access}};
}

/**
 * One device over an in-process account api and the session record the controller already owns. The api
 * answers a preview and an acceptance from the caller's own live record, so a test can tell which
 * subject and which bearer a request used, and it keeps every read and write of the two family
 * management routes on this process only.
 */
function fixture({seed='adult'}:{seed?:'anonymous'|'adult'|'child'}={}) {
  const installationId=uuid(),first=session('adult'),child=session('child'),second=session('adult');
  const seeded=seed==='child'?child:seed==='adult'?first:null;
  const recovery=(value:SessionTokens)=>({subjectId:value.session.subjectId,subjectKind:value.session.subjectKind,sessionId:value.session.sessionId,
    refreshToken:value.refreshToken,refreshExpiresAt:value.refreshExpiresAt,absoluteExpiresAt:value.sessionAbsoluteExpiresAt,
    pendingRotationId:null,pendingSince:null});
  let record:string|null=seeded?JSON.stringify({schemaVersion:1,environment:'test',apiBaseUrl:baseUrl,installationId,
    active:recovery(seeded),revocations:[]}):null;
  const active=()=>JSON.parse(record!).active;
  const familyId=uuid(),ownerSubjectId=uuid(),otherFamilyId=uuid();
  const previewFor=(recipientSubjectId:string,overrides:Partial<FamilyManagementAcceptancePreview>={}):FamilyManagementAcceptancePreview=>(
    {familyId,ownerSubjectId,recipientSubjectId,familyVersion:3,membershipVersion:2,ownerMembershipVersion:4,
      childScopeDigest,childCount:1,...overrides});
  const receiptFor=(recipientSubjectId:string):FamilyManagementAcceptanceReceipt=>({acceptanceId:uuid(),familyId,ownerSubjectId,
    recipientSubjectId,familyVersion:3,membershipVersion:2,ownerMembershipVersion:4,childScopeDigest,
    acceptedAt:at(0),expiresAt:at(86_400_000),consumedAt:null});
  const acceptance={expectedFamilyVersion:3,expectedMembershipVersion:2,expectedOwnerMembershipVersion:4,
    expectedChildScopeDigest:childScopeDigest,acceptance:{familyManagement:true as const,guardianship:true as const}};
  const calls={preview:[] as {token:string;familyId:string}[],accept:[] as {token:string;familyId:string;input:unknown}[],
    signals:[] as AbortSignal[],refreshed:[] as string[]};
  let issued:FamilyManagementAcceptanceReceipt|null=null;
  let previewAnswer:(recipientSubjectId:string)=>unknown=recipient=>previewFor(recipient);
  let receiptAnswer:(recipientSubjectId:string)=>unknown=recipient=>{issued=receiptFor(recipient);return issued;};
  let acceptFailure:AuthClientError|null=null;
  let previewGate:null|{promise:Promise<void>;release:()=>void}=null,previewEntered:(()=>void)|null=null;
  let acceptGate:null|{promise:Promise<void>;release:()=>void}=null,acceptEntered:(()=>void)|null=null;
  const api={endpoint:{environment:'test' as const,apiBaseUrl:baseUrl},
    login:async()=>second,
    refresh:async(refreshToken:string)=>{const current=active(),expiry=at(600_000);
      const accessToken=`refreshed-${uuid()}`;calls.refreshed.push(accessToken);
      return {tokenType:'Bearer' as const,accessToken,accessExpiresAt:expiry,refreshToken,
        refreshExpiresAt:current.absoluteExpiresAt,sessionAbsoluteExpiresAt:current.absoluteExpiresAt,
        session:{subjectId:current.subjectId,subjectKind:current.subjectKind,sessionId:current.sessionId,expiresAt:expiry}};},
    logout:async()=>{},
    familyManagementPreview:async(token:string,value:string,signal?:AbortSignal)=>{calls.preview.push({token,familyId:value});
      if(signal)calls.signals.push(signal);
      if(previewEntered){const notify=previewEntered;previewEntered=null;notify();}
      if(previewGate)await previewGate.promise;
      return previewAnswer(active().subjectId);},
    acceptFamilyManagement:async(token:string,value:string,input:unknown)=>{calls.accept.push({token,familyId:value,input});
      if(acceptEntered){const notify=acceptEntered;acceptEntered=null;notify();}
      if(acceptGate)await acceptGate.promise;
      if(acceptFailure){const throwing=acceptFailure;acceptFailure=null;throw throwing;}
      return receiptAnswer(active().subjectId);}};
  const frozenApi={
    frozenFamilyPreview:async(token:string,family:string,signal?:AbortSignal)=>{
      const raw=await api.familyManagementPreview(token,family,signal) as FamilyManagementAcceptancePreview;
      const {ownerSubjectId,...rest}=raw;return {...rest,deletingSubjectId:ownerSubjectId};
    },
    acceptFrozenFamily:async(token:string,family:string,input:unknown)=>{
      const raw=await api.acceptFamilyManagement(token,family,input) as FamilyManagementAcceptanceReceipt;
      const {ownerSubjectId,expiresAt,...rest}=raw;return {...rest,deletingSubjectId:ownerSubjectId,childCount:1};
    },
  };
  const controller=createAuthController({api:{...api,...frozenApi} as unknown as AuthApiClient,newId:uuid,
    vault:{read:async()=>record,write:async(value:string)=>{record=value;}}});
  const deferred=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});
    return {promise,release(){release();}};};
  return {controller,calls,first,second,familyId,otherFamilyId,acceptance,
    previewFor,receiptFor,record:()=>record,
    issued:()=>issued,
    /** Replaces the next answers, so a test can prove a foreign or malformed body is never adopted. */
    announcePreview(answer:(recipientSubjectId:string)=>unknown){previewAnswer=answer;},
    announceReceipt(answer:(recipientSubjectId:string)=>unknown){receiptAnswer=answer;},
    seedPreviewAndReceipt(){previewAnswer=recipient=>previewFor(recipient);receiptAnswer=recipient=>{issued=receiptFor(recipient);return issued;};},
    failAccept(code:string){acceptFailure=new AuthClientError(code as never);},
    holdPreview(){const held=deferred();previewGate=held;return {seen:new Promise<void>(resolve=>{previewEntered=resolve;}),
      release(){previewGate=null;held.release();}};},
    holdAccept(){const held=deferred();acceptGate=held;return {seen:new Promise<void>(resolve=>{acceptEntered=resolve;}),
      release(){acceptGate=null;held.release();}};}};
}

const switchAccount=(controller:ReturnType<typeof createAuthController>)=>
  controller.login({email:'next@example.test',password,platform:'android'});

/** Neither the bearer nor the accepted record may be published or persisted anywhere. */
function assertNoCredential(f:{controller:{getState:()=>unknown};record:()=>string},values:string[]) {
  for(const published of [JSON.stringify(f.controller.getState()),f.record()]) {
    for(const value of values) assert.equal(published.includes(value),false);
  }
}

test('a previewed duty is accepted once with exactly the displayed scope and returns the strict receipt',async()=>{
  const f=fixture();await f.controller.bootstrap();
  const preview=await f.controller.familyManagementPreview(f.familyId);
  assert.deepEqual(preview,f.previewFor(f.first.session.subjectId));
  // The duty was read on the current session's own bearer, for exactly the family that was asked for.
  assert.deepEqual(f.calls.preview.map(item=>item.familyId),[f.familyId]);
  assert.equal(f.calls.preview[0]!.token,f.calls.refreshed[0]!);
  const receipt=await f.controller.acceptFamilyManagement(f.familyId,f.acceptance);
  assert.deepEqual(receipt,f.issued());
  assert.equal(receipt.familyId,f.familyId);
  assert.equal(receipt.recipientSubjectId,f.first.session.subjectId);
  assert.equal(receipt.consumedAt,null);
  // The body is exactly the strict contract shape: the versions and digest shown, both duties
  // confirmed, and no subject, role or token field anywhere in it.
  assert.deepEqual(f.calls.accept[0]!.input,f.acceptance);
  assert.deepEqual(Object.keys(f.calls.accept[0]!.input as object).sort(),
    ['acceptance','expectedChildScopeDigest','expectedFamilyVersion','expectedMembershipVersion','expectedOwnerMembershipVersion']);
  // One bearer for both calls, and neither it nor the accepted record reaches the vault or the state.
  assert.equal(f.calls.accept[0]!.token,f.calls.preview[0]!.token);
  assertNoCredential(f,[f.calls.preview[0]!.token,f.issued()!.acceptanceId]);
  // The preview is spent by its own acceptance: a repeat must read the family again.
  await assert.rejects(f.controller.acceptFamilyManagement(f.familyId,f.acceptance),{code:'challenge_invalid'});
  assert.equal(f.calls.accept.length,1);
  await f.controller.dispose();
});

test('an acceptance must follow a successful preview of exactly that family',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await assert.rejects(f.controller.acceptFamilyManagement(f.familyId,f.acceptance),{code:'challenge_invalid'});
  await assert.rejects(f.controller.familyManagementPreview('not-a-family-id'),{code:'invalid_request'});
  assert.deepEqual(f.calls.preview,[]);assert.deepEqual(f.calls.accept,[]);
  await f.controller.familyManagementPreview(f.familyId);
  // A family this device never previewed is refused before a request leaves it.
  await assert.rejects(f.controller.acceptFamilyManagement(f.otherFamilyId,f.acceptance),{code:'invalid_request'});
  assert.deepEqual(f.calls.accept,[]);
  // Those refusals left the previewed duty intact: it still accepts exactly once.
  assert.equal((await f.controller.acceptFamilyManagement(f.familyId,f.acceptance)).familyId,f.familyId);
  assert.equal(f.calls.accept.length,1);
  await f.controller.dispose();
});

test('a restricted child device and an anonymous device neither preview nor accept',async()=>{
  const restricted=fixture({seed:'child'});await restricted.controller.bootstrap();
  await assert.rejects(restricted.controller.familyManagementPreview(restricted.familyId),{code:'adult_required'});
  await assert.rejects(restricted.controller.acceptFamilyManagement(restricted.familyId,restricted.acceptance),{code:'adult_required'});
  assert.deepEqual(restricted.calls.preview,[]);assert.deepEqual(restricted.calls.accept,[]);
  assert.equal(restricted.controller.getState().session!.subjectKind,'child');
  await restricted.controller.dispose();

  const anonymous=fixture({seed:'anonymous'});await anonymous.controller.bootstrap();
  await assert.rejects(anonymous.controller.familyManagementPreview(anonymous.familyId),{code:'reauth_required'});
  await assert.rejects(anonymous.controller.acceptFamilyManagement(anonymous.familyId,anonymous.acceptance),{code:'reauth_required'});
  assert.deepEqual(anonymous.calls.preview,[]);assert.deepEqual(anonymous.calls.accept,[]);
  await anonymous.controller.dispose();
});

test('a forged scope, version or responsibility field is refused and the preview survives',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.familyManagementPreview(f.familyId);
  for(const forged of [
    {...f.acceptance,expectedFamilyVersion:4},
    {...f.acceptance,expectedMembershipVersion:3},
    {...f.acceptance,expectedOwnerMembershipVersion:5},
    {...f.acceptance,expectedChildScopeDigest:'d'.repeat(64)},
    {...f.acceptance,acceptance:{familyManagement:true,guardianship:false}},
    {...f.acceptance,acceptance:{familyManagement:true}},
    // A subject, a role, a bearer or any other claim about who is accepting is never part of the body.
    {...f.acceptance,recipientSubjectId:f.first.session.subjectId},
    {...f.acceptance,role:'owner'},
    {...f.acceptance,accessToken:'synthetic-token'},
    null,
  ]) await assert.rejects(f.controller.acceptFamilyManagement(f.familyId,forged as never),{code:'invalid_request'});
  assert.deepEqual(f.calls.accept,[]);
  // The refused attempts never replaced the displayed duty, which still accepts with the shown values.
  assert.equal((await f.controller.acceptFamilyManagement(f.familyId,f.acceptance)).recipientSubjectId,f.first.session.subjectId);
  assert.equal(f.calls.accept.length,1);
  await f.controller.dispose();
});

test('a preview of another family, another subject or a broken shape is never shown or cached',async()=>{
  const f=fixture();await f.controller.bootstrap();
  for(const answer of [
    (recipient:string)=>f.previewFor(recipient,{familyId:uuid()}),
    (recipient:string)=>f.previewFor(recipient,{recipientSubjectId:uuid()}),
    (recipient:string)=>f.previewFor(recipient,{childCount:-1}),
    (recipient:string)=>f.previewFor(recipient,{childScopeDigest:'short'}),
    (recipient:string)=>({...f.previewFor(recipient),policyText:'anything'}),
    (recipient:string)=>({...f.previewFor(recipient),childScopeDigest:undefined}),
  ]) {
    f.announcePreview(answer);
    await assert.rejects(f.controller.familyManagementPreview(f.familyId),{code:'invalid_response'});
  }
  // Nothing was cached: accepting still needs a successful preview of this family.
  await assert.rejects(f.controller.acceptFamilyManagement(f.familyId,f.acceptance),{code:'challenge_invalid'});
  assert.deepEqual(f.calls.accept,[]);
  f.seedPreviewAndReceipt();
  assert.deepEqual(await f.controller.familyManagementPreview(f.familyId),f.previewFor(f.first.session.subjectId));
  assert.equal((await f.controller.acceptFamilyManagement(f.familyId,f.acceptance)).familyId,f.familyId);
  await f.controller.dispose();
});

test('a receipt of another recipient, the wrong scope or a broken shape is refused, never reported as success',async()=>{
  const f=fixture();await f.controller.bootstrap();
  for(const answer of [
    (recipient:string)=>({...f.receiptFor(recipient),recipientSubjectId:uuid()}),
    (recipient:string)=>({...f.receiptFor(recipient),familyId:uuid()}),
    (recipient:string)=>({...f.receiptFor(recipient),ownerSubjectId:uuid()}),
    (recipient:string)=>({...f.receiptFor(recipient),childScopeDigest:'d'.repeat(64)}),
    (recipient:string)=>({...f.receiptFor(recipient),familyVersion:99}),
    (recipient:string)=>({...f.receiptFor(recipient),membershipVersion:99}),
    (recipient:string)=>({...f.receiptFor(recipient),ownerMembershipVersion:99}),
    (recipient:string)=>({...f.receiptFor(recipient),acceptanceId:'not-an-acceptance-id'}),
    (recipient:string)=>({...f.receiptFor(recipient),consumedAt:undefined}),
    (recipient:string)=>({...f.receiptFor(recipient),displayName:'Synthetic Parent'}),
  ]) {
    await f.controller.familyManagementPreview(f.familyId);
    f.announceReceipt(answer);
    await assert.rejects(f.controller.acceptFamilyManagement(f.familyId,f.acceptance),{code:'invalid_response'});
    // Each refusal followed a real dispatch, so its preview is gone and a repeat has to read the family.
    await assert.rejects(f.controller.acceptFamilyManagement(f.familyId,f.acceptance),{code:'challenge_invalid'});
  }
  assert.equal(f.calls.accept.length,10);
  f.seedPreviewAndReceipt();
  await f.controller.familyManagementPreview(f.familyId);
  assert.deepEqual(await f.controller.acceptFamilyManagement(f.familyId,f.acceptance),f.issued());
  await f.controller.dispose();
});

test('a version conflict or a lost answer reports a failure and retires the preview instead of repeating it',async()=>{
  const conflict=fixture();await conflict.controller.bootstrap();
  await conflict.controller.familyManagementPreview(conflict.familyId);
  conflict.failAccept('busy');
  await assert.rejects(conflict.controller.acceptFamilyManagement(conflict.familyId,conflict.acceptance),{code:'busy'});
  assert.equal(conflict.calls.accept.length,1);
  // The server refused the state this device had shown, so that preview is never reused: the duty is
  // not accepted and the caller must read the family again.
  await assert.rejects(conflict.controller.acceptFamilyManagement(conflict.familyId,conflict.acceptance),{code:'challenge_invalid'});
  assert.equal(conflict.calls.accept.length,1);
  assert.equal(conflict.issued(),null);
  await conflict.controller.dispose();

  const lost=fixture();await lost.controller.bootstrap();
  await lost.controller.familyManagementPreview(lost.familyId);
  lost.failAccept('network');
  await assert.rejects(lost.controller.acceptFamilyManagement(lost.familyId,lost.acceptance),{code:'network'});
  // An unknown outcome is a failure, not an acceptance: nothing is reported as accepted and the same
  // request is never re-sent by itself.
  assert.equal(lost.issued(),null);
  assert.equal(lost.controller.getState().status,'authenticated');
  assertNoCredential(lost,[lost.calls.preview[0]!.token]);
  await assert.rejects(lost.controller.acceptFamilyManagement(lost.familyId,lost.acceptance),{code:'challenge_invalid'});
  assert.equal(lost.calls.accept.length,1);
  await lost.controller.dispose();
});

test('an account switch, a sign-out or a dispose ends the preview so no other session can accept it',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.familyManagementPreview(f.familyId);
  await switchAccount(f.controller);
  assert.equal(f.controller.getState().account!.subjectId,f.second.session.subjectId);
  await assert.rejects(f.controller.acceptFamilyManagement(f.familyId,f.acceptance),{code:'challenge_invalid'});
  assert.deepEqual(f.calls.accept,[]);
  // The next account accepts only what it previewed itself, with its own bearer.
  await f.controller.familyManagementPreview(f.familyId);
  const accepted=await f.controller.acceptFamilyManagement(f.familyId,f.acceptance);
  assert.equal(accepted.recipientSubjectId,f.second.session.subjectId);
  assert.notEqual(f.calls.accept[0]!.token,f.calls.preview[0]!.token);
  await f.controller.dispose();

  const out=fixture();await out.controller.bootstrap();
  await out.controller.familyManagementPreview(out.familyId);
  await out.controller.logout();
  await assert.rejects(out.controller.acceptFamilyManagement(out.familyId,out.acceptance),{code:'reauth_required'});
  assert.deepEqual(out.calls.accept,[]);
  await out.controller.dispose();

  const disposed=fixture();await disposed.controller.bootstrap();
  await disposed.controller.familyManagementPreview(disposed.familyId);
  await disposed.controller.dispose();
  await assert.rejects(disposed.controller.acceptFamilyManagement(disposed.familyId,disposed.acceptance),{code:'cancelled'});
  assert.deepEqual(disposed.calls.accept,[]);
});

test('a session that switches while the preview read is open never publishes the late answer',async()=>{
  const f=fixture();await f.controller.bootstrap();
  const held=f.holdPreview(),reading=f.controller.familyManagementPreview(f.familyId);
  await held.seen;
  await switchAccount(f.controller);
  held.release();
  await assert.rejects(reading,{code:'cancelled'});
  // The first account's answer was never adopted, and its request was abandoned rather than reused.
  assert.equal(f.calls.signals[0]!.aborted,true);
  await assert.rejects(f.controller.acceptFamilyManagement(f.familyId,f.acceptance),{code:'challenge_invalid'});
  assert.deepEqual(f.calls.accept,[]);
  await f.controller.dispose();
});

test('an acceptance in flight refuses a second acceptance and a new preview',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.familyManagementPreview(f.familyId);
  const held=f.holdAccept(),first=f.controller.acceptFamilyManagement(f.familyId,f.acceptance);
  await held.seen;
  await assert.rejects(f.controller.acceptFamilyManagement(f.familyId,f.acceptance),{code:'busy'});
  await assert.rejects(f.controller.familyManagementPreview(f.familyId),{code:'busy'});
  assert.equal(f.calls.accept.length,1);assert.equal(f.calls.preview.length,1);
  held.release();
  assert.deepEqual(await first,f.issued());
  // One dispatch, one accepted duty, and the preview is spent when the answer lands.
  await assert.rejects(f.controller.acceptFamilyManagement(f.familyId,f.acceptance),{code:'challenge_invalid'});
  assert.equal(f.calls.accept.length,1);
  await f.controller.dispose();
});

test('refreshing responsibility excludes concurrent reads and acceptance of the old preview',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.familyManagementPreview(f.familyId);
  const held=f.holdPreview(),reading=f.controller.familyManagementPreview(f.familyId);
  await held.seen;
  try {
    await assert.rejects(f.controller.acceptFamilyManagement(f.familyId,f.acceptance),{code:'busy'});
    await assert.rejects(f.controller.familyManagementPreview(f.familyId),{code:'busy'});
    assert.equal(f.calls.accept.length,0);
  } finally {held.release();await reading;await f.controller.dispose();}
});


test('frozen responsibility needs a displayed scope and both explicit confirmations',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await assert.rejects(f.controller.acceptFrozenFamily(f.familyId,f.acceptance),{code:'challenge_invalid'});
  const scope=await f.controller.frozenFamilyPreview(f.familyId);
  scope.familyVersion=99;
  await assert.rejects(f.controller.acceptFrozenFamily(f.familyId,{...f.acceptance,acceptance:{familyManagement:true,guardianship:false}} as never),{code:'invalid_request'});
  const receipt=await f.controller.acceptFrozenFamily(f.familyId,f.acceptance);
  assert.equal(receipt.familyVersion,3);assert.equal(f.calls.accept.length,1);
  await assert.rejects(f.controller.acceptFrozenFamily(f.familyId,f.acceptance),{code:'challenge_invalid'});
  await f.controller.dispose();
});
test('frozen preview cannot race another read, acceptance or account switch',async()=>{
  const f=fixture();await f.controller.bootstrap();await f.controller.frozenFamilyPreview(f.familyId);
  const held=f.holdPreview(),reading=f.controller.frozenFamilyPreview(f.familyId);await held.seen;
  await assert.rejects(f.controller.acceptFrozenFamily(f.familyId,f.acceptance),{code:'busy'});
  await assert.rejects(f.controller.frozenFamilyPreview(f.familyId),{code:'busy'});
  await switchAccount(f.controller);held.release();await assert.rejects(reading,{code:'cancelled'});
  await assert.rejects(f.controller.acceptFrozenFamily(f.familyId,f.acceptance),{code:'challenge_invalid'});
  assert.equal(f.calls.accept.length,0);await f.controller.dispose();
});
