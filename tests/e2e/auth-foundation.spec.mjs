import { test, expect } from 'playwright/test';
import { randomUUID } from 'node:crypto';
import { startPostgresFixture } from '../../apps/server/tests/integration/postgres-fixture.mjs';
import { createAuthFixture } from '../../apps/server/tests/integration/auth-fixture.mjs';
import { createRuntimeApp } from '../../apps/server/dist/runtime-app.js';
import { createAccountSessionClient } from '../../packages/adapters/dist/index.js';
let db, auth, app, address;
test.beforeAll(async()=>{
 db=await startPostgresFixture(); auth=await createAuthFixture(db);
 app=createRuntimeApp(db.app,db.identity,{sessions:auth.service});
 address=await app.listen({host:'127.0.0.1',port:0});
});
test.afterAll(async()=>{await app?.close();await db?.stop();});

test('real HTTP + PostgreSQL: existing client identity, refresh recovery and logout',async({request})=>{
 const original=await auth.issue();
 const client=createAccountSessionClient({baseUrl:address,fetcher:fetch});
 expect(await client.query(original.accessToken)).toEqual(original.session);
 const data={refreshToken:original.refreshToken,rotationId:randomUUID()};
 const refreshed=await request.post(address+'/v1/auth/refresh',{data});expect(refreshed.status()).toBe(200);
 expect(refreshed.headers()['cache-control']).toBe('no-store');
 const result=await refreshed.json();
 const recovered=await request.post(address+'/v1/auth/refresh',{data});
 expect((await recovered.json()).data).toEqual(result.data);
 expect(await client.query(result.data.accessToken)).toEqual(result.data.session);
 const logout=await request.post(address+'/v1/auth/logout',{data:{refreshToken:result.data.refreshToken}});
 expect(logout.status()).toBe(204);
 expect((await request.get(address+'/v1/account/session',{headers:{authorization:`Bearer ${result.data.accessToken}`}})).status()).toBe(401);
});

test('HTTP replay revokes device and strict body rejects extra authority claims',async({request})=>{
 const original=await auth.issue();
 const endpoint=address+'/v1/auth/refresh';
 const data={refreshToken:original.refreshToken,rotationId:randomUUID()};
 expect((await request.post(endpoint,{data:{...data,subjectKind:'adult',role:'owner'}})).status()).toBe(400);
 expect((await request.post(endpoint+'?refreshToken=forbidden',{data})).status()).toBe(400);
 const first=await request.post(endpoint,{data});expect(first.status()).toBe(200);
 const replay=await request.post(endpoint,{data:{...data,rotationId:randomUUID()}});
 expect(replay.status()).toBe(401);expect((await replay.json()).error.code).toBe('AUTH_REFRESH_REPLAYED');
 expect((await request.get(address+'/v1/account/session',{headers:{authorization:`Bearer ${original.accessToken}`}})).status()).toBe(401);
 expect((await request.post(address+'/v1/auth/logout',{data:{sessionId:original.session.sessionId}})).status()).toBe(400);
});

test('HTTP readiness, disabled providers, origin boundary and absent public Mock',async({request})=>{
 expect((await request.get(address+'/health/live')).status()).toBe(200);
 expect((await request.get(address+'/health/ready')).status()).toBe(200);
 const providers=await request.get(address+'/v1/auth/providers?platform=ios');
 expect((await providers.json()).data).toEqual({emailPassword:{enabled:false},apple:{enabled:false,platforms:['ios']}});
 expect((await request.get(address+'/v1/auth/providers?platform=unknown')).status()).toBe(400);
 expect((await request.post(address+'/v1/ai/mock-plan',{data:{goal:'synthetic'}})).status()).toBe(404);
 expect((await request.get(address+'/v1/auth/providers',{headers:{origin:'https://untrusted.invalid'}})).status()).toBe(403);
 await db.admin.query("UPDATE siyue.server_metadata SET environment='staging'");
 try {
  expect((await request.get(address+'/health/ready')).status()).toBe(503);
  expect((await request.get(address+'/health/live')).status()).toBe(200);
 } finally {await db.admin.query("UPDATE siyue.server_metadata SET environment='test'");}
});


test('database outage is temporary, existing client does not mistake it for invalid credentials',async({request})=>{
 const original=await auth.issue();
 db.halt();
 expect((await request.get(address+'/health/live')).status()).toBe(200);
 expect((await request.get(address+'/health/ready')).status()).toBe(503);
 const response=await request.get(address+'/v1/account/session',{headers:{authorization:`Bearer ${original.accessToken}`}});
 expect(response.status()).toBe(503);
 const client=createAccountSessionClient({baseUrl:address,fetcher:fetch});
 await expect(client.query(original.accessToken)).rejects.toMatchObject({code:'unavailable'});
});
