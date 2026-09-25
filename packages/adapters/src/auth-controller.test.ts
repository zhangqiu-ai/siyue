import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {DevicePairingStatus,SessionTokens} from '@siyue/contracts';
import {createAuthController} from './auth-controller.js';
import type {ChildDevicePairingClient,ChildDevicePairingTicket,GuardianChildDeviceClient} from './child-device-api-client.js';
import {AuthClientError,type AuthApiClient,type AuthClientErrorCode,type AuthEndpoint} from './auth-api-client.js';

const baseUrl='http://127.0.0.1:8787/v1';
const at=(offsetMs:number)=>new Date(Date.now()+offsetMs).toISOString();
const opaque=()=>`${randomUUID()}.${'p'.repeat(43)}`;
/** The transport client's own rule: a dispatch whose outcome is unknown must stay replayable. */
const unknownOutcome=new Set<AuthClientErrorCode>(['network','timeout','cancelled','unavailable','invalid_response']);
/** One issued session; the paired device receives the `child` kind on a 30-day device grant. */
const tokens=(subjectKind:'adult'|'child',accessOffsetMs:number):SessionTokens=>{const access=at(accessOffsetMs),absolute=at(30*24*60*60*1000);
  // Every issued session gets its own access token, so a test can tell whose bearer a call carried.
  return {tokenType:'Bearer',accessToken:`paired-access-${randomUUID()}`,accessExpiresAt:access,refreshToken:opaque(),refreshExpiresAt:absolute,sessionAbsoluteExpiresAt:absolute,
    session:{subjectId:randomUUID(),subjectKind,sessionId:randomUUID(),expiresAt:access}};};

/**
 * One anonymous pairing over an in-process adult api, vault and pairing client. The pairing client holds
 * the poll secret of the transport client as a private canary, so a test can prove that the secret never
 * reaches the controller, its state, its ticket or the vault.
 */
