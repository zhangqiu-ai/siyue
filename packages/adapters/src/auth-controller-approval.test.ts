import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {AuthClientErrorCode,SessionTokens} from '@siyue/contracts';
import {createAuthController} from './auth-controller.js';
import type {AppleAuthorize} from './apple-sign-in.js';
import type {GuardianChildDeviceClient} from './child-device-api-client.js';
import {AuthClientError,type AuthApiClient,type AuthEndpoint} from './auth-api-client.js';

const baseUrl='http://127.0.0.1:8787/v1';
const uuid=()=>randomUUID();
const opaque=()=>`${uuid()}.${'g'.repeat(43)}`;
const requestToken='r'.repeat(43);
const password='synthetic-password-1';
const otherPassword='synthetic-password-2';
const installationId='2b8f1c6e-9d4a-4f3b-8c1d-5e7a9b0c2d3e';
const pairingWindowMs=300_000;

/**
 * One signed-in guardian approving a previewed child-device pairing over an in-process api, vault and
 * guardian client. The controller's own clock drives the pairing window, and the Apple routes are the
 * synthetic stand-in the adapter tests use: one grant per completion key, the same grant replayed for a
 * repeated key, and no provider, family store or session store outside this process.
 */
function fixture({seed='adult',accessOffsetMs=600_000}:{seed?:'anonymous'|'adult'|'child';accessOffsetMs?:number}={}) {
  let clock=Date.now();
  const at=(offsetMs:number)=>new Date(clock+offsetMs).toISOString();
  const subjectKind:'adult'|'child'=seed==='child'?'child':'adult';
  const account={subjectId:uuid(),sessionId:uuid()},switched={subjectId:uuid(),sessionId:uuid()};
  const familyId=uuid(),childSubjectId=uuid(),pairingId=uuid();
  const refreshToken=opaque(),absolute=at(30*24*60*60*1000);
  // Every issued session carries its own bearer, so a test can tell whose credential a request used.
  const refreshedAccess=`refreshed-${uuid()}`,switchedAccess=`switched-${uuid()}`;
  let raw:string|null=seed==='anonymous'?null:JSON.stringify({schemaVersion:1,environment:'test',apiBaseUrl:baseUrl,installationId,
    active:{...account,subjectKind,refreshToken,refreshExpiresAt:absolute,absoluteExpiresAt:absolute,pendingRotationId:null,pendingSince:null},revocations:[]});
  const stored=()=>JSON.parse(raw!);
  const issued=(session:{subjectId:string;sessionId:string},kind:'adult'|'child',token:string):SessionTokens=>{
    const expiry=at(600_000);
    return {tokenType:'Bearer',accessToken:token,accessExpiresAt:expiry,refreshToken:opaque(),refreshExpiresAt:absolute,sessionAbsoluteExpiresAt:absolute,
      session:{...session,subjectKind:kind,expiresAt:expiry}};};
  let relationshipVersion=1,failList:AuthClientErrorCode|null=null,failReauth:AuthClientErrorCode|null=null,
    failApprove:AuthClientErrorCode|null=null,failComplete:AuthClientErrorCode|null=null;
  const boundIdentity='synthetic.header.payload',flowState='x'.repeat(43);
  let identity=boundIdentity;
  const calls={refresh:[] as string[],logout:[] as string[],reauth:[] as {token:string;password:string;action:string}[],
    start:[] as {token:string;action?:string;platform?:string;installationId?:string}[],completions:[] as {token:string;input:unknown;key:string}[],native:0};
  const grants=new Map<string,{reauthGrant:string;expiresAt:string}>(),grantValues:string[]=[];
  const api={endpoint:{environment:'test' as const,apiBaseUrl:baseUrl},
    login:async()=>issued(switched,'adult',switchedAccess),
    logout:async(token:string)=>{calls.logout.push(token);},
    refresh:async(token:string)=>{calls.refresh.push(token);const active=stored().active,expiry=at(600_000);
      return {tokenType:'Bearer' as const,accessToken:refreshedAccess,accessExpiresAt:expiry,refreshToken:token,refreshExpiresAt:active.refreshExpiresAt,
        sessionAbsoluteExpiresAt:active.absoluteExpiresAt,session:{subjectId:active.subjectId,subjectKind:active.subjectKind,sessionId:active.sessionId,expiresAt:expiry}};},
    session:async()=>{const active=stored().active;
      return {subjectId:active.subjectId,subjectKind:active.subjectKind,sessionId:active.sessionId,expiresAt:at(600_000)};},
    reauthPassword:async(token:string,currentPassword:string,_signal?:AbortSignal,action?:string)=>{
      calls.reauth.push({token,password:currentPassword,action:action??''});
      if(failReauth){const code=failReauth;failReauth=null;throw new AuthClientError(code);}
      const answer={reauthGrant:opaque(),expiresAt:at(pairingWindowMs)};grantValues.push(answer.reauthGrant);return answer;},
    startAppleReauth:async(token:string,input:{action?:string;platform?:string;installationId?:string})=>{
      calls.start.push({token,...input});
      return {flowId:uuid(),transactionSecret:'t'.repeat(43),nonce:'n'.repeat(43),state:flowState,expiresAt:at(pairingWindowMs)};},
    completeAppleReauth:async(token:string,input:unknown,key:string)=>{
      calls.completions.push({token,input,key});
      if(failComplete){const code=failComplete;failComplete=null;throw new AuthClientError(code);}
      if((input as {identityToken:string}).identityToken!==boundIdentity)throw new AuthClientError('apple_restart_required');
      let answer=grants.get(key);
      if(!answer){answer={reauthGrant:opaque(),expiresAt:at(pairingWindowMs)};grants.set(key,answer);grantValues.push(answer.reauthGrant);}
      return answer;}};
  // The guardian face records every credential it was handed, so a test can prove which session's bearer
  // a read carried, and every approval it was asked to dispatch.
  const guardian={children:[] as {access:string;familyId:string}[],previews:[] as {access:string;pairingId:string;requestToken:string;childSubjectId:string}[],
    approvals:[] as {access:string;pairingId:string;requestToken:string;childSubjectId:string;reauthGrant:string;expectedGuardianVersion:number}[],
    signals:[] as (AbortSignal|undefined)[],endpoints:[] as AuthEndpoint[],factories:0};
  let listGate:null|{promise:Promise<void>;release:()=>void}=null,listEntered:null|(()=>void)=null;
  let nativeGate:null|{promise:Promise<void>;release:()=>void}=null,nativeEntered:null|(()=>void)=null;
  const guardianClient:GuardianChildDeviceClient={
    createChild:async()=>{throw new AuthClientError('invalid_request');},
    async listChildren(access,family,{signal}={}){
      guardian.children.push({access,familyId:family});guardian.signals.push(signal);
      if(listEntered){const notify=listEntered;listEntered=null;notify();}
      if(listGate)await listGate.promise;
      if(failList){const code=failList;failList=null;throw new AuthClientError(code);}
      return [{childSubjectId,familyId:family,guardianSubjectId:account.subjectId,relationshipVersion,familyVersion:1,displayName:'小玥'}];},
    listDevices:async()=>{throw new AuthClientError('invalid_request');},
    revokeDevice:async()=>{throw new AuthClientError('invalid_request');},
    async previewPairing(access,pairing,input,{signal}={}){
      guardian.previews.push({access,pairingId:pairing,requestToken:input.requestToken,childSubjectId:input.childSubjectId});
      if(signal?.aborted)throw new AuthClientError('cancelled');
      return {deviceLabel:'客厅 iPad',platform:'ios',expiresAt:at(pairingWindowMs),child:{childSubjectId:input.childSubjectId,displayName:'小玥'}};},
    async approvePairing(access,pairing,input,{signal}={}){
      guardian.approvals.push({access,pairingId:pairing,requestToken:input.requestToken,childSubjectId:input.childSubjectId,
        reauthGrant:input.reauthGrant,expectedGuardianVersion:input.expectedGuardianVersion});
      if(signal?.aborted)throw new AuthClientError('cancelled');
      if(failApprove){const code=failApprove;failApprove=null;throw new AuthClientError(code);}
      return {status:'approved' as const,expiresAt:at(pairingWindowMs)};}};
  const authorize:AppleAuthorize=async({state,signal})=>{
    calls.native++;
    if(nativeEntered){const notify=nativeEntered;nativeEntered=null;notify();}
    if(nativeGate)await nativeGate.promise;
    if(signal.aborted)throw new AuthClientError('cancelled');
    return {state,identityToken:identity,authorizationCode:'synthetic-authorization-code'};};
  const build=()=>createAuthController({api:api as unknown as AuthApiClient,newId:uuid,now:()=>clock,
    vault:{read:async()=>raw,write:async(value:string)=>{raw=value;}},
    createGuardianClient:(endpoint:AuthEndpoint)=>{guardian.factories++;guardian.endpoints.push(endpoint);return guardianClient;}});
  const host=build();
  const target={pairingId,requestToken,childSubjectId,familyId};
  return {host,restart:build,calls,guardian,authorize,target,switched,familyId,childSubjectId,pairingId,requestToken,password,otherPassword,
    installationId,adultAccess:refreshedAccess,switchedAccess,refreshToken,raw:()=>raw!,grants:()=>grantValues,
    setRelationshipVersion(value:number){relationshipVersion=value;},advance(ms:number){clock+=ms;},
    failList(code:AuthClientErrorCode){failList=code;},failReauth(code:AuthClientErrorCode){failReauth=code;},
    failApprove(code:AuthClientErrorCode){failApprove=code;},failComplete(code:AuthClientErrorCode){failComplete=code;},
    useOtherIdentity(){identity='other-account.header.payload';},
    holdList(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{listEntered=resolve;});
      listGate={promise,release};return {seen,release(){listGate=null;release();}};},
    holdNative(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{nativeEntered=resolve;});
      nativeGate={promise,release};return {seen,release(){nativeGate=null;release();}};}};
}

