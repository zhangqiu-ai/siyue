import {test,expect} from 'playwright/test';
import {_electron} from 'playwright';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createEmailFixture,password} from '../../apps/server/tests/integration/email-fixture.mjs';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';
import {createAppleIdentityStorage} from '../../apps/server/dist/identities/apple/identity-storage.js';
import {transaction} from '../../apps/server/dist/adapters/postgres/database.js';
const root=path.resolve(import.meta.dirname,'../..');const require=createRequire(path.join(root,'apps/desktop/package.json'));
test('real Electron main vault and restricted IPC: sign in, encrypted persistence, restart, sign out',async({},testInfo)=>{
 const db=await startPostgresFixture();const fx=await createEmailFixture(db);
 const server=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email});const address=await server.listen({host:'127.0.0.1',port:0});
 const account=await fx.register('electron@example.test');const directory=testInfo.outputPath('user-data');await mkdir(directory,{recursive:true});
 let application,page;
 async function start() {
  const env={...process.env,SIYUE_AUTH_URL:address+'/v1',SIYUE_DATA_DIR:directory,SIYUE_RENDERER_URL:''};delete env.ELECTRON_RUN_AS_NODE;
  application=await _electron.launch({executablePath:require('electron'),args:[path.join(root,'apps/desktop')],cwd:root,env,chromiumSandbox:true,timeout:30_000});
  page=await application.firstWindow();await expect(page.getByText(/离线可用|Available offline/).first()).toBeVisible();
 }
 async function command(operation,payload={},generation=0) {
  return page.evaluate(({operation,payload,generation})=>window.siyueDesktop.auth({version:1,requestId:crypto.randomUUID(),operation,payload,generation}),{operation,payload,generation});
 }
 try {
  await start();expect(await application.evaluate(({safeStorage})=>safeStorage.isEncryptionAvailable())).toBe(true);
  await expect.poll(async()=>(await command('state')).data?.status).toBe('anonymous');
  const before=await command('state');expect(before.ok).toBe(true);expect(before.data.status).toBe('anonymous');
  const logged=await command('login',{email:account.address,password},before.data.generation);
  expect(logged.ok).toBe(true);expect(logged.data.status).toBe('authenticated');expect(logged.data.session.subjectId).toBe(account.tokens.session.subjectId);
  expect(JSON.stringify(logged)).not.toMatch(/accessToken|refreshToken/);
  const parallel=await Promise.all(Array.from({length:10},()=>command('session',{},logged.data.generation)));
  expect(parallel.every(result=>result.ok&&result.data.sessionId===logged.data.session.sessionId)).toBe(true);
  const methods=await command('login-methods',{},logged.data.generation);
  expect(methods.ok).toBe(true);expect(methods.data.items.map(item=>item.kind)).toEqual(['email_password']);
  expect(methods.data.items[0]).toMatchObject({kind:'email_password',status:'active'});
  expect(methods.data.items[0].emailMask).toBe(`${account.address[0]}•••@${account.address.split('@')[1]}`);
  expect(JSON.stringify(methods)).not.toMatch(/accessToken|refreshToken|Bearer/);
  expect(JSON.stringify(methods)).not.toContain(account.address);
  const impact=await command('deletion-impact',{},logged.data.generation);
  expect(impact.ok).toBe(true);expect(impact.data).toEqual({subjectId:account.tokens.session.subjectId,families:[],guardianships:[],activeChildDeviceCount:0});
  const progress=await command('deletion-status',{},logged.data.generation);
  expect(progress.ok).toBe(true);expect(progress.data).toBeNull();
  const injected=await command('submit-deletion',{currentPassword:password,dependencyDisposition:{kind:'none'},reauthGrant:'injected'},logged.data.generation);
  expect(injected.error).toBe('invalid_request');
  const overdrawn=await command('login-methods',{token:'synthetic',url:'https://evil.invalid'},logged.data.generation);
  expect(overdrawn.error).toBe('invalid_request');
  const file=await readFile(path.join(directory,'auth/development/recovery.enc'));expect(file.includes(Buffer.from(password))).toBe(false);expect(file.includes(Buffer.from('refreshToken'))).toBe(false);
  const stale=await command('logout',{},before.data.generation);expect(stale.error).toBe('cancelled');
  const forged=await command('fetch',{url:'https://evil.invalid'},logged.data.generation);expect(forged.error).toBe('invalid_request');
  await application.close();application=undefined;await start();
  await expect.poll(async()=>(await command('state')).data?.status).toBe('authenticated');
  const restored=await command('state');expect(restored.data.status).toBe('authenticated');expect(restored.data.session.subjectId).toBe(account.tokens.session.subjectId);
  expect((await command('session',{},restored.data.generation)).data.sessionId).toBe(restored.data.session.sessionId);
  const logout=await command('logout',{},restored.data.generation);expect(logout.data).toEqual({local:true,server:'confirmed'});
  await application.close();application=undefined;await start();await expect.poll(async()=>(await command('state')).data?.status).toBe('anonymous');
  const signedOut=await command('state');expect(signedOut.data.status).toBe('anonymous');
  const denied=await command('login-methods',{},signedOut.data.generation);
  expect(denied.ok).toBe(false);expect(denied.error).toBe('reauth_required');
 expect(JSON.stringify(denied)).not.toMatch(/accessToken|refreshToken|Bearer/);
 }finally{await application?.close();await server.close();await db.stop();}
});

