import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {appleReauthGrantSchema,type AuthClientErrorCode,type DeletionDependencyDisposition,type EmailChallengeResponse,type SessionTokens} from '@siyue/contracts';
import {createAppleDeletionAttempt,createAppleReauthAttempt,createAppleRevokeAttempt} from './apple-reauth.js';
import {createAuthController} from './auth-controller.js';
import {AuthClientError,type AuthApiClient} from './auth-api-client.js';

const baseUrl='http://127.0.0.1:8787/v1';
const link={email:'first-email@example.test',locale:'zh-CN' as const};
const linkKey='7f0d1f5e-1a2b-4c3d-8e4f-5a6b7c8d9e0f';
// A fixed installation id keeps the fake's admission assertion and the seeded record in step.
const installationId='7c9e6679-7425-40de-944b-e07fc1f90ae7';
const password='第一次绑定登录邮箱的合成密码 🌙';
const uuid=()=>randomUUID();
const opaque=()=>`${randomUUID()}.${'s'.repeat(43)}`;
const zeros={start:0,complete:0,link:0,native:0,refresh:0,logout:0,confirm:0,login:0,revoke:0,revokeAll:0,sessions:0,submit:0};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

/** In-memory stand-in for the Apple reauth, email link and device revocation routes: one action
 *  grant per completion key, the same grant and challenge replayed for a repeated key, and a record
 *  of what was sent. No provider, session, vault or mailbox outside this process is involved. */
function fakeServer(){
 // A frozen clock: every derived deadline is exact, so validators never see a 1 ms drift.
 const clock={ms:Date.now(),now:()=>clock.ms};let grants=0;
 const counts={...zeros};
 const revoked=new Set<string>();let allRevoked=false;const issued:string[]=[];
 const sent={complete:[] as {input:unknown;key:string}[],link:[] as {token:string;input:{email:string;locale:string;reauthGrant:string};key:string}[],
  confirm:[] as {token:string;input:unknown;key:string}[],start:[] as {token:string;action?:string;platform?:string;installationId?:string}[],
  revoke:[] as {token:string;sessionId:string;reauthGrant?:string}[],revokeAll:[] as {token:string;reauthGrant:string}[],
  submit:[] as {token:string;input:{reauthGrant:string;confirmation:boolean;dependencyDisposition:unknown};key:string}[]};
 const answers=new Map<string,{reauthGrant:string;expiresAt:string}>(),challenges=new Map<string,EmailChallengeResponse>(),
  deletionReceipts=new Map<string,{deletionId:string;receiptSecret:string;expiresAt:string}>();
 const fails={start:0,complete:0,link:0,confirm:0,revoke:0,revokeAll:0,grantTtl:300_000 as number,
  submit:0,submitCode:'network' as AuthClientErrorCode,
  startCode:'network' as AuthClientErrorCode,completeCode:'network' as AuthClientErrorCode,linkCode:'network' as AuthClientErrorCode,confirmCode:'reauth_required' as AuthClientErrorCode,
  revokeCode:'network' as AuthClientErrorCode,revokeAllCode:'network' as AuthClientErrorCode,commitRevokeAllBeforeFailure:false,
  refresh:'ok' as 'ok'|'denied'};
 let gate:{promise:Promise<void>;resolve:()=>void}|null=null,notify:(()=>void)|null=null;
 let submitGate:{promise:Promise<void>;resolve:()=>void}|null=null,submitReady:(()=>void)|null=null;
 const at=(ms:number)=>new Date(clock.now()+ms).toISOString();
 const flow=()=>({flowId:uuid(),transactionSecret:'t'.repeat(43),nonce:'n'.repeat(43),state:'x'.repeat(43),expiresAt:at(300_000)});
 const api={endpoint:{environment:'test' as const,apiBaseUrl:baseUrl},
  startAppleReauth:async(token:string,input:{action?:string;platform?:string;installationId?:string})=>{counts.start++;sent.start.push({token,...input});
   if(fails.start-- >0)throw new AuthClientError(fails.startCode);
   assert.equal(input.platform,'ios');assert.equal(input.installationId,installationId);return flow();},
  completeAppleReauth:async(_token:string,input:unknown,key:string)=>{counts.complete++;sent.complete.push({input,key});
   if(fails.complete-- >0)throw new AuthClientError(fails.completeCode);
   let answer=answers.get(key);
   if(!answer){grants++;answer=appleReauthGrantSchema.parse({reauthGrant:opaque(),expiresAt:at(fails.grantTtl)});answers.set(key,answer);issued.push(answer.reauthGrant);}
   return answer;},
  requestEmailLink:async(token:string,input:{email:string;locale:string;reauthGrant:string},key:string)=>{counts.link++;
   sent.link.push({token,input,key});
   if(fails.link-- >0)throw new AuthClientError(fails.linkCode);
   let answer=challenges.get(key);if(!answer){answer={challengeId:uuid(),requestSecret:'c'.repeat(43),expiresAt:at(600_000),resendAfterSeconds:60};challenges.set(key,answer);}return answer;},
  confirmEmailLink:async(token:string,input:unknown,key:string)=>{counts.confirm++;sent.confirm.push({token,input,key});
   if(fails.confirm-- >0)throw new AuthClientError(fails.confirmCode);},
  revokeDeviceSession:async(token:string,sessionId:string,reauthGrant?:string)=>{counts.revoke++;sent.revoke.push({token,sessionId,...reauthGrant===undefined?{}:{reauthGrant}});
   if(fails.revoke-- >0)throw new AuthClientError(fails.revokeCode);
   revoked.add(sessionId);},
  revokeAllDeviceSessions:async(token:string,reauthGrant:string)=>{counts.revokeAll++;sent.revokeAll.push({token,reauthGrant});
   if(fails.commitRevokeAllBeforeFailure)allRevoked=true;
   if(fails.revokeAll-- >0)throw new AuthClientError(fails.revokeAllCode);
   allRevoked=true;},
  deviceSessions:async()=>{counts.sessions++;return {items:[],nextCursor:null};},
  refresh:async()=>{counts.refresh++;if(fails.refresh==='denied')throw new AuthClientError('reauth_required');return tokens();},
  login:async()=>{counts.login++;return tokens();},
  logout:async()=>{counts.logout++;},
  submitDeletion:async(token:string,input:{reauthGrant:string;confirmation:boolean;dependencyDisposition:unknown},key:string)=>{counts.submit++;
   sent.submit.push({token,input,key});submitReady?.();if(submitGate)await submitGate.promise;
   if(fails.submit-- >0)throw new AuthClientError(fails.submitCode);
   let answer=deletionReceipts.get(key);
   if(!answer){answer={deletionId:uuid(),receiptSecret:'d'.repeat(43),expiresAt:at(86_400_000)};deletionReceipts.set(key,answer);}
   return answer;}
 };
 const tokens=():SessionTokens=>({tokenType:'Bearer',accessToken:'access-1',accessExpiresAt:at(600_000),refreshToken:opaque(),
  refreshExpiresAt:at(600_000),sessionAbsoluteExpiresAt:at(600_000),session:{subjectId:uuid(),subjectKind:'adult',sessionId:uuid(),expiresAt:at(600_000)}});
 const authorize=async({state}:{state:string})=>{counts.native++;notify?.();if(gate)await gate.promise;
  return {state,identityToken:'synthetic.header.payload',authorizationCode:'synthetic-authorization-code'};};
 return {api:api as unknown as AuthApiClient,counts,sent,fails,clock,authorize,
  grants:()=>grants,grantValues:()=>issued,isRevoked:(id:string)=>allRevoked||revoked.has(id),
  holdNative(){gate=deferred();},releaseNative(){gate?.resolve();gate=null;},nextNative(){return new Promise<void>(resolve=>{notify=resolve;});},
  holdSubmit(){submitGate=deferred();},releaseSubmit(){submitGate?.resolve();submitGate=null;},
  nextSubmit(){return new Promise<void>(resolve=>{submitReady=resolve;});}};
}

