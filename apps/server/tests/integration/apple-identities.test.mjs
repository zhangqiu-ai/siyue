import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {startPostgresFixture} from './postgres-fixture.mjs';
import {transaction} from '../../dist/adapters/postgres/database.js';
import {RecoveryCipher} from '../../dist/adapters/crypto/auth-crypto.js';
import {AppleIdentityStorageError,createAppleIdentityStorage} from '../../dist/identities/apple/identity-storage.js';

let db;before(async()=>{db=await startPostgresFixture();});after(async()=>{await db?.stop();});

const namespace='app.siyue.mobile',otherNamespace='app.siyue.desktop',clientId='app.siyue.mobile',refresh='synthetic-apple-refresh';
const cipher=new RecoveryCipher('test',new Map([['test',randomBytes(32)]]));
const unique=label=>`${label}-${randomUUID()}`;
const value=(subject,id=clientId)=>({identity:{provider:'apple',subject,clientId:id},refreshToken:refresh});
const aad=(identityId,ns=namespace)=>`apple-identity:${identityId}:${ns}`;
function fixture(ns=namespace){let time=Date.parse('2026-09-22T00:00:00Z');const clock=()=>new Date(time);return {clock,store:createAppleIdentityStorage(cipher,ns,clock),advance:ms=>{time+=ms;}};}
const rows=(sql,...params)=>db.app.query(sql,params).then(result=>result.rows);
const count=(sql,...params)=>rows(sql,...params).then(result=>result[0].total);
const create=(store,subject,displayName,id)=>transaction(db.app,client=>store.resolve(client,value(subject,id),displayName));
const subjectOf=id=>rows('SELECT * FROM siyue.subjects WHERE id=$1',id).then(rows=>rows[0]);
const identityOf=id=>rows('SELECT * FROM siyue.external_identities WHERE id=$1',id).then(rows=>rows[0]);
const credentialOf=id=>rows('SELECT * FROM siyue.apple_provider_credentials WHERE identity_id=$1',id).then(rows=>rows[0]);

test('first resolve creates one active adult subject with the default name and an isolated encrypted credential',async()=>{
 const {store,clock}=fixture(),appleSubject=unique('synthetic-first'),result=await create(store,appleSubject);
 assert.equal(result.created,true);
 const subject=await subjectOf(result.subjectId);
 assert.deepEqual([subject.kind,subject.status,subject.display_name],['adult','active','Siyue']);
 assert.equal(+subject.created_at,+clock());
 const identity=await identityOf(result.identityId);
 assert.deepEqual([identity.subject_id,identity.provider,identity.provider_namespace,identity.provider_subject,identity.client_id,identity.issuer,identity.status],
  [result.subjectId,'apple',namespace,appleSubject,clientId,'https://appleid.apple.com','active']);
 assert.equal(+identity.last_login_at,+identity.created_at);
 const credential=await credentialOf(result.identityId);
 assert.equal(credential.refresh_ciphertext.includes(refresh),false);
 assert.equal(credential.refresh_ciphertext.includes('synthetic'),false);
 assert.deepEqual(cipher.open(credential.refresh_ciphertext,aad(result.identityId)),{refreshToken:refresh});
 assert.throws(()=>cipher.open(credential.refresh_ciphertext,aad(result.identityId,otherNamespace)));
 assert.throws(()=>cipher.open(credential.refresh_ciphertext,aad(randomUUID())));
 const again=await create(store,appleSubject);
 assert.deepEqual([again.subjectId,again.identityId,again.created],[result.subjectId,result.identityId,false]);
 assert.equal(await count('SELECT count(*)::int AS total FROM siyue.subjects WHERE id=$1',result.subjectId),1);
 assert.equal(await count('SELECT count(*)::int AS total FROM siyue.external_identities WHERE id=$1',result.identityId),1);
});