function fixture({seed='anonymous',create=true,guardian=true,accessOffsetMs=600_000}:{seed?:'anonymous'|'adult'|'child';create?:boolean;guardian?:boolean;accessOffsetMs?:number}={}) {
  const installationId=randomUUID(),child=tokens('child',accessOffsetMs),adult=tokens('adult',600_000),switched=tokens('adult',600_000);
  const familyId=randomUUID(),childSubjectId=randomUUID();
  const recovery=(tokens:SessionTokens,subjectKind:'adult'|'child')=>({subjectId:tokens.session.subjectId,subjectKind,sessionId:tokens.session.sessionId,
    refreshToken:tokens.refreshToken,refreshExpiresAt:at(600_000),absoluteExpiresAt:tokens.sessionAbsoluteExpiresAt,pendingRotationId:null,pendingSince:null});
  const seeded=seed==='adult'?adult:seed==='child'?child:null;
  let raw:string|null=seeded?JSON.stringify({schemaVersion:1,environment:'test',apiBaseUrl:baseUrl,installationId,
    active:recovery(seeded,seeded.session.subjectKind),revocations:[]}):null;
  const stored=()=>JSON.parse(raw!);
  const calls={refresh:[] as string[],logout:[] as string[],session:[] as string[],login:0};
  const api={endpoint:{environment:'test' as const,apiBaseUrl:baseUrl},
    // A second account signing in on the same installation, for the session-switch fence.
    login:async()=>{calls.login++;return switched;},
    logout:async(token:string)=>{calls.logout.push(token);},
    refresh:async(refreshToken:string)=>{calls.refresh.push(refreshToken);const active=stored().active,expiry=at(600_000);
      return {tokenType:'Bearer' as const,accessToken:'refreshed-access',accessExpiresAt:expiry,refreshToken,refreshExpiresAt:active.absoluteExpiresAt,
        sessionAbsoluteExpiresAt:active.absoluteExpiresAt,session:{subjectId:active.subjectId,subjectKind:active.subjectKind,sessionId:active.sessionId,expiresAt:expiry}};},
    session:async(token:string)=>{calls.session.push(token);const active=stored().active;
      return {subjectId:active.subjectId,subjectKind:active.subjectKind,sessionId:active.sessionId,expiresAt:at(600_000)};}};
  // The vault fails either every write or only the write that would store an issued session.
  let failAll=false,failSession=false;
  const vault={read:async()=>raw,write:async(value:string)=>{if(failAll)throw new AuthClientError('storage_unavailable');
    if(failSession&&JSON.parse(value).active!==null)throw new AuthClientError('storage_unavailable');raw=value;}};
  const pairing={starts:[] as {installationId:string;platform:string;deviceLabel?:string}[],statusCalls:0,claims:0};
  const canary='POLL-SECRET-CANARY-'+'c'.repeat(20);
  // The client keeps its own clock, so a test can close the five-minute window without touching the
  // controller's time or the issued session's real deadlines.
  let clock=Date.now(),lifecycle:DevicePairingStatus='pending',factory=0,claimError:AuthClientError|null=null;
  let dispatchedAt:number|undefined,refused=false,settled=false;
  let gate:null|{promise:Promise<void>;release:()=>void}=null,entered:null|(()=>void)=null;
  const ticket:ChildDevicePairingTicket={pairingId:randomUUID(),requestToken:'r'.repeat(43),expiresAt:new Date(clock+300_000).toISOString()};
  const client:ChildDevicePairingClient={get started(){return pairing.starts.length>0;},
    async start(input,{signal}={}){if(signal?.aborted)throw new AuthClientError('cancelled');pairing.starts.push({...input});return {...ticket};},
    // A claimed request is consumed and an elapsed window is expired locally, exactly as the transport
    // client answers them without spending a poll.
    async status({signal}={}){pairing.statusCalls++;if(signal?.aborted)throw new AuthClientError('cancelled');
      if(settled)return {status:'consumed',expiresAt:ticket.expiresAt};
      return {status:Date.parse(ticket.expiresAt)<=clock?'expired':lifecycle,expiresAt:ticket.expiresAt};},
    async claim({signal}={}){pairing.claims++;if(entered){const notify=entered;entered=null;notify();}
      if(signal?.aborted)throw new AuthClientError('cancelled');
      if(settled||refused)throw new AuthClientError('challenge_invalid');
      // An initial claim cannot start after the window; a dispatched one keeps its sealed result for the
      // separate recovery window, which is why a lost response stays recoverable past expiry.
      if(dispatchedAt===undefined&&Date.parse(ticket.expiresAt)<=clock){refused=true;throw new AuthClientError('challenge_invalid');}
      if(dispatchedAt!==undefined&&clock>=dispatchedAt+60_000){refused=true;throw new AuthClientError('challenge_invalid');}
      if(dispatchedAt===undefined)dispatchedAt=clock;
      if(gate)await gate.promise;
      if(claimError){const failure=claimError;claimError=null;
        if(!unknownOutcome.has(failure.code)){dispatchedAt=undefined;if(failure.code==='challenge_invalid'||failure.code==='invalid_request')refused=true;}
        throw failure;}
      settled=true;dispatchedAt=undefined;return {kind:'child' as const,deviceGrantId:randomUUID(),tokens:child};}};
  // The signed-in guardian face. It records every credential it was handed, so a test can prove which
  // session's bearer a read carried and that both reads were built from the API client's own endpoint.
  const guardianCalls={endpoints:[] as AuthEndpoint[],factories:0,signals:[] as (AbortSignal|undefined)[],
    children:[] as {access:string;familyId:string}[],previews:[] as {access:string;pairingId:string;requestToken:string;childSubjectId:string}[]};
  let guardianFailure:AuthClientError|null=null;
  let guardianGate:null|{promise:Promise<void>;release:()=>void}=null,guardianEntered:null|(()=>void)=null;
  const guardianClient:GuardianChildDeviceClient={
    createChild:async()=>{throw new AuthClientError('invalid_request');},
    async listChildren(access,family,{signal}={}){guardianCalls.children.push({access,familyId:family});guardianCalls.signals.push(signal);
      if(guardianEntered){const notify=guardianEntered;guardianEntered=null;notify();}
      if(signal?.aborted)throw new AuthClientError('cancelled');
      if(guardianGate)await guardianGate.promise;
      if(guardianFailure){const failure=guardianFailure;guardianFailure=null;throw failure;}
      return [{childSubjectId,familyId:family,guardianSubjectId:adult.session.subjectId,relationshipVersion:1,familyVersion:1,displayName:'小玥'}];},
    listDevices:async()=>{throw new AuthClientError('invalid_request');},
    revokeDevice:async()=>{throw new AuthClientError('invalid_request');},
    async previewPairing(access,pairingId,input,{signal}={}){
      guardianCalls.previews.push({access,pairingId,requestToken:input.requestToken,childSubjectId:input.childSubjectId});
      if(signal?.aborted)throw new AuthClientError('cancelled');
      if(guardianFailure){const failure=guardianFailure;guardianFailure=null;throw failure;}
      return {deviceLabel:'客厅 iPad',platform:'ios',expiresAt:ticket.expiresAt,child:{childSubjectId:input.childSubjectId,displayName:'小玥'}};},
    approvePairing:async()=>{throw new AuthClientError('invalid_request');}};
  const host=createAuthController({api:api as unknown as AuthApiClient,vault,newId:randomUUID,
    ...(create?{createChildPairingClient:()=>{factory++;return client;}}:{}),
    ...(guardian?{createGuardianClient:(endpoint:AuthEndpoint)=>{guardianCalls.factories++;guardianCalls.endpoints.push(endpoint);return guardianClient;}}:{})});
  return {host,api,calls,pairing,ticket,canary,tokens:child,adult,raw:()=>raw!,factory:()=>factory,advance:(ms:number)=>{clock+=ms;},
    guardian:guardianCalls,familyId,childSubjectId,switched,
    installationId:()=>stored().installationId,
    failAll(value:boolean){failAll=value;},failSession(value:boolean){failSession=value;},
    setStatus(value:DevicePairingStatus){lifecycle=value;},
    failClaim(code:AuthClientErrorCode){claimError=new AuthClientError(code);},
    failGuardian(code:AuthClientErrorCode){guardianFailure=new AuthClientError(code);},
    holdGuardian(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{guardianEntered=resolve;});
      guardianGate={promise,release};return {seen,release(){guardianGate=null;release();}};},
    holdClaim(){let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;}),seen=new Promise<void>(resolve=>{entered=resolve;});
      gate={promise,release};return {seen,release(){gate=null;release();}};}};
}

