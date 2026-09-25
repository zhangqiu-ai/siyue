import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createAuthIpcDispatcher} from './auth-ipc.mjs';
import {AuthClientError} from '@siyue/adapters';
const rendererUrl='file:///synthetic/index.html';
function fixture(overrides={}) {
 let generation=1;let calls=0;
 const state=()=>({status:'anonymous',generation,session:null,account:null,error:null,pendingRevocations:0});
 const auth={subscribe:()=>()=>{},getState:state,login:async()=>{calls++;generation++;},...overrides};
 const webContents={isDestroyed:()=>false,getURL:()=>rendererUrl,mainFrame:{url:rendererUrl},send(){}};
 const event={sender:webContents,senderFrame:webContents.mainFrame};
 return {dispatcher:createAuthIpcDispatcher({auth,webContents,rendererUrl}),event,calls:()=>calls};
}
test('account IPC denies subframes, unknown operations and stale account generation; successful login returns only public state',async()=>{
 const fx=fixture();const input={version:1,requestId:randomUUID(),generation:1,operation:'login',payload:{email:'a@example.test',password:'a long synthetic password'}};
 assert.equal((await fx.dispatcher.handle({...fx.event,senderFrame:{url:rendererUrl}},input)).error,'forbidden');
 assert.equal((await fx.dispatcher.handle(fx.event,{...input,operation:'fetch',url:'https://evil.invalid'})).error,'invalid_request');
 assert.equal((await fx.dispatcher.handle(fx.event,{...input,generation:0})).error,'cancelled');
 assert.equal(fx.calls(),0);
 const result=await fx.dispatcher.handle(fx.event,input);assert.equal(result.ok,true);assert.equal(result.data.generation,2);
 assert.equal(JSON.stringify(result).includes('password'),false);assert.equal('refreshToken' in result.data,false);
 fx.dispatcher.dispose();assert.equal((await fx.dispatcher.handle(fx.event,input)).error,'forbidden');
});
test('account IPC preserves retry cooldown and hides unknown exception details',async()=>{
 const input={version:1,requestId:randomUUID(),generation:1,operation:'providers',payload:{}};
 const limited=fixture({providers:async()=>{throw new AuthClientError('rate_limited',37);}});
 const reply=await limited.dispatcher.handle(limited.event,input);
 assert.equal(reply.ok,false);assert.equal(reply.error,'rate_limited');assert.equal(reply.retryAfterSeconds,37);
 assert.equal(reply.requestId,input.requestId);limited.dispatcher.dispose();
 const broken=fixture({providers:async()=>{throw new Error('private deployment detail');}});
 const safe=await broken.dispatcher.handle(broken.event,input);
 assert.equal(safe.error,'unavailable');assert.equal(safe.retryAfterSeconds,0);
 assert.equal(JSON.stringify(safe).includes('private deployment detail'),false);broken.dispatcher.dispose();
});

// The account page asks which ways the signed-in subject can still sign in. The read carries no
// argument of its own, so a caller cannot turn it into a token read, an arbitrary fetch or a file
// read, and the reply is the strictly parsed method list the controller already produced.
test('account IPC exposes only the empty-payload login-methods read of the authenticated subject',async()=>{
 let reads=0;
 const methods={items:[{identityId:'email:6f1d1f3a-5f1c-4d1f-9f3a-6f1d1f3a5f1c',kind:'email_password',status:'active',emailMask:'a•••@example.test'}]};
 const fx=fixture({loginMethods:async()=>{reads++;return methods;}});
 const input={version:1,requestId:randomUUID(),generation:1,operation:'login-methods',payload:{}};
 const reply=await fx.dispatcher.handle(fx.event,input);
 assert.deepEqual(reply,{version:1,requestId:input.requestId,ok:true,data:methods,generation:1});
 assert.deepEqual(Object.keys(reply).sort(),['data','generation','ok','requestId','version']);
 assert.equal(reads,1);
 for(const rejected of [
  {...input,payload:{token:'synthetic'}},{...input,payload:{url:'https://evil.invalid'}},{...input,payload:{path:'/tmp/synthetic'}},
  {...input,payload:{subjectId:randomUUID()}},{...input,payload:{cursor:randomUUID()}},{...input,url:'https://evil.invalid'},
  {...input,operation:'login-methods-extra'},{...input,requestId:'not-a-uuid'},
 ]) assert.equal((await fx.dispatcher.handle(fx.event,rejected)).error,'invalid_request');
 assert.equal((await fx.dispatcher.handle(fx.event,{...input,generation:0})).error,'cancelled');
 assert.equal((await fx.dispatcher.handle({...fx.event,senderFrame:{url:rendererUrl}},input)).error,'forbidden');
 assert.equal(reads,1);
 fx.dispatcher.dispose();
 assert.equal((await fx.dispatcher.handle(fx.event,input)).error,'forbidden');assert.equal(reads,1);
});

