import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAuthApiClient,AuthClientError } from './auth-api-client.js';
const providers={emailPassword:{enabled:true},apple:{enabled:false,platforms:['ios']}};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const code=(value:string)=>(error:unknown)=>error instanceof AuthClientError&&error.code===value;
test('production endpoint has one configured prefix and never exposes a generic authenticated URL operation',async()=>{
  const api=createAuthApiClient({environment:'production',apiBaseUrl:'https://api.qiugeapp.com/api/siyue/v1/',fetcher:async(url,options)=>{
    assert.equal(url,'https://api.qiugeapp.com/api/siyue/v1/auth/providers');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
    return json({data:providers});
  }});
  assert.deepEqual(await api.providers(),providers);assert.equal('fetch' in api,false);
  for(const apiBaseUrl of ['https://evil.invalid/v1','https://api.qiugeapp.com/api/cloud/v1','http://api.qiugeapp.com/api/siyue/v1','https://user@api.qiugeapp.com/api/siyue/v1']) {
    assert.throws(()=>createAuthApiClient({environment:'production',apiBaseUrl,fetcher:fetch}),code('invalid_config'));
  }
  assert.throws(()=>createAuthApiClient({environment:'development',apiBaseUrl:'http://192.0.2.1/v1',fetcher:fetch}),code('invalid_config'));
});
test('only allowlisted server error codes escape, not arbitrary message or secret-bearing errors',async()=>{
  for(const raw of ['constructor','__proto__','private-token']) {
    const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>json({error:{code:raw,message:'private-token'}},403)});
    await assert.rejects(api.providers(),error=>code('unavailable')(error)&&!String(error).includes('private-token'));
  }
});
test('deletion dependency and adult-only refusals keep distinct client actions',async()=>{
  for(const [server,status,expected] of [
    ['AUTH_DELETION_DEPENDENCIES',409,'deletion_dependencies'],
    ['AUTH_ADULT_REQUIRED',403,'adult_required'],
  ] as const){
    const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',
      fetcher:async()=>json({error:{code:server,messageKey:`auth.errors.${server}`,retryable:false}},status)});
    await assert.rejects(api.deletionImpact('synthetic-token'),code(expected));
  }
});
test('management acceptance client binds one family and refuses forged responsibility fields',async()=>{
  const familyId=randomUUID(),ownerSubjectId=randomUUID(),recipientSubjectId=randomUUID();
  const preview={familyId,ownerSubjectId,recipientSubjectId,familyVersion:2,
    membershipVersion:1,ownerMembershipVersion:3,childScopeDigest:'c'.repeat(64),childCount:1};
  const input={expectedFamilyVersion:2,expectedMembershipVersion:1,expectedOwnerMembershipVersion:3,
    expectedChildScopeDigest:preview.childScopeDigest,
    acceptance:{familyManagement:true as const,guardianship:true as const}};
  const receipt={acceptanceId:randomUUID(),familyId,ownerSubjectId,recipientSubjectId,
    familyVersion:2,membershipVersion:1,ownerMembershipVersion:3,childScopeDigest:preview.childScopeDigest,
    acceptedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86_400_000).toISOString(),consumedAt:null};
  const calls:Array<{url:string;init:RequestInit}>=[];
  const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',
    fetcher:async(url,init)=>{calls.push({url,init});return url.endsWith('/preview')
      ?json({data:preview}):json({data:receipt},201);}});
  assert.deepEqual(await api.familyManagementPreview('synthetic-token',familyId),preview);
  assert.deepEqual(await api.acceptFamilyManagement('synthetic-token',familyId,input),receipt);
  assert.deepEqual(calls.map(call=>call.url),[
    `http://127.0.0.1:8787/v1/families/${familyId}/management-acceptance/preview`,
    `http://127.0.0.1:8787/v1/families/${familyId}/management-acceptance`]);
  assert.equal(new Headers(calls[1]!.init.headers).get('Authorization'),'Bearer synthetic-token');
  assert.deepEqual(JSON.parse(calls[1]!.init.body as string),input);
  assert.throws(()=>api.acceptFamilyManagement('synthetic-token',familyId,
    {...input,recipientSubjectId} as never),code('invalid_request'));
  assert.throws(()=>api.acceptFamilyManagement('synthetic-token','not-a-uuid',input),code('invalid_request'));
  assert.equal(calls.length,2);
});
test('expired deletion submission receipt never tells the caller to sign in again',async()=>{
  const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',
    fetcher:async()=>json({error:{code:'AUTH_DELETION_RECEIPT_UNRECOVERABLE',
      messageKey:'auth.errors.AUTH_DELETION_RECEIPT_UNRECOVERABLE',retryable:false}},409)});
  await assert.rejects(api.submitDeletion('synthetic-token',{
    reauthGrant:`${randomUUID()}.${'g'.repeat(43)}`,confirmation:true,
    dependencyDisposition:{kind:'none'}},randomUUID()),code('deletion_receipt_unrecoverable'));
});
test('deletion outcome uncertainty and changed request key have distinct actions',async()=>{
  const input={reauthGrant:`${randomUUID()}.${'g'.repeat(43)}`,confirmation:true as const,
    dependencyDisposition:{kind:'none' as const}};
  for(const [server,expected] of [
    ['AUTH_DELETION_OUTCOME_UNKNOWN','deletion_outcome_unknown'],
    ['AUTH_IDEMPOTENCY_CONFLICT','deletion_request_conflict'],
  ] as const){
    const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',
      fetcher:async()=>json({error:{code:server,messageKey:`auth.errors.${server}`,retryable:false}},409)});
    await assert.rejects(api.submitDeletion('synthetic-token',input,randomUUID()),code(expected));
  }
});
test('timeout and cancellation cover transports ignoring abort; streamed response is bounded',async()=>{
  const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',timeoutMs:10,fetcher:()=>new Promise(()=>{})});
  await assert.rejects(api.providers(),code('timeout'));
  const abort=new AbortController();abort.abort();await assert.rejects(api.providers(abort.signal),code('cancelled'));
  const big=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>json({data:'x'.repeat(17_000)})});
  await assert.rejects(big.providers(),code('invalid_response'));
});
test('idempotency, strict password contract, redirect rejection and expected status are enforced',async()=>{
  let count=0;
  const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>{count++;const result=json({data:providers});Object.defineProperty(result,'redirected',{value:true});return result;}});
  assert.throws(()=>api.login({email:'a@example.test',password:'too short',platform:'ios',installationId:'x'}),code('invalid_request'));
  await assert.rejects(api.requestRegistration({email:'a@example.test',locale:'en-US'},'not-uuid'),code('invalid_request'));assert.equal(count,0);
  await assert.rejects(api.providers(),code('invalid_response'));
  const wrong=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>json({data:{challengeId:randomUUID(),requestSecret:'x'.repeat(43),expiresAt:new Date().toISOString(),resendAfterSeconds:60}},200)});
  await assert.rejects(wrong.requestRegistration({email:'a@example.test',locale:'en-US'},randomUUID()),code('invalid_response'));
});