test('an anonymous device starts one pairing request from its own installation and only carries the ticket',async()=>{
  const f=fixture();await f.host.bootstrap();
  const ticket=await f.host.startChildPairing({platform:'ios',deviceLabel:'客厅 iPad'});
  // The QR payload is exactly the identifier, the request token and the deadline: no poll secret, no
  // session, no identity. The controller never receives the secret at all.
  assert.deepEqual(Object.keys(ticket).sort(),['expiresAt','pairingId','requestToken']);
  assert.deepEqual(ticket,{pairingId:f.ticket.pairingId,requestToken:f.ticket.requestToken,expiresAt:f.ticket.expiresAt});
  assert.deepEqual(f.pairing.starts,[{installationId:f.installationId(),platform:'ios',deviceLabel:'客厅 iPad'}]);
  assert.equal(JSON.stringify(ticket).includes(f.canary),false);
  assert.equal(JSON.stringify(f.host.getState()).includes(f.canary),false);
  assert.equal(f.raw()!.includes(f.canary),false);
  assert.equal(f.host.getState().status,'anonymous');assert.equal(f.host.getState().session,null);
  assert.deepEqual(f.host.childPairingTicket(),f.ticket);assert.equal(f.host.hasPendingChildPairing(),true);
  // One device has one pending request: a second start is refused instead of opening a stray secret.
  await assert.rejects(f.host.startChildPairing({platform:'android'}),{code:'busy'});
  assert.equal(f.pairing.starts.length,1);assert.equal(f.factory(),1);
  await f.host.dispose();
});