test('account IPC reports the login-methods failure code without leaking controller detail',async()=>{
 const input={version:1,requestId:randomUUID(),generation:1,operation:'login-methods',payload:{}};
 const anonymous=fixture({loginMethods:async()=>{throw new AuthClientError('reauth_required');}});
 const denied=await anonymous.dispatcher.handle(anonymous.event,input);
 assert.equal(denied.ok,false);assert.equal(denied.error,'reauth_required');assert.equal(denied.retryAfterSeconds,0);
 assert.equal(denied.requestId,input.requestId);assert.equal('data' in denied,false);anonymous.dispatcher.dispose();
 const limited=fixture({loginMethods:async()=>{throw new AuthClientError('reauth_required',23);}});
 assert.equal((await limited.dispatcher.handle(limited.event,input)).retryAfterSeconds,23);limited.dispatcher.dispose();
 const broken=fixture({loginMethods:async()=>{throw new Error('synthetic vault /Users/private/recovery.enc');}});
 const safe=await broken.dispatcher.handle(broken.event,input);
 assert.equal(safe.error,'unavailable');assert.equal(JSON.stringify(safe).includes('/Users/private'),false);
 assert.equal(JSON.stringify(safe).includes('recovery.enc'),false);broken.dispatcher.dispose();
});

// Unbinding the email login method is the one account write the desktop exposes, and it is bounded
// on both sides: the renderer hands back the strict `email:` handle the summary returned plus the
// account's current password, while the password re-verification, the single-use `unlink-identity`
// grant and the bearer stay inside the controller. The reply is public state only, so no grant, no
// token and no address can travel back to the renderer.
test('account IPC routes exactly one bounded unlink-identity write and replies with public state only',async()=>{
 const handle=`email:${randomUUID()}`,secret='synthetic current password';const received=[];
 let status='authenticated',generation=1;
 const state=()=>({status,generation,session:null,account:null,error:null,pendingRevocations:0});
 const fx=fixture({getState:state,unlinkIdentity:async(identityId,currentPassword)=>{received.push([identityId,currentPassword]);status='anonymous';generation+=1;}});
 const input={version:1,requestId:randomUUID(),generation:1,operation:'unlink-identity',payload:{identityId:handle,currentPassword:secret}};
 const reply=await fx.dispatcher.handle(fx.event,input);
 assert.deepEqual(Object.keys(reply).sort(),['data','generation','ok','requestId','version']);
 assert.equal(reply.ok,true);assert.equal(reply.requestId,input.requestId);assert.equal(reply.generation,2);
 assert.deepEqual(reply.data,{status:'anonymous',generation:2,session:null,account:null,error:null,pendingRevocations:0});
 assert.deepEqual(received,[[handle,secret]]);
 assert.equal(JSON.stringify(reply).includes(secret),false);assert.equal(JSON.stringify(reply).includes(handle),false);
 assert.equal('data' in reply&&'reauthGrant' in reply.data,false);assert.equal('refreshToken' in reply.data,false);
 // Every argument that is not the handle plus the password is refused before the controller runs:
 // a smuggled grant/token/URL, an Apple handle, a bare row id, a differently cased or malformed
 // handle, a password outside the account password rule, and a differently spelled operation.
 for(const rejected of [
  {...input,payload:{...input.payload,reauthGrant:`${randomUUID()}.${'A'.repeat(43)}`}},{...input,payload:{...input.payload,accessToken:'synthetic'}},
  {...input,payload:{...input.payload,subjectId:randomUUID()}},{...input,payload:{...input.payload,key:randomUUID()}},
  {...input,payload:{...input.payload,url:'https://evil.invalid'}},{...input,payload:{...input.payload,path:'/tmp/synthetic'}},
  {...input,payload:{identityId:`apple:${randomUUID()}`,currentPassword:secret}},{...input,payload:{identityId:randomUUID(),currentPassword:secret}},
  {...input,payload:{identityId:handle.toUpperCase(),currentPassword:secret}},{...input,payload:{identityId:'email:not-a-uuid',currentPassword:secret}},
  {...input,payload:{identityId:handle,currentPassword:'too short'}},{...input,payload:{identityId:handle,currentPassword:''}},
  {...input,payload:{identityId:handle}},{...input,payload:{currentPassword:secret}},{...input,payload:{}},{...input,payload:undefined},
  {...input,url:'https://evil.invalid'},{...input,operation:'unlink-identity-extra'},{...input,operation:'unlink'},{...input,requestId:'not-a-uuid'},
 ]) assert.equal((await fx.dispatcher.handle(fx.event,rejected)).error,'invalid_request',JSON.stringify(rejected));
 assert.equal(received.length,1);
 // The same write on a stale generation and from an untrusted frame changes nothing.
 assert.equal((await fx.dispatcher.handle(fx.event,{...input,generation:0})).error,'cancelled');
 assert.equal((await fx.dispatcher.handle({...fx.event,senderFrame:{url:rendererUrl}},input)).error,'forbidden');
 assert.equal(received.length,1);
 fx.dispatcher.dispose();
 assert.equal((await fx.dispatcher.handle(fx.event,input)).error,'forbidden');assert.equal(received.length,1);
});