test('Apple requests use fixed routes, strict native payloads and a mandatory stable idempotency key',async()=>{
 const flow={flowId:randomUUID(),transactionSecret:'s'.repeat(43),state:'t'.repeat(43),nonce:'n'.repeat(43),expiresAt:new Date().toISOString()};
 const complete={flowId:flow.flowId,transactionSecret:flow.transactionSecret,state:flow.state,identityToken:'a.b.c',authorizationCode:'synthetic-code'};
 const now=new Date().toISOString(),tokens={tokenType:'Bearer',accessToken:'synthetic-access',accessExpiresAt:now,refreshToken:`${randomUUID()}.${'r'.repeat(43)}`,refreshExpiresAt:now,sessionAbsoluteExpiresAt:now,session:{subjectId:randomUUID(),subjectKind:'adult',sessionId:randomUUID(),expiresAt:now}};
 const calls:Array<{url:string;init:RequestInit}>=[],key=randomUUID();
 const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async(url,init)=>{calls.push({url,init});return json({data:url.endsWith('/start')?flow:tokens});}});
 assert.deepEqual(await api.startApple({purpose:'login',platform:'ios',installationId:'synthetic'}),flow);
 assert.deepEqual(await api.completeApple(complete,key),tokens);assert.deepEqual(await api.completeApple(complete,key),tokens);
 assert.equal(calls[0]!.url,'http://127.0.0.1:8787/v1/auth/apple/start');
 for(const call of calls.slice(1)){assert.equal(call.url,'http://127.0.0.1:8787/v1/auth/apple/complete');assert.equal(new Headers(call.init.headers).get('Idempotency-Key'),key);assert.equal(new Headers(call.init.headers).has('Authorization'),false);assert.deepEqual(JSON.parse(call.init.body as string),complete);}
 assert.throws(()=>api.completeApple(complete,''),code('invalid_request'));
 assert.throws(()=>api.startApple({purpose:'login',platform:'android',installationId:'synthetic'} as never),code('invalid_request'));
 assert.throws(()=>api.completeApple({...complete,user:'forged'} as never,key),code('invalid_request'));assert.equal(calls.length,3);
});

test('Apple errors preserve restart versus in-progress semantics and never retry a code automatically',async()=>{
 const input={flowId:randomUUID(),transactionSecret:'s'.repeat(43),state:'t'.repeat(43),identityToken:'a.b.c',authorizationCode:'synthetic'};
 for(const [status,server,expected] of [[401,'AUTH_APPLE_RESTART_REQUIRED','apple_restart_required'],[409,'AUTH_IN_PROGRESS','busy'],[409,'AUTH_OPERATION_COMPLETED_LOGIN_REQUIRED','operation_completed'],[400,'AUTH_IDEMPOTENCY_KEY_REQUIRED','invalid_request']] as const){
  let calls=0;const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>{calls++;return json({error:{code:server,message:'provider-secret'}},status);}});
  await assert.rejects(api.completeApple(input,randomUUID()),code(expected));assert.equal(calls,1);
 }
});

