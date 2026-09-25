import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,exportPKCS8,jwtVerify} from 'jose';
import {appleRevokeErrorSchema,createAppleTokenRevocation} from './revocation.js';

const signing=await generateKeyPair('ES256',{extractable:true});
const config={teamId:'TEAM123456',keyId:'KEY1234567',clientId:'app.siyue.mobile',privateKey:await exportPKCS8(signing.privateKey)};
const now=new Date('2026-09-22T00:00:00Z'),seconds=+now/1000,refresh='synthetic-apple-refresh-token';
const json=(value:unknown,status:number)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});

test('revocation posts the documented Apple form once and never exposes the provider reply',async()=>{
 let calls=0;
 const revoke=await createAppleTokenRevocation(config,{now:()=>now,fetcher:async(url,init)=>{
  calls++;
  assert.equal(url,'https://appleid.apple.com/auth/revoke');
  assert.equal(init?.method,'POST');
  assert.equal(init?.redirect,'error');
  assert.equal(init?.credentials,'omit');
  assert.match(String(new Headers(init?.headers).get('content-type')),/^application\/x-www-form-urlencoded/);
  const form=new URLSearchParams(String(init?.body));
  // Exactly Apple's documented revoke body: no grant_type, no authorization code, no redirect_uri.
  assert.deepEqual([...form.keys()].sort(),['client_id','client_secret','token','token_type_hint']);
  assert.equal(form.get('client_id'),config.clientId);
  assert.equal(form.get('token'),refresh);
  assert.equal(form.get('token_type_hint'),'refresh_token');
  const claims=await jwtVerify(form.get('client_secret')!,signing.publicKey,{algorithms:['ES256'],issuer:config.teamId,
   subject:config.clientId,audience:'https://appleid.apple.com',currentDate:now});
  assert.equal(claims.protectedHeader.kid,config.keyId);
  assert.equal(claims.payload.exp,seconds+300);
  // Apple's documented success answer for a revoked or already invalid token: 200 without a body.
  return new Response(null,{status:200});
 }});
 const result=await revoke({refreshToken:refresh});
 assert.deepEqual(result,{outcome:'revoked'});
 assert.equal(calls,1);
 assert.equal(JSON.stringify(result).includes(refresh),false);
 assert.equal(JSON.stringify(result).includes(config.clientId),false);
});

test('only a documented Apple error code is classified and no provider body is echoed',async()=>{
 for(const error of appleRevokeErrorSchema.options){
  const revoke=await createAppleTokenRevocation(config,{now:()=>now,fetcher:async()=>json({error},400)});
  assert.deepEqual(await revoke({refreshToken:refresh}),{outcome:'rejected',error});
 }
 const marker='synthetic-provider-body-that-must-not-leak';
 const cases:Array<[string,()=>Response]>=[
  ['undocumented code',()=>json({error:'synthetic_undocumented_code',detail:marker},400)],
  ['empty object',()=>json({},400)],
  ['null error code',()=>json({error:null},400)],
  ['unparseable json body',()=>new Response(marker,{status:400,headers:{'Content-Type':'application/json'}})],
  ['non-json content type',()=>new Response(JSON.stringify({error:'invalid_grant'}),{status:400,headers:{'Content-Type':'text/html'}})],
  ['oversized error body',()=>json({error:'invalid_grant',padding:'x'.repeat(9*1024)},400)],
 ];
 for(const [label,response] of cases){
  let calls=0;
  const revoke=await createAppleTokenRevocation(config,{now:()=>now,fetcher:async()=>{calls++;return response();}});
  const result=await revoke({refreshToken:refresh});
  assert.deepEqual(result,{outcome:'unavailable'},label);
  assert.equal(JSON.stringify(result).includes(marker),false,label);
  assert.equal(calls,1,label);
 }
});

test('unavailable providers, redirects and network failures stay a single attempt',async()=>{
 for(const status of [429,500,503]){
  let calls=0;
  const revoke=await createAppleTokenRevocation(config,{now:()=>now,fetcher:async()=>{calls++;return json({error:'invalid_client'},status);}});
  assert.deepEqual(await revoke({refreshToken:refresh}),{outcome:'unavailable'},String(status));
  assert.equal(calls,1,String(status));
 }
 const redirected=new Response(null,{status:200});
 Object.defineProperty(redirected,'redirected',{value:true});
 let redirects=0;
 const followed=await createAppleTokenRevocation(config,{now:()=>now,fetcher:async()=>{redirects++;return redirected;}});
 assert.deepEqual(await followed({refreshToken:refresh}),{outcome:'unavailable'});
 assert.equal(redirects,1);
 let failures=0;
 const down=await createAppleTokenRevocation(config,{now:()=>now,fetcher:async()=>{failures++;throw new Error('synthetic network failure');}});
 assert.deepEqual(await down({refreshToken:refresh}),{outcome:'unavailable'});
 assert.equal(failures,1);
});

test('a hanging provider stream is bounded by the deadline instead of holding the outbox',async()=>{
 const hanging=[async()=>new Promise<Response>(()=>{}),
  async()=>new Response(new ReadableStream({start(){}}),{status:400,headers:{'Content-Type':'application/json'}})];
 for(const fetcher of hanging){
  let calls=0;
  const revoke=await createAppleTokenRevocation(config,{now:()=>now,timeoutMs:10,fetcher:async()=>{calls++;return fetcher();}});
  assert.deepEqual(await revoke({refreshToken:refresh}),{outcome:'unavailable'});
  assert.equal(calls,1);
 }
});

test('malformed configuration or token stops before any external call',async()=>{
 for(const change of [{privateKey:'not-a-key'},{teamId:'TOOLONGTEAM'},{keyId:'key1234567'},{clientId:'https://arbitrary.invalid'}])
  await assert.rejects(createAppleTokenRevocation({...config,...change}),/invalid_apple_revocation_config/);
 await assert.rejects(createAppleTokenRevocation(config,{timeoutMs:60_000}),/invalid_apple_revocation_config/);
 let calls=0;
 const revoke=await createAppleTokenRevocation(config,{now:()=>now,fetcher:async()=>{calls++;return new Response(null,{status:200});}});
 for(const input of [{refreshToken:''},{refreshToken:'x'.repeat(8193)},{refreshToken:123},{}])
  await assert.rejects(revoke(input as {refreshToken:string}),/invalid_apple_revocation_input/);
 assert.equal(calls,0);
});
