import {test,expect} from 'playwright/test';
import {_electron} from 'playwright';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

// Explicit opt-in acceptance against the fixed production host. The operator supplies one dedicated
// test account in a private file and delivers its REAL mailbox code to code.txt. No database code
// extraction, test endpoint, mock provider or auth URL override is available in this scenario.
// Deliberately no traces/screenshots while credentials are entered.
const root=path.resolve(import.meta.dirname,'../..');
const require=createRequire(path.join(root,'apps/desktop/package.json'));
const directory=process.env.SIYUE_ONLINE_ACCEPTANCE_DIR;
test('real public email registration, restart, login and account deletion',async({},info)=>{
 test.skip(!directory,'Explicit SIYUE_ONLINE_ACCEPTANCE_DIR is required; this test sends real email and deletes only its dedicated test account.');
 test.setTimeout(360_000);
 const config=JSON.parse(await readFile(path.join(directory,'input.json'),'utf8'));
 if(!/^[a-z0-9._%-]+\+siyue-qa-[a-z0-9-]+@gmail\.com$/i.test(config.email)||typeof config.password!=='string'||config.password.length<20)
  throw Error('dedicated_acceptance_identity_required');
 const data=path.join(directory,'electron-data');await mkdir(data,{recursive:true,mode:0o700});
 let app,page,subject;
 async function phase(value,extra={}){await writeFile(path.join(directory,'state.json'),JSON.stringify({phase:value,...extra}),{mode:0o600});}
 async function start(){const env={...process.env,SIYUE_DATA_DIR:data,SIYUE_RENDERER_URL:''};delete env.ELECTRON_RUN_AS_NODE;delete env.SIYUE_AUTH_URL;
  app=await _electron.launch({executablePath:require('electron'),args:[path.join(root,'apps/desktop')],cwd:root,env,chromiumSandbox:true,timeout:30000});
  page=await app.firstWindow();await expect(page.locator('.local-badge')).toBeVisible();
 }
 async function openAccount(){await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'账号',exact:true}).click();}
 async function publicState(){return page.evaluate(async()=>{const reply=await window.siyueDesktop.auth({version:1,requestId:crypto.randomUUID(),generation:0,operation:'state',payload:{}});if(!reply.ok)throw Error('state_failed');return {status:reply.data.status,subjectId:reply.data.account?.subjectId??null};});}
 async function close(){if(app){await app.close();app=undefined;}}
 try{
  await start();await openAccount();await page.getByRole('button',{name:'注册',exact:true}).click();
  await page.getByLabel('邮箱',{exact:true}).fill(config.email);
  await page.getByRole('checkbox').check();
  const terms=page.getByRole('link',{name:'用户协议',exact:true});await expect(terms).toHaveAttribute('href','https://api.qiugeapp.com/api/siyue/legal/terms.html');
  await page.getByRole('button',{name:'发送验证码',exact:true}).click();
  await expect(page.getByLabel('六位验证码',{exact:true})).toBeVisible();await phase('awaiting_mailbox_code');
  let code;
  await expect.poll(async()=>{try{code=(await readFile(path.join(directory,'code.txt'),'utf8')).trim();return /^\d{6}$/.test(code);}catch{return false;}},{timeout:180_000,intervals:[1000,2000,3000]}).toBe(true);
  await page.getByLabel('六位验证码',{exact:true}).fill(code);await unlink(path.join(directory,'code.txt'));code=undefined;
  await page.getByLabel('密码',{exact:true}).fill(config.password);await page.getByLabel('再次输入新密码',{exact:true}).fill(config.password);
  await page.getByRole('button',{name:'创建账号',exact:true}).click();await expect(page.getByRole('status')).toHaveText('已登录');
  subject=(await publicState()).subjectId;expect(subject).toMatch(/^[0-9a-f-]{36}$/);await phase('registered',{subjectId:subject});
  await close();await start();await openAccount();await expect(page.getByRole('status')).toHaveText('已登录');expect((await publicState()).subjectId).toBe(subject);await phase('restart_restored',{subjectId:subject});
  await page.getByRole('button',{name:'退出登录',exact:true}).click();await expect(page.getByLabel('邮箱',{exact:true})).toBeVisible();
  await page.getByLabel('邮箱',{exact:true}).fill(config.email);await page.getByLabel('密码',{exact:true}).fill(config.password);await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('已登录');expect((await publicState()).subjectId).toBe(subject);await phase('password_login_verified',{subjectId:subject});
  await page.getByRole('button',{name:'注销账号',exact:true}).click();await page.getByRole('button',{name:'查看影响并继续',exact:true}).click();
  await expect(page.getByText('没有受影响的家庭或儿童设备。',{exact:true})).toBeVisible();
  await page.getByLabel(/的密码确认$/).fill(config.password);await page.getByRole('checkbox',{name:'我确认以上家庭处置，并同意注销账号。',exact:true}).check();
  await page.getByRole('button',{name:'提交注销请求',exact:true}).click();await expect(page.getByRole('heading',{name:'注销处理进度',exact:true})).toBeVisible();
  await expect.poll(async()=>{if(await page.getByText('已受理并完成',{exact:true}).isVisible())return true;await page.getByRole('button',{name:'刷新进度',exact:true}).click();return false;},{timeout:90_000,intervals:[2000,5000]}).toBe(true);
  await phase('deletion_completed',{subjectId:subject});await close();await start();await openAccount();
  await expect.poll(async()=>(await publicState()).subjectId).toBe(null);
  await page.getByLabel('邮箱',{exact:true}).fill(config.email);await page.getByLabel('密码',{exact:true}).fill(config.password);await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('不正确');expect((await publicState()).subjectId).toBe(null);
  await phase('passed',{subjectId:subject,realMailbox:true,restartRestored:true,passwordLogin:true,deletionCompleted:true,deletedLoginRejected:true});
 }catch(error){await phase('failed',{subjectId:subject??null,errorName:error?.name??'Error'});throw error;}finally{await close();}
});