test('password change uses action-bound reauth and a protected idempotent request',async()=>{
 const key=randomUUID(),grant=`${randomUUID()}.${'g'.repeat(43)}`,token='synthetic-access';
 const calls:Array<{url:string;init:RequestInit}>=[];
 const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async(url,init)=>{
  calls.push({url,init});
  return url.endsWith('/reauth/password')?json({data:{reauthGrant:grant,expiresAt:new Date(Date.now()+60_000).toISOString()}}):new Response(null,{status:204});
 }});
 const issued=await api.reauthPassword(token,'a valid current password',new AbortController().signal);
 assert.equal(issued.reauthGrant,grant);
 await api.changePassword(token,{newPassword:'a different valid password',reauthGrant:grant},key);
 assert.equal(calls[0]!.url,'http://127.0.0.1:8787/v1/auth/reauth/password');
 assert.deepEqual(JSON.parse(calls[0]!.init.body as string),{password:'a valid current password',action:'change-password'});
 for(const call of calls){assert.equal(new Headers(call.init.headers).get('Authorization'),`Bearer ${token}`);}
 assert.equal(calls[1]!.url,'http://127.0.0.1:8787/v1/me/password/change');
 assert.equal(new Headers(calls[1]!.init.headers).get('Idempotency-Key'),key);
 assert.deepEqual(JSON.parse(calls[1]!.init.body as string),{newPassword:'a different valid password',reauthGrant:grant});
 await assert.rejects(api.changePassword(token,{newPassword:'a different valid password',reauthGrant:grant},'bad-key'),code('invalid_request'));
});

test('device-session client bounds cursors and sends scoped revocation proofs only to the fixed API',async()=>{
 const token='synthetic-access',target=randomUUID(),grant=`${randomUUID()}.${'g'.repeat(43)}`;
 const calls:Array<{url:string;init:RequestInit}>=[];
 const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async(url,init)=>{
  calls.push({url,init});return url.endsWith('/reauth/password')?json({data:{reauthGrant:grant,expiresAt:new Date(Date.now()+60_000).toISOString()}}):url.includes('/me/sessions?')?json({data:{items:[],nextCursor:null}}):new Response(null,{status:204});
 }});
 assert.deepEqual(await api.deviceSessions(token),{items:[],nextCursor:null});
 await api.revokeDeviceSession(token,target,grant);await api.revokeAllDeviceSessions(token,grant);
 const reauth=await api.reauthPassword(token,'a valid current password',undefined,'revoke-all-sessions');assert.equal(reauth.reauthGrant,grant);
 assert.equal(calls[0]!.url,'http://127.0.0.1:8787/v1/me/sessions?limit=25');
 assert.equal(calls[1]!.url,`http://127.0.0.1:8787/v1/me/sessions/${target}`);assert.equal(calls[1]!.init.method,'DELETE');
 assert.deepEqual(JSON.parse(calls[1]!.init.body as string),{reauthGrant:grant});
 assert.equal(calls[2]!.url,'http://127.0.0.1:8787/v1/me/sessions/revoke-all');
 assert.deepEqual(JSON.parse(calls[2]!.init.body as string),{reauthGrant:grant});
 assert.deepEqual(JSON.parse(calls[3]!.init.body as string),{password:'a valid current password',action:'revoke-all-sessions'});
 for(const call of calls)assert.equal(new Headers(call.init.headers).get('Authorization'),`Bearer ${token}`);
 assert.throws(()=>api.deviceSessions(token,'not-a-uuid'),code('invalid_request'));
 assert.throws(()=>api.revokeDeviceSession(token,'not-a-uuid'),code('invalid_request'));
});

test('login-method summary uses only the current bearer and rejects unmasked or authority-bearing responses',async()=>{
 const token='synthetic-access',identityId=`email:${randomUUID()}`;
 const items=[{identityId,kind:'email_password',status:'active',emailMask:'p•••@example.test'}];
 const calls:Array<{url:string;init:RequestInit}>=[];
 const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async(url,init)=>{calls.push({url,init});return json({data:{items}});}});
 assert.deepEqual(await api.loginMethods(token),{items});
 assert.equal(calls[0]!.url,'http://127.0.0.1:8787/v1/me/identities');
 assert.equal(calls[0]!.init.method,'GET');assert.equal(calls[0]!.init.body,undefined);
 assert.equal(new Headers(calls[0]!.init.headers).get('Authorization'),`Bearer ${token}`);
 assert.throws(()=>api.loginMethods('bad token'),code('invalid_request'));
 for(const leaked of [
  {...items[0],email:'parent@example.test'},
  {...items[0],emailMask:'parent@example.test'},
  {...items[0],providerSubject:'private-subject'},
  {...items[0],identityId:randomUUID()},
 ]) {
  const invalid=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>json({data:{items:[leaked]}})});
  await assert.rejects(invalid.loginMethods(token),code('invalid_response'));
 }
});