test('pairing requires an anonymous device, a wired factory and a valid request',async()=>{
  const signed=fixture({seed:'adult'});await signed.host.bootstrap();
  assert.equal(signed.host.getState().status,'authenticated');
  await assert.rejects(signed.host.startChildPairing({platform:'ios'}),{code:'busy'});
  // The adult session is untouched by the refusal: no request, no factory call, no new generation.
  assert.deepEqual(signed.pairing.starts,[]);assert.equal(signed.factory(),0);
  assert.equal(signed.host.getState().status,'authenticated');assert.equal(JSON.parse(signed.raw()!).active.refreshToken,signed.adult.refreshToken);
  await signed.host.dispose();

  const bare=fixture({create:false});await bare.host.bootstrap();
  await assert.rejects(bare.host.startChildPairing({platform:'ios'}),{code:'invalid_config'});
  await bare.host.dispose();

  const f=fixture();await f.host.bootstrap();
  for(const input of [{platform:'windows'},{platform:'ios',deviceLabel:'bad\nlabel'},{platform:'ios',deviceLabel:'l'.repeat(101)}])
    await assert.rejects(f.host.startChildPairing(input as never),{code:'invalid_request'});
  assert.deepEqual(f.pairing.starts,[]);assert.equal(f.factory(),0);assert.equal(f.host.hasPendingChildPairing(),false);
  await f.host.dispose();
});

test('polling reports the pairing lifecycle and an undelivered expired request is retired on claim',async()=>{
  const f=fixture();await f.host.bootstrap();await f.host.startChildPairing({platform:'android'});
  assert.deepEqual(await f.host.childPairingStatus(),{status:'pending',expiresAt:f.ticket.expiresAt});
  f.setStatus('approved');
  assert.deepEqual(await f.host.childPairingStatus(),{status:'approved',expiresAt:f.ticket.expiresAt});
  assert.equal(f.pairing.statusCalls,2);assert.equal(f.pairing.claims,0);
  // The five-minute window closes. Status reports it locally, and the pairing keeps the secret, because
  // an already dispatched completion would still be recoverable inside its own window.
  f.advance(300_001);
  assert.equal((await f.host.childPairingStatus()).status,'expired');
  assert.equal(f.host.hasPendingChildPairing(),true);assert.deepEqual(f.host.childPairingTicket(),f.ticket);
  // A request that never dispatched the completion is refused by the client, which retires the pairing.
  await assert.rejects(f.host.claimChildPairing(),{code:'challenge_invalid'});
  assert.equal(f.host.getState().status,'anonymous');assert.equal(f.host.hasPendingChildPairing(),false);
  await assert.rejects(f.host.childPairingStatus(),{code:'challenge_invalid'});
  assert.equal(f.pairing.claims,1);assert.deepEqual(f.calls.logout,[]);await f.host.dispose();
});

test('a lost completion stays recoverable after the window closes and is dropped past its own window',async()=>{
  const f=fixture();await f.host.bootstrap();await f.host.startChildPairing({platform:'ios'});
  // The completion is dispatched in the last minute of the five-minute window and its response is lost.
  f.advance(290_000);
  f.failClaim('network');
  await assert.rejects(f.host.claimChildPairing(),{code:'network'});
  assert.equal(f.host.hasPendingChildPairing(),true);
  // The application window closes while the response is still unknown: the client sealed that dispatch,
  // so the same instance and poll secret still recover it inside the separate sixty-second window.
  f.advance(20_000);
  assert.equal((await f.host.childPairingStatus()).status,'expired');
  assert.equal(f.host.hasPendingChildPairing(),true);assert.deepEqual(f.host.childPairingTicket(),f.ticket);
  await f.host.claimChildPairing();
  assert.equal(f.pairing.claims,2);assert.equal(f.host.getState().status,'authenticated');
  assert.equal(f.host.getState().session!.subjectKind,'child');
  assert.equal(JSON.parse(f.raw()!).active.refreshToken,f.tokens.refreshToken);
  assert.equal(f.raw()!.includes(f.canary),false);await f.host.dispose();

  // Past the client's own recovery window the same secret is refused, so the pairing is retired.
  const g=fixture();await g.host.bootstrap();await g.host.startChildPairing({platform:'ios'});
  g.failClaim('network');
  await assert.rejects(g.host.claimChildPairing(),{code:'network'});
  g.advance(60_000);
  await assert.rejects(g.host.claimChildPairing(),{code:'challenge_invalid'});
  assert.equal(g.host.getState().status,'anonymous');assert.equal(g.host.hasPendingChildPairing(),false);
  assert.equal(g.pairing.claims,2);assert.deepEqual(g.calls.logout,[]);await g.host.dispose();
});

