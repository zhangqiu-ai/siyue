import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {appleReauthGrantSchema,type AuthClientErrorCode} from '@siyue/contracts';
import {createAppleChildApprovalAttempt} from './apple-reauth.js';
import {AuthClientError,type AuthApiClient} from './auth-api-client.js';

const baseUrl='http://127.0.0.1:8787/v1';
// A fixed installation id keeps the fake admission assertion and the start body in step.
const installationId='7c9e6679-7425-40de-944b-e07fc1f90ae7';
const uuid=()=>randomUUID();
const opaque=()=>`${randomUUID()}.${'s'.repeat(43)}`;
const zeros={start:0,complete:0,native:0,approve:0};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

/** In-memory stand-in for the Apple reauth routes and the one guardian approval the grant
 *  authorizes: one grant per completion key, the same grant replayed for a repeated key, and a
 *  record of what was sent. No provider, session, vault or family store outside this process is
 *  involved. */
function fakeServer(){
 // A frozen clock: every derived deadline is exact, so validators never see a 1 ms drift.
 const clock={ms:Date.now(),now:()=>clock.ms};let grants=0,approved=false;
 const counts={...zeros};
 // The Apple identity this subject has linked. A completion that presents any other account is
 // refused, exactly as the server refuses a mismatched Apple identity.
 const boundIdentity='synthetic.header.payload';
 const sent={start:[] as {token:string;action?:string;platform?:string;installationId?:string}[],
  complete:[] as {token:string;input:unknown;key:string}[],approve:[] as {token:string;grant:string}[]};
 const answers=new Map<string,{reauthGrant:string;expiresAt:string}>(),issued:string[]=[];
 const fails={start:0,complete:0,approve:0,grantTtl:300_000 as number,
  startCode:'network' as AuthClientErrorCode,completeCode:'network' as AuthClientErrorCode,approveCode:'network' as AuthClientErrorCode};
 let identity=boundIdentity,stateOverride:string|undefined;
 let gate:{promise:Promise<void>;resolve:()=>void}|null=null,notify:(()=>void)|null=null;
 const at=(ms:number)=>new Date(clock.now()+ms).toISOString();
 const flow=()=>({flowId:uuid(),transactionSecret:'t'.repeat(43),nonce:'n'.repeat(43),state:'x'.repeat(43),expiresAt:at(300_000)});
 const api={endpoint:{environment:'test' as const,apiBaseUrl:baseUrl},
  startAppleReauth:async(token:string,input:{action?:string;platform?:string;installationId?:string})=>{counts.start++;sent.start.push({token,...input});
   if(fails.start-- >0)throw new AuthClientError(fails.startCode);
   assert.equal(input.platform,'ios');assert.equal(input.installationId,installationId);return flow();},
  completeAppleReauth:async(token:string,input:unknown,key:string)=>{counts.complete++;sent.complete.push({token,input,key});
   if(fails.complete-- >0)throw new AuthClientError(fails.completeCode);
   if((input as {identityToken:string}).identityToken!==boundIdentity)throw new AuthClientError('apple_restart_required');
   let answer=answers.get(key);
   if(!answer){grants++;answer=appleReauthGrantSchema.parse({reauthGrant:opaque(),expiresAt:at(fails.grantTtl)});answers.set(key,answer);issued.push(answer.reauthGrant);}
   return answer;}
 };
 // The single approval the guardian spends the grant on. The dispatch is recorded before it can
 // fail, because an approval that was sent and then lost still was sent.
 const approve=async(token:string,grant:string)=>{counts.approve++;sent.approve.push({token,grant});
  if(fails.approve-- >0)throw new AuthClientError(fails.approveCode);approved=true;};
 const authorize=async({state}:{state:string})=>{counts.native++;notify?.();if(gate)await gate.promise;
  return {state:stateOverride??state,identityToken:identity,authorizationCode:'synthetic-authorization-code'};};
 return {api:api as unknown as AuthApiClient,counts,sent,fails,clock,authorize,approve,
  grants:()=>grants,grantValues:()=>issued,isApproved:()=>approved,
  useOtherAccount(){identity='other-account.header.payload';},useMismatchedState(){stateOverride='y'.repeat(43);},
  holdNative(){gate=deferred();},releaseNative(){gate?.resolve();gate=null;},nextNative(){return new Promise<void>(resolve=>{notify=resolve;});}};
}