test('Apple reauth reuses the fixed provider routes with the current session bearer and returns only an action grant',async()=>{
 const flow={flowId:randomUUID(),transactionSecret:'s'.repeat(43),state:'t'.repeat(43),nonce:'n'.repeat(43),expiresAt:new Date().toISOString()};
 const grant={reauthGrant:`${randomUUID()}.${'g'.repeat(43)}`,expiresAt:new Date(Date.now()+300_000).toISOString()};
 const complete={flowId:flow.flowId,transactionSecret:flow.transactionSecret,state:flow.state,identityToken:'a.b.c',authorizationCode:'synthetic-code'};
 const token='synthetic-access',key=randomUUID(),calls:Array<{url:string;init:RequestInit}>=[],start={action:'link-identity' as const,platform:'ios' as const,installationId:'synthetic'};
 const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async(url,init)=>{calls.push({url,init});return json({data:url.endsWith('/start')?flow:grant});}});
 assert.deepEqual(await api.startAppleReauth(token,start),flow);
 assert.deepEqual(await api.completeAppleReauth(token,complete,key),grant);
 assert.equal(calls.length,2);
 assert.equal(calls[0]!.url,'http://127.0.0.1:8787/v1/auth/apple/start');
 assert.deepEqual(JSON.parse(calls[0]!.init.body as string),{purpose:'reauth',action:'link-identity',platform:'ios',installationId:'synthetic'});
 assert.equal(new Headers(calls[0]!.init.headers).has('Idempotency-Key'),false);
 assert.equal(calls[1]!.url,'http://127.0.0.1:8787/v1/auth/apple/complete');
 assert.deepEqual(JSON.parse(calls[1]!.init.body as string),complete);
 assert.equal(new Headers(calls[1]!.init.headers).get('Idempotency-Key'),key);
 for(const call of calls){const headers=new Headers(call.init.headers);assert.equal(headers.get('Authorization'),`Bearer ${token}`);assert.equal(headers.get('Accept'),'application/json');assert.equal(call.init.credentials,'omit');assert.equal(call.init.redirect,'error');}
 // The action grant is the entire response: a reauth flow exposes no session token.
 assert.equal(Object.hasOwn(grant,'accessToken'),false);
 assert.equal(Object.hasOwn(grant,'refreshToken'),false);
});

test('Apple reauth rejects a caller-supplied purpose, widened payloads, absent keys, malformed bearers and wrong statuses',async()=>{
 const flow={flowId:randomUUID(),transactionSecret:'s'.repeat(43),state:'t'.repeat(43),nonce:'n'.repeat(43),expiresAt:new Date().toISOString()};
 const grant={reauthGrant:`${randomUUID()}.${'g'.repeat(43)}`,expiresAt:new Date(Date.now()+300_000).toISOString()};
 const complete={flowId:flow.flowId,transactionSecret:flow.transactionSecret,state:flow.state,identityToken:'a.b.c',authorizationCode:'synthetic-code'};
 const start={action:'link-identity' as const,platform:'ios' as const,installationId:'synthetic'};
 let calls=0,status=200;
 const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async(url)=>{calls++;return json({data:url.endsWith('/start')?flow:grant},status);}});
 assert.throws(()=>api.startAppleReauth('synthetic-access',{...start,action:'unlink-identity'} as never),code('invalid_request'));
 assert.throws(()=>api.startAppleReauth('synthetic-access',{...start,purpose:'login'} as never),code('invalid_request'));
 assert.throws(()=>api.startAppleReauth('synthetic-access',{...start,subjectId:randomUUID()} as never),code('invalid_request'));
 for(const token of ['','bad token','a'.repeat(4097)]) assert.throws(()=>api.startAppleReauth(token,start),code('invalid_request'));
 assert.throws(()=>api.completeAppleReauth('synthetic-access',complete,''),code('invalid_request'));
 await assert.rejects(api.completeAppleReauth('synthetic-access',complete,'not-a-uuid'),code('invalid_request'));
 assert.throws(()=>api.completeAppleReauth('synthetic-access',{...complete,user:'forged'} as never,randomUUID()),code('invalid_request'));
 assert.equal(calls,0);
 status=201;
 await assert.rejects(api.startAppleReauth('synthetic-access',start),code('invalid_response'));
 await assert.rejects(api.completeAppleReauth('synthetic-access',complete,randomUUID()),code('invalid_response'));
 const leaking=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>json({error:{code:'AUTH_SESSION_INVALID',message:'synthetic-access'}},401)});
 await assert.rejects(leaking.startAppleReauth('synthetic-access',start),error=>code('reauth_required')(error)&&!String(error).includes('synthetic-access'));
});