/** The grant, the request token and the bearer must never be published or persisted anywhere. */
function assertNoCredential(f:{host:{getState:()=>unknown};raw:()=>string;requestToken:string},values:string[]) {
  for(const published of [JSON.stringify(f.host.getState()),f.raw()]) {
    assert.equal(published.includes(f.requestToken),false);
    for(const value of values) assert.equal(published.includes(value),false);
  }
}

test('an approval must follow a successful preview of exactly that request',async()=>{
  const f=fixture();await f.host.bootstrap();
  await assert.rejects(f.host.approveChildPairingWithPassword(f.target,f.password),{code:'challenge_invalid'});
  await assert.rejects(f.host.approveChildPairingWithApple(f.target,f.authorize),{code:'challenge_invalid'});
  // Nothing was read, re-verified or spent before a preview existed.
  assert.deepEqual(f.calls.reauth,[]);assert.deepEqual(f.calls.start,[]);assert.deepEqual(f.guardian.approvals,[]);
  const preview=await f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId);
  assert.equal(preview.child.childSubjectId,f.childSubjectId);
  // A pairing, token or child the guardian never saw is refused before any request leaves this device.
  await assert.rejects(f.host.approveChildPairingWithPassword({...f.target,pairingId:uuid()},f.password),{code:'invalid_request'});
  await assert.rejects(f.host.approveChildPairingWithPassword({...f.target,requestToken:'s'.repeat(43)},f.password),{code:'invalid_request'});
  await assert.rejects(f.host.approveChildPairingWithPassword({...f.target,childSubjectId:uuid()},f.password),{code:'invalid_request'});
  await assert.rejects(f.host.approveChildPairingWithPassword({...f.target,pollSecret:'p'.repeat(43)} as typeof f.target,f.password),{code:'invalid_request'});
  await assert.rejects(f.host.approveChildPairingWithPassword({...f.target,familyId:'not-a-family-id'},f.password),{code:'invalid_request'});
  assert.deepEqual(f.calls.reauth,[]);assert.deepEqual(f.guardian.approvals,[]);
  // Those refusals left the previewed request intact: it still approves exactly once.
  assert.equal((await f.host.approveChildPairingWithPassword(f.target,f.password)).status,'approved');
  assert.equal(f.guardian.approvals.length,1);assert.equal(f.calls.reauth.length,1);
  await f.host.dispose();
});