test('a claimed child session is persisted as the restricted session and refreshed as a child',async()=>{
  const f=fixture({accessOffsetMs:10_000});await f.host.bootstrap();await f.host.startChildPairing({platform:'ios'});
  await f.host.claimChildPairing();
  const state=f.host.getState();
  assert.equal(state.status,'authenticated');assert.equal(state.session!.subjectKind,'child');
  assert.equal(state.session!.sessionId,f.tokens.session.sessionId);assert.equal(state.account!.subjectKind,'child');
  assert.equal(state.account!.sessionId,f.tokens.session.sessionId);assert.equal(state.error,null);
  const active=JSON.parse(f.raw()!).active;
  assert.equal(active.subjectKind,'child');assert.equal(active.refreshToken,f.tokens.refreshToken);
  assert.equal(active.sessionId,f.tokens.session.sessionId);assert.equal(f.raw()!.includes(f.canary),false);
  assert.equal(f.host.hasPendingChildPairing(),false);assert.equal(f.pairing.claims,1);
  // The paired device stays a child device: the near-expiry access refreshes with the stored child token.
  assert.equal((await f.host.session()).subjectKind,'child');
  assert.deepEqual(f.calls.refresh,[f.tokens.refreshToken]);assert.deepEqual(f.calls.session,['refreshed-access']);
  assert.equal(f.host.getState().session!.sessionId,f.tokens.session.sessionId);assert.equal(f.host.getState().status,'authenticated');
  await assert.rejects(f.host.startChildPairing({platform:'ios'}),{code:'busy'});
  await f.host.dispose();
});

test('a lost completion keeps the same client and secret for one retry',async()=>{
  const f=fixture();await f.host.bootstrap();await f.host.startChildPairing({platform:'ios'});
  f.failClaim('network');
  await assert.rejects(f.host.claimChildPairing(),{code:'network'});
  assert.equal(f.host.getState().status,'anonymous');assert.equal(f.host.getState().session,null);
  assert.equal(JSON.parse(f.raw()!).active,null);assert.deepEqual(f.calls.logout,[]);
  assert.equal(f.host.hasPendingChildPairing(),true);assert.deepEqual(f.host.childPairingTicket(),f.ticket);
  // The retry reuses the instance the secret lives in and never opens a second request.
  await f.host.claimChildPairing();
  assert.equal(f.pairing.claims,2);assert.equal(f.pairing.starts.length,1);assert.equal(f.factory(),1);
  assert.equal(f.host.getState().status,'authenticated');
  assert.equal(JSON.parse(f.raw()!).active.refreshToken,f.tokens.refreshToken);
  assert.deepEqual(f.calls.logout,[]);await f.host.dispose();
});

test('a generation change during a claim is never adopted and revokes the issued child session',async()=>{
  const f=fixture();await f.host.bootstrap();await f.host.startChildPairing({platform:'ios'});
  const hold=f.holdClaim(),claiming=f.host.claimChildPairing();await hold.seen;
  await f.host.logout();hold.release();
  await assert.rejects(claiming,{code:'cancelled'});
  assert.deepEqual(f.calls.logout,[f.tokens.refreshToken]);
  assert.equal(f.host.getState().status,'anonymous');assert.equal(f.host.getState().session,null);
  assert.equal(JSON.parse(f.raw()!).active,null);assert.equal(f.host.hasPendingChildPairing(),false);
  assert.equal(f.pairing.claims,1);await f.host.dispose();
});

