import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createEmailEntry,type EmailEntryActions} from './email-entry.js';
import {AuthClientError} from './auth-api-client.js';
const password='Syn-新密码-🌙7';
function fixture(overrides:Partial<EmailEntryActions>={}) {
 let now=1000,requests=0,confirms=0;
 const actions:EmailEntryActions={login:async()=>{},requestReset:async()=>{requests++;return {challengeId:randomUUID(),requestSecret:'x'.repeat(43),expiresAt:new Date(now+600000).toISOString(),resendAfterSeconds:60};},confirmReset:async()=>{confirms++;},...overrides};
 const flow=createEmailEntry(actions,randomUUID,()=>now);
 flow.set('email','synthetic@example.test');
 return {flow,advance:(ms:number)=>{now+=ms;},requests:()=>requests,confirms:()=>confirms};
}
test('reset validates matching passwords/code, bounds resend, clears secrets and never signs in',async()=>{
 let logins=0;const fx=fixture({login:async()=>{logins++;}}),{flow}=fx;
 flow.navigate('reset-request');await flow.submit('en-US');assert.equal(flow.getState().mode,'reset-confirm');
 await flow.resend('en-US');assert.equal(fx.requests(),1);
 flow.set('password',password);flow.set('repeatPassword','different password');flow.set('code','123456');await flow.submit('en-US');
 assert.equal(flow.getState().error,'password_mismatch');assert.equal(fx.confirms(),0);
 flow.set('repeatPassword',password);flow.set('code','abcdef');await flow.submit('en-US');assert.equal(flow.getState().error,'code_invalid');
 flow.set('code','123456');await flow.submit('en-US');assert.equal(flow.getState().mode,'reset-complete');
 assert.equal(fx.confirms(),1);assert.equal(logins,0);assert.equal(flow.getState().password,'');assert.equal(flow.getState().code,'');
});
test('unknown POST result freezes intent and retries identical idempotency key and payload',async()=>{
 const seen:Array<{input:unknown;key:string}>=[];
 const {flow}=fixture({requestReset:async(input,key)=>{seen.push({input,key});if(seen.length===1)throw new AuthClientError('network');return {challengeId:randomUUID(),requestSecret:'x'.repeat(43),expiresAt:new Date(601000).toISOString(),resendAfterSeconds:60};}});
 flow.navigate('reset-request');await flow.submit('zh-CN');assert.equal(flow.getState().retryPending,true);
 flow.set('email','other@example.test');assert.equal(flow.getState().email,'synthetic@example.test');
 await flow.submit('en-US');assert.deepEqual(seen[0],seen[1]);assert.equal(flow.getState().retryPending,false);
});
test('rate limited login respects Retry-After and a disposed screen drops late reset results',async()=>{
 let calls=0;const fx=fixture({login:async()=>{calls++;throw new AuthClientError('rate_limited',10);}});
 fx.flow.set('password',password);await fx.flow.submit('en-US');await fx.flow.submit('en-US');assert.equal(calls,1);
 fx.advance(10000);await fx.flow.submit('en-US');assert.equal(calls,2);
 let release!:(value:Awaited<ReturnType<EmailEntryActions['requestReset']>>)=>void;
 const {flow}=fixture({requestReset:()=>new Promise(resolve=>{release=resolve;})});flow.navigate('reset-request');const pending=flow.submit('en-US');
 flow.dispose();release({challengeId:randomUUID(),requestSecret:'x'.repeat(43),expiresAt:new Date(601000).toISOString(),resendAfterSeconds:60});await pending;
 assert.equal(flow.getState().email,'');assert.equal(flow.getState().mode,'reset-request');
});