test('email link request and confirm use the fixed authenticated routes, bearer, idempotency key and expected 202/204',async()=>{
 const token='synthetic-access',key=randomUUID(),grant=`${randomUUID()}.${'g'.repeat(43)}`;
 const challenge={challengeId:randomUUID(),requestSecret:'c'.repeat(43),expiresAt:new Date(Date.now()+600_000).toISOString(),resendAfterSeconds:60};
 const link={email:'parent@example.test',locale:'en-US' as const,reauthGrant:grant};
 const confirm={challengeId:challenge.challengeId,requestSecret:challenge.requestSecret,code:'123456',newPassword:'a valid new passphrase'};
 const calls:Array<{url:string;init:RequestInit}>=[],headers=(call:{init:RequestInit})=>new Headers(call.init.headers);
 const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async(url,init)=>{calls.push({url,init});return url.endsWith('/request')?json({data:challenge},202):new Response(null,{status:204});}});
 assert.deepEqual(await api.requestEmailLink(token,link,key),challenge);
 assert.equal(await api.confirmEmailLink(token,confirm,key),undefined);
 assert.equal(calls[0]!.url,'http://127.0.0.1:8787/v1/me/email/link/request');
 assert.deepEqual(JSON.parse(calls[0]!.init.body as string),link);
 assert.equal(calls[1]!.url,'http://127.0.0.1:8787/v1/me/email/link/confirm');
 assert.deepEqual(JSON.parse(calls[1]!.init.body as string),confirm);
 for(const call of calls){assert.equal(headers(call).get('Authorization'),`Bearer ${token}`);assert.equal(headers(call).get('Idempotency-Key'),key);assert.equal(call.init.credentials,'omit');}
 assert.throws(()=>api.requestEmailLink(token,{...link,email:'not-an-email'},key),code('invalid_request'));
 assert.throws(()=>api.requestEmailLink(token,{...link,subjectId:randomUUID()} as never,key),code('invalid_request'));
 await assert.rejects(api.requestEmailLink(token,link,'not-a-uuid'),code('invalid_request'));
 assert.throws(()=>api.requestEmailLink('bad token',link,key),code('invalid_request'));
 assert.throws(()=>api.confirmEmailLink(token,{...confirm,code:'12345'},key),code('invalid_request'));
 assert.throws(()=>api.confirmEmailLink(token,{...confirm,newPassword:'too short'},key),code('invalid_request'));
 assert.equal(calls.length,2);
 const wrongStatus=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async(url)=>url.endsWith('/request')?json({data:challenge},200):json({data:{emailLinked:true}},200)});
 await assert.rejects(wrongStatus.requestEmailLink(token,link,key),code('invalid_response'));
 await assert.rejects(wrongStatus.confirmEmailLink(token,confirm,key),code('invalid_response'));
});

test('AUTH_EMAIL_ALREADY_LINKED keeps its own stable code and never surfaces the server message',async()=>{
 for(const operation of ['request','confirm'] as const){
  const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>json({error:{code:'AUTH_EMAIL_ALREADY_LINKED',messageKey:'auth.errors.AUTH_EMAIL_ALREADY_LINKED',retryable:false},meta:{requestId:randomUUID()}},409)});
  const grant=`${randomUUID()}.${'g'.repeat(43)}`;
  const promise=operation==='request'?api.requestEmailLink('synthetic-access',{email:'parent@example.test',locale:'en-US',reauthGrant:grant},randomUUID()):api.confirmEmailLink('synthetic-access',{challengeId:randomUUID(),requestSecret:'c'.repeat(43),code:'123456',newPassword:'a valid new passphrase'},randomUUID());
  await assert.rejects(promise,error=>code('email_already_linked')(error)&&!String(error).includes('parent@example.test'));
 }
});

