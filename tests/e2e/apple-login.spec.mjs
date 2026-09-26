import {createAuthController} from '../../packages/adapters/dist/auth-controller.js';
import {createAuthApiClient} from '../../packages/adapters/dist/auth-api-client.js';
import {AppleIdentityError} from '../../apps/server/dist/identities/apple/identity.js';
import {test,expect} from 'playwright/test';
import {randomBytes,randomUUID} from 'node:crypto';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';
import {createAppleRequestGate} from '../../apps/server/dist/identities/apple/request-gate.js';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createAuthFixture} from '../../apps/server/tests/integration/auth-fixture.mjs';
import {createAppleFlowStorage} from '../../apps/server/dist/identities/apple/flow-storage.js';
import {createAppleIdentityStorage} from '../../apps/server/dist/identities/apple/identity-storage.js';
import {createAppleLoginPreparation} from '../../apps/server/dist/identities/apple/prepare-login.js';
import {createAppleLoginService} from '../../apps/server/dist/identities/apple/login-service.js';

// Actual runtime routes with isolated database and synthetic provider adapters.
// Provider identity/exchange are synthetic; real JWT verification has separate tests.
test('Apple completion over HTTP recovers one persisted session, then refuses consumed credentials',async({request})=>{
 const db=await startPostgresFixture();let app;
 try{
  const auth=await createAuthFixture(db),clientId='app.siyue.mobile';
  const identity={provider:'apple',subject:'synthetic-http-apple',clientId};let exchanges=0,verificationFailure=false;
  const storage=createAppleFlowStorage(db.app,auth.cipher,clientId,auth.clock);
  const preparation=createAppleLoginPreparation({storage,requestPepper:randomBytes(32),clock:auth.clock,verify:async()=>{if(verificationFailure)throw new AppleIdentityError('provider_unavailable');return identity;},
   exchange:async()=>{exchanges++;return {identity,refreshToken:'synthetic-provider-secret'};}});
  const service=createAppleLoginService({preparation,storage,identities:createAppleIdentityStorage(auth.cipher,'synthetic-team',auth.clock),sessions:auth.service});
  app=createRuntimeApp(db.app,db.identity,{sessions:auth.service,apple:{service,gate:createAppleRequestGate(db.app,randomBytes(32),auth.clock)}});
  const base=await app.listen({port:0,host:'127.0.0.1'});
  const start=await request.post(`${base}/v1/auth/apple/start`,{data:{purpose:'login',platform:'ios',installationId:'synthetic-http'}});
  expect(start.ok()).toBe(true);expect(start.headers()['cache-control']).toBe('no-store');
  const flow=(await start.json()).data;
  expect((await (await request.get(`${base}/v1/auth/providers`)).json()).data.apple.enabled).toBe(true);
  for(const platform of ['ios','android','desktop']){
   const provider=await request.get(`${base}/v1/auth/providers?platform=${platform}`);
   expect((await provider.json()).data.apple.enabled).toBe(platform==='ios');
  }
  const input={flowId:flow.flowId,transactionSecret:flow.transactionSecret,state:flow.state,identityToken:'synthetic.jwt.token',authorizationCode:'synthetic-code'};
  const key=randomUUID(),options={headers:{'idempotency-key':key},data:input};
  await preparation.prepare(input,key);
  const replies=await Promise.all(Array.from({length:6},()=>request.post(`${base}/v1/auth/apple/complete`,options)));
  for(let i=0;i<replies.length;i++){if(replies[i].status()===429){expect((await replies[i].json()).error.code).toBe('AUTH_BUSY');replies[i]=await request.post(`${base}/v1/auth/apple/complete`,options);}}
  const first=(await replies[0].json()).data;expect(replies.every(reply=>reply.ok())).toBe(true);
  for(const reply of replies)expect((await reply.json()).data).toEqual(first);
  expect(await auth.service.verify(first.accessToken)).toEqual(first.session);
  expect(JSON.stringify(first)).not.toContain('synthetic-provider-secret');expect(exchanges).toBe(1);
  const count=await db.app.query('SELECT count(*)::int AS n FROM siyue.auth_sessions');expect(count.rows[0].n).toBe(1);
  await auth.service.refresh(first.refreshToken,randomUUID());
  const consumed=await request.post(`${base}/v1/auth/apple/complete`,options);expect(consumed.status()).toBe(409);
  expect((await consumed.json()).error.code).toBe('AUTH_OPERATION_COMPLETED_LOGIN_REQUIRED');expect(exchanges).toBe(1);

  expect((await db.app.query("SELECT count(*)::int AS n FROM siyue.security_events WHERE event_type='apple.complete' AND outcome='success'")).rows[0].n).toBe(1);
  const noKey=await request.post(`${base}/v1/auth/apple/complete`,{data:input});expect(noKey.status()).toBe(400);
  expect((await noKey.json()).error.code).toBe('AUTH_IDEMPOTENCY_KEY_REQUIRED');
  for(const options of [{data:{...input,user:'forged'},headers:{'idempotency-key':key}},{data:input,headers:{'idempotency-key':key,authorization:'Bearer forged'}}]){
   const invalid=await request.post(`${base}/v1/auth/apple/complete`,options);expect(invalid.status()).toBe(400);
  }
  expect((await request.post(`${base}/v1/auth/apple/complete?x=1`,options)).status()).toBe(400);
  expect((await request.post(`${base}/v1/auth/apple/complete`,{...options,data:{padding:'x'.repeat(65536)}})).status()).toBe(413);
  const pending=await service.start({purpose:'login',platform:'ios',installationId:'synthetic-outage'});
  const outageOptions={headers:{'idempotency-key':randomUUID()},data:{...input,flowId:pending.flowId,transactionSecret:pending.transactionSecret,state:pending.state}};
  verificationFailure=true;
  const unavailable=await request.post(`${base}/v1/auth/apple/complete`,outageOptions);
  expect(unavailable.status()).toBe(503);expect((await unavailable.json()).error.code).toBe('AUTH_TEMPORARILY_UNAVAILABLE');
  expect(exchanges).toBe(1);
  verificationFailure=false;expect((await request.post(`${base}/v1/auth/apple/complete`,outageOptions)).ok()).toBe(true);
  const api=createAuthApiClient({environment:'test',apiBaseUrl:`${base}/v1`,fetcher:fetch});
  const clientFlow=await api.startApple({purpose:'login',platform:'ios',installationId:'synthetic-typed-client'});
  const clientInput={...input,flowId:clientFlow.flowId,transactionSecret:clientFlow.transactionSecret,state:clientFlow.state},clientKey=randomUUID();
  const clientTokens=await api.completeApple(clientInput,clientKey);
  expect(await api.completeApple(clientInput,clientKey)).toEqual(clientTokens);
  expect(await auth.service.verify(clientTokens.accessToken)).toEqual(clientTokens.session);
  try{await api.completeApple({...clientInput,state:'z'.repeat(43)},clientKey);throw Error('expected rejection');}
  catch(error){expect(error.code).toBe('apple_restart_required');}
  let stored=null,loseResponse=true,nativeCalls=0;
  const completeRequests=[];
  const controllerApi=createAuthApiClient({environment:'test',apiBaseUrl:`${base}/v1`,fetcher:async(url,init)=>{
   if(url.endsWith('/apple/complete'))completeRequests.push({body:init.body,key:new Headers(init.headers).get('idempotency-key')});
   const response=await fetch(url,init);
   if(url.endsWith('/apple/complete')&&loseResponse){loseResponse=false;await response.text();throw Error('synthetic response lost');}
   return response;
  }});
  const host=createAuthController({api:controllerApi,vault:{read:async()=>stored,write:async value=>{stored=value;}},newId:randomUUID});
  try{
   await host.bootstrap();
   try{await host.loginApple(async({state})=>{nativeCalls++;return {state,identityToken:'synthetic.jwt.token',authorizationCode:'synthetic-controller-code'};});throw Error('expected network failure');}
   catch(error){expect(error.code).toBe('network');}
   expect(host.canRetryApple()).toBe(true);await host.retryApple();
   expect(host.getState().status).toBe('authenticated');expect(nativeCalls).toBe(1);
   expect(completeRequests[1]).toEqual(completeRequests[0]);expect(stored).not.toContain('identityToken');expect(stored).not.toContain('authorizationCode');
   await host.logout();
  }finally{await host.dispose();}
  let limited;
  for(let index=0;index<11;index++){
   limited=await request.post(`${base}/v1/auth/apple/start`,{data:{purpose:'login',platform:'ios',installationId:'synthetic-http'}});
   if(limited.status()===429)break;
  }
  expect(limited.status()).toBe(429);expect(limited.headers()['retry-after']).toBe('60');
  expect((await limited.json()).error.code).toBe('AUTH_RATE_LIMITED');
 }finally{await app?.close();await db.stop();}
});