test('the password approval re-reads the relationship version and spends one action-bound grant',async()=>{
  const f=fixture({accessOffsetMs:10_000});await f.host.bootstrap();
  await f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId);
  f.setRelationshipVersion(4);
  const approved=await f.host.approveChildPairingWithPassword(f.target,f.password);
  assert.equal(approved.status,'approved');assert.equal(typeof approved.expiresAt,'string');
  // The version came from this guardian's own live list in the named family, on the current bearer.
  assert.deepEqual(f.guardian.children,[{access:f.adultAccess,familyId:f.familyId}]);
  assert.deepEqual(f.calls.reauth,[{token:f.adultAccess,password:f.password,action:'approve-child-device'}]);
  assert.deepEqual(f.guardian.approvals,[{access:f.adultAccess,pairingId:f.pairingId,requestToken:f.requestToken,
    childSubjectId:f.childSubjectId,reauthGrant:f.grants()[0]!,expectedGuardianVersion:4}]);
  // The action is fixed by the controller: this flow can never present another action's grant.
  assert.equal(f.calls.reauth[0]!.action,'approve-child-device');
  assertNoCredential(f,[f.grants()[0]!,f.adultAccess]);
  // The dispatch spent the preview: a repeat must preview again instead of re-sending the same approval.
  await assert.rejects(f.host.approveChildPairingWithPassword(f.target,f.password),{code:'challenge_invalid'});
  assert.equal(f.calls.reauth.length,1);assert.equal(f.guardian.approvals.length,1);
  await f.host.dispose();
});