/** Attempt alone: the controller supplies the real access token and session fence. */
function attemptFixture(){const server=fakeServer();
 const attempt=createAppleReauthAttempt({api:server.api,newId:uuid,now:server.clock.now,authorize:server.authorize,...link,key:linkKey});
 const run=(signal=new AbortController().signal)=>attempt.run({access:async()=>'access-1',installationId,signal});
 return {server,attempt,run};}

test('one attempt spends a single grant and returns only the email challenge',async()=>{
 const {server,attempt,run}=attemptFixture();
 const result=await run();
 assert.deepEqual(Object.keys(result).sort(),['challengeId','expiresAt','requestSecret','resendAfterSeconds']);
 assert.deepEqual(server.counts,{...zeros,start:1,complete:1,link:1,native:1});
 assert.deepEqual(server.sent.start,[{token:'access-1',action:'link-identity',platform:'ios',installationId}]);
 assert.equal(server.grants(),1);assert.equal(attempt.canRetry(),false);
 assert.deepEqual(server.sent.link,[{token:'access-1',input:{...link,reauthGrant:server.sent.link[0]!.input.reauthGrant},key:linkKey}]);
 assert.equal(JSON.stringify(result).includes('reauthGrant'),false);
});

test('a lost completion replays the same key and input without another native authorization',async()=>{
 const {server,attempt,run}=attemptFixture();server.fails.complete=1;
 await assert.rejects(run(),{code:'network'});
 assert.equal(attempt.canRetry(),true);await run();
 assert.deepEqual(server.sent.complete[0],server.sent.complete[1]);
 assert.equal(server.grants(),1);assert.equal(server.counts.native,1);assert.equal(server.counts.link,1);
});

test('a lost link response replays the same key and grant without a second completion',async()=>{
 const {server,attempt,run}=attemptFixture();server.fails.link=1;
 await assert.rejects(run(),{code:'network'});
 assert.equal(attempt.canRetry(),true);
 const result=await run();
 assert.equal(server.counts.complete,1);assert.equal(server.counts.native,1);assert.equal(server.grants(),1);assert.equal(server.counts.link,2);
 assert.deepEqual(server.sent.link[0],server.sent.link[1]);
 assert.deepEqual(result,{challengeId:result.challengeId,requestSecret:'c'.repeat(43),expiresAt:result.expiresAt,resendAfterSeconds:60});
 assert.equal(attempt.canRetry(),false);
});

