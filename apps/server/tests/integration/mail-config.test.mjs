import { test,after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { generateKeyPair,exportPKCS8,exportJWK } from 'jose';
import { readAuthConfig } from '../../dist/auth-config.js';
const directory=mkdtempSync('/tmp/siyue-mail-config-');
after(()=>rmSync(directory,{recursive:true,force:true}));
function file(name,value,mode=0o600){const path=join(directory,name);writeFileSync(path,typeof value==='string'?value:JSON.stringify(value),{mode});return path;}
const pair=await generateKeyPair('ES256',{extractable:true});
const env={PATH:process.env.PATH,SIYUE_ENVIRONMENT:'test',
 SIYUE_JWT_ISSUER:'https://siyue.test/auth',SIYUE_JWT_AUDIENCE:'siyue-test-api',SIYUE_JWT_KEY_ID:'test-key',
 SIYUE_JWT_PRIVATE_KEY_FILE:file('private.pem',await exportPKCS8(pair.privateKey)),
 SIYUE_JWT_VERIFY_KEYS_FILE:file('public.json',{keys:[{...await exportJWK(pair.publicKey),kid:'test-key',alg:'ES256'}]}),
 SIYUE_SECRET_ENCRYPTION_KEY_FILE:file('encryption.json',{activeVersion:'test-v1',keys:{'test-v1':randomBytes(32).toString('base64')}}),
 SIYUE_CHALLENGE_PEPPER_FILE:file('pepper',randomBytes(32).toString('base64'))};
const withMail=mailFile=>({...env,SIYUE_EMAIL_ENABLED:'true',SIYUE_MAIL_CONFIG_FILE:mailFile});

test('a private file written for SMTP keeps auth.smtp and now also reports a normalised auth.mail',async()=>{
 const legacy=file('smtp-legacy.json',{host:'smtp.example.invalid',port:465,user:'synthetic',password:'synthetic',from:'siyue@example.test'});
 const auth=await readAuthConfig(withMail(legacy));
 assert.equal(auth.mail.provider,'smtp');
 assert.equal(auth.mail.host,'smtp.example.invalid');
 assert.equal(auth.mail.port,465);
 assert.equal(Object.hasOwn(auth.mail,'apiKey'),false);
 assert.deepEqual(Object.keys(auth.smtp).sort(),['from','host','password','port','user']);
 const explicit=file('smtp-tagged.json',{provider:'smtp',host:'smtp.example.invalid',port:587,secure:true,user:'synthetic',password:'synthetic',from:'siyue@example.test'});
 const tagged=await readAuthConfig(withMail(explicit));
 assert.equal(tagged.mail.port,587);assert.equal(tagged.smtp.secure,true);assert.equal(Object.hasOwn(tagged.smtp,'provider'),false);
});

let rejectedCount=0;
test('the mail provider flag decides the transport, and an unknown provider never falls back to SMTP',async()=>{
 const resend=file('resend.json',{provider:'resend',apiKey:'re_synthetic_key',from:'siyue@example.test'});
 const auth=await readAuthConfig(withMail(resend));
 assert.equal(auth.mail.provider,'resend');
 assert.equal(auth.mail.apiKey,'re_synthetic_key');
 assert.equal(auth.mail.from,'siyue@example.test');
 assert.equal(auth.smtp,undefined);
 for(const value of [
  {provider:'sendgrid',apiKey:'re_synthetic_key',from:'siyue@example.test'},
  {provider:'resend',from:'siyue@example.test'},
  {provider:'resend',apiKey:'re_synthetic_key'},
  {provider:'resend',apiKey:'re_synthetic_key',from:'siyue'},
  {provider:'resend',apiKey:12345,from:'siyue@example.test'},
  {provider:'resend',apiKey:'re_synthetic_key',from:'siyue@example.test',host:'smtp.example.invalid'},
  {provider:'resend',apiKey:'re_synthetic_key',from:'siyue@example.test',endpoint:'https://synthetic.invalid/emails'},
 ]) {
  const path=file(`rejected-${++rejectedCount}.json`,value);
  await assert.rejects(readAuthConfig(withMail(path)),/invalid_auth_configuration/,JSON.stringify(value));
 }
});

test('mail configuration stays inside its own private file, flag and permission boundary',async()=>{
 const resend=file('resend-isolation.json',{provider:'resend',apiKey:'re_synthetic_key',from:'siyue@example.test'});
 // The flag alone, an environment variable shortcut, or another provider's file never enables mail.
 assert.equal((await readAuthConfig({...env,SIYUE_MAIL_CONFIG_FILE:resend})).mail,undefined);
 assert.equal((await readAuthConfig({...env,SIYUE_MAIL_CONFIG_FILE:resend})).smtp,undefined);
 await assert.rejects(readAuthConfig({...env,SIYUE_EMAIL_ENABLED:'true',SIYUE_RESEND_API_KEY:'re_from_environment'}),/invalid_auth_configuration/);
 for(const flag of ['TRUE','1','','yes']) await assert.rejects(readAuthConfig({...env,SIYUE_EMAIL_ENABLED:flag,SIYUE_MAIL_CONFIG_FILE:resend}),/invalid_auth_configuration/);
 await assert.rejects(readAuthConfig({...env,SIYUE_APPLE_ENABLED:'true',SIYUE_APPLE_CONFIG_FILE:resend}),/invalid_auth_configuration/);
 // A file carrying an API key must stay unreadable to other accounts on the host.
 const open=file('resend-open.json',{provider:'resend',apiKey:'re_synthetic_key',from:'siyue@example.test'},0o644);
 await assert.rejects(readAuthConfig(withMail(open)),/invalid_auth_configuration/);
 await assert.rejects(readAuthConfig(withMail(join(directory,'missing.json'))),/invalid_auth_configuration/);
});
