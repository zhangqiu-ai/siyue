import test from 'node:test';
import assert from 'node:assert/strict';
import {resumeAccountAuth} from '../src/account/foreground-auth.ts';

test('foreground leaves ongoing auth alone and drains anonymous logout without replacing local workspace',async()=>{
 for(const status of ['authenticating','logging-out','bootstrapping','refreshing','anonymous','secure-storage-unavailable','service-unavailable','reauth-required']){
  const calls=[];
  await resumeAccountAuth({getState:()=>({status}),bootstrap:async()=>calls.push('bootstrap'),session:async()=>calls.push('session'),drainRevocations:async()=>calls.push('drain')});
  assert.deepEqual(calls,status==='anonymous'?['drain']:['secure-storage-unavailable','service-unavailable','reauth-required'].includes(status)?['bootstrap']:[],status);
 }
});
