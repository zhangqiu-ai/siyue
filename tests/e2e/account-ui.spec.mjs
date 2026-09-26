import {test,expect} from 'playwright/test';
import {_electron} from 'playwright';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createEmailFixture,password} from '../../apps/server/tests/integration/email-fixture.mjs';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';
import {transaction} from '../../apps/server/dist/adapters/postgres/database.js';
const root=path.resolve(import.meta.dirname,'../..'),require=createRequire(path.join(root,'apps/desktop/package.json'));
for(const locale of ['zh','en'])test(`${locale} actual account UI: validation, reset, sign in, restart and sign out`,async({},info)=>{
 const db=await startPostgresFixture(),fx=await createEmailFixture(db);
 const server=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email});
 let loseReset=locale==='en',loseChange=locale==='en',providersUnavailable=locale==='zh';const resetKeys=[],changeKeys=[];
 server.addHook('onSend',async(request,reply,payload)=>{
  if(request.url==='/v1/auth/providers'&&providersUnavailable){reply.code(503);return JSON.stringify({error:{code:'AUTH_TEMPORARILY_UNAVAILABLE'}});}
  if(request.url==='/v1/auth/email/password/reset/confirm'){
   resetKeys.push(request.headers['idempotency-key']);
   if(loseReset&&reply.statusCode===204){loseReset=false;reply.code(503);return JSON.stringify({error:{code:'AUTH_TEMPORARILY_UNAVAILABLE'}});}
  }
  if(request.url==='/v1/me/password/change'){
   changeKeys.push(request.headers['idempotency-key']);
   if(loseChange&&reply.statusCode===204){loseChange=false;reply.code(503);return JSON.stringify({error:{code:'AUTH_TEMPORARILY_UNAVAILABLE'}});}
  }
  return payload;
 });
 const address=await server.listen({host:'127.0.0.1',port:0});
 await fx.register(`${locale}@example.test`);fx.advance(61000);
 const dir=info.outputPath('user-data');await mkdir(dir,{recursive:true});let app,page;
 const en=locale==='en',labels={settings:en?'Settings':'设置',account:en?'Account':'账号',email:en?'Email':'邮箱',password:en?'Password':'密码',login:en?'Sign in':'登录',close:en?'Close':'关闭'};
 async function start(){
  const env={...process.env,SIYUE_DATA_DIR:dir,SIYUE_AUTH_URL:address+'/v1',SIYUE_RENDERER_URL:''};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:require('electron'),args:[path.join(root,'apps/desktop')],cwd:root,env,chromiumSandbox:true,timeout:30000});page=await app.firstWindow();
  await app.context().tracing.start({screenshots:true,snapshots:true});
  await expect(page.locator('.local-badge')).toBeVisible();
 }
 async function account(){await page.getByRole('button',{name:labels.settings,exact:true}).click();await page.getByRole('button',{name:labels.account,exact:true}).click();}
 async function close(){if(!app)return;await app.context().tracing.stop({path:info.outputPath(`trace-${Date.now()}.zip`)});await app.close();app=undefined;}
 try{
  await start();if(en){await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'English',exact:true}).click();await page.getByRole('button',{name:'Close',exact:true}).click();await page.emulateMedia({colorScheme:'dark'});}
  await account();
  if(en){
   try{await expect(page.getByLabel(labels.email,{exact:true})).toBeVisible({timeout:1500});}
   catch{await expect(page.getByRole('alert')).toContainText('Account service is unavailable');await page.getByRole('button',{name:'Retry',exact:true}).click();}
  }
  if(!en){
   await expect(page.getByRole('alert')).toContainText('账号服务暂不可用');
   await expect(page.getByText('账号服务暂不可用，请稍后重试。',{exact:true})).toHaveCount(1);
   await expect(page.getByLabel(labels.email,{exact:true})).toHaveCount(0);
   providersUnavailable=false;await page.getByRole('button',{name:'重试',exact:true}).click();
  }
  await expect(page.getByLabel(labels.email,{exact:true})).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCSS('background-color',en?'rgb(32, 42, 35)':'rgb(255, 254, 250)');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(900,640));
  await page.getByRole('button',{name:labels.login,exact:true}).click();await expect(page.getByRole('alert')).toContainText(en?'valid email':'有效邮箱');
  await page.getByLabel(labels.email,{exact:true}).fill(`${locale}@example.test`);await page.getByLabel(labels.password,{exact:true}).fill('incorrect synthetic password');
  await page.getByRole('button',{name:labels.login,exact:true}).click();await expect(page.getByRole('alert')).toContainText(en?'incorrect':'不正确');
  await page.screenshot({path:info.outputPath('login-error.png')});
  await page.getByRole('button',{name:en?'Forgot password':'忘记密码',exact:true}).click();
  await page.getByRole('button',{name:en?'Send code':'发送验证码',exact:true}).click();
  await expect(page.getByLabel(en?'Six-digit code':'六位验证码',{exact:true})).toBeVisible();
  const job=(await db.app.query("SELECT * FROM siyue.outbox_jobs WHERE payload_ciphertext IS NOT NULL AND aggregate_id IN(SELECT id FROM siyue.email_challenges WHERE purpose='password-reset') ORDER BY created_at DESC LIMIT 1")).rows[0];
  const otp=fx.cipher.open(job.payload_ciphertext,`mail:${job.id}`).code,newPassword='account-ui-new-pw7';
  await page.getByLabel(en?'Six-digit code':'六位验证码',{exact:true}).fill(otp);
  await page.getByLabel(en?'New password':'新密码',{exact:true}).fill(newPassword);
  await page.getByLabel(en?'Repeat new password':'再次输入新密码',{exact:true}).fill('different synthetic password');
  await page.getByRole('button',{name:en?'Set new password':'设置新密码',exact:true}).click();await expect(page.getByRole('alert')).toContainText(en?'do not match':'不同');
  await page.getByLabel(en?'Repeat new password':'再次输入新密码',{exact:true}).fill(newPassword);
  await page.getByRole('button',{name:en?'Set new password':'设置新密码',exact:true}).click();
  if(en){
   await expect(page.getByRole('status')).toContainText('result is not confirmed');
   await expect(page.getByLabel('New password',{exact:true})).toBeDisabled();
   await page.getByRole('button',{name:'Retry this operation',exact:true}).click();
   await expect.poll(()=>resetKeys.length).toBe(2);expect(resetKeys[0]).toBe(resetKeys[1]);
  }
  await expect(page.getByRole('status')).toContainText(en?'Password updated':'密码已更新');
  await page.getByRole('button',{name:en?'Back to sign in':'返回登录',exact:true}).click();await expect(page.getByLabel(labels.password,{exact:true})).toHaveValue('');
  await page.getByLabel(labels.password,{exact:true}).fill(newPassword);await page.getByRole('button',{name:labels.login,exact:true}).click();
  await expect(page.getByRole('status')).toHaveText(en?'Signed in':'已登录');await page.screenshot({path:info.outputPath('signed-in.png')});
  const changedPassword='account-ui-chg-pw8';
  await page.getByLabel(en?'Current password':'当前密码',{exact:true}).fill(newPassword);
  await page.getByLabel(en?'New password':'新密码',{exact:true}).last().fill(changedPassword);
  await page.getByLabel(en?'Current password':'当前密码',{exact:true}).fill('incorrect current password');
  await page.getByLabel(en?'Confirm new password':'确认新密码',{exact:true}).fill(changedPassword);
  await page.getByRole('button',{name:en?'Change password':'修改密码',exact:true}).last().click();
  await expect(page.getByRole('alert')).toContainText(en?'incorrect':'不正确');
  await page.getByLabel(en?'Current password':'当前密码',{exact:true}).fill(newPassword);
  await page.getByLabel(en?'Confirm new password':'确认新密码',{exact:true}).fill('different synthetic password');
  await page.getByRole('button',{name:en?'Change password':'修改密码',exact:true}).last().click();
  await expect(page.getByRole('alert')).toContainText(en?'do not match':'不同');
  await page.getByLabel(en?'Confirm new password':'确认新密码',{exact:true}).fill(changedPassword);
  await page.getByRole('button',{name:en?'Change password':'修改密码',exact:true}).last().click();
  if(en){
   await expect.poll(()=>changeKeys.length,{timeout:12000}).toBe(1);
   await expect(page.getByText('The result is not confirmed. Retry uses the same request; closing does not undo an operation already processed by the server.',{exact:true})).toBeVisible();
   await expect(page.getByLabel(en?'New password':'新密码',{exact:true}).last()).toBeDisabled();
   await page.getByRole('button',{name:'Close',exact:true}).click();await account();
   await expect(page.getByRole('button',{name:'Retry this operation',exact:true})).toBeEnabled();
   await page.getByRole('button',{name:'Retry this operation',exact:true}).click();
   await expect.poll(()=>changeKeys.length).toBe(2);expect(changeKeys[0]).toBe(changeKeys[1]);
  }
  await expect(page.getByText(en?'Password updated. All device sessions were signed out. Sign in with your new password.':'密码已更新，所有设备会话已退出。请使用新密码登录。',{exact:true})).toBeVisible();
  await expect.poll(async()=>(await db.app.query('SELECT id FROM siyue.auth_sessions WHERE revoked_at IS NULL')).rowCount).toBe(0);
  const subjectId=(await db.app.query("SELECT id FROM siyue.subjects WHERE display_name='' ORDER BY created_at DESC LIMIT 1")).rows[0].id;
  expect((await db.app.query("SELECT count(*) FROM siyue.security_events WHERE event_type='password.change' AND subject_id=$1",[subjectId])).rows[0].count).toBe('1');
  expect((await db.app.query('SELECT credential_version FROM siyue.subjects WHERE id=$1',[subjectId])).rows[0].credential_version).toBe(3);
  await page.getByLabel(labels.email,{exact:true}).fill(`${locale}@example.test`);
  await page.getByLabel(labels.password,{exact:true}).fill(changedPassword);await page.getByRole('button',{name:labels.login,exact:true}).click();
  await expect(page.getByRole('status')).toHaveText(en?'Signed in':'已登录');
  await close();await start();await account();await expect(page.getByRole('status')).toHaveText(en?'Signed in':'已登录');
  const synthetic=await transaction(db.app,client=>fx.service.issue(client,subjectId,randomUUID(),'email'));
  await db.app.query("UPDATE siyue.auth_sessions SET platform='desktop',device_label='Synthetic Test Device' WHERE id=$1",[synthetic.session.sessionId]);
  await page.getByRole('button',{name:en?'Manage signed-in devices':'管理登录设备',exact:true}).click();
  await expect(page.getByText('Synthetic Test Device',{exact:true})).toBeVisible();
  await page.getByRole('listitem').filter({hasText:'Synthetic Test Device'}).scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('device-sessions.png')});
  await page.getByLabel(en?'Current email password':'当前邮箱密码',{exact:true}).fill(changedPassword);
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('listitem').filter({hasText:'Synthetic Test Device'}).getByRole('button',{name:en?'Sign out other device':'撤销此设备'}).click();
  await expect(page.getByText('Synthetic Test Device',{exact:true})).toHaveCount(0);
  await expect.poll(async()=>(await db.app.query('SELECT revoked_at FROM siyue.auth_sessions WHERE id=$1',[synthetic.session.sessionId])).rows[0].revoked_at).not.toBeNull();
  await expect(page.getByRole('status').filter({hasText:en?'Signed in':'已登录'})).toBeVisible();
  await page.getByRole('button',{name:en?'Sign out':'退出登录',exact:true}).click();await expect(page.getByLabel(labels.email,{exact:true})).toBeVisible();
  await expect(page.getByLabel(labels.email,{exact:true})).toHaveValue('');
  await expect.poll(async()=>(await db.app.query('SELECT id FROM siyue.auth_sessions WHERE revoked_at IS NULL')).rowCount).toBe(0);
  await page.getByRole('button',{name:labels.close,exact:true}).click();await expect(page.locator('.local-badge')).toBeVisible();
 }finally{await close();await server.close();await db.stop();}
});
