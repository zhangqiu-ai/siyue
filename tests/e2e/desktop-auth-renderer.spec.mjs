import {test,expect} from 'playwright/test';
import {randomUUID} from 'node:crypto';
import {createRendererAuth} from '../../apps/desktop/src/renderer/auth-client.ts';

// The desktop renderer reaches the account only through the preload bridge. `login-methods` is a
// strict, empty-payload read: the renderer sends nothing but version/requestId/generation and
// re-parses the reply, so a credential, a raw address or a foreign shape never reaches the UI.
function wire(reply) {
 const calls=[];
 return {calls,auth:async request=>{calls.push(request);return reply(request);},onAuthState:()=>()=>{}};
}
const apple={identityId:'apple:6f1d1f3a-5f1c-4d1f-9f3a-6f1d1f3a5f1c',kind:'apple',status:'active'};
const reply=(data)=>(request)=>({version:1,requestId:request.requestId,ok:true,data,generation:request.generation});

test('renderer login-methods sends only the generation-scoped empty read and returns the parsed summary',async()=>{
 const bridge=wire(reply({items:[apple]}));
 const methods=await createRendererAuth(bridge).loginMethods();
 expect(methods).toEqual({items:[apple]});
 expect(Object.keys(methods)).toEqual(['items']);
 expect(bridge.calls).toHaveLength(1);
 expect(bridge.calls[0]).toEqual({version:1,requestId:bridge.calls[0].requestId,generation:0,operation:'login-methods',payload:{}});
 expect(bridge.calls[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
});

test('renderer login-methods refuses a reply carrying a credential, a raw address or a foreign shape',async()=>{
 const masked={identityId:'email:5e2c5b7a-2c31-4f6e-9d0a-5e2c5b7a2c31',kind:'email_password',status:'active',emailMask:'e•••@example.test'};
 for(const data of [
  {items:[apple],accessToken:'synthetic'},{items:[apple],refreshToken:'synthetic'},
  {items:[{...apple,providerSubject:'001122.abcdef',clientId:'synthetic.client'}]},
  {items:[{...masked,emailMask:'electron@example.test'}]},{items:[{...masked,email:'electron@example.test'}]},
  {items:[{...apple,identityId:'apple:not-a-uuid'}]},{items:[{...apple,status:'revoked'}]},
  {items:[apple,apple]},{items:Array.from({length:21},(_,index)=>({...apple,identityId:`apple:6f1d1f3a-5f1c-4d1f-9f3a-6f1d1f3a5f${String(index).padStart(2,'0')}`}))},
  {subjects:[apple]},null,
 ]) await expect(createRendererAuth(wire(reply(data))).loginMethods()).rejects.toMatchObject({code:'invalid_response'});
});

test('renderer login-methods rejects a mismatched envelope and an absent bridge without exposing data',async()=>{
 const mismatched=wire(request=>({version:1,requestId:randomUUID(),ok:true,data:{items:[apple]},generation:request.generation}));
 await expect(createRendererAuth(mismatched).loginMethods()).rejects.toMatchObject({code:'invalid_response'});
 const stale=wire(request=>({version:1,requestId:request.requestId,ok:true,data:{items:[apple]},generation:-1}));
 await expect(createRendererAuth(stale).loginMethods()).rejects.toMatchObject({code:'cancelled'});
 const denied=wire(request=>({version:1,requestId:request.requestId,ok:false,error:'reauth_required',retryAfterSeconds:0}));
 await expect(createRendererAuth(denied).loginMethods()).rejects.toMatchObject({code:'reauth_required'});
 await expect(createRendererAuth(undefined).loginMethods()).rejects.toMatchObject({code:'unavailable'});
});

// Unbinding the email method is the write counterpart of that read: the renderer sends back the
// handle it just listed plus the account's current password. The single-use grant, the bearer and the
// password re-verification never leave the main process, and the reply it adopts is plain public
// state, so nothing extra can be carried into the UI by a reply.
const unlinkHandle='email:5e2c5b7a-2c31-4f6e-9d0a-5e2c5b7a2c31';
const unlinkPassword='synthetic current password';
const anonymous={status:'anonymous',generation:1,session:null,account:null,error:null,pendingRevocations:0};

test('renderer unlink-identity sends exactly the strict handle and password and adopts the returned state',async()=>{
 const bridge=wire(request=>({version:1,requestId:request.requestId,ok:true,data:anonymous,generation:anonymous.generation}));
 const auth=createRendererAuth(bridge);
 expect(await auth.unlinkIdentity(unlinkHandle,unlinkPassword)).toBeUndefined();
 expect(bridge.calls).toHaveLength(1);
 expect(bridge.calls[0]).toEqual({version:1,requestId:bridge.calls[0].requestId,generation:0,operation:'unlink-identity',
  payload:{identityId:unlinkHandle,currentPassword:unlinkPassword}});
 expect(Object.keys(bridge.calls[0].payload)).toEqual(['identityId','currentPassword']);
 expect(bridge.calls[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
 expect(auth.getState()).toEqual(anonymous);
});

test('renderer unlink-identity refuses a malformed handle or password before it reaches the bridge',async()=>{
 for(const [identityId,currentPassword] of [[`apple:5e2c5b7a-2c31-4f6e-9d0a-5e2c5b7a2c31`,unlinkPassword],
  ['5e2c5b7a-2c31-4f6e-9d0a-5e2c5b7a2c31',unlinkPassword],[unlinkHandle.toUpperCase(),unlinkPassword],['email:not-a-uuid',unlinkPassword],
  [`${unlinkHandle}?force=1`,unlinkPassword],[unlinkHandle,'short'],[unlinkHandle,'x'.repeat(129)],[unlinkHandle,`${'x'.repeat(20)}\ud800`]]) {
  const bridge=wire(request=>({version:1,requestId:request.requestId,ok:true,data:anonymous,generation:1}));
  await expect(createRendererAuth(bridge).unlinkIdentity(identityId,currentPassword)).rejects.toMatchObject({code:'invalid_request'});
  expect(bridge.calls).toHaveLength(0);
 }
});

test('renderer unlink-identity refuses a reply carrying a grant, a token or a foreign shape',async()=>{
 const grant='5e2c5b7a-2c31-4f6e-9d0a-5e2c5b7a2c31.'+'A'.repeat(43);
 for(const data of [{...anonymous,reauthGrant:grant},{...anonymous,accessToken:'synthetic'},{...anonymous,refreshToken:'synthetic'},
  {...anonymous,identityId:unlinkHandle},{...anonymous,email:'electron@example.test'},{...anonymous,status:'bootstrapping',session:{subjectId:'synthetic',subjectKind:'adult',sessionId:'synthetic',expiresAt:'2026-09-24T00:00:00.000Z'}},
  {items:[apple]},null,undefined,'anonymous',
 ]) await expect(createRendererAuth(wire(reply(data))).unlinkIdentity(unlinkHandle,unlinkPassword)).rejects.toMatchObject({code:'invalid_response'});
 const mismatched=wire(request=>({version:1,requestId:randomUUID(),ok:true,data:anonymous,generation:1}));
 await expect(createRendererAuth(mismatched).unlinkIdentity(unlinkHandle,unlinkPassword)).rejects.toMatchObject({code:'invalid_response'});
 const stale=wire(request=>({version:1,requestId:request.requestId,ok:true,data:anonymous,generation:-1}));
 await expect(createRendererAuth(stale).unlinkIdentity(unlinkHandle,unlinkPassword)).rejects.toMatchObject({code:'cancelled'});
});

test('renderer unlink-identity surfaces the stable refusal codes and needs a bridge',async()=>{
 for(const code of ['last_method_required','identity_not_found','reauth_required','invalid_credentials']) {
  const bridge=wire(request=>({version:1,requestId:request.requestId,ok:false,error:code,retryAfterSeconds:0}));
  await expect(createRendererAuth(bridge).unlinkIdentity(unlinkHandle,unlinkPassword)).rejects.toMatchObject({code});
 }
 for(const error of ['synthetic_server_detail',undefined]) {
  const bridge=wire(request=>({version:1,requestId:request.requestId,ok:false,error}));
  await expect(createRendererAuth(bridge).unlinkIdentity(unlinkHandle,unlinkPassword)).rejects.toMatchObject({code:'unavailable'});
 }
 const untimed=wire(request=>({version:1,requestId:request.requestId,ok:false,error:'last_method_required',retryAfterSeconds:'soon'}));
 await expect(createRendererAuth(untimed).unlinkIdentity(unlinkHandle,unlinkPassword)).rejects.toMatchObject({code:'last_method_required',retryAfterSeconds:0});
 await expect(createRendererAuth(undefined).unlinkIdentity(unlinkHandle,unlinkPassword)).rejects.toMatchObject({code:'unavailable'});
});

test('renderer deletion progress and impact are strict and never return receipt proof',async()=>{
 const impact={subjectId:randomUUID(),families:[],guardianships:[],activeChildDeviceCount:0};
 const progress={deletionId:randomUUID(),expiresAt:new Date(Date.now()+60_000).toISOString(),
  status:{serverDataDeleted:false,providerRevocationPending:true,completedAt:null,lastErrorCode:null}};
 for(const [method,operation,value] of [['deletionImpact','deletion-impact',impact],['deletionStatus','deletion-status',progress]]){
  const bridge=wire(reply(value));expect(await createRendererAuth(bridge)[method]()).toEqual(value);
  expect(bridge.calls[0]).toMatchObject({operation,payload:{}});
  for(const extra of [{receiptSecret:'A'.repeat(43)},{accessToken:'secret'},{subjectId:'invalid'}]){
   await expect(createRendererAuth(wire(reply({...value,...extra})))[method]()).rejects.toMatchObject({code:'invalid_response'});
  }
 }
 expect(await createRendererAuth(wire(reply(null))).deletionStatus()).toBeNull();
});

test('renderer deletion submission and retry adopt only public auth state',async()=>{
 const bridge=wire(reply(anonymous)),auth=createRendererAuth(bridge);
 await auth.submitDeletionWithPassword(unlinkPassword,{kind:'none'});
 expect(bridge.calls[0]).toMatchObject({operation:'submit-deletion',payload:{currentPassword:unlinkPassword,dependencyDisposition:{kind:'none'}}});
 await auth.retryDeletion();expect(bridge.calls[1]).toMatchObject({operation:'retry-deletion',payload:{}});
 expect(auth.getState()).toEqual(anonymous);
 await expect(createRendererAuth(wire(reply({...anonymous,receiptSecret:'secret'}))).retryDeletion()).rejects.toMatchObject({code:'invalid_response'});
});

test('renderer family acceptance sends only the displayed versions and explicit responsibility choices',async()=>{
 const scope={familyId:randomUUID(),ownerSubjectId:randomUUID(),recipientSubjectId:randomUUID(),
  familyVersion:1,membershipVersion:2,ownerMembershipVersion:3,childScopeDigest:'a'.repeat(64),childCount:0};
 const input={expectedFamilyVersion:1,expectedMembershipVersion:2,expectedOwnerMembershipVersion:3,
  expectedChildScopeDigest:scope.childScopeDigest,acceptance:{familyManagement:true,guardianship:true}};
 const {childCount,...receiptScope}=scope;
 const receipt={...receiptScope,acceptanceId:randomUUID(),acceptedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),consumedAt:null};
 const bridge=wire(request=>reply(request.operation==='family-management-preview'?scope:receipt)(request));
 const auth=createRendererAuth(bridge);
 expect(await auth.familyManagementPreview(scope.familyId)).toEqual(scope);
 expect(await auth.acceptFamilyManagement(scope.familyId,input)).toEqual(receipt);
 expect(bridge.calls[1]).toMatchObject({operation:'accept-family-management',payload:{familyId:scope.familyId,input}});
 await expect(auth.acceptFamilyManagement(scope.familyId,{...input,recipientSubjectId:randomUUID()})).rejects.toMatchObject({code:'invalid_request'});
 await expect(createRendererAuth(wire(reply({...scope,accessToken:'secret'}))).familyManagementPreview(scope.familyId)).rejects.toMatchObject({code:'invalid_response'});
 expect(bridge.calls).toHaveLength(2);
});