test('concurrent same-identity resolutions create one subject while another namespace stays isolated',async()=>{
 const mobile=fixture(),desktop=fixture(otherNamespace),appleSubject=unique('synthetic-race');
 const results=await Promise.all([
  ...Array.from({length:4},()=>create(mobile.store,appleSubject)),
  ...Array.from({length:4},()=>create(desktop.store,appleSubject)),
 ]);
 const inMobile=results.slice(0,4),inDesktop=results.slice(4);
 assert.equal(new Set(inMobile.map(result=>result.subjectId)).size,1);
 assert.equal(new Set(inMobile.map(result=>result.identityId)).size,1);
 assert.equal(new Set(inDesktop.map(result=>result.subjectId)).size,1);
 assert.equal(new Set(inDesktop.map(result=>result.identityId)).size,1);
 assert.notEqual(inMobile[0].subjectId,inDesktop[0].subjectId);
 assert.equal(results.filter(result=>result.created).length,2);
 assert.equal(await count('SELECT count(*)::int AS total FROM siyue.subjects WHERE id=$1',inMobile[0].subjectId),1);
 assert.equal(await count('SELECT count(*)::int AS total FROM siyue.external_identities WHERE provider_subject=$1',appleSubject),2);
 assert.equal(await count('SELECT count(*)::int AS total FROM siyue.external_identities WHERE provider_namespace=$1 AND provider_subject=$2',namespace,appleSubject),1);
 assert.equal(await count('SELECT count(*)::int AS total FROM siyue.apple_provider_credentials WHERE identity_id=$1',inMobile[0].identityId),1);
});

test('distinct identities never merge by namespace, display name or existing email',async()=>{
 const mobile=fixture(),desktop=fixture(otherNamespace),appleSubject=unique('synthetic-scope'),name='Synthetic Same Name';
 const inMobile=await create(mobile.store,appleSubject,name),inDesktop=await create(desktop.store,appleSubject,name);
 assert.equal(inMobile.created,true);assert.equal(inDesktop.created,true);assert.notEqual(inMobile.subjectId,inDesktop.subjectId);
 const emailSubject=randomUUID(),email=`${randomUUID()}@example.test`;
 await db.app.query("INSERT INTO siyue.subjects(id,kind,display_name) VALUES($1,'adult',$2)",[emailSubject,name]);
 await db.app.query('INSERT INTO siyue.account_emails(id,subject_id,email_original,email_normalized,verified_at) VALUES($1,$2,$3,$3,now())',[randomUUID(),emailSubject,email]);
 const another=await create(mobile.store,unique('synthetic-scope'),name);
 assert.notEqual(another.subjectId,inMobile.subjectId);assert.notEqual(another.subjectId,emailSubject);assert.notEqual(another.subjectId,inDesktop.subjectId);
 // Three Apple subjects share the name; the pre-existing email subject is never reused or renamed.
 assert.equal(await count('SELECT count(*)::int AS total FROM siyue.subjects WHERE display_name=$1',name),4);
 assert.equal(await count('SELECT count(*)::int AS total FROM siyue.account_emails WHERE subject_id=$1',emailSubject),1);
});

test('re-login keeps the first display name and records the newest client and login time',async()=>{
 const {store,clock,advance}=fixture(),appleSubject=unique('synthetic-reuse');
 const first=await create(store,appleSubject,'First Synthetic Name'),createdAt=+clock();
 advance(60000);
 const second=await create(store,appleSubject,'Second Synthetic Name','app.siyue.other');
 assert.deepEqual([second.created,second.subjectId,second.identityId],[false,first.subjectId,first.identityId]);
 const subject=await subjectOf(first.subjectId),identity=await identityOf(first.identityId);
 assert.equal(subject.display_name,'First Synthetic Name');
 assert.equal(identity.client_id,'app.siyue.other');
 assert.equal(+identity.created_at,createdAt);
 assert.equal(+identity.last_login_at,createdAt+60000);
 assert.deepEqual(cipher.open((await credentialOf(first.identityId)).refresh_ciphertext,aad(first.identityId)),{refreshToken:refresh});
 const restarted=fixture(),recovered=await create(restarted.store,appleSubject,'Third Synthetic Name');
 assert.deepEqual([recovered.created,recovered.subjectId],[false,first.subjectId]);
 assert.equal((await subjectOf(first.subjectId)).display_name,'First Synthetic Name');
});