test('account IPC reports unlink refusals by code and hides any other failure detail',async()=>{
 const input={version:1,requestId:randomUUID(),generation:1,operation:'unlink-identity',
  payload:{identityId:`email:${randomUUID()}`,currentPassword:'synthetic current password'}};
 const last=fixture({unlinkIdentity:async()=>{throw new AuthClientError('last_method_required');}});
 const refused=await last.dispatcher.handle(last.event,input);
 assert.equal(refused.ok,false);assert.equal(refused.error,'last_method_required');assert.equal(refused.retryAfterSeconds,0);
 assert.equal(refused.requestId,input.requestId);assert.equal('data' in refused,false);last.dispatcher.dispose();
 const missing=fixture({unlinkIdentity:async()=>{throw new AuthClientError('identity_not_found');}});
 assert.equal((await missing.dispatcher.handle(missing.event,input)).error,'identity_not_found');missing.dispatcher.dispose();
 const limited=fixture({unlinkIdentity:async()=>{throw new AuthClientError('rate_limited',31);}});
 const throttled=await limited.dispatcher.handle(limited.event,input);
 assert.equal(throttled.error,'rate_limited');assert.equal(throttled.retryAfterSeconds,31);limited.dispatcher.dispose();
 const grant=`${randomUUID()}.${'A'.repeat(43)}`;
 const broken=fixture({unlinkIdentity:async()=>{throw new Error(`synthetic vault failure with grant ${grant}`);}});
 const safe=await broken.dispatcher.handle(broken.event,input);
 assert.equal(safe.error,'unavailable');assert.equal(safe.retryAfterSeconds,0);
 assert.equal(JSON.stringify(safe).includes(grant),false);assert.equal(JSON.stringify(safe).includes('synthetic vault failure'),false);broken.dispatcher.dispose();
});

test('deletion IPC keeps credentials and receipt proof out of its response and rejects injected authority',async()=>{
 const received=[];
 const fx=fixture({submitDeletionWithPassword:async(...args)=>received.push(args),retryDeletion:async()=>received.push('retry'),
  deletionImpact:async()=>({subjectId:randomUUID(),families:[],guardianships:[],activeChildDeviceCount:0}),deletionStatus:async()=>null});
 const input={version:1,requestId:randomUUID(),generation:1,operation:'submit-deletion',payload:{currentPassword:'synthetic long password',dependencyDisposition:{kind:'none'}}};
 const result=await fx.dispatcher.handle(fx.event,input);
 assert.equal(result.ok,true);assert.deepEqual(received,[['synthetic long password',{kind:'none'}]]);
 assert.equal(JSON.stringify(result).includes('password'),false);
 for(const extra of [{accessToken:'secret'},{reauthGrant:'secret'},{subjectId:randomUUID()},{key:randomUUID()},{confirmation:false}]){
  assert.equal((await fx.dispatcher.handle(fx.event,{...input,payload:{...input.payload,...extra}})).error,'invalid_request');
 }
 for(const operation of ['deletion-impact','deletion-status','retry-deletion']){
  assert.equal((await fx.dispatcher.handle(fx.event,{...input,operation,payload:{}})).ok,true);
  assert.equal((await fx.dispatcher.handle(fx.event,{...input,operation,payload:{receiptSecret:'secret'}})).error,'invalid_request');
 }
 assert.equal((await fx.dispatcher.handle(fx.event,{...input,generation:0})).error,'cancelled');
 assert.equal(received.length,2);fx.dispatcher.dispose();
});

