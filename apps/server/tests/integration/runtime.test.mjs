import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,chmodSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startPostgresFixture } from './postgres-fixture.mjs';
import { createAuthFixture } from './auth-fixture.mjs';
import { readAuthConfig } from '../../dist/auth-config.js';
import { assertDatabaseReady } from '../../dist/adapters/postgres/migrate.js';
let db,auth,directory,env;
before(async()=>{
 db=await startPostgresFixture();auth=await createAuthFixture(db);directory=mkdtempSync('/tmp/siyue-auth-config-');
 const file=(name,body)=>{const path=join(directory,name);writeFileSync(path,body,{mode:0o600});return path;};
 env={PATH:process.env.PATH,NODE_ENV:'test',SIYUE_ENVIRONMENT:'test',SIYUE_DATABASE_NAME:'siyue_test',SIYUE_DATABASE_URL:db.app.options.connectionString,
  SIYUE_JWT_ISSUER:auth.config.issuer,SIYUE_JWT_AUDIENCE:auth.config.audience,SIYUE_JWT_KEY_ID:auth.config.kid,
  SIYUE_JWT_PRIVATE_KEY_FILE:file('private.pem',auth.config.privateKey),SIYUE_JWT_VERIFY_KEYS_FILE:file('public.json',JSON.stringify(auth.config.jwks)),
  SIYUE_SECRET_ENCRYPTION_KEY_FILE:file('encryption.json',JSON.stringify({activeVersion:'test-v1',keys:{'test-v1':randomBytes(32).toString('base64')}})),
  SIYUE_CHALLENGE_PEPPER_FILE:file('pepper',randomBytes(32).toString('base64'))};
});
after(async()=>{await db?.stop();if(directory)rmSync(directory,{recursive:true});});

test('secret files, key pairing, provider gates and environment isolation fail closed',async()=>{
 await readAuthConfig(env);
 for(const replacement of [
  {SIYUE_JWT_KEY_ID:'missing-key'}, {SIYUE_JWT_PRIVATE_KEY_FILE:undefined},
  {SIYUE_SECRET_ENCRYPTION_KEY_FILE:env.SIYUE_CHALLENGE_PEPPER_FILE},
  {SIYUE_JWT_ISSUER:'https://api.qiugeapp.com/api/siyue'}, {SIYUE_APPLE_ENABLED:'true'}, {SIYUE_EMAIL_ENABLED:'true'},
 ]) await assert.rejects(readAuthConfig({...env,...replacement}),/^Error: invalid_auth_configuration$/);
 chmodSync(env.SIYUE_JWT_PRIVATE_KEY_FILE,0o644);
 await assert.rejects(readAuthConfig(env),/^Error: invalid_auth_configuration$/);
 chmodSync(env.SIYUE_JWT_PRIVATE_KEY_FILE,0o600);
});

test('unexpected runtime schema privilege makes readiness fail',async()=>{
 await db.admin.query('GRANT CREATE ON SCHEMA siyue TO siyue_app');
 try {await assert.rejects(assertDatabaseReady(db.app,db.identity),/database_identity_rejected/);}
 finally {await db.admin.query('REVOKE CREATE ON SCHEMA siyue FROM siyue_app');}
});

async function launch(extra) {
 const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');
 const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
 const processHandle=spawn(process.execPath,[fileURLToPath(new URL('../../dist/index.js',import.meta.url))],{
  env:{...env,SIYUE_SERVER_PORT:String(port),...extra},stdio:['ignore','pipe','pipe']});
 let output='';processHandle.stdout.on('data',chunk=>{output+=chunk;});processHandle.stderr.on('data',chunk=>{output+=chunk;});
 const closed=once(processHandle,'close');
 return {processHandle,closed,port,output:()=>output,stop:async()=>{if(processHandle.exitCode===null && processHandle.signalCode===null)processHandle.kill('SIGTERM');await closed;}};
}

test('actual service boots with isolated configuration, serves identity and shuts down',async()=>{
 const child=await launch({});
 try {
  let ready=false;
  for(let i=0;i<50;i++) {
   if(child.processHandle.exitCode!==null)break;
   try {ready=(await fetch(`http://127.0.0.1:${child.port}/health/ready`)).ok;} catch {}
   if(ready)break;await delay(50);
  }
  assert.equal(ready,true,'runtime did not become ready');
  const tokens=await auth.issue();
  const result=await fetch(`http://127.0.0.1:${child.port}/v1/account/session`,{headers:{authorization:`Bearer ${tokens.accessToken}`}});
  assert.equal(result.status,200);assert.deepEqual(await result.json(),tokens.session);
  assert.equal(child.output().includes(tokens.accessToken),false);
 } finally {await child.stop();}
});

test('production without database and secrets exits instead of exposing local Mock',async()=>{
 const child=await launch({NODE_ENV:'production',SIYUE_ENVIRONMENT:'production',SIYUE_DATABASE_URL:''});
 try {
  const [exitCode]=await child.closed;assert.equal(exitCode,1);
  assert.match(child.output(),/startup failed/);assert.equal(child.output().includes(env.SIYUE_DATABASE_URL),false);
 } finally {await child.stop();}
});

