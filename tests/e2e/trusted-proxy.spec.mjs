import {test,expect} from 'playwright/test';
import {randomBytes} from 'node:crypto';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';
import {createAppleRequestGate} from '../../apps/server/dist/identities/apple/request-gate.js';
let db;
test.beforeAll(async()=>{db=await startPostgresFixture();});
test.afterAll(async()=>{await db?.stop();});
for(const [name,cidrs,chain,separate] of [
 ['default denies forwarded IP spoofing',[],false,false],
 ['untrusted socket ignores forwarded IPs',['10.0.0.0/8'],false,false],
 ['explicit loopback proxy supplies distinct client IPs',['127.0.0.1/32'],false,true],
 ['first untrusted hop fences attacker-controlled chain prefixes',['127.0.0.1/32'],true,false],
])test(name,async({request})=>{
 const gate=createAppleRequestGate(db.app,randomBytes(32));let starts=0;
 // Exercise production runtime and admission gate. A minimal start service isolates
 // proxy interpretation from Apple exchange; no provider or external network is used.
 const app=createRuntimeApp(db.app,db.identity,{trustedProxyCidrs:cidrs,apple:{gate,service:{start:async()=>{starts++;return {accepted:true};}}}});
 try{
  const base=await app.listen({port:0,host:'127.0.0.1'}),statuses=[];
  if(cidrs.includes('127.0.0.1/32')){
   const malformed=await request.post(`${base}/v1/auth/apple/start`,{headers:{'x-forwarded-for':'unknown'},data:{purpose:'login',platform:'ios',installationId:'synthetic'}});
   expect(malformed.status()).toBe(400);expect(starts).toBe(0);
  }
  for(let i=1;i<=12;i++){
   const response=await request.post(`${base}/v1/auth/apple/start`,{
    headers:{'x-forwarded-for':chain?`192.0.2.${i}, 198.51.100.55`:`192.0.2.${i}`},
    data:{purpose:'login',platform:'ios',installationId:'synthetic-proxy-test'},
   });
   statuses.push(response.status());
   if(response.status()===429){expect((await response.json()).error.code).toBe('AUTH_RATE_LIMITED');expect(response.headers()['retry-after']).toBe('60');}
  }
  expect(statuses.filter(status=>status===200)).toHaveLength(separate?12:10);
  expect(statuses.filter(status=>status===429)).toHaveLength(separate?0:2);
  expect(starts).toBe(separate?12:10);
 }finally{await app.close();}
});