test('blocked subjects, child subjects and non-active identities are unavailable and left unchanged',async()=>{
 const {store}=fixture(),appleSubject=unique('synthetic-inactive');
 const {subjectId,identityId}=await create(store,appleSubject,'Unavailable Synthetic Name');
 const unavailable=async()=>{await assert.rejects(create(store,appleSubject),error=>error instanceof AppleIdentityStorageError&&error.code==='identity_unavailable');};
 for(const status of ['blocked','deletion_pending','deleted']){await db.app.query('UPDATE siyue.subjects SET status=$2 WHERE id=$1',[subjectId,status]);await unavailable();}
 await db.app.query("UPDATE siyue.subjects SET status='active',kind='child' WHERE id=$1",[subjectId]);await unavailable();
 await db.app.query("UPDATE siyue.subjects SET kind='adult' WHERE id=$1",[subjectId]);
 for(const status of ['revoked','unlinked']){await db.app.query('UPDATE siyue.external_identities SET status=$2 WHERE id=$1',[identityId,status]);await unavailable();}
 await db.app.query("UPDATE siyue.external_identities SET status='active' WHERE id=$1",[identityId]);
 const recovered=await create(store,appleSubject);
 assert.deepEqual([recovered.created,recovered.subjectId],[false,subjectId]);
 assert.equal((await subjectOf(subjectId)).display_name,'Unavailable Synthetic Name');
 assert.ok((await credentialOf(identityId)).refresh_ciphertext.length>0);
});

test('a failing caller transaction leaves no orphan subject, identity or credential',async()=>{
 const {store}=fixture(),appleSubject=unique('synthetic-rollback'),name=unique('Synthetic Rollback Name');
 const failing=createAppleIdentityStorage({seal(){throw new Error('synthetic_seal_failure');},open:cipher.open.bind(cipher)},namespace);
 await assert.rejects(transaction(db.app,client=>failing.resolve(client,value(appleSubject),name)),/synthetic_seal_failure/);
 assert.equal(await count('SELECT count(*)::int AS total FROM siyue.subjects WHERE display_name=$1',name),0);
 assert.equal(await count('SELECT count(*)::int AS total FROM siyue.external_identities WHERE provider_subject=$1',appleSubject),0);
 await assert.rejects(transaction(db.app,async client=>{await store.resolve(client,value(appleSubject),name);throw new Error('synthetic_rollback');}),/synthetic_rollback/);
 assert.equal(await count('SELECT count(*)::int AS total FROM siyue.subjects WHERE display_name=$1',name),0);
 assert.equal(await count('SELECT count(*)::int AS total FROM siyue.external_identities WHERE provider_subject=$1',appleSubject),0);
 assert.equal(await count(`SELECT count(*)::int AS total FROM siyue.apple_provider_credentials c
  JOIN siyue.external_identities i ON i.id=c.identity_id WHERE i.provider_subject=$1`,appleSubject),0);
 const committed=await create(store,appleSubject,name);
 assert.equal(committed.created,true);
 assert.equal(await count('SELECT count(*)::int AS total FROM siyue.subjects WHERE id=$1',committed.subjectId),1);
 assert.deepEqual(cipher.open((await credentialOf(committed.identityId)).refresh_ciphertext,aad(committed.identityId)),{refreshToken:refresh});
});