test('a flow that ended without staged state never restarts provider authorization',async()=>{
 const {server,attempt,run}=attemptFixture();server.fails.start=1;server.fails.startCode='reauth_required';
 await assert.rejects(run(),{code:'reauth_required'});
 assert.equal(attempt.canRetry(),false);
 await assert.rejects(run(),{code:'apple_restart_required'});
 assert.equal(server.counts.start,1);assert.equal(server.counts.native,0);assert.equal(server.counts.complete,0);
});

test('an expired grant cannot be spent and ends the attempt',async()=>{
 const {server,attempt,run}=attemptFixture();server.fails.grantTtl=-1_000;
 await assert.rejects(run(),{code:'apple_restart_required'});
 assert.equal(server.counts.link,0);assert.equal(attempt.canRetry(),false);
 // The spent instance never restarts provider authorization under the same caller key.
 await assert.rejects(run(),{code:'apple_restart_required'});
 assert.equal(server.counts.native,1);assert.equal(server.counts.link,0);
 // A fresh instance, which is what the controller builds for a new key, can still finish.
 const fresh=attemptFixture();await fresh.run();
 assert.equal(fresh.server.counts.link,1);
});

test('an aborted flow stops before the completion and cannot be retried',async()=>{
 const {server,attempt}=attemptFixture();const control=new AbortController();server.holdNative();
 const entered=server.nextNative(),running=attempt.run({access:async()=>'access-1',installationId,signal:control.signal});
 await entered;control.abort();server.releaseNative();
 await assert.rejects(running,{code:'cancelled'});
 assert.equal(server.counts.complete,0);assert.equal(attempt.canRetry(),false);
});

test('an overlapping run is refused while the first keeps its staged flow',async()=>{
 const {server,attempt,run}=attemptFixture();server.holdNative();
 const entered=server.nextNative(),first=run();await entered;
 await assert.rejects(run(),{code:'busy'});
 server.releaseNative();await first;
 assert.equal(server.counts.native,1);assert.equal(attempt.canRetry(),false);
});

/** Controller with a seeded recovery record, so bootstrap authenticates a synthetic session. */
function controllerFixture({authenticated=true}:{authenticated?:boolean}={}){
 const server=fakeServer(),subjectId=uuid(),sessionId=uuid();
 const expiresAt=()=>new Date(server.clock.now()+600_000).toISOString();
 let raw:string|null=authenticated?JSON.stringify({schemaVersion:1,environment:'test',apiBaseUrl:baseUrl,installationId,
  active:{subjectId,subjectKind:'adult',sessionId,refreshToken:opaque(),refreshExpiresAt:expiresAt(),absoluteExpiresAt:expiresAt(),pendingRotationId:null,pendingSince:null},revocations:[]}):null;
 const active=()=>JSON.parse(raw!).active as {subjectId:string;sessionId:string;refreshToken:string;absoluteExpiresAt:string};
 // Rotation must answer for the stored session, unlike the bare attempt fixture.
 server.api.refresh=async()=>{server.counts.refresh++;if(server.fails.refresh==='denied'||server.isRevoked(sessionId))throw new AuthClientError('reauth_required');
  const stored=active(),expiry=new Date(server.clock.now()+600_000).toISOString();
  return {tokenType:'Bearer',accessToken:'access-1',accessExpiresAt:expiry,refreshToken:stored.refreshToken,refreshExpiresAt:expiry,
   sessionAbsoluteExpiresAt:stored.absoluteExpiresAt,session:{subjectId:stored.subjectId,subjectKind:'adult',sessionId:stored.sessionId,expiresAt:expiry}};};
 const host=createAuthController({api:server.api,vault:{read:async()=>raw,write:async value=>{raw=value;}},newId:uuid,now:server.clock.now});
 return {...server,host,subjectId,sessionId,raw:()=>raw};
}
const proof={challengeId:uuid(),requestSecret:'c'.repeat(43),code:'123456',newPassword:password};
const badInput=(value:unknown)=>value as {email:string;locale:'zh-CN'};

test('first email link requires an authenticated session and a valid request',async()=>{
 const anonymous=controllerFixture({authenticated:false});await anonymous.host.bootstrap();
 assert.equal(anonymous.host.getState().status,'anonymous');
 await assert.rejects(anonymous.host.requestEmailLinkWithApple(link,anonymous.authorize,uuid()),{code:'reauth_required'});
 await assert.rejects(anonymous.host.confirmEmailLink(proof,uuid()),{code:'reauth_required'});
 assert.deepEqual(anonymous.counts,zeros);
 const f=controllerFixture();await f.host.bootstrap();
 await assert.rejects(f.host.requestEmailLinkWithApple(badInput({...link,email:'not-an-email'}),f.authorize,uuid()),{code:'invalid_request'});
 await assert.rejects(f.host.requestEmailLinkWithApple(badInput({...link,locale:'fr-FR'}),f.authorize,uuid()),{code:'invalid_request'});
 await assert.rejects(f.host.requestEmailLinkWithApple(badInput({...link,extra:true}),f.authorize,uuid()),{code:'invalid_request'});
 await assert.rejects(f.host.requestEmailLinkWithApple(link,f.authorize,'not-a-uuid'),{code:'invalid_request'});
 await assert.rejects(f.host.confirmEmailLink(badInput({...proof,code:'12ab56'}),uuid()),{code:'invalid_request'});
 await assert.rejects(f.host.confirmEmailLink(proof,'not-a-uuid'),{code:'invalid_request'});
 assert.equal(f.counts.start,0);assert.equal(f.counts.confirm,0);
});

