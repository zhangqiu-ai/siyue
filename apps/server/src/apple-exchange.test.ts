import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,exportPKCS8,exportJWK,createLocalJWKSet,jwtVerify,SignJWT} from 'jose';
import {createAppleCodeExchange} from './identities/apple/exchange.js';
import {createAppleIdentityVerifier} from './identities/apple/identity.js';
import {digest} from './adapters/crypto/auth-crypto.js';
const signing=await generateKeyPair('ES256',{extractable:true}),apple=await generateKeyPair('RS256');
const config={teamId:'TEAM123456',keyId:'KEY1234567',clientId:'app.siyue.mobile',privateKey:await exportPKCS8(signing.privateKey)};
const now=new Date('2026-09-22T00:00:00Z'),seconds=+now/1000,nonce='N'.repeat(43),input={authorizationCode:'synthetic-code',expectedNonceHash:digest(nonce),expectedSubject:'apple-sub'};
const verify=createAppleIdentityVerifier(config.clientId,createLocalJWKSet({keys:[{...await exportJWK(apple.publicKey),alg:'RS256',kid:'apple-test'}]}));
const identity=async(sub='apple-sub',tokenNonce=nonce)=>new SignJWT({nonce:tokenNonce}).setProtectedHeader({alg:'RS256',kid:'apple-test'}).setIssuer('https://appleid.apple.com').setAudience(config.clientId).setSubject(sub).setIssuedAt(seconds).setExpirationTime(seconds+300).sign(apple.privateKey);
const body=async(sub='apple-sub',tokenNonce=nonce)=>({id_token:await identity(sub,tokenNonce),refresh_token:'synthetic-apple-refresh',access_token:'synthetic-apple-access',token_type:'Bearer',expires_in:3600});
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
test('native exchange uses fixed endpoint and ES256 client secret, re-verifies identity and keeps provider access internal',async()=>{
 let calls=0;const exchange=await createAppleCodeExchange(config,{now:()=>now,verify,fetcher:async(url,init)=>{
  calls++;assert.equal(url,'https://appleid.apple.com/auth/token');assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');
  const form=new URLSearchParams(String(init?.body));assert.deepEqual([...form.keys()].sort(),['client_id','client_secret','code','grant_type']);
  assert.equal(form.get('grant_type'),'authorization_code');assert.equal(form.get('client_id'),config.clientId);assert.equal(form.get('code'),input.authorizationCode);
  const claims=await jwtVerify(form.get('client_secret')!,signing.publicKey,{algorithms:['ES256'],issuer:config.teamId,subject:config.clientId,audience:'https://appleid.apple.com',currentDate:now});
  assert.equal(claims.protectedHeader.kid,config.keyId);assert.equal(claims.payload.exp,seconds+300);
  return response(await body());
 }});
 assert.deepEqual(await exchange(input),{identity:{provider:'apple',subject:'apple-sub',clientId:config.clientId},refreshToken:'synthetic-apple-refresh'});assert.equal(calls,1);
});
test('different subject or nonce after exchange cannot issue a session',async()=>{
 for(const args of [['other-sub',nonce],['apple-sub','other-nonce']]){
  const exchange=await createAppleCodeExchange(config,{now:()=>now,verify,fetcher:async()=>response(await body(...args))});
  await assert.rejects(exchange(input),{reason:'invalid_identity'});
 }
});
test('failed or ambiguous exchange never retries and never exposes provider error bodies',async()=>{
 for(const status of [400,401,429,500]){
  let calls=0;const exchange=await createAppleCodeExchange(config,{now:()=>now,verify,fetcher:async()=>{calls++;return response({error:'secret-bearing-provider-body'},status);}});
  await assert.rejects(exchange(input),error=>error instanceof Error&&error.message==='apple_authorization_restart_required'&&!error.message.includes('secret-bearing'));assert.equal(calls,1);
 }
});
test('invalid, oversized and redirected responses cannot return credentials',async()=>{
 const good=await body();const redirected=response(good);Object.defineProperty(redirected,'redirected',{value:true});
 for(const result of [response({...good,refresh_token:''}),response({...good,token_type:'Other'}),response({data:'x'.repeat(33*1024)}),new Response('not-json'),redirected]){
  const exchange=await createAppleCodeExchange(config,{now:()=>now,verify,fetcher:async()=>result});await assert.rejects(exchange(input),{reason:'unknown'});
 }
});
test('deadline bounds ignored abort and hanging response streams without retry',async()=>{
 for(const fetcher of [async()=>new Promise<Response>(()=>{}),async()=>new Response(new ReadableStream({start(){}}),{headers:{'Content-Type':'application/json'}})]){
  let calls=0;const exchange=await createAppleCodeExchange(config,{now:()=>now,verify,timeoutMs:10,fetcher:async(...args)=>{calls++;return fetcher(...args);}});
  await assert.rejects(exchange(input),{reason:'unknown'});assert.equal(calls,1);
 }
});
test('malformed configuration and request stop before external calls',async()=>{
 await assert.rejects(createAppleCodeExchange({...config,privateKey:'not-a-key'}),/invalid_apple_exchange_config/);
 let calls=0;const exchange=await createAppleCodeExchange(config,{now:()=>now,verify,fetcher:async()=>{calls++;return response({});}});
 for(const change of [{authorizationCode:''},{authorizationCode:'x'.repeat(2049)},{expectedNonceHash:'bad'},{expectedSubject:''}])await assert.rejects(exchange({...input,...change}),/invalid_apple_exchange_input/);
 assert.equal(calls,0);
});
