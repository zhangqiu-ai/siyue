import { test,before,after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { generateKeyPair,exportPKCS8,exportJWK } from 'jose';
import { startPostgresFixture } from './postgres-fixture.mjs';
const apiKey='re_synthetic_worker_0000000000000000';
const smtpPassword='synthetic-smtp-password';
let db,directory,env;
before(async()=>{
 db=await startPostgresFixture();directory=mkdtempSync('/tmp/siyue-mail-worker-');
 const file=(name,value)=>{const path=join(directory,name);writeFileSync(path,typeof value==='string'?value:JSON.stringify(value),{mode:0o600});return path;};
 const pair=await generateKeyPair('ES256',{extractable:true});
 env={PATH:process.env.PATH,SIYUE_ENVIRONMENT:'test',SIYUE_DATABASE_NAME:'siyue_test',SIYUE_DATABASE_URL:db.app.options.connectionString,
  SIYUE_JWT_ISSUER:'https://siyue.test/auth',SIYUE_JWT_AUDIENCE:'siyue-test-api',SIYUE_JWT_KEY_ID:'test-key',
  SIYUE_JWT_PRIVATE_KEY_FILE:file('private.pem',await exportPKCS8(pair.privateKey)),
  SIYUE_JWT_VERIFY_KEYS_FILE:file('public.json',{keys:[{...await exportJWK(pair.publicKey),kid:'test-key',alg:'ES256'}]}),
  SIYUE_SECRET_ENCRYPTION_KEY_FILE:file('encryption.json',{activeVersion:'test-v1',keys:{'test-v1':randomBytes(32).toString('base64')}}),
  SIYUE_CHALLENGE_PEPPER_FILE:file('pepper',randomBytes(32).toString('base64')),
  SIYUE_MAIL_CONFIG_FILE:file('resend.json',{provider:'resend',apiKey,from:'siyue@example.test'})};
 env.SIYUE_LEGACY_MAIL_CONFIG_FILE=file('smtp-legacy.json',{host:'smtp.example.invalid',port:465,user:'synthetic',password:smtpPassword,from:'siyue@example.test'});
});
after(async()=>{await db?.stop();if(directory)rmSync(directory,{recursive:true,force:true});});
function launch(extra={}) {
 const child=spawn(process.execPath,[fileURLToPath(new URL('../../dist/mail-worker.js',import.meta.url))],{env:{...env,...extra},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
 const closed=once(child,'close');
 return {child,closed,output:()=>output,stop:async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await closed;}};
}

// The worker previously required SMTP credentials to start. Both a Resend-only deployment and the
// legacy SMTP file must boot, find no work, and shut down without any provider request or output.
test('a Resend-only or legacy SMTP configuration boots the worker, idles silently and stops cleanly',async()=>{
 for(const mailConfigFile of [env.SIYUE_MAIL_CONFIG_FILE,env.SIYUE_LEGACY_MAIL_CONFIG_FILE]) {
  const worker=launch({SIYUE_EMAIL_ENABLED:'true',SIYUE_MAIL_CONFIG_FILE:mailConfigFile});
  try {
   await delay(1_500);
   assert.equal(worker.child.exitCode,null,'worker exited instead of idling');
   assert.equal((await db.app.query('SELECT count(*)::int AS count FROM siyue.outbox_jobs')).rows[0].count,0);
   assert.equal(worker.output(),'','idle worker should stay silent');
   assert.equal(worker.output().includes(apiKey),false);
   assert.equal(worker.output().includes(smtpPassword),false);
  } finally {await worker.stop();}
  assert.equal(worker.child.exitCode,0);
 }
});

test('the worker refuses to start without a provider or with a rejected private file',async()=>{
 for(const extra of [
  {SIYUE_EMAIL_ENABLED:'false'},
  {SIYUE_EMAIL_ENABLED:'true',SIYUE_MAIL_CONFIG_FILE:join(directory,'missing.json')},
  {SIYUE_EMAIL_ENABLED:'true',SIYUE_MAIL_CONFIG_FILE:undefined},
 ]) {
  const worker=launch(extra);
  const [code]=await worker.closed;
  assert.equal(code,1,JSON.stringify(extra));
  assert.match(worker.output(),/startup failed/);
  assert.equal(worker.output().includes(apiKey),false);
 }
});