test('the grant is spent inside the call, leaves nothing persisted and returns only the challenge',async()=>{
 const f=controllerFixture();await f.host.bootstrap();const generation=f.host.getState().generation;
 const result=await f.host.requestEmailLinkWithApple(link,f.authorize,linkKey);
 assert.deepEqual(Object.keys(result).sort(),['challengeId','expiresAt','requestSecret','resendAfterSeconds']);
 assert.deepEqual(f.counts,{...zeros,start:1,complete:1,link:1,native:1,refresh:1});
 assert.equal(f.host.getState().generation,generation);assert.equal(f.host.getState().status,'authenticated');
 assert.equal(f.host.getState().session!.sessionId,f.sessionId);
 assert.equal(f.counts.logout,0);assert.equal(f.raw()!.includes('reauthGrant'),false);assert.equal(f.raw()!.includes('access-1'),false);
 assert.equal(JSON.parse(f.raw()!).active.sessionId,f.sessionId);assert.equal(JSON.parse(f.raw()!).active.pendingRotationId,null);
 assert.deepEqual(f.sent.link,[{token:'access-1',input:{...link,reauthGrant:f.sent.link[0]!.input.reauthGrant},key:linkKey}]);
});

test('a lost completion resumes the same key without native authorization or a second grant',async()=>{
 const f=controllerFixture();await f.host.bootstrap();f.fails.complete=1;
 await assert.rejects(f.host.requestEmailLinkWithApple(link,f.authorize,linkKey),{code:'network'});
 await assert.rejects(f.host.requestEmailLinkWithApple(link,f.authorize,uuid()),{code:'busy'});
 const result=await f.host.requestEmailLinkWithApple(link,f.authorize,linkKey);
 assert.deepEqual(f.sent.complete[0],f.sent.complete[1]);
 assert.equal(f.grants(),1);assert.equal(f.counts.native,1);assert.equal(f.counts.link,1);
 assert.equal(typeof result.challengeId,'string');
 // The finished operation is released, so a new key starts a new provider flow.
 await f.host.requestEmailLinkWithApple({...link,email:'second@example.test'},f.authorize,uuid());
 assert.equal(f.counts.native,2);assert.equal(f.counts.start,2);
});

test('a lost link response replays the same key and returns the original challenge',async()=>{
 const f=controllerFixture();await f.host.bootstrap();f.fails.link=1;
 await assert.rejects(f.host.requestEmailLinkWithApple(link,f.authorize,linkKey),{code:'network'});
 const first=await f.host.requestEmailLinkWithApple(link,f.authorize,linkKey);
 assert.equal(f.counts.complete,1);assert.equal(f.counts.native,1);assert.equal(f.counts.link,2);assert.equal(f.grants(),1);
 assert.deepEqual(f.sent.link[0],f.sent.link[1]);
 assert.equal(f.sent.complete.length,1);
 assert.equal(f.host.getState().status,'authenticated');assert.equal(first.resendAfterSeconds,60);
});

test('logout during the flow cancels it, spends no grant and cannot be resumed with the same key',async()=>{
 const f=controllerFixture();await f.host.bootstrap();f.holdNative();
 const entered=f.nextNative(),pending=f.host.requestEmailLinkWithApple(link,f.authorize,linkKey);
 await entered;await f.host.logout();f.releaseNative();
 await assert.rejects(pending,{code:'cancelled'});
 assert.equal(f.counts.complete,0);assert.equal(f.counts.link,0);assert.equal(f.counts.logout,1);
 assert.equal(f.host.getState().status,'anonymous');assert.equal(JSON.parse(f.raw()!).active,null);
 await f.host.login({email:'next@example.test',password,platform:'ios'});
 await f.host.requestEmailLinkWithApple(link,f.authorize,linkKey);
 assert.equal(f.counts.native,2);assert.equal(f.counts.start,2);
});

test('a dead grant keeps the live session and ends only the flow',async()=>{
 const f=controllerFixture();await f.host.bootstrap();f.fails.link=1;f.fails.linkCode='reauth_required';
 await assert.rejects(f.host.requestEmailLinkWithApple(link,f.authorize,linkKey),{code:'reauth_required'});
 assert.equal(f.host.getState().status,'authenticated');assert.equal(f.host.getState().session!.sessionId,f.sessionId);
 assert.equal(JSON.parse(f.raw()!).active.sessionId,f.sessionId);assert.equal(f.counts.refresh,2);
 await f.host.requestEmailLinkWithApple(link,f.authorize,linkKey);
 assert.equal(f.counts.native,2);
});