test('database constraints and invalid input cannot bypass the storage contract',async()=>{
 const {store}=fixture(),appleSubject=unique('synthetic-contract'),{subjectId,identityId}=await create(store,appleSubject);
 const insert='INSERT INTO siyue.external_identities(id,subject_id,provider,provider_namespace,provider_subject,client_id,issuer) VALUES($1,$2,$3,$4,$5,$6,$7)';
 await assert.rejects(db.app.query(insert,[randomUUID(),subjectId,'apple',namespace,appleSubject,clientId,'https://appleid.apple.com']),error=>error.code==='23505');
 await assert.rejects(db.app.query(insert,[randomUUID(),subjectId,'google',namespace,unique('synthetic-google'),clientId,'https://appleid.apple.com']),error=>error.code==='23514');
 await assert.rejects(db.app.query(insert,[randomUUID(),subjectId,'apple',namespace,unique('synthetic-issuer'),clientId,'https://example.test']),error=>error.code==='23514');
 await assert.rejects(db.app.query('INSERT INTO siyue.apple_provider_credentials(identity_id,refresh_ciphertext) VALUES($1,$2)',[randomUUID(),'synthetic-ciphertext']),error=>error.code==='23503');
 await assert.rejects(db.app.query('INSERT INTO siyue.apple_provider_credentials(identity_id,refresh_ciphertext) VALUES($1,$2)',[identityId,'']),error=>error.code==='23514');
 assert.throws(()=>createAppleIdentityStorage(cipher,'bad namespace'));
 assert.throws(()=>createAppleIdentityStorage(cipher,''));
 for(const invalid of [{identity:{provider:'google',subject:appleSubject,clientId},refreshToken:refresh},
  {identity:{provider:'apple',subject:'has whitespace',clientId},refreshToken:refresh},
  {identity:{provider:'apple',subject:'',clientId},refreshToken:refresh},
  {identity:{provider:'apple',subject:unique('synthetic-invalid'),clientId},refreshToken:''}])
  await assert.rejects(transaction(db.app,client=>store.resolve(client,invalid)));
 assert.equal(await count("SELECT count(*)::int AS total FROM siyue.external_identities WHERE provider_subject='has whitespace'"),0);
});

test('caller transaction owns visibility and rollback; storage never commits on its own',async()=>{
 const {store}=fixture(),appleSubject=unique('synthetic-unmanaged'),held=await db.app.connect();
 try{
  await held.query('BEGIN');
  const pending=await store.resolve(held,value(appleSubject),'Synthetic Pending Name');
  assert.equal(await count('SELECT count(*)::int AS total FROM siyue.external_identities WHERE id=$1',pending.identityId),0);
  assert.equal(await count('SELECT count(*)::int AS total FROM siyue.subjects WHERE id=$1',pending.subjectId),0);
  await held.query('ROLLBACK');
 }finally{held.release();}
 assert.equal(await count('SELECT count(*)::int AS total FROM siyue.external_identities WHERE provider_subject=$1',appleSubject),0);
 assert.equal(await count('SELECT count(*)::int AS total FROM siyue.subjects WHERE display_name=$1','Synthetic Pending Name'),0);
});

test('failed later session step preserves the previously committed provider credential',async()=>{
 const {store,advance}=fixture(),appleSubject=unique('synthetic-credential-rollback');
 const initial=await create(store,appleSubject,'Original');
 const beforeCredential=await credentialOf(initial.identityId),beforeIdentity=await identityOf(initial.identityId);
 advance(1000);
 await assert.rejects(transaction(db.app,async client=>{
  await store.resolve(client,{...value(appleSubject,'app.siyue.other'),refreshToken:'synthetic-replacement'});
  throw Error('synthetic_session_failure');
 }),/synthetic_session_failure/);
 assert.deepEqual(await credentialOf(initial.identityId),beforeCredential);
 assert.deepEqual(await identityOf(initial.identityId),beforeIdentity);
 await transaction(db.app,client=>store.resolve(client,{...value(appleSubject),refreshToken:'synthetic-replacement'}));
 assert.deepEqual(cipher.open((await credentialOf(initial.identityId)).refresh_ciphertext,aad(initial.identityId)),{refreshToken:'synthetic-replacement'});
});
