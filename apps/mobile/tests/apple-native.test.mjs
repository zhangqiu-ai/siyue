import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNativeAppleAuthorizer} from '../src/account/apple-native-adapter.ts';
const input=()=>({nonce:'n'.repeat(43),state:'s'.repeat(43),signal:new AbortController().signal});
const credential={identityToken:'a.b.c',authorizationCode:'synthetic',state:'s'.repeat(43),user:'untrusted-user',email:'hidden@example.test'};
test('native bridge passes raw nonce/state and only returns credentials and optional bounded name',async()=>{
 let received;const authorize=createNativeAppleAuthorizer({available:async()=>true,signIn:async value=>{received=value;return {...credential,fullName:{givenName:'Synthetic',familyName:null,nickname:'',unexpected:'ignored'}};}});
 assert.deepEqual(await authorize(input()),{identityToken:'a.b.c',authorizationCode:'synthetic',state:credential.state,fullName:{givenName:'Synthetic'}});
 assert.deepEqual(received,{nonce:'n'.repeat(43),state:credential.state});
 const again=createNativeAppleAuthorizer({available:async()=>true,signIn:async()=>({...credential,fullName:null})});
 assert.equal('fullName' in await again(input()),false);
});
test('native cancellation is distinct, missing tokens or wrong state require authorization restart',async()=>{
 for(const [patch,code] of [[{identityToken:null},'apple_restart_required'],[{authorizationCode:null},'apple_restart_required'],[{state:null},'apple_restart_required'],[{state:'wrong'},'apple_restart_required']]){
  await assert.rejects(createNativeAppleAuthorizer({available:async()=>true,signIn:async()=>({...credential,...patch})})(input()),{code});
 }
 for(const [native,expected] of [['ERR_REQUEST_CANCELED','cancelled'],['synthetic-private-error','unavailable']]){
  await assert.rejects(createNativeAppleAuthorizer({available:async()=>true,signIn:async()=>{throw {code:native,message:'secret'};}})(input()),{code:expected});
 }
});
test('unsupported device and aborted or late SDK results never escape the bridge',async()=>{
 let calls=0;const controller=new AbortController();
 const unavailable=createNativeAppleAuthorizer({available:async()=>false,signIn:async()=>{calls++;return credential;}});
 await assert.rejects(unavailable(input()),{code:'unavailable'});assert.equal(calls,0);
 const late=createNativeAppleAuthorizer({available:async()=>true,signIn:async()=>{controller.abort();return credential;}});
 await assert.rejects(late({...input(),signal:controller.signal}),{code:'cancelled'});
 await assert.rejects(late({...input(),signal:controller.signal}),{code:'cancelled'});
});