test('a lapsed same-key recovery window ends the flow and needs a fresh provider authorization',async()=>{
 const f=controllerFixture();await f.host.bootstrap();f.fails.link=1;f.fails.linkCode='operation_completed';
 await assert.rejects(f.host.requestEmailLinkWithApple(link,f.authorize,linkKey),{code:'operation_completed'});
 assert.equal(f.host.getState().status,'authenticated');assert.equal(JSON.parse(f.raw()!).active.sessionId,f.sessionId);
 // The bounded window is gone, so the same key may not be presented as a resumed flow.
 await f.host.requestEmailLinkWithApple(link,f.authorize,linkKey);
 assert.equal(f.counts.native,2);assert.equal(f.counts.start,2);
});

test('email link confirmation uses the current session and clears local recovery only for a revoked one',async()=>{
 const f=controllerFixture();await f.host.bootstrap();
 await f.host.confirmEmailLink(proof,linkKey);
 assert.deepEqual(f.sent.confirm,[{token:'access-1',input:proof,key:linkKey}]);
 assert.equal(f.host.getState().status,'authenticated');
 f.fails.confirm=1;
 await assert.rejects(f.host.confirmEmailLink(proof,linkKey),{code:'reauth_required'});
 assert.equal(f.host.getState().status,'authenticated');assert.equal(JSON.parse(f.raw()!).active.sessionId,f.sessionId);
 f.fails.refresh='denied';
 f.fails.confirm=1;
 await assert.rejects(f.host.confirmEmailLink(proof,linkKey),{code:'reauth_required'});
 assert.equal(f.host.getState().status,'anonymous');assert.equal(JSON.parse(f.raw()!).active,null);
});

test('the revocation attempt keeps the grant inside the flow and refuses to replay a dispatched revoke',async()=>{
 const server=fakeServer();
 const attempt=createAppleRevokeAttempt({api:server.api,newId:uuid,now:server.clock.now,authorize:server.authorize,action:'revoke-session'});
 const spent:string[]=[],target=uuid();
 const run=(revoke:(grant:string)=>Promise<void>)=>attempt.run({access:async()=>'access-1',installationId,signal:new AbortController().signal,
  spend:async({grant,access})=>{spent.push(grant);await revoke(grant);await access();}});
 await assert.rejects(run(async grant=>{await server.api.revokeDeviceSession('access-1',target,grant);throw new AuthClientError('network');}),{code:'network'});
 // The dispatched revocation ends the flow: a repeat would replay a spend whose outcome is unknown.
 assert.equal(attempt.canRetry(),false);
 await assert.rejects(run(async()=>{}),{code:'apple_restart_required'});
 assert.deepEqual(server.sent.start.map(item=>item.action),['revoke-session']);
 assert.equal(spent.length,1);assert.equal(server.grants(),1);assert.equal(server.counts.revoke,1);
 assert.deepEqual(spent,[server.grantValues()[0]!]);
});

test('Apple-only revocation of another device asks for revoke-session and keeps the local session',async()=>{
 const f=controllerFixture();await f.host.bootstrap();const generation=f.host.getState().generation,target=uuid();
 assert.equal(await f.host.revokeDeviceSessionWithApple(target,f.authorize,linkKey),undefined);
 assert.deepEqual(f.sent.start,[{token:'access-1',action:'revoke-session',platform:'ios',installationId}]);
 assert.equal(f.counts.native,1);assert.equal(f.counts.complete,1);assert.equal(f.grants(),1);
 const grant=f.grantValues()[0]!;
 assert.match(grant,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/);
 assert.deepEqual(f.sent.revoke,[{token:'access-1',sessionId:target,reauthGrant:grant}]);
 // The one-time grant is spent inside the call: it is not persisted, echoed or published.
 assert.equal(f.raw()!.includes(grant),false);assert.equal(f.raw()!.includes('reauthGrant'),false);
 assert.equal(JSON.stringify(f.host.getState()).includes(grant),false);
 assert.equal(f.host.getState().generation,generation);assert.equal(f.host.getState().status,'authenticated');
 assert.equal(f.host.getState().session!.sessionId,f.sessionId);
 assert.equal(JSON.parse(f.raw()!).active.sessionId,f.sessionId);assert.equal(f.counts.logout,0);assert.equal(f.counts.revokeAll,0);
 // The finished operation is released, so the same key starts a new provider flow.
 await f.host.revokeDeviceSessionWithApple(uuid(),f.authorize,linkKey);
 assert.equal(f.counts.native,2);assert.equal(f.counts.start,2);assert.equal(f.counts.revoke,2);
});

test('Apple-only revoke-all asks for revoke-all-sessions and clears the local session after confirmation',async()=>{
 const f=controllerFixture();await f.host.bootstrap();
 assert.equal(await f.host.revokeAllDeviceSessionsWithApple(f.authorize,linkKey),undefined);
 assert.deepEqual(f.sent.start.map(item=>item.action),['revoke-all-sessions']);
 assert.deepEqual(f.sent.revokeAll,[{token:'access-1',reauthGrant:f.grantValues()[0]!}]);
 assert.equal(f.counts.revoke,0);assert.equal(f.counts.logout,0);
 assert.equal(f.host.getState().status,'anonymous');assert.equal(f.host.getState().session,null);assert.equal(f.host.getState().account,null);
 assert.equal(f.host.getState().pendingRevocations,0);
 assert.equal(JSON.parse(f.raw()!).active,null);assert.equal(JSON.parse(f.raw()!).revocations.length,0);
 assert.equal(f.raw()!.includes(f.grantValues()[0]!),false);
});