// The one account write the desktop exposes is unbinding the email login method. It is bounded on
// both sides of the bridge: the renderer hands back the strict `email:` handle the summary returned
// plus the account's current password, the password re-verification, the single-use `unlink-identity`
// grant and the bearer stay inside the main process, and the reply is public state only. Real HTTP
// against the real runtime over a temporary PostgreSQL cluster, with the synthetic Apple repository.
test('real Electron unbinds the email method through restricted IPC and keeps the remaining way in',async({},testInfo)=>{
 const db=await startPostgresFixture();const fx=await createEmailFixture(db);const apples=createAppleIdentityStorage(fx.cipher,'app.siyue.e2e.desktop.unlink');
 const server=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email});const address=await server.listen({host:'127.0.0.1',port:0});
 // One adult subject with two usable login methods, built by the real identity repository and the
 // real link flow: an Apple identity, then a verified address with the account's first password.
 const identity=await transaction(db.app,client=>apples.resolve(client,{identity:{provider:'apple',subject:`synthetic-${randomUUID()}`,clientId:'app.siyue.synthetic'},refreshToken:`synthetic-refresh-${randomUUID()}`}));
 const seeded=await transaction(db.app,client=>fx.service.issue(client,identity.subjectId,randomUUID(),'apple'));
 const linkGrant=await transaction(db.app,client=>fx.service.issueReauth(client,seeded.session.sessionId,'link-identity'));