test('identity unlink sends one strict scoped DELETE, maps both refusals and never repeats itself',async()=>{
 const token='synthetic-access',identityId=`email:${randomUUID()}`,grant=`${randomUUID()}.${'g'.repeat(43)}`;
 const calls:Array<{url:string;init:RequestInit}>=[];
 const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async(url,init)=>{calls.push({url,init});return new Response(null,{status:204});}});
 assert.equal(await api.unlinkIdentity(token,identityId,grant),undefined);
 assert.equal(calls.length,1);
 assert.equal(calls[0]!.url,`http://127.0.0.1:8787/v1/me/identities/${identityId}`);
 assert.equal(calls[0]!.init.method,'DELETE');assert.deepEqual(JSON.parse(calls[0]!.init.body as string),{reauthGrant:grant});
 const headers=new Headers(calls[0]!.init.headers);
 assert.equal(headers.get('Authorization'),`Bearer ${token}`);assert.equal(headers.get('Accept'),'application/json');
 // One single-use grant, no replayable request: the DELETE carries no idempotency key.
 assert.equal(headers.has('Idempotency-Key'),false);
 assert.equal(calls[0]!.init.credentials,'omit');assert.equal(calls[0]!.init.redirect,'error');
 // Only the subject's own `email:` handle is a request this method serves.
 for(const invalid of [randomUUID(),`apple:${randomUUID()}`,'email:not-a-uuid','EMAIL:0F0D1F5E-1A2B-4C3D-8E4F-5A6B7C8D9E0F','']) assert.throws(()=>api.unlinkIdentity(token,invalid,grant),code('invalid_request'));
 assert.throws(()=>api.unlinkIdentity('bad token',identityId,grant),code('invalid_request'));
 assert.throws(()=>api.unlinkIdentity(token,identityId,'not-a-grant'),code('invalid_request'));
 assert.throws(()=>api.unlinkIdentity(token,identityId,`${randomUUID()}.${'g'.repeat(42)}`),code('invalid_request'));
 assert.equal(calls.length,1);
 // Both refusals keep their own code, reach the caller once and never echo the grant.
 for(const [status,server,expected] of [[409,'AUTH_LAST_METHOD_REQUIRED','last_method_required'],[404,'AUTH_IDENTITY_NOT_FOUND','identity_not_found']] as const){
  let attempts=0;
  const refusing=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>{attempts++;return json({error:{code:server,messageKey:`auth.errors.${server}`,retryable:false},meta:{requestId:randomUUID()}},status);}});
  await assert.rejects(refusing.unlinkIdentity(token,identityId,grant),error=>code(expected)(error)&&!String(error).includes(grant));
  assert.equal(attempts,1);
 }
 // A wrong status is a protocol error, and a lost response is reported as such without a repeat.
 const unknownStatus=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>json({data:{removed:true}},200)});
 await assert.rejects(unknownStatus.unlinkIdentity(token,identityId,grant),code('invalid_response'));
 let transport=0;
 const lost=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>{transport++;throw new Error('socket closed');}});
await assert.rejects(lost.unlinkIdentity(token,identityId,grant),code('network'));
 assert.equal(transport,1);
});

test('deletion progress is receipt-only: no session bearer, the proof travels in the body',async()=>{
 const deletionId=randomUUID(),receiptSecret='B'.repeat(43);
 const progress={serverDataDeleted:false,providerRevocationPending:true,completedAt:null,lastErrorCode:null};
 const calls:Array<{url:string;init:RequestInit}>=[],headers=(call:{init:RequestInit})=>new Headers(call.init.headers);
 const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async(url,init)=>{calls.push({url,init});return json({data:progress});}});
 assert.deepEqual(await api.deletionStatus({deletionId,receiptSecret}),progress);
 assert.deepEqual(await api.deletionStatus({deletionId,receiptSecret},new AbortController().signal),progress);
 assert.equal(calls.length,2);
 for(const call of calls){
  assert.equal(call.url,'http://127.0.0.1:8787/v1/account/deletion/status');assert.equal(call.init.method,'POST');
  assert.deepEqual(JSON.parse(call.init.body as string),{deletionId,receiptSecret});
  // The receipt is the whole credential: no session bearer and no replayable key travel with it.
  assert.equal(headers(call).has('Authorization'),false);assert.equal(headers(call).has('Idempotency-Key'),false);
  assert.equal(headers(call).get('Accept'),'application/json');assert.equal(call.init.credentials,'omit');assert.equal(call.init.redirect,'error');
 }
 // A non-opaque secret, a foreign field or a non-uuid job is refused before any request is sent.
 for(const invalid of [{deletionId,receiptSecret:'B'.repeat(42)},{deletionId,receiptSecret:'B'.repeat(42)+'!'},{deletionId:'not-a-uuid',receiptSecret},
  {deletionId,receiptSecret,subjectId:deletionId},{deletionId,receiptSecret,receiptSecretHash:'B'.repeat(43)},{deletionId},{receiptSecret}] as never[]) assert.throws(()=>api.deletionStatus(invalid),code('invalid_request'));
 assert.equal(calls.length,2);
 // Unknown, spent and expired receipts agree on the server; the client reports an unusable proof
 // instead of a retryable outage, and never echoes the secret it was given.
 const refused=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>json({error:{code:'AUTH_DELETION_RECEIPT_INVALID',messageKey:'auth.errors.AUTH_DELETION_RECEIPT_INVALID',retryable:false},meta:{requestId:randomUUID()}},404)});
 await assert.rejects(refused.deletionStatus({deletionId,receiptSecret}),error=>code('challenge_invalid')(error)&&!String(error).includes(receiptSecret));
 // Progress stays minimal and read-only: a widened payload or an unusable code is a protocol error.
 for(const leaked of [{...progress,email:'parent@example.test'},{...progress,accessToken:'synthetic-access'},{...progress,lastErrorCode:'Synthetic'}]) {
  const widened=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>json({data:leaked})});
  await assert.rejects(widened.deletionStatus({deletionId,receiptSecret}),code('invalid_response'));
 }
 const wrongStatus=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>json({data:progress},201)});
 await assert.rejects(wrongStatus.deletionStatus({deletionId,receiptSecret}),code('invalid_response'));
 const oversized=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>json({data:{...progress,lastErrorCode:'x'.repeat(17_000)}})});
 await assert.rejects(oversized.deletionStatus({deletionId,receiptSecret}),code('invalid_response'));
});