test('an approval whose answer was lost is reported and never replayed',async()=>{
  const f=fixture();await f.host.bootstrap();
  await f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId);
  f.failApprove('network');
  await assert.rejects(f.host.approveChildPairingWithPassword(f.target,f.password),{code:'network'});
  // The request was dispatched with its grant: its outcome is unknown, so it is reported as a failure.
  assert.equal(f.guardian.approvals.length,1);assert.equal(f.calls.reauth.length,1);
  await assert.rejects(f.host.approveChildPairingWithPassword(f.target,f.password),{code:'challenge_invalid'});
  assert.equal(f.guardian.approvals.length,1);assert.equal(f.calls.reauth.length,1);
  // The recovery the caller is told to use: preview the same request again, then approve deliberately.
  await f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId);
  assert.equal((await f.host.approveChildPairingWithPassword(f.target,f.password)).status,'approved');
  assert.equal(f.calls.reauth.length,2);assert.equal(f.guardian.approvals.length,2);
  assert.notEqual(f.grants()[0],f.grants()[1]);
  assertNoCredential(f,[f.grants()[1]!]);
  await f.host.dispose();
});

test('a refusal before the approval is dispatched keeps the preview for a corrected retry',async()=>{
  const f=fixture();await f.host.bootstrap();
  await f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId);
  // A child that is not in this guardian's live list is refused before any re-verification is asked for.
  f.failList('identity_not_found');
  await assert.rejects(f.host.approveChildPairingWithPassword(f.target,f.password),{code:'identity_not_found'});
  assert.deepEqual(f.calls.reauth,[]);assert.deepEqual(f.guardian.approvals,[]);
  // A refused re-verification is reported as-is and leaves the same preview usable.
  f.setRelationshipVersion(9);f.failReauth('invalid_credentials');
  await assert.rejects(f.host.approveChildPairingWithPassword(f.target,f.otherPassword),{code:'invalid_credentials'});
  assert.deepEqual(f.guardian.approvals,[]);
  assert.equal((await f.host.approveChildPairingWithPassword(f.target,f.password)).status,'approved');
  assert.equal(f.guardian.approvals.length,1);assert.equal(f.guardian.approvals[0]!.expectedGuardianVersion,9);
  await f.host.dispose();
});

test('an approval in flight refuses a second approval and a new preview',async()=>{
  const f=fixture();await f.host.bootstrap();
  await f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId);
  const held=f.holdList(),first=f.host.approveChildPairingWithPassword(f.target,f.password);
  await held.seen;
  await assert.rejects(f.host.approveChildPairingWithPassword(f.target,f.password),{code:'busy'});
  await assert.rejects(f.host.approveChildPairingWithApple(f.target,f.authorize),{code:'busy'});
  await assert.rejects(f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId),{code:'busy'});
  assert.equal(f.calls.native,0);assert.equal(f.calls.reauth.length,0);
  held.release();
  assert.equal((await first).status,'approved');
  // One grant, one dispatch, and no second native authorization was ever opened.
  assert.equal(f.guardian.approvals.length,1);assert.equal(f.calls.native,0);assert.equal(f.calls.reauth.length,1);
  await f.host.dispose();
});