test('cancelling a claim in flight is refused instead of reporting a false cancellation',async()=>{
  const f=fixture();await f.host.bootstrap();await f.host.startChildPairing({platform:'ios'});
  const hold=f.holdClaim(),claiming=f.host.claimChildPairing();await hold.seen;
  // The pending record is already gone (the sign-in dropped it when the claim started), so a cancel that
  // only forgot the request would report a success while this run can still publish a signed-in device.
  assert.equal(f.host.hasPendingChildPairing(),true);assert.deepEqual(f.host.childPairingTicket(),f.ticket);
  assert.throws(()=>f.host.cancelChildPairing(),{code:'busy'});
  await assert.rejects(f.host.startChildPairing({platform:'android'}),{code:'busy'});
  assert.equal(f.pairing.starts.length,1);assert.equal(f.factory(),1);
  assert.deepEqual(f.calls.logout,[]);
  hold.release();await claiming;
  // The claim settled on its own terms: this device really is the paired child device, not a cancelled one.
  assert.equal(f.host.getState().status,'authenticated');assert.equal(f.host.getState().session!.subjectKind,'child');
  assert.equal(JSON.parse(f.raw()!).active.refreshToken,f.tokens.refreshToken);
  assert.equal(f.host.hasPendingChildPairing(),false);assert.equal(f.host.childPairingTicket(),null);
  f.host.cancelChildPairing();assert.equal(f.host.hasPendingChildPairing(),false);
  await f.host.dispose();
});

test('a waiting completion keeps its pairing while a refused one is retired',async()=>{
  const f=fixture();await f.host.bootstrap();await f.host.startChildPairing({platform:'ios'});
  // The guardian has not approved yet: the same secret stays usable for the next attempt.
  f.failClaim('busy');
  await assert.rejects(f.host.claimChildPairing(),{code:'busy'});
  assert.equal(f.host.getState().status,'anonymous');assert.equal(f.host.hasPendingChildPairing(),true);
  assert.deepEqual(f.host.childPairingTicket(),f.ticket);assert.deepEqual(f.calls.logout,[]);
  // A request the server proves is gone is terminal: repeating the dead secret is refused locally.
  f.failClaim('challenge_invalid');
  await assert.rejects(f.host.claimChildPairing(),{code:'challenge_invalid'});
  assert.equal(f.host.getState().status,'anonymous');assert.equal(f.host.hasPendingChildPairing(),false);
  assert.equal(f.host.childPairingTicket(),null);assert.equal(f.pairing.claims,2);
  await assert.rejects(f.host.claimChildPairing(),{code:'challenge_invalid'});
  assert.equal(f.pairing.claims,2);assert.deepEqual(f.calls.logout,[]);await f.host.dispose();
});

test('a secure-storage failure after the claim revokes the session and never shows a signed-in device',async()=>{
  const f=fixture();await f.host.bootstrap();await f.host.startChildPairing({platform:'ios'});
  // Only the write that would store the issued session fails, so the claim itself is dispatched.
  f.failSession(true);
  await assert.rejects(f.host.claimChildPairing(),{code:'storage_unavailable'});
  assert.equal(f.host.getState().status,'secure-storage-unavailable');assert.equal(f.host.getState().session,null);
  assert.equal(f.host.getState().account,null);
  assert.deepEqual(f.calls.logout,[f.tokens.refreshToken]);
  assert.equal(JSON.parse(f.raw()!).active,null);assert.equal(f.raw()!.includes(f.canary),false);
  // A consumed grant is never claimed twice, so the pairing is retired instead of inviting a replay.
  assert.equal(f.host.hasPendingChildPairing(),false);assert.equal(f.pairing.claims,1);
  await assert.rejects(f.host.claimChildPairing(),{code:'challenge_invalid'});
  await f.host.dispose();
});

