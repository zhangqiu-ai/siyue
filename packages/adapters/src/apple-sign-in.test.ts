import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {SessionTokens} from '@siyue/contracts';
import {createAuthController} from './auth-controller.js';
import {AuthClientError,type AuthApiClient} from './auth-api-client.js';
const tokens=():SessionTokens=>{const expiresAt=new Date(Date.now()+60000).toISOString();return {tokenType:'Bearer',accessToken:'synthetic',accessExpiresAt:expiresAt,refreshToken:`${randomUUID()}.${'r'.repeat(43)}`,refreshExpiresAt:expiresAt,sessionAbsoluteExpiresAt:expiresAt,session:{subjectId:randomUUID(),subjectKind:'adult',sessionId:randomUUID(),expiresAt}};};
function fixture(){
 let raw:string|null=null,complete=0,starts=0;const issued=tokens(),requests:unknown[]=[],revoked:string[]=[];
 const flow={flowId:randomUUID(),transactionSecret:'s'.repeat(43),nonce:'n'.repeat(43),state:'t'.repeat(43),expiresAt:new Date(Date.now()+300000).toISOString()};
 const api={endpoint:{environment:'test',apiBaseUrl:'http://127.0.0.1:8787/v1'},startApple:async()=>{starts++;return flow;},completeApple:async(input:unknown,key:string)=>{complete++;requests.push({input,key});return issued;},logout:async(token:string)=>{revoked.push(token);}} as unknown as AuthApiClient;
 const host=createAuthController({api,vault:{read:async()=>raw,write:async value=>{raw=value;}},newId:randomUUID});
 const authorize=async({state}:{state:string})=>({state,identityToken:'a.b.c',authorizationCode:'synthetic'});
 return {host,api,issued,requests,revoked,authorize,raw:()=>raw,counts:()=>({complete,starts})};
}
test('native cancellation and wrong state never submit complete or persist an active session',async()=>{
 for(const mode of ['cancel','state']){
  const f=fixture();await f.host.bootstrap();
  await assert.rejects(f.host.loginApple(async input=>{if(mode==='cancel')throw new AuthClientError('cancelled');return {...await f.authorize(input),state:'wrong'};}),{code:mode==='cancel'?'cancelled':'apple_restart_required'});
  assert.equal(f.counts().complete,0);assert.equal(JSON.parse(f.raw()!).active,null);assert.equal(f.host.canRetryApple(),false);await f.host.dispose();
 }
});
test('uncertain completion retries the same native authorization and exact key without persisting Apple secrets',async()=>{
 const f=fixture(),original=f.api.completeApple;let fail=true,native=0;
 f.api.completeApple=async(...args)=>{const result=await original(...args);if(fail){fail=false;throw new AuthClientError('network');}return result;};
 await f.host.bootstrap();await assert.rejects(f.host.loginApple(async input=>{native++;return f.authorize(input);}),{code:'network'});
 assert.equal(f.host.canRetryApple(),true);await f.host.retryApple();assert.equal(native,1);assert.deepEqual(f.requests[0],f.requests[1]);
 assert.equal(f.host.getState().status,'authenticated');assert.equal(f.host.canRetryApple(),false);
 assert.equal(f.raw()!.includes('authorizationCode'),false);assert.equal(f.raw()!.includes('identityToken'),false);await f.host.dispose();
});
test('a late SDK result after logout cannot submit a completion',async()=>{
 const f=fixture();await f.host.bootstrap();let release!:(value:Awaited<ReturnType<typeof f.authorize>>)=>void,entered!:()=>void;
 const seen=new Promise<void>(resolve=>{entered=resolve;}),held=new Promise<Awaited<ReturnType<typeof f.authorize>>>(resolve=>{release=resolve;});
 const signing=f.host.loginApple(async()=>{entered();return held;});await seen;await f.host.logout();release(await f.authorize({state:'t'.repeat(43)}));
 await assert.rejects(signing,{code:'cancelled'});assert.equal(f.counts().complete,0);assert.equal(f.host.getState().status,'anonymous');await f.host.dispose();
});
test('a late issued session after logout is revoked, never adopted',async()=>{
 const f=fixture();await f.host.bootstrap();let release!:(value:SessionTokens)=>void,entered!:()=>void;
 const seen=new Promise<void>(resolve=>{entered=resolve;});f.api.completeApple=async()=>{entered();return new Promise(resolve=>{release=resolve;});};
 const signing=f.host.loginApple(f.authorize);await seen;await f.host.logout();release(f.issued);
 await assert.rejects(signing,{code:'cancelled'});assert.deepEqual(f.revoked,[f.issued.refreshToken]);assert.equal(JSON.parse(f.raw()!).active,null);await f.host.dispose();
});
test('another account operation clears an uncertain Apple attempt',async()=>{
 const f=fixture();f.api.completeApple=async()=>{throw new AuthClientError('timeout');};await f.host.bootstrap();
 await assert.rejects(f.host.loginApple(f.authorize),{code:'timeout'});assert.equal(f.host.canRetryApple(),true);
 await f.host.logout();assert.equal(f.host.canRetryApple(),false);await assert.rejects(f.host.retryApple(),{code:'apple_restart_required'});await f.host.dispose();
});

test('Apple entry refuses to replace an already active account',async()=>{
 const f=fixture();await f.host.bootstrap();await f.host.loginApple(f.authorize);
 const before=f.host.getState();let native=0;
 await assert.rejects(f.host.loginApple(async input=>{native++;return f.authorize(input);}),{code:'busy'});
 assert.equal(native,0);assert.deepEqual(f.host.getState(),before);assert.equal(f.revoked.length,0);await f.host.dispose();
});