test('a lost Apple completion resumes the same revocation under the same key',async()=>{
 const f=controllerFixture();await f.host.bootstrap();f.fails.complete=1;const target=uuid();
 await assert.rejects(f.host.revokeDeviceSessionWithApple(target,f.authorize,linkKey),{code:'network'});
 // A different key, a different target and the other action may not resume or replace the flow.
 await assert.rejects(f.host.revokeDeviceSessionWithApple(target,f.authorize,uuid()),{code:'busy'});
 await assert.rejects(f.host.revokeDeviceSessionWithApple(uuid(),f.authorize,linkKey),{code:'busy'});
 await assert.rejects(f.host.revokeAllDeviceSessionsWithApple(f.authorize,linkKey),{code:'busy'});
 await f.host.revokeDeviceSessionWithApple(target,f.authorize,linkKey);
 assert.deepEqual(f.sent.complete[0],f.sent.complete[1]);
 assert.equal(f.grants(),1);assert.equal(f.counts.native,1);assert.equal(f.counts.start,1);assert.equal(f.counts.revoke,1);
 assert.deepEqual(f.sent.revoke,[{token:'access-1',sessionId:target,reauthGrant:f.grantValues()[0]!}]);
});

test('an unknown revocation outcome is reported as a failure and leaves the device list re-readable',async()=>{
 const f=controllerFixture();await f.host.bootstrap();f.fails.revoke=1;const target=uuid();
 await assert.rejects(f.host.revokeDeviceSessionWithApple(target,f.authorize,linkKey),{code:'network'});
 assert.equal(f.host.getState().status,'authenticated');assert.equal(f.host.getState().session!.sessionId,f.sessionId);
 assert.equal(JSON.parse(f.raw()!).active.sessionId,f.sessionId);
 // The list stays available, and the ended flow authorizes again instead of replaying the revoke.
 assert.deepEqual(await f.host.deviceSessions(),{items:[],nextCursor:null});assert.equal(f.counts.sessions,1);
 await f.host.revokeDeviceSessionWithApple(target,f.authorize,linkKey);
 assert.equal(f.counts.native,2);assert.equal(f.counts.start,2);assert.equal(f.counts.revoke,2);
 assert.equal(f.sent.revoke[0]!.sessionId,target);assert.equal(f.sent.revoke[1]!.sessionId,target);
 assert.notEqual(f.sent.revoke[0]!.reauthGrant,f.sent.revoke[1]!.reauthGrant);
});

test('an unknown revoke-all outcome is never reported as success',async()=>{
 const f=controllerFixture();await f.host.bootstrap();f.fails.revokeAll=1;
 await assert.rejects(f.host.revokeAllDeviceSessionsWithApple(f.authorize,linkKey),{code:'network'});
 assert.equal(f.host.getState().status,'authenticated');assert.equal(JSON.parse(f.raw()!).active.sessionId,f.sessionId);
 // The same loss after the server committed is still not a success: the dead session is cleared.
 const committed=controllerFixture();await committed.host.bootstrap();committed.fails.revokeAll=1;committed.fails.commitRevokeAllBeforeFailure=true;
 await assert.rejects(committed.host.revokeAllDeviceSessionsWithApple(committed.authorize,linkKey),{code:'reauth_required'});
 assert.equal(committed.counts.revokeAll,1);assert.equal(committed.host.getState().status,'anonymous');
 assert.equal(JSON.parse(committed.raw()!).active,null);
});

test('logout during the Apple revocation cancels it without spending a grant',async()=>{
 const f=controllerFixture();await f.host.bootstrap();f.holdNative();const target=uuid();
 const entered=f.nextNative(),revoking=f.host.revokeDeviceSessionWithApple(target,f.authorize,linkKey);
 await entered;await f.host.logout();f.releaseNative();
 await assert.rejects(revoking,{code:'cancelled'});
 assert.equal(f.counts.complete,0);assert.equal(f.counts.revoke,0);assert.equal(f.counts.logout,1);
 assert.equal(f.host.getState().status,'anonymous');assert.equal(JSON.parse(f.raw()!).active,null);
 await f.host.login({email:'next@example.test',password,platform:'ios'});
 await f.host.revokeDeviceSessionWithApple(uuid(),f.authorize,linkKey);
 assert.equal(f.counts.native,2);assert.equal(f.counts.start,2);assert.equal(f.counts.revoke,1);
 assert.equal(f.host.getState().status,'authenticated');
});

test('revoking this device with Apple needs no fresh authorization and clears the local session',async()=>{
 const f=controllerFixture();await f.host.bootstrap();
 await f.host.revokeDeviceSessionWithApple(f.sessionId,f.authorize,linkKey);
 assert.equal(f.counts.native,0);assert.equal(f.counts.start,0);assert.equal(f.counts.complete,0);
 assert.deepEqual(f.sent.revoke,[{token:'access-1',sessionId:f.sessionId}]);
 assert.equal(f.host.getState().status,'anonymous');assert.equal(f.host.getState().pendingRevocations,0);
 assert.equal(JSON.parse(f.raw()!).active,null);
});