test('an unwritable vault refuses to start a pairing and never reports a session',async()=>{
  const f=fixture();f.failAll(true);
  await assert.rejects(f.host.bootstrap(),{code:'storage_unavailable'});
  assert.equal(f.host.getState().status,'secure-storage-unavailable');
  await assert.rejects(f.host.startChildPairing({platform:'ios'}),{code:'busy'});
  assert.deepEqual(f.pairing.starts,[]);assert.equal(f.host.getState().session,null);
  await f.host.dispose();
});

test('cancelling or superseding a pairing retires it and the next request uses a new client',async()=>{
  const f=fixture();await f.host.bootstrap();
  const ticket=await f.host.startChildPairing({platform:'ios'});assert.deepEqual(f.host.childPairingTicket(),ticket);
  f.host.cancelChildPairing();
  assert.equal(f.host.hasPendingChildPairing(),false);assert.equal(f.host.childPairingTicket(),null);
  await assert.rejects(f.host.claimChildPairing(),{code:'challenge_invalid'});
  await assert.rejects(f.host.childPairingStatus(),{code:'challenge_invalid'});
  assert.equal(f.pairing.claims,0);assert.equal(f.pairing.statusCalls,0);
  await f.host.startChildPairing({platform:'android'});assert.equal(f.factory(),2);
  // Another account operation ends an unanswered request instead of leaving a stray secret behind.
  await f.host.logout();assert.equal(f.host.hasPendingChildPairing(),false);
  await assert.rejects(f.host.claimChildPairing(),{code:'challenge_invalid'});
  await f.host.dispose();
});

test('an adult session reads its guardian children and previews the pending device without publishing a secret',async()=>{
  const f=fixture({seed:'adult'});await f.host.bootstrap();
  assert.equal(f.host.getState().status,'authenticated');
  const pairingId=randomUUID(),requestToken='r'.repeat(43);
  const children=await f.host.guardianChildren(f.familyId);
  assert.equal(children.length,1);
  assert.equal(children[0].familyId,f.familyId);assert.equal(children[0].childSubjectId,f.childSubjectId);
  // The read carried the current adult access token — never the stored refresh token — and asked the
  // endpoint the API client itself uses. It spent no extra refresh and touched no pairing request.
  assert.deepEqual(f.guardian.children,[{access:'refreshed-access',familyId:f.familyId}]);
  assert.notEqual(f.guardian.children[0].access,f.adult.refreshToken);
  assert.deepEqual(f.guardian.endpoints,[{environment:'test',apiBaseUrl:baseUrl}]);
  assert.equal(f.calls.refresh.length,1);assert.equal(f.calls.login,0);
  assert.deepEqual(f.pairing.starts,[]);assert.equal(f.host.hasPendingChildPairing(),false);
  const preview=await f.host.guardianPairingPreview(pairingId,requestToken,f.childSubjectId);
  assert.deepEqual(preview,{deviceLabel:'客厅 iPad',platform:'ios',expiresAt:f.ticket.expiresAt,
    child:{childSubjectId:f.childSubjectId,displayName:'小玥'}});
  assert.deepEqual(f.guardian.previews,[{access:'refreshed-access',pairingId,requestToken,childSubjectId:f.childSubjectId}]);
  // One stateless guardian client per read, and neither the access bearer nor the request token is
  // echoed into the answer, published in client state or written to the vault. The vault keeps only the
  // rotation credential it owns; the access token of the read exists solely in that request header.
  assert.equal(f.guardian.factories,2);
  assert.equal(JSON.stringify(preview).includes(requestToken),false);
  for(const published of [JSON.stringify(f.host.getState()),f.raw()!]){
    assert.equal(published.includes('refreshed-access'),false);
    assert.equal(published.includes(requestToken),false);
  }
  assert.equal(f.raw()!.includes(f.canary),false);
  assert.deepEqual(f.calls.logout,[]);await f.host.dispose();
});