test('family responsibility IPC accepts only explicit scope confirmation without caller authority',async()=>{
 const familyId=randomUUID(),received=[];
 const input={expectedFamilyVersion:1,expectedMembershipVersion:1,expectedOwnerMembershipVersion:1,
  expectedChildScopeDigest:'a'.repeat(64),acceptance:{familyManagement:true,guardianship:true}};
 const fx=fixture({familyManagementPreview:async family=>{received.push(family);return {familyId:family};},
  acceptFamilyManagement:async(family,value)=>{received.push([family,value]);return {accepted:true};}});
 const base={version:1,requestId:randomUUID(),generation:1};
 assert.equal((await fx.dispatcher.handle(fx.event,{...base,operation:'family-management-preview',payload:{familyId}})).ok,true);
 assert.equal((await fx.dispatcher.handle(fx.event,{...base,operation:'accept-family-management',payload:{familyId,input}})).ok,true);
 for(const bad of [{...input,recipientSubjectId:randomUUID()},{...input,accessToken:'secret'},
  {...input,acceptance:{familyManagement:true,guardianship:false}}]){
  assert.equal((await fx.dispatcher.handle(fx.event,{...base,operation:'accept-family-management',payload:{familyId,input:bad}})).error,'invalid_request');
 }
 assert.equal(received.length,2);assert.deepEqual(received[1],[familyId,input]);fx.dispatcher.dispose();
});

// Registration starts by reading the released terms and privacy versions, which is a public read like
// `providers`: the renderer sends nothing but version/requestId/generation, the controller answers for
// that generation, and the reply is exactly the published policy pair. A closed policy is data too —
// the screen, not the host, decides what an unreleased policy renders as.
test('account IPC exposes the released registration policy as an empty public read',async()=>{
 let reads=0;
 const policy={enabled:true,terms:{version:'terms-2026-09-25',url:'https://siyue.test/terms'},privacy:{version:'privacy-2026-09-25',url:'https://siyue.test/privacy'}};
 const fx=fixture({registrationPolicy:async()=>{reads++;return policy;}});
 const input={version:1,requestId:randomUUID(),generation:1,operation:'registration-policy',payload:{}};
 const reply=await fx.dispatcher.handle(fx.event,input);
 assert.deepEqual(reply,{version:1,requestId:input.requestId,ok:true,data:policy,generation:1});
 assert.deepEqual(Object.keys(reply).sort(),['data','generation','ok','requestId','version']);
 assert.equal(reads,1);
 const closed=fixture({registrationPolicy:async()=>({enabled:false,terms:null,privacy:null})});
 assert.deepEqual((await closed.dispatcher.handle(closed.event,input)).data,{enabled:false,terms:null,privacy:null});closed.dispatcher.dispose();
 for(const rejected of [
  {...input,payload:{token:'synthetic'}},{...input,payload:{url:'https://evil.invalid'}},{...input,payload:{email:'a@example.test'}},
  {...input,payload:{key:randomUUID()}},{...input,payload:{generation:2}},{...input,url:'https://evil.invalid'},
  {...input,operation:'registration-policy-extra'},{...input,requestId:'not-a-uuid'},
 ]) assert.equal((await fx.dispatcher.handle(fx.event,rejected)).error,'invalid_request',JSON.stringify(rejected));
 assert.equal((await fx.dispatcher.handle(fx.event,{...input,generation:0})).error,'cancelled');
 assert.equal((await fx.dispatcher.handle({...fx.event,senderFrame:{url:rendererUrl}},input)).error,'forbidden');
 assert.equal(reads,1);
 fx.dispatcher.dispose();
 assert.equal((await fx.dispatcher.handle(fx.event,input)).error,'forbidden');assert.equal(reads,1);
});

// The policy read is shared with the other reads, so it never spends one of the four write slots, and
// no operation is ever answered with `ok: true` and no data: a host that does not implement a command
// refuses it instead of reporting an empty success.
test('account IPC bounds the policy read with the reads and never answers an unhandled operation with ok',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const inFlight=fixture({registrationPolicy:async()=>{await gate;return {enabled:false,terms:null,privacy:null};}});
 const read=()=>inFlight.dispatcher.handle(inFlight.event,{version:1,requestId:randomUUID(),generation:1,operation:'registration-policy',payload:{}});
 const unhandled=fixture(),base={version:1,requestId:randomUUID(),generation:1};
 try {
  for(const operation of ['restore','family-responsibilities','deletion-impact']) {
   const reply=await unhandled.dispatcher.handle(unhandled.event,{...base,operation,payload:{}});
   assert.equal(reply.ok,false,operation);assert.equal(reply.error,'unavailable',operation);
   assert.equal('data' in reply,false,operation);assert.equal(reply.requestId,base.requestId,operation);
  }
  const writes=()=>inFlight.dispatcher.handle(inFlight.event,{version:1,requestId:randomUUID(),generation:1,operation:'login',
   payload:{email:'a@example.test',password:'a long synthetic password'}});
  const reads=Array.from({length:5},()=>read()),write=writes();release();
  const replies=await Promise.all([...reads,write]);
  assert.equal(replies.every(reply=>reply.ok),true,JSON.stringify(replies));
 } finally {release();unhandled.dispatcher.dispose();inFlight.dispatcher.dispose();}
});