const linkedAddress='electron.unlink@example.test',linkPassword='  desktop-unlink7  ';
 const challenge=await fx.email.linkRequest(seeded.accessToken,{email:linkedAddress,locale:'zh-CN',reauthGrant:linkGrant.reauthGrant},randomUUID(),fx.context);
 const mailed=(await db.app.query('SELECT * FROM siyue.outbox_jobs WHERE aggregate_id=$1',[challenge.challengeId])).rows[0];
 await fx.email.linkConfirm(seeded.accessToken,{challengeId:challenge.challengeId,requestSecret:challenge.requestSecret,code:fx.cipher.open(mailed.payload_ciphertext,`mail:${mailed.id}`).code,newPassword:linkPassword},randomUUID(),fx.context);
 const handle=`email:${(await db.app.query('SELECT id FROM siyue.account_emails WHERE subject_id=$1',[identity.subjectId])).rows[0].id}`;
 // A second, email-only account proves the last-method refusal travels back through the same bridge.
 const single=await fx.register('electron.unlink.email-only@example.test');
 const count=(sql,...params)=>db.app.query(sql,params).then(result=>Number(result.rows[0].n));
 const directory=testInfo.outputPath('user-data');await mkdir(directory,{recursive:true});
 let application,page;
 async function start() {
  const env={...process.env,SIYUE_AUTH_URL:address+'/v1',SIYUE_DATA_DIR:directory,SIYUE_RENDERER_URL:''};delete env.ELECTRON_RUN_AS_NODE;
  application=await _electron.launch({executablePath:require('electron'),args:[path.join(root,'apps/desktop')],cwd:root,env,chromiumSandbox:true,timeout:30_000});
  page=await application.firstWindow();await expect(page.getByText(/离线可用|Available offline/).first()).toBeVisible();
 }
 async function command(operation,payload={},generation=0) {
  return page.evaluate(({operation,payload,generation})=>window.siyueDesktop.auth({version:1,requestId:crypto.randomUUID(),operation,payload,generation}),{operation,payload,generation});
 }
 try {
  await start();
  await expect.poll(async()=>(await command('state')).data?.status).toBe('anonymous');
  const before=await command('state');
  const logged=await command('login',{email:linkedAddress,password:linkPassword},before.data.generation);
  expect(logged.ok).toBe(true);expect(logged.data.status).toBe('authenticated');expect(logged.data.session.subjectId).toBe(identity.subjectId);
  const methods=await command('login-methods',{},logged.data.generation);
  expect(methods.ok).toBe(true);expect(methods.data.items.map(item=>item.kind).sort()).toEqual(['apple','email_password']);
  expect(methods.data.items.find(item=>item.kind==='email_password').identityId).toBe(handle);
  // Nothing but that handle and the password may travel: a grant, a token, an Apple handle, a bare
  // row id, a URL or a password outside the account rule is refused before the method is touched.
  for(const payload of [
   {identityId:handle,currentPassword:linkPassword,reauthGrant:`${randomUUID()}.${'A'.repeat(43)}`},
   {identityId:handle,currentPassword:linkPassword,accessToken:'synthetic'},
   {identityId:handle,currentPassword:linkPassword,url:'https://evil.invalid'},
   {identityId:`apple:${identity.identityId}`,currentPassword:linkPassword},{identityId:identity.identityId,currentPassword:linkPassword},
   {identityId:handle,currentPassword:'short'},{identityId:handle},
  ]) expect((await command('unlink-identity',payload,logged.data.generation)).error).toBe('invalid_request');
  expect((await command('login-methods',{},logged.data.generation)).data.items).toHaveLength(2);
  const unlinked=await command('unlink-identity',{identityId:handle,currentPassword:linkPassword},logged.data.generation);
  expect(unlinked.ok).toBe(true);expect(unlinked.data.status).toBe('anonymous');expect(unlinked.generation).toBeGreaterThan(logged.data.generation);
  // The reply is the bounded public state and nothing else: no grant, no token, no extra field, and
  // none of the secrets the call spent.
  for(const key of Object.keys(unlinked.data)) expect(['account','deletionPending','error','generation','passwordChangePending','pendingRevocations','session','status']).toContain(key);
  expect(unlinked.data.session).toBeNull();expect(unlinked.data.account).toBeNull();
  const reply=JSON.stringify(unlinked);
  for(const secret of [linkPassword,linkedAddress,handle,seeded.accessToken,seeded.refreshToken,linkGrant.reauthGrant]) expect(reply.includes(secret)).toBe(false);
  // Server state: the method and its password are gone, the Apple identity and its credential stay,
  // every session of the subject is revoked, and the removed address got its own security notice.
  expect(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',identity.subjectId)).toBe(0);
  expect(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',identity.subjectId)).toBe(0);
  expect(await count('SELECT count(*)::int AS n FROM siyue.external_identities WHERE subject_id=$1 AND status=$2',identity.subjectId,'active')).toBe(1);
  expect(await count('SELECT count(*)::int AS n FROM siyue.apple_provider_credentials WHERE identity_id=$1',identity.identityId)).toBe(1);
  expect(await count('SELECT count(*)::int AS n FROM siyue.auth_sessions WHERE subject_id=$1 AND revoked_at IS NULL',identity.subjectId)).toBe(0);
  const notices=(await db.app.query("SELECT * FROM siyue.outbox_jobs WHERE kind='security-notice' AND aggregate_id=$1",[identity.subjectId])).rows;
  expect(notices).toHaveLength(1);
  expect(fx.cipher.open(notices[0].payload_ciphertext,`mail:${notices[0].id}`)).toEqual({template:'email-unlinked',to:linkedAddress,locale:'zh-CN'});
  // The removed method is really gone: no method read without a session, and no second sign-in with
  // the same address and password on this device.
  const signedOut=await command('state');expect(signedOut.data.status).toBe('anonymous');
  expect((await command('login-methods',{},signedOut.data.generation)).error).toBe('reauth_required');
  const removed=await command('login',{email:linkedAddress,password:linkPassword},signedOut.data.generation);
  expect(removed.ok).toBe(false);expect(removed.error).toBe('invalid_credentials');
  // An account that would lose its only way to sign in keeps it, and stays signed in.
  const retryState=await command('state');
  const other=await command('login',{email:single.address,password},retryState.data.generation);
  expect(other.ok).toBe(true);expect(other.data.status).toBe('authenticated');
  const onlyHandle=(await command('login-methods',{},other.data.generation)).data.items[0].identityId;
  const refused=await command('unlink-identity',{identityId:onlyHandle,currentPassword:password},other.data.generation);
  expect(refused).toEqual({version:1,requestId:refused.requestId,ok:false,error:'last_method_required',retryAfterSeconds:0});
  const kept=await command('state');
  expect(kept.data.status).toBe('authenticated');expect(kept.data.session.subjectId).toBe(single.tokens.session.subjectId);
  expect((await command('login-methods',{},kept.data.generation)).data.items.map(item=>item.kind)).toEqual(['email_password']);
  expect(await count('SELECT count(*)::int AS n FROM siyue.account_emails WHERE subject_id=$1',single.tokens.session.subjectId)).toBe(1);
  expect(await count('SELECT count(*)::int AS n FROM siyue.password_credentials WHERE subject_id=$1',single.tokens.session.subjectId)).toBe(1);
 }finally{await application?.close();await server.close();await db.stop();}
});