test('the Apple approval spends one action-bound grant through a single native authorization',async()=>{
  const f=fixture();await f.host.bootstrap();
  await f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId);
  const approved=await f.host.approveChildPairingWithApple(f.target,f.authorize);
  assert.equal(approved.status,'approved');
  // The action is fixed to this approval, on this installation and platform, on the session's bearer.
  assert.deepEqual(f.calls.start,[{token:f.adultAccess,action:'approve-child-device',platform:'ios',installationId:f.installationId}]);
  assert.deepEqual(f.calls.completions.map(item=>item.token),[f.adultAccess]);
  assert.equal((f.calls.completions[0]!.input as {identityToken:string}).identityToken,'synthetic.header.payload');
  assert.deepEqual(f.guardian.approvals,[{access:f.adultAccess,pairingId:f.pairingId,requestToken:f.requestToken,
    childSubjectId:f.childSubjectId,reauthGrant:f.grants()[0]!,expectedGuardianVersion:1}]);
  assertNoCredential(f,[f.grants()[0]!,f.adultAccess]);
  // The dispatch retired the attempt with its grant: a repeat needs a fresh preview.
  await assert.rejects(f.host.approveChildPairingWithApple(f.target,f.authorize),{code:'challenge_invalid'});
  assert.equal(f.calls.native,1);assert.equal(f.calls.start.length,1);assert.equal(f.guardian.approvals.length,1);
  await f.host.dispose();
});

test('a lost Apple completion resumes the same attempt without another native prompt',async()=>{
  const f=fixture();await f.host.bootstrap();
  await f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId);
  f.failComplete('network');
  await assert.rejects(f.host.approveChildPairingWithApple(f.target,f.authorize),{code:'network'});
  assert.equal(f.calls.native,1);assert.equal(f.grants().length,0);assert.deepEqual(f.guardian.approvals,[]);
  // The staged completion is replayed under its own key: no second sheet, no second grant, one approval.
  assert.equal((await f.host.approveChildPairingWithApple(f.target,f.authorize)).status,'approved');
  assert.equal(f.calls.native,1);assert.equal(f.calls.completions.length,2);
  assert.equal(f.calls.completions[0]!.key,f.calls.completions[1]!.key);
  assert.equal(f.grants().length,1);assert.deepEqual(f.guardian.approvals.map(item=>item.reauthGrant),[f.grants()[0]!]);
  await f.host.dispose();
});

test('a dispatched Apple approval whose answer was lost is never replayed',async()=>{
  const f=fixture();await f.host.bootstrap();
  await f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId);
  f.failApprove('network');
  await assert.rejects(f.host.approveChildPairingWithApple(f.target,f.authorize),{code:'network'});
  assert.equal(f.guardian.approvals.length,1);assert.equal(f.calls.native,1);
  // The unknown outcome ends the flow: no second sheet, no second grant, no second dispatch.
  await assert.rejects(f.host.approveChildPairingWithApple(f.target,f.authorize),{code:'challenge_invalid'});
  assert.equal(f.calls.native,1);assert.equal(f.calls.start.length,1);assert.equal(f.guardian.approvals.length,1);
  // Previewing again is the deliberate recovery, and it authorizes and dispatches once more.
  await f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId);
  assert.equal((await f.host.approveChildPairingWithApple(f.target,f.authorize)).status,'approved');
  assert.equal(f.calls.native,2);assert.equal(f.guardian.approvals.length,2);
  assertNoCredential(f,[f.guardian.approvals[1]!.reauthGrant]);
  await f.host.dispose();
});

test('an Apple identity that is not the linked account is refused and never approves',async()=>{
  const f=fixture();await f.host.bootstrap();
  await f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId);
  f.useOtherIdentity();
  await assert.rejects(f.host.approveChildPairingWithApple(f.target,f.authorize),{code:'apple_restart_required'});
  assert.deepEqual(f.guardian.approvals,[]);assert.equal(f.grants().length,0);
  // The attempt proved it cannot resume, so the preview is retired instead of being retried.
  await assert.rejects(f.host.approveChildPairingWithApple(f.target,f.authorize),{code:'challenge_invalid'});
  assert.equal(f.calls.native,1);assert.equal(f.calls.start.length,1);
  await f.host.dispose();
});

