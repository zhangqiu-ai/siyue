import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,createLocalJWKSet,SignJWT} from 'jose';
import {createAppleIdentityVerifier} from './identities/apple/identity.js';
import {digest} from './adapters/crypto/auth-crypto.js';
const key=await generateKeyPair('RS256'),other=await generateKeyPair('RS256');
const now=new Date('2026-09-22T00:00:00Z'),seconds=+now/1000,nonce='N'.repeat(43),client='app.siyue.mobile';
const verify=createAppleIdentityVerifier(client,createLocalJWKSet({keys:[{...await exportJWK(key.publicKey),kid:'test-key',alg:'RS256'}]}));
const sign=(claims:Record<string,unknown>={},header:Record<string,unknown>={},privateKey=key.privateKey)=>new SignJWT({iss:'https://appleid.apple.com',aud:client,sub:'apple-stable-sub',iat:seconds,exp:seconds+300,nonce,...claims}).setProtectedHeader({alg:'RS256',kid:'test-key',...header}).sign(privateKey);
const rejected={code:'invalid_identity'};
test('verified Apple subject never comes from profile/email or client assertions',async()=>{
 assert.deepEqual(await verify(await sign({email:'relay@example.test',email_verified:'true',is_private_email:'true'}),digest(nonce),now),{provider:'apple',subject:'apple-stable-sub',clientId:client});
});
test('rejects wrong issuer, audience, nonce, signature and missing required claims',async()=>{
 for(const claims of [{iss:'https://other.invalid'},{aud:'another.app'},{aud:[client,'another.app']},{nonce:'wrong'},{nonce:undefined},{sub:undefined},{iat:undefined},{exp:undefined},{sub:''},{sub:'bad subject'}])await assert.rejects(verify(await sign(claims),digest(nonce),now),rejected);
 await assert.rejects(verify(await sign({}, {},other.privateKey),digest(nonce),now),rejected);
});
test('enforces time bounds and integer claims, including future iat and expired tokens',async()=>{
 for(const claims of [{exp:seconds-61},{iat:seconds+61},{iat:seconds-661},{iat:seconds+.5},{exp:seconds+.5},{exp:seconds-1,iat:seconds}])await assert.rejects(verify(await sign(claims),digest(nonce),now),rejected);
 await verify(await sign({exp:seconds-59,iat:seconds-100}),digest(nonce),now);
});
test('refuses header-directed keys and non-RS256 algorithms before key resolution',async()=>{
 let calls=0;const noKeys=createAppleIdentityVerifier(client,async()=>{calls++;throw Error('must not fetch');});
 for(const header of [{jku:'https://other.invalid/keys'},{x5u:'https://other.invalid/cert'},{jwk:{}},{kid:''}])await assert.rejects(noKeys(await sign({},header),digest(nonce),now),rejected);
 const ec=await generateKeyPair('ES256');const token=await new SignJWT({}).setProtectedHeader({alg:'ES256',kid:'test-key'}).sign(ec.privateKey);
 await assert.rejects(noKeys(token,digest(nonce),now),rejected);assert.equal(calls,0);
});
test('malformed inputs stay bounded and provider outages are distinct from invalid identity',async()=>{
 for(const token of ['', 'not.jwt', 'x'.repeat(16*1024+1)])await assert.rejects(verify(token,digest(nonce),now),rejected);
 await assert.rejects(verify(await sign(),'bad-hash',now),rejected);
 const unavailable=createAppleIdentityVerifier(client,async()=>{throw Error('synthetic provider down');});
 await assert.rejects(unavailable(await sign(),digest(nonce),now),{code:'provider_unavailable'});
 assert.throws(()=>createAppleIdentityVerifier('https://arbitrary.invalid'),/invalid_apple_client/);
});