test('deletion submission spends one action grant, passes the per-family disposition through and sends the caller key it was given',async()=>{
 const token='synthetic-access',grant=randomUUID()+'.'+'g'.repeat(43),deletionId=randomUUID(),receiptSecret='C'.repeat(43),key=randomUUID();
 const receipt={deletionId,receiptSecret,expiresAt:new Date(Date.now()+30*86_400_000).toISOString()};
 const ownerFamily=randomUUID(),guardedFamily=randomUUID(),recipient=randomUUID();
 const submission={reauthGrant:grant,confirmation:true as const,dependencyDisposition:{kind:'per-family' as const,families:[
  {familyId:ownerFamily,kind:'transfer' as const,recipientSubjectId:recipient},
  {familyId:guardedFamily,kind:'end-family-access' as const}]}};
 const soleFamily={...submission,dependencyDisposition:{kind:'per-family' as const,families:[{familyId:guardedFamily,kind:'end-family-access' as const}]}};
 const noDependency={...submission,dependencyDisposition:{kind:'none' as const}};
 const calls:Array<{url:string;init:RequestInit}>=[],headers=(call:{init:RequestInit})=>new Headers(call.init.headers);
 const api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async(url,init)=>{calls.push({url,init});return json({data:receipt},202);}});
 assert.deepEqual(await api.submitDeletion(token,submission,key),receipt);
 assert.deepEqual(await api.submitDeletion(token,soleFamily,key),receipt);
 assert.deepEqual(await api.submitDeletion(token,noDependency,key),receipt);
 assert.equal(calls.length,3);
 for(const call of calls){
  assert.equal(call.url,'http://127.0.0.1:8787/v1/me/account');assert.equal(call.init.method,'DELETE');
  assert.equal(headers(call).get('Authorization'),'Bearer '+token);
  // One single-use grant plus the caller's own key: repeating a submission whose response was lost
  // carries this same key so the server answers with the job it may already have created.
  assert.equal(headers(call).get('Idempotency-Key'),key);
  assert.equal(call.init.credentials,'omit');assert.equal(call.init.redirect,'error');
 }
 // The nested per-family list reaches the wire verbatim, in the caller's order, with each family
 // keeping its own handling: this client decides nothing about which family gets which choice.
 assert.deepEqual(JSON.parse(calls[0]!.init.body as string),submission);
 assert.deepEqual(JSON.parse(calls[1]!.init.body as string),soleFamily);
 assert.deepEqual(JSON.parse(calls[2]!.init.body as string),noDependency);
 // A self-reported subject, an absent confirmation, an unresolvable transfer target or a malformed
 // bearer never reach the route.
 for(const invalid of [{reauthGrant:grant,dependencyDisposition:{kind:'none'}},{...submission,confirmation:false},{...submission,confirmation:'true'},
  {...submission,reauthGrant:'not-a-grant'},{...submission,subjectId:deletionId},{...submission,sessionId:deletionId},
  // The replaced whole-request variants name no family at all, so a caller cannot send one choice
  // for every family; an empty list, a family settled twice or an unresolvable recipient is refused
  // here, and each entry may carry only the fields its own handling needs.
  {...submission,dependencyDisposition:{kind:'transfer',recipientSubjectId:recipient}},{...submission,dependencyDisposition:{kind:'end-family-access'}},
  {...submission,dependencyDisposition:{kind:'transfer'}},{...submission,dependencyDisposition:{kind:'transfer',recipientSubjectId:'not-a-uuid'}},
  {...submission,dependencyDisposition:{kind:'transfer',recipientSubjectId:randomUUID(),eligible:true}},
  {...submission,dependencyDisposition:{kind:'end-family-access',revokeChildDevices:true}},{...submission,dependencyDisposition:{kind:'delete-everything'}},
  {...submission,dependencyDisposition:{kind:'per-family'}},{...submission,dependencyDisposition:{kind:'per-family',families:[]}},
  {...submission,dependencyDisposition:{kind:'per-family',families:[{familyId:ownerFamily,kind:'end-family-access'},{familyId:ownerFamily,kind:'end-family-access'}]}},
  {...submission,dependencyDisposition:{kind:'per-family',families:[{familyId:ownerFamily,kind:'transfer',recipientSubjectId:'not-a-uuid'}]}},
  {...submission,dependencyDisposition:{kind:'per-family',families:[{familyId:'not-a-uuid',kind:'end-family-access'}]}},
  {...submission,dependencyDisposition:{kind:'per-family',families:[{familyId:ownerFamily,kind:'transfer',recipientSubjectId:recipient,eligible:true}]}}] as never[]) assert.throws(()=>api.submitDeletion(token,invalid,key),code('invalid_request'));
 assert.throws(()=>api.submitDeletion('bad token',submission,key),code('invalid_request'));
 // The key is the caller's own UUID and is never minted here: an absent or empty key is refused
 // while the request is still being built, and a malformed one never reaches the transport.
 assert.throws(()=>api.submitDeletion(token,submission,undefined as never),code('invalid_request'));
 assert.throws(()=>api.submitDeletion(token,submission,''),code('invalid_request'));
 await assert.rejects(api.submitDeletion(token,submission,'not-a-uuid'),code('invalid_request'));
 assert.equal(calls.length,3);
 // Only the exact 202 receipt accepts a submission: a "deleted" 200 or a receipt carrying a
 // credential is refused, and the single-use grant is never echoed back inside an error.
 const wrongStatus=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>json({data:receipt},200)});
 await assert.rejects(wrongStatus.submitDeletion(token,submission,key),code('invalid_response'));
 for(const leaked of [{...receipt,accessToken:'synthetic-access'},{...receipt,subjectId:deletionId},{...receipt,refreshToken:grant}]) {
  const widened=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>json({data:leaked},202)});
  await assert.rejects(widened.submitDeletion(token,submission,key),error=>code('invalid_response')(error)&&!String(error).includes(grant));
 }
 let transport=0;
 const lost=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>{transport++;throw new Error('socket closed');}});
 await assert.rejects(lost.submitDeletion(token,submission,key),code('network'));assert.equal(transport,1);
});
test('registration policy is one public read of the released versions and nothing else',async()=>{
 const policy={enabled:true,terms:{version:'terms-2026-09-25',url:'https://siyue.app/terms'},
   privacy:{version:'privacy-2026-09-25',url:'https://siyue.app/privacy'}};
 const calls:Array<{url:string;init:RequestInit}>=[],api=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',
   fetcher:async(url,init)=>{calls.push({url,init});return json({data:policy});}});
 assert.deepEqual(await api.registrationPolicy(),policy);
 assert.equal(calls[0]!.url,'http://127.0.0.1:8787/v1/auth/registration-policy');assert.equal(calls[0]!.init.method,'GET');
 // No bearer, no idempotency key and no body travel with the read, and no cache answers a later call.
 assert.equal(new Headers(calls[0]!.init.headers).get('Authorization'),null);
 assert.equal(new Headers(calls[0]!.init.headers).get('Idempotency-Key'),null);
 assert.equal(calls[0]!.init.body,undefined);assert.equal(calls[0]!.init.cache,'no-store');
 await api.registrationPolicy();assert.equal(calls.length,2);
 // A disabled or half published answer is refused as a body rather than rendered as a policy.
 for(const leaked of [{enabled:false,terms:policy.terms,privacy:null},{enabled:true,terms:policy.terms,privacy:null},
   {enabled:false,terms:null,privacy:null,termsVersion:policy.terms.version},null]) {
  const widened=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>json({data:leaked})});
  await assert.rejects(widened.registrationPolicy(),code('invalid_response'));
 }
 const missing=createAuthApiClient({environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher:async()=>json({})});
 await assert.rejects(missing.registrationPolicy(),code('invalid_response'));
});
test('a rolled or closed sign-up keeps its own client code instead of reading as an outage',async()=>{
 const confirmInput={challengeId:randomUUID(),requestSecret:'A'.repeat(43),code:'000012',password:'a long synthetic phrase',
   installationId:'test-device',platform:'ios' as const,termsVersion:'terms-2026-09-25',privacyVersion:'privacy-2026-09-25'};
 const apiWith=(fetcher:(url:string,init:RequestInit)=>Promise<Response>)=>createAuthApiClient({environment:'test',
   apiBaseUrl:'http://127.0.0.1:8787/v1',fetcher});
 const responds=(status:number,body:unknown)=>apiWith(async()=>json(body,status));
 for(const [server,status,expected] of [['AUTH_POLICY_CHANGED',409,'policy_changed'],
   ['AUTH_REGISTRATION_UNAVAILABLE',503,'registration_closed']] as const) {
   const api=responds(status,{error:{code:server,messageKey:`auth.errors.${server}`,retryable:false}});
   await assert.rejects(api.register(confirmInput,randomUUID()),code(expected));
 }
 // Every other 5xx stays retryable: an unknown or prototype-shaped code, and an unreadable body.
 for(const body of [{error:{code:'AUTH_TEMPORARILY_UNAVAILABLE',retryable:true}},{error:{code:'constructor'}},
   {error:{code:'__proto__'}},{error:'temporarily_unavailable'},{}]) {
   await assert.rejects(responds(503,body).register(confirmInput,randomUUID()),code('unavailable'));
 }
 await assert.rejects(apiWith(async()=>new Response('<html>synthetic</html>',{status:503})).register(confirmInput,randomUUID()),code('unavailable'));
 await assert.rejects(apiWith(async()=>new Response('x'.repeat(20_000),{status:503,headers:{'Content-Type':'application/json'}}))
   .register(confirmInput,randomUUID()),code('unavailable'));
});