test('an account switch or a sign-out ends the preview so no other session can approve it',async()=>{
  const f=fixture();await f.host.bootstrap();
  await f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId);
  await f.host.login({email:'guardian@example.com',password:password,platform:'ios'});
  assert.equal(f.host.getState().account!.subjectId,f.switched.subjectId);
  await assert.rejects(f.host.approveChildPairingWithPassword(f.target,f.password),{code:'challenge_invalid'});
  await assert.rejects(f.host.approveChildPairingWithApple(f.target,f.authorize),{code:'challenge_invalid'});
  assert.deepEqual(f.calls.reauth,[]);assert.deepEqual(f.guardian.approvals,[]);assert.equal(f.calls.native,0);
  assert.deepEqual(f.calls.logout,[f.refreshToken]);
  // The next account approves only what it previewed itself, with its own bearer.
  await f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId);
  assert.equal((await f.host.approveChildPairingWithPassword(f.target,f.password)).status,'approved');
  assert.deepEqual(f.guardian.children.map(item=>item.access),[f.switchedAccess]);
  assert.deepEqual(f.guardian.approvals.map(item=>item.access),[f.switchedAccess]);
  await f.host.dispose();

  const out=fixture();await out.host.bootstrap();
  await out.host.guardianPairingPreview(out.pairingId,out.requestToken,out.childSubjectId);
  await out.host.logout();
  // A signed-out device cannot re-verify at all, and the preview it left behind approves nothing.
  await assert.rejects(out.host.approveChildPairingWithPassword(out.target,out.password),{code:'reauth_required'});
  assert.deepEqual(out.calls.reauth,[]);assert.deepEqual(out.guardian.approvals,[]);
  await out.host.dispose();
});

test('an elapsed pairing window or a restart ends the preview before anything is spent',async()=>{
  const f=fixture();await f.host.bootstrap();
  await f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId);
  // A second controller over the same vault inherits nothing: the binding is memory-only.
  const restarted=f.restart();await restarted.bootstrap();
  await assert.rejects(restarted.approveChildPairingWithPassword(f.target,f.password),{code:'challenge_invalid'});
  assert.deepEqual(f.calls.reauth,[]);assert.deepEqual(f.guardian.approvals,[]);
  // The pairing's own deadline closes the preview on this controller too.
  f.advance(pairingWindowMs+1);
  await assert.rejects(f.host.approveChildPairingWithPassword(f.target,f.password),{code:'challenge_invalid'});
  assert.deepEqual(f.calls.reauth,[]);assert.deepEqual(f.guardian.approvals,[]);
  // A fresh preview binds the new window, and one deliberate approval goes through.
  await f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId);
  assert.equal((await f.host.approveChildPairingWithPassword(f.target,f.password)).status,'approved');
  assert.equal(f.guardian.approvals.length,1);
  await restarted.dispose();await f.host.dispose();
});

test('a session that switches while the relationship read is open cancels the approval',async()=>{
  const f=fixture();await f.host.bootstrap();
  await f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId);
  const held=f.holdList(),approving=f.host.approveChildPairingWithPassword(f.target,f.password);
  await held.seen;
  await f.host.login({email:'second@example.com',password:otherPassword,platform:'ios'});
  held.release();
  await assert.rejects(approving,{code:'cancelled'});
  // The answer of the first account is never adopted, and no grant of it is ever spent.
  assert.deepEqual(f.guardian.approvals,[]);assert.deepEqual(f.calls.reauth,[]);
  assert.equal(f.guardian.signals[0]!.aborted,true);
  await f.host.dispose();
});

test('a session that switches during the Apple authorization cancels the approval',async()=>{
  const f=fixture();await f.host.bootstrap();
  await f.host.guardianPairingPreview(f.pairingId,f.requestToken,f.childSubjectId);
  const held=f.holdNative(),approving=f.host.approveChildPairingWithApple(f.target,f.authorize);
  await held.seen;
  await f.host.login({email:'second@example.com',password:otherPassword,platform:'ios'});
  held.release();
  await assert.rejects(approving,{code:'cancelled'});
  assert.deepEqual(f.guardian.approvals,[]);assert.equal(f.grants().length,0);
  await f.host.dispose();
});

test('an anonymous or restricted device and an unwired guardian factory never approve anything',async()=>{
  const anonymous=fixture({seed:'anonymous'});await anonymous.host.bootstrap();
  await assert.rejects(anonymous.host.approveChildPairingWithPassword(anonymous.target,anonymous.password),{code:'reauth_required'});
  await assert.rejects(anonymous.host.approveChildPairingWithApple(anonymous.target,anonymous.authorize),{code:'reauth_required'});
  assert.equal(anonymous.guardian.factories,0);assert.deepEqual(anonymous.calls.reauth,[]);
  await anonymous.host.dispose();

  const paired=fixture({seed:'child'});await paired.host.bootstrap();
  await assert.rejects(paired.host.approveChildPairingWithPassword(paired.target,paired.password),{code:'identity_not_found'});
  assert.equal(paired.guardian.factories,0);assert.equal(paired.host.getState().session!.subjectKind,'child');
  await paired.host.dispose();
});