test('Apple-only revocation validates the target, the key and the session state',async()=>{
 const anonymous=controllerFixture({authenticated:false});await anonymous.host.bootstrap();
 assert.equal(anonymous.host.getState().status,'anonymous');
 await assert.rejects(anonymous.host.revokeDeviceSessionWithApple(uuid(),anonymous.authorize,linkKey),{code:'reauth_required'});
 await assert.rejects(anonymous.host.revokeAllDeviceSessionsWithApple(anonymous.authorize,linkKey),{code:'reauth_required'});
 assert.deepEqual(anonymous.counts,zeros);
 const f=controllerFixture();await f.host.bootstrap();
 await assert.rejects(f.host.revokeDeviceSessionWithApple('not-a-uuid',f.authorize,linkKey),{code:'invalid_request'});
 await assert.rejects(f.host.revokeDeviceSessionWithApple(uuid(),f.authorize,'not-a-uuid'),{code:'invalid_request'});
 await assert.rejects(f.host.revokeAllDeviceSessionsWithApple(f.authorize,'not-a-uuid'),{code:'invalid_request'});
 assert.deepEqual(f.counts,{...zeros,refresh:1});assert.equal(f.sent.start.length,0);
});

/** Apple deletion attempt alone: the caller supplies the session access and the fence, and the fixture
 *  counts how often that access was read so a repeat never needs it again. */
function deletionFixture({key=linkKey,dependencyDisposition={kind:'none'} as DeletionDependencyDisposition}:
  {key?:string;dependencyDisposition?:DeletionDependencyDisposition}={}){
 const server=fakeServer();
 const attempt=createAppleDeletionAttempt({api:server.api,newId:uuid,now:server.clock.now,authorize:server.authorize,dependencyDisposition,key});
 let reads=0;
 const run=(signal=new AbortController().signal)=>attempt.run({access:async()=>{reads++;return 'access-1';},installationId,signal});
 return {server,attempt,run,accessReads:()=>reads};
}

test('an Apple deletion spends one delete-account grant on the caller key and returns only the receipt',async()=>{
 const {server,attempt,run,accessReads}=deletionFixture();
 const receipt=await run();
 assert.deepEqual(server.sent.start,[{token:'access-1',action:'delete-account',platform:'ios',installationId}]);
 assert.equal(server.counts.native,1);assert.equal(server.grants(),1);assert.equal(server.sent.submit.length,1);
 // The one DELETE carries the issued grant, the caller's own key and the caller's declaration, on the
 // session the flow was started against.
 assert.deepEqual(server.sent.submit[0],{token:'access-1',key:linkKey,
  input:{reauthGrant:server.grantValues()[0]!,confirmation:true,dependencyDisposition:{kind:'none'}}});
 assert.deepEqual(Object.keys(receipt).sort(),['deletionId','expiresAt','receiptSecret']);
 // Neither the bearer nor the grant reaches the attempt's surface, and the cached receipt is what a
 // failed secure write reads back.
 assert.deepEqual(Object.keys(attempt).sort(),['canRetry','clear','run']);
 assert.equal(JSON.stringify(attempt).includes('access-1'),false);
 assert.equal(JSON.stringify(receipt).includes(server.grantValues()[0]!),false);
 assert.equal(attempt.canRetry(),true);
});

test('a lost deletion repeats the same key, bearer and body without another Apple authorization',async()=>{
 const {server,attempt,run,accessReads}=deletionFixture();server.fails.submit=1;server.fails.submitCode='deletion_outcome_unknown';
 await assert.rejects(run(),{code:'deletion_outcome_unknown'});
 // The submission keeps the repeatable loss the provider rules would have dropped, and the retry is
 // its own: no provider flow and no further session read.
 assert.equal(attempt.canRetry(),true);
 const reads=accessReads();
 await run();
 assert.equal(server.sent.submit.length,2);assert.deepEqual(server.sent.submit[0],server.sent.submit[1]);
 assert.deepEqual(server.sent.start.map(item=>item.action),['delete-account']);
 assert.equal(server.counts.native,1);assert.equal(server.counts.start,1);assert.equal(server.counts.complete,1);assert.equal(server.grants(),1);
 assert.equal(accessReads(),reads);
});

test('a cached deletion receipt is read back without a request, an authorization or a session read',async()=>{
 const {server,attempt,run,accessReads}=deletionFixture();
 const first=await run();
 first.receiptSecret='x'.repeat(43);
 const reads=accessReads();
 const second=await run();
 assert.equal(second.receiptSecret,'d'.repeat(43));assert.notEqual(second,first);
 assert.equal(server.sent.submit.length,1);assert.equal(server.counts.native,1);assert.equal(accessReads(),reads);
 assert.equal(attempt.canRetry(),true);
});

test('any other deletion outcome ends the Apple attempt instead of spending the grant twice',async()=>{
 const {server,attempt,run,accessReads}=deletionFixture();server.fails.submit=1;server.fails.submitCode='deletion_dependencies';
 await assert.rejects(run(),{code:'deletion_dependencies'});
 assert.equal(attempt.canRetry(),false);
 const reads=accessReads();
 await assert.rejects(run(),{code:'cancelled'});
 assert.equal(server.sent.submit.length,1);assert.equal(server.counts.native,1);assert.equal(server.grants(),1);
 assert.equal(accessReads(),reads);
});