/** Attempt alone: a real controller supplies the access token, the session fence and the approval
 *  request; here `spend` is that approval, the one place the grant is handed out. */
function attemptFixture(){
 const server=fakeServer();
 const attempt=createAppleChildApprovalAttempt({api:server.api,newId:uuid,now:server.clock.now,authorize:server.authorize});
 const run=(signal:AbortSignal=new AbortController().signal)=>attempt.run({access:async()=>'access-1',installationId,signal,
  spend:async({grant,access})=>{await server.approve(await access(),grant);}});
 return {server,attempt,run};
}

test('one approval spends a single approve-child-device grant and returns nothing to the caller',async()=>{
 const {server,attempt,run}=attemptFixture();
 assert.equal(await run(),undefined);
 assert.deepEqual(server.counts,{...zeros,start:1,complete:1,native:1,approve:1});
 assert.deepEqual(server.sent.start,[{token:'access-1',action:'approve-child-device',platform:'ios',installationId}]);
 // start, complete and the approval all run on the same session access token.
 assert.equal(server.sent.complete[0]!.token,'access-1');
 assert.deepEqual(server.sent.approve,[{token:'access-1',grant:server.grantValues()[0]!}]);
 assert.equal(server.grants(),1);assert.equal(server.isApproved(),true);assert.equal(attempt.canRetry(),false);
});

test('a lost completion replays the same key and input without another native authorization',async()=>{
 const {server,attempt,run}=attemptFixture();server.fails.complete=1;
 await assert.rejects(run(),{code:'network'});
 assert.equal(attempt.canRetry(),true);
 await run();
 assert.deepEqual(server.sent.complete[0],server.sent.complete[1]);
 assert.equal(server.grants(),1);assert.equal(server.counts.native,1);assert.equal(server.counts.approve,1);
 assert.equal(attempt.canRetry(),false);
});

test('an Apple identity that is not the linked account is refused and spends no grant',async()=>{
 const {server,attempt,run}=attemptFixture();server.useOtherAccount();
 await assert.rejects(run(),{code:'apple_restart_required'});
 assert.equal(server.counts.complete,1);assert.equal(server.counts.approve,0);assert.equal(server.grants(),0);
 assert.equal(attempt.canRetry(),false);
 // The attempt refuses to re-prove the identity it already got wrong, and never approves.
 await assert.rejects(run(),{code:'apple_restart_required'});
 assert.equal(server.counts.native,1);assert.equal(server.counts.start,1);assert.equal(server.counts.approve,0);
});

test('a provider state that does not match the started flow ends the attempt before completion',async()=>{
 const {server,attempt,run}=attemptFixture();server.useMismatchedState();
 await assert.rejects(run(),{code:'apple_restart_required'});
 assert.equal(server.counts.complete,0);assert.equal(server.counts.approve,0);assert.equal(attempt.canRetry(),false);
});

test('an abort signal cancels the approval before any completion or spend',async()=>{
 const {server,attempt,run}=attemptFixture();const control=new AbortController();server.holdNative();
 const entered=server.nextNative(),running=run(control.signal);
 await entered;control.abort();server.releaseNative();
 await assert.rejects(running,{code:'cancelled'});
 assert.equal(server.counts.complete,0);assert.equal(server.counts.approve,0);assert.equal(attempt.canRetry(),false);
 // A cancelled or account-switched flow is dead: the same instance refuses to resume, and a fresh
 // attempt, which is what a new session/generation builds, runs on the new session access.
 const fresh=attemptFixture();await fresh.run();
 assert.deepEqual(fresh.server.sent.start.map(item=>item.action),['approve-child-device']);
 assert.equal(fresh.server.counts.native,1);assert.equal(fresh.server.counts.approve,1);
});

test('an approval that fails after dispatch is reported as a failure and is never replanted as a success',async()=>{
 const {server,attempt,run}=attemptFixture();server.fails.approve=1;
 await assert.rejects(run(),{code:'network'});
 assert.equal(server.counts.approve,1);assert.equal(server.isApproved(),false);assert.equal(attempt.canRetry(),false);
 // The dispatched approval ends the flow: a repeat neither re-authorizes nor approves again, so the
 // caller must re-read the pairing status instead of seeing a success.
 await assert.rejects(run(),{code:'apple_restart_required'});
 assert.equal(server.counts.native,1);assert.equal(server.counts.start,1);assert.equal(server.counts.approve,1);
});