test('actual runtime enables email only with private SMTP config, queues encrypted verification without sending from API',async()=>{
 const path=join(directory,'smtp.json');
 writeFileSync(path,JSON.stringify({host:'smtp.example.invalid',port:465,user:'synthetic',password:'synthetic',from:'siyue@example.test'}),{mode:0o600});
 // Sign-up is closed until a published policy exists, so this runtime needs an explicit test policy.
 // It is published here only to exercise the mail path; the gate itself is unchanged.
 const policyPath=join(directory,'registration-policy.json');
 writeFileSync(policyPath,JSON.stringify({enabled:true,terms:{version:'0.0.1-test',url:'https://example.test/siyue/terms'},
  privacy:{version:'0.0.1-test',url:'https://example.test/siyue/privacy'}}),{mode:0o600});
 const emailEnv={SIYUE_EMAIL_ENABLED:'true',SIYUE_MAIL_CONFIG_FILE:path,SIYUE_REGISTRATION_POLICY_FILE:policyPath};
 await readAuthConfig({...env,...emailEnv});
 chmodSync(path,0o644);await assert.rejects(readAuthConfig({...env,...emailEnv}),/invalid_auth_configuration/);chmodSync(path,0o600);
 const child=await launch(emailEnv);
 try {
  let ready=false;
  for(let i=0;i<50;i++) {
   if(child.processHandle.exitCode!==null)break;
   try {ready=(await fetch(`http://127.0.0.1:${child.port}/health/ready`)).ok;} catch {}
   if(ready)break;await delay(50);
  }
  assert.equal(ready,true);
  const base=`http://127.0.0.1:${child.port}`;
  const providers=await (await fetch(base+'/v1/auth/providers')).json();assert.equal(providers.data.emailPassword.enabled,true);
  const response=await fetch(base+'/v1/auth/email/register/request',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':(await import('node:crypto')).randomUUID()},body:JSON.stringify({email:'runtime-synthetic@example.test',locale:'en-US'})});
  assert.equal(response.status,202);
  const challenge=(await response.json()).data;
  const outbox=(await db.app.query('SELECT status,payload_ciphertext FROM siyue.outbox_jobs WHERE aggregate_id=$1',[challenge.challengeId])).rows[0];
  assert.equal(outbox.status,'pending');assert.ok(outbox.payload_ciphertext);assert.equal(outbox.payload_ciphertext.includes('runtime-synthetic@example.test'),false);
  assert.equal(child.output().includes(challenge.requestSecret),false);assert.equal(child.output().includes('synthetic'),false);
 } finally {await child.stop();}
});

test('Apple enabled config validates private files and actual runtime exposes only the native login routes',async()=>{
 const path=join(directory,'apple.json');
 const config={teamId:'TESTTEAM01',keyId:'TESTKEY001',clientId:'app.siyue.synthetic',namespace:'synthetic-team',privateKeyFile:env.SIYUE_JWT_PRIVATE_KEY_FILE};
 const write=value=>writeFileSync(path,JSON.stringify(value),{mode:0o600});write(config);
 const appleEnv={SIYUE_APPLE_ENABLED:'true',SIYUE_APPLE_CONFIG_FILE:path};
 assert.equal((await readAuthConfig({...env,...appleEnv})).apple.clientId,config.clientId);
 for(const patch of [{teamId:'bad'},{keyId:'bad'},{clientId:'bad client'},{namespace:''},{privateKeyFile:directory},{unexpected:true}]){
  write({...config,...patch});await assert.rejects(readAuthConfig({...env,...appleEnv}),/invalid_auth_configuration/);
 }
 write(config);chmodSync(path,0o644);await assert.rejects(readAuthConfig({...env,...appleEnv}),/invalid_auth_configuration/);chmodSync(path,0o600);
 for(const flag of ['TRUE','1',''])await assert.rejects(readAuthConfig({...env,SIYUE_APPLE_ENABLED:flag}),/invalid_auth_configuration/);
 const child=await launch(appleEnv);
 try{
  const base=`http://127.0.0.1:${child.port}`;let ready=false;
  for(let i=0;i<50;i++){if(child.processHandle.exitCode!==null)break;try{ready=(await fetch(base+'/health/ready')).ok;}catch{}if(ready)break;await delay(50);}
  assert.equal(ready,true);
  assert.equal((await(await fetch(base+'/v1/auth/providers')).json()).data.apple.enabled,true);
  const response=await fetch(base+'/v1/auth/apple/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({purpose:'login',platform:'ios',installationId:'synthetic-start'})});
  assert.equal(response.status,200);const result=(await response.json()).data;
  assert.equal(result.state.length,43);assert.equal((await db.app.query('SELECT status FROM siyue.apple_login_flows WHERE id=$1',[result.flowId])).rows[0].status,'pending');
  for(const value of [config.clientId,auth.config.privateKey,result.transactionSecret])assert.equal(child.output().includes(value),false);
 }finally{await child.stop();}
});