test('clear during the native authorization discards the late grant and sends no DELETE',async()=>{
 const {server,attempt,run}=deletionFixture();server.holdNative();
 const entered=server.nextNative(),running=run();
 await entered;attempt.clear();server.releaseNative();
 await assert.rejects(running,{code:'cancelled'});
 assert.equal(server.sent.submit.length,0);assert.equal(attempt.canRetry(),false);
 await assert.rejects(run(),{code:'cancelled'});
 // The grant that arrived after the clear was still issued and then dropped: it never becomes a DELETE.
 assert.equal(server.counts.complete,1);assert.equal(server.sent.submit.length,0);
 assert.equal(server.counts.native,1);assert.equal(server.counts.start,1);
});

test('clear during the deletion discards its late receipt and no later run acts',async()=>{
 const {server,attempt,run}=deletionFixture();server.holdSubmit();
 const entered=server.nextSubmit(),running=run();
 await entered;attempt.clear();server.releaseSubmit();
 await assert.rejects(running,{code:'cancelled'});
 assert.equal(server.sent.submit.length,1);assert.equal(attempt.canRetry(),false);
 await assert.rejects(run(),{code:'cancelled'});
 assert.equal(server.sent.submit.length,1);assert.equal(server.counts.native,1);
});

test('an overlapping Apple deletion is refused as busy while the first keeps its staged attempt',async()=>{
 const {server,attempt,run}=deletionFixture();server.holdNative();
 const entered=server.nextNative(),first=run();
 await entered;
 await assert.rejects(run(),{code:'busy'});
 server.releaseNative();
 assert.equal(typeof (await first).deletionId,'string');
 assert.equal(server.counts.native,1);assert.equal(server.sent.submit.length,1);assert.equal(attempt.canRetry(),true);
});

test('the caller declaration reaches the DELETE verbatim, including a per-family handling',async()=>{
 const disposition:DeletionDependencyDisposition={kind:'per-family',
  families:[{familyId:uuid(),kind:'transfer',recipientSubjectId:uuid()}]};
 const {server,run}=deletionFixture({dependencyDisposition:disposition});
 await run();
 assert.deepEqual(server.sent.submit[0]!.input.dependencyDisposition,disposition);
});

test('a declaration or key that breaks the contract is refused before any provider round trip',()=>{
 const server=fakeServer();
 const build=(over:{dependencyDisposition?:unknown;key?:unknown})=>createAppleDeletionAttempt({api:server.api,newId:uuid,
  now:server.clock.now,authorize:server.authorize,key:linkKey,dependencyDisposition:{kind:'none'},...over} as never);
 build({});
 for(const over of [{key:'not-a-uuid'},{key:''},{key:randomUUID().replace(/-/g,'')},
  {dependencyDisposition:{kind:'per-family',families:[]}},{dependencyDisposition:{kind:'none',extra:true}},
  {dependencyDisposition:{kind:'transfer',recipientSubjectId:uuid()}}] as Array<{dependencyDisposition?:unknown;key?:unknown}>)
  assert.throws(()=>build(over),{code:'invalid_request'},JSON.stringify(over));
 assert.deepEqual(server.counts,zeros);assert.equal(server.sent.start.length,0);
});

test('the declaration is snapshotted, so an edit during the provider round trip cannot change the choice',async()=>{
 const transfer={familyId:uuid(),kind:'transfer' as const,recipientSubjectId:uuid()};
 const dependencyDisposition:DeletionDependencyDisposition={kind:'per-family',families:[transfer]};
 const snapshot=JSON.parse(JSON.stringify(dependencyDisposition)) as DeletionDependencyDisposition;
 const {server,run}=deletionFixture({dependencyDisposition});
 // The caller keeps editing while Apple authorizes: another recipient, another handling and an extra
 // family all appear in the caller's own copy only.
 server.holdNative();const entered=server.nextNative(),running=run();
 await entered;
 transfer.recipientSubjectId=uuid();
 (dependencyDisposition as {kind:string}).kind='none';
 (dependencyDisposition as {families?:unknown[]}).families!.push({familyId:uuid(),kind:'end-family-access'});
 server.releaseNative();
 await running;
 assert.deepEqual(server.sent.submit[0]!.input.dependencyDisposition,snapshot);
 assert.equal(server.sent.submit[0]!.input.confirmation,true);
});

test('a foreign throw is sanitized into an outage and never echoes a token',async()=>{
 const server=fakeServer();
 const attempt=createAppleDeletionAttempt({api:server.api,newId:uuid,now:server.clock.now,
  authorize:async()=>{throw new Error('provider failed for access-1');},dependencyDisposition:{kind:'none'},key:linkKey});
 const run=()=>attempt.run({access:async()=>'access-1',installationId,signal:new AbortController().signal});
 // The provider error is reported as a plain outage: its message, and anything it carried, is dropped.
 await assert.rejects(run(),error=>error instanceof AuthClientError&&error.code==='unavailable'&&!String(error).includes('access-1'));
 assert.equal(server.sent.submit.length,0);
 assert.equal(attempt.canRetry(),false);
});