test('a guardian refusal is reported without clearing the adult session or spending another request',async()=>{
  const f=fixture({seed:'adult'});await f.host.bootstrap();
  f.failGuardian('identity_not_found');
  await assert.rejects(f.host.guardianChildren(f.familyId),{code:'identity_not_found'});
  assert.equal(f.host.getState().status,'authenticated');assert.equal(f.host.getState().error,null);
  assert.equal(JSON.parse(f.raw()!).active.refreshToken,f.adult.refreshToken);
  // An unknown child or family is not a session failure: no reconcile refresh, no revocation queue.
  assert.equal(f.calls.refresh.length,1);assert.deepEqual(f.calls.logout,[]);
  await f.host.dispose();
});

test('a restricted child device, an anonymous client and an unwired factory never reach the family surface',async()=>{
  const paired=fixture({seed:'child'});await paired.host.bootstrap();
  assert.equal(paired.host.getState().status,'authenticated');
  assert.equal(paired.host.getState().session!.subjectKind,'child');
  for(const read of [()=>paired.host.guardianChildren(paired.familyId),
    ()=>paired.host.guardianPairingPreview(randomUUID(),'r'.repeat(43),paired.childSubjectId)])
    await assert.rejects(read(),{code:'identity_not_found'});
  // Refused before anything was built or spent: no client, no request, and the child session stays intact
  // instead of being reported as a session that needs re-verification.
  assert.equal(paired.guardian.factories,0);assert.deepEqual(paired.guardian.children,[]);assert.deepEqual(paired.guardian.previews,[]);
  assert.equal(paired.host.getState().status,'authenticated');assert.equal(paired.host.getState().error,null);
  assert.equal(paired.host.getState().session!.subjectKind,'child');assert.equal(JSON.parse(paired.raw()!).active.subjectKind,'child');
  assert.deepEqual(paired.calls.logout,[]);await paired.host.dispose();

  const anonymous=fixture();await anonymous.host.bootstrap();
  await assert.rejects(anonymous.host.guardianChildren(anonymous.familyId),{code:'reauth_required'});
  assert.equal(anonymous.guardian.factories,0);assert.deepEqual(anonymous.guardian.children,[]);
  await anonymous.host.dispose();

  const unwired=fixture({seed:'adult',guardian:false});await unwired.host.bootstrap();
  await assert.rejects(unwired.host.guardianChildren(unwired.familyId),{code:'invalid_config'});
  await assert.rejects(unwired.host.guardianPairingPreview(randomUUID(),'r'.repeat(43),unwired.childSubjectId),{code:'invalid_config'});
  assert.equal(unwired.host.getState().status,'authenticated');
  assert.equal(JSON.parse(unwired.raw()!).active.refreshToken,unwired.adult.refreshToken);
  await unwired.host.dispose();
});

test('a session switch during a guardian read cancels that answer and the next account reads with its own bearer',async()=>{
  const f=fixture({seed:'adult'});await f.host.bootstrap();
  const hold=f.holdGuardian(),reading=f.host.guardianChildren(f.familyId);await hold.seen;
  // Another account signs in on this installation while the first read is still open.
  await f.host.login({email:'guardian@example.com',password:'synthetic-password-1',platform:'ios'});
  assert.equal(f.host.getState().status,'authenticated');
  assert.equal(f.host.getState().account!.subjectId,f.switched.session.subjectId);
  assert.deepEqual(f.calls.logout,[f.adult.refreshToken]);
  // The open read was cancelled at its request boundary and its answer is never adopted by the new
  // account: the fence is the generation, not the screen that asked.
  hold.release();
  await assert.rejects(reading,{code:'cancelled'});
  assert.equal(f.guardian.signals[0]!.aborted,true);
  assert.equal(f.guardian.children.length,1);
  // The next read belongs to the account that is signed in now and carries exactly its own access token.
  const children=await f.host.guardianChildren(f.familyId);
  assert.equal(children.length,1);assert.equal(children[0].familyId,f.familyId);
  assert.equal(f.guardian.children.length,2);
  assert.equal(f.guardian.children[1].access,f.switched.accessToken);
  assert.notEqual(f.guardian.children[0].access,f.switched.accessToken);
  assert.equal(f.host.getState().account!.subjectId,f.switched.session.subjectId);
  await f.host.dispose();
});
