import {test,expect} from 'playwright/test';
import {_electron} from 'playwright';
import {createRequire} from 'node:module';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createEmailFixture} from '../../apps/server/tests/integration/email-fixture.mjs';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';
import {disabledRegistrationPolicy} from '../../apps/server/dist/registration-policy.js';

// The registration panel is the only place the desktop asks for an email code as a stranger: it reads
// the released terms/privacy versions, refuses to send anything before they are accepted, and creates
// the account with the versions the server published. These run the real Electron main process, the
// real restricted auth IPC bridge and the real HTTP runtime over a temporary PostgreSQL cluster, so a
// passing screen here means the released documents, the challenge and the session really agreed.
const root=path.resolve(import.meta.dirname,'../..'),require=createRequire(path.join(root,'apps/desktop/package.json'));
const published={enabled:true,terms:{version:'terms-2026-09-25',url:'https://siyue.test/terms'},privacy:{version:'privacy-2026-09-25',url:'https://siyue.test/privacy'}};
const address='register-ui@example.test',finalAddress='register-ui-final@example.test',accountPassword='  注册账号-🌙-siyue-registration  ',shortPassword='short password';
const zh={settings:'设置',account:'账号',email:'邮箱',password:'密码',code:'六位验证码',repeatPassword:'再次输入新密码',register:'注册',sendCode:'发送验证码',createAccount:'创建账号',changeEmail:'修改邮箱',backLogin:'返回登录',retry:'重试',terms:'用户协议',privacy:'隐私政策'};
const en={settings:'Settings',account:'Account',email:'Email',password:'Password',code:'Six-digit code',repeatPassword:'Repeat new password',register:'Sign up',sendCode:'Send code',createAccount:'Create account',changeEmail:'Change email',backLogin:'Back to sign in',retry:'Retry',terms:'Terms of Use',privacy:'Privacy Policy'};

const challengeCount=async(db,purpose='register')=>(await db.app.query('SELECT id FROM siyue.email_challenges WHERE purpose=$1',[purpose])).rowCount;
// The fixture clock is a fixed clock, so two addresses requested in the same run share one timestamp:
// the released code is the newest pending challenge of that address, not simply the newest row.
async function latestCode(db,fx,email){let code='';
 await expect.poll(async()=>{
  const job=(await db.app.query("SELECT j.* FROM siyue.outbox_jobs j JOIN siyue.email_challenges c ON c.id=j.aggregate_id WHERE c.purpose='register' AND c.status='pending' AND c.email_normalized=$1 AND j.payload_ciphertext IS NOT NULL ORDER BY c.created_at DESC LIMIT 1",[email])).rows[0];
  if(!job)return '';
  code=fx.cipher.open(job.payload_ciphertext,`mail:${job.id}`).code;return code;
 }).toMatch(/^\d{6}$/);
 return code;
}

function launch({server,dir}) {const env={...process.env,SIYUE_DATA_DIR:dir,SIYUE_AUTH_URL:server+'/v1',SIYUE_RENDERER_URL:''};delete env.ELECTRON_RUN_AS_NODE;
 return _electron.launch({executablePath:require('electron'),args:[path.join(root,'apps/desktop')],cwd:root,env,chromiumSandbox:true,timeout:30_000});}

test('real Electron registration: consent gate, released policy, wrong code, a lost answer repeated with the same key, and a real session',async({},info)=>{
 const db=await startPostgresFixture(),fx=await createEmailFixture(db,{registrationPolicy:published});
 const server=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email,registrationPolicy:published});
 // One confirmation loses its answer after the server has already committed the account. The panel must
 // offer to repeat that same request key, not start a second account or lock the primary action.
 const confirmKeys=[];let loseConfirm=true;
 server.addHook('onSend',async(request,reply,payload)=>{
  if(request.url==='/v1/auth/email/register/confirm') {
   confirmKeys.push(request.headers['idempotency-key']);
   if(loseConfirm&&reply.statusCode===201){loseConfirm=false;reply.code(503);return JSON.stringify({error:{code:'AUTH_TEMPORARILY_UNAVAILABLE'}});}
  }
  return payload;
 });
 const origin=await server.listen({host:'127.0.0.1',port:0});
 const dir=info.outputPath('user-data');await mkdir(dir,{recursive:true});let app,page;
 async function start(){app=await launch({server:origin,dir});page=await app.firstWindow();await app.context().tracing.start({screenshots:true,snapshots:true});await expect(page.locator('.local-badge')).toBeVisible();}
 try {
  await start();
  await page.getByRole('button',{name:zh.settings,exact:true}).click();await page.getByRole('button',{name:zh.account,exact:true}).click();
  // The entry belongs to the sign-in form; the released documents are not part of it until it is used.
  const entry=page.getByRole('button',{name:zh.register,exact:true});
  await expect(entry).toBeVisible();await expect(page.getByRole('link',{name:zh.terms,exact:true})).toHaveCount(0);
  await entry.click();
  await expect(page.getByRole('heading',{name:zh.register,exact:true})).toBeVisible();
  const terms=page.getByRole('link',{name:zh.terms,exact:true});
  await expect(terms).toHaveAttribute('href',published.terms.url);
  await expect(page.getByRole('link',{name:zh.privacy,exact:true})).toHaveAttribute('href',published.privacy.url);
  // The released document points at its HTTPS address, and activating it never replaces the form.
  await terms.click();expect(app.windows()).toHaveLength(1);
  await expect(page.getByRole('heading',{name:zh.register,exact:true})).toBeVisible();
  const consent=page.getByRole('checkbox',{name:/我已阅读并同意/}),send=page.getByRole('button',{name:zh.sendCode,exact:true});
  await expect(consent).not.toBeChecked();await expect(send).toBeDisabled();
  await page.getByLabel(zh.email,{exact:true}).fill(address);
  // An accepted consent is what releases the code request; an invalid address is refused locally.
  await expect(send).toBeDisabled();expect(await challengeCount(db)).toBe(0);
  await consent.check();
  await page.getByLabel(zh.email,{exact:true}).fill('not-an-address');await send.click();
  await expect(page.getByRole('alert')).toContainText('请输入有效邮箱');expect(await challengeCount(db)).toBe(0);
  await page.getByLabel(zh.email,{exact:true}).fill(address);await send.click();
  await expect(page.getByLabel(zh.code,{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:/重新发送/})).toBeDisabled();
  await expect.poll(()=>challengeCount(db)).toBe(1);
  // Secrets typed into the verification step do not survive leaving it for the sign-in form. The account
  // that follows uses a second address, because the released cooldown is exactly what stops the same
  // address from being sent a second code on demand.
  await page.getByLabel(zh.code,{exact:true}).fill('123456');await page.getByLabel(zh.password,{exact:true}).fill(accountPassword);
  await page.getByRole('button',{name:zh.backLogin,exact:true}).click();
  await expect(entry).toBeVisible();await entry.click();
  await expect(page.getByLabel(zh.email,{exact:true})).toHaveValue('');
  await expect(page.getByLabel(zh.code,{exact:true})).toHaveCount(0);
  await expect(page.getByRole('checkbox',{name:/我已阅读并同意/})).not.toBeChecked();
  await page.getByLabel(zh.email,{exact:true}).fill(finalAddress);await page.getByRole('checkbox',{name:/我已阅读并同意/}).check();
  await page.getByRole('button',{name:zh.sendCode,exact:true}).click();
  await expect(page.getByLabel(zh.code,{exact:true})).toBeVisible();
  const otp=await latestCode(db,fx,finalAddress);
  // The refusal is shown before the server is asked at all, so no account can exist yet.
  await page.getByLabel(zh.password,{exact:true}).fill(shortPassword);await page.getByLabel(zh.repeatPassword,{exact:true}).fill(shortPassword);
  await page.getByRole('button',{name:zh.createAccount,exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('密码需为15–128个字符');
  await page.getByLabel(zh.password,{exact:true}).fill(accountPassword);await page.getByLabel(zh.repeatPassword,{exact:true}).fill('a different long password for register UI');
  await page.getByRole('button',{name:zh.createAccount,exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('两次输入的密码不同');
  await page.getByLabel(zh.repeatPassword,{exact:true}).fill(accountPassword);
  await page.getByLabel(zh.code,{exact:true}).fill(otp==='000000'?'000001':'000000');
  await page.getByRole('button',{name:zh.createAccount,exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('验证码不正确');
  expect((await db.app.query('SELECT count(*) FROM siyue.account_emails')).rows[0].count).toBe('0');
  await page.getByLabel(zh.code,{exact:true}).fill(otp);
  await page.getByRole('button',{name:zh.createAccount,exact:true}).click();
  // The answer was lost after the server committed: the form freezes and the primary action stays usable.
  await expect(page.getByRole('status')).toContainText('请求结果尚未确认');
  const retry=page.getByRole('button',{name:'重试本次操作',exact:true});
  await expect(retry).toBeEnabled();await expect(page.getByLabel(zh.repeatPassword,{exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:zh.changeEmail,exact:true})).toBeDisabled();
  await retry.click();
  await expect(page.getByRole('status')).toContainText('已登录');
  // One confirm per intent: the refused wrong code, then the committed answer and its explicit repeat,
  // which must carry the key of the request whose answer was lost.
  expect(confirmKeys).toHaveLength(3);expect(confirmKeys[0]).not.toBe(confirmKeys[1]);expect(confirmKeys[1]).toBe(confirmKeys[2]);
  expect((await db.app.query('SELECT count(*) FROM siyue.account_emails WHERE email_normalized=$1',[finalAddress])).rows[0].count).toBe('1');
  await expect.poll(async()=>(await db.app.query('SELECT platform FROM siyue.auth_sessions WHERE revoked_at IS NULL')).rows[0]?.platform).toBe('desktop');
  // The password and the code are memory only: neither renderer storage nor the recovery record keeps them.
  const stored=await page.evaluate(()=>{try{return JSON.stringify(Object.entries(localStorage));}catch{return 'storage-unavailable';}});
  expect(stored).not.toContain(accountPassword);expect(stored).not.toContain(otp);
  const vault=await readFile(path.join(dir,'auth/development/recovery.enc'));
  expect(vault.includes(Buffer.from(accountPassword))).toBe(false);expect(vault.includes(Buffer.from(otp))).toBe(false);
  // The account is real: signing out and signing in with the password just set works.
  await page.getByRole('button',{name:'退出登录',exact:true}).click();
  await expect(page.getByLabel(zh.email,{exact:true})).toHaveValue('');
  await page.getByLabel(zh.email,{exact:true}).fill(finalAddress);await page.getByLabel(zh.password,{exact:true}).fill(accountPassword);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('已登录');
 } finally {await app?.close();await server.close();await db.stop();}
});

test('real Electron registration retries the released policy read and sends nothing before it is accepted',async({},info)=>{
 const db=await startPostgresFixture(),fx=await createEmailFixture(db,{registrationPolicy:published});
 const server=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email,registrationPolicy:published});
 // The one public read the panel depends on is unavailable at first: the screen must say so, keep the
 // primary action unusable and let the user read the documents after an explicit retry.
 let hidePolicy=true;
 server.addHook('onSend',async(request,reply,payload)=>{if(request.url==='/v1/auth/registration-policy'&&hidePolicy){hidePolicy=false;reply.code(503);return JSON.stringify({error:{code:'AUTH_TEMPORARILY_UNAVAILABLE'}});}return payload;});
 const origin=await server.listen({host:'127.0.0.1',port:0});
 const dir=info.outputPath('user-data');await mkdir(dir,{recursive:true});let app,page;
 async function start(){app=await launch({server:origin,dir});page=await app.firstWindow();await app.context().tracing.start({screenshots:true,snapshots:true});await expect(page.locator('.local-badge')).toBeVisible();}
 try {
  await start();
  await page.getByRole('button',{name:zh.settings,exact:true}).click();await page.getByRole('button',{name:'English',exact:true}).click();await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.getByRole('button',{name:en.settings,exact:true}).click();await page.getByRole('button',{name:en.account,exact:true}).click();
  await page.getByRole('button',{name:en.register,exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Account service is unavailable');
  await expect(page.getByRole('link',{name:en.terms,exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:en.sendCode,exact:true})).toBeDisabled();
  await page.getByRole('button',{name:en.retry,exact:true}).click();
  await expect(page.getByRole('link',{name:en.terms,exact:true})).toHaveAttribute('href',published.terms.url);
  await expect(page.getByRole('link',{name:en.privacy,exact:true})).toHaveAttribute('href',published.privacy.url);
  await page.getByLabel(en.email,{exact:true}).fill(address);
  await page.getByRole('checkbox',{name:/I have read and agree to the/}).check();
  await page.getByRole('button',{name:en.sendCode,exact:true}).click();
  await expect(page.getByLabel(en.code,{exact:true})).toBeVisible();
  await expect.poll(()=>challengeCount(db)).toBe(1);
 } finally {await app?.close();await server.close();await db.stop();}
});

test('real Electron registration is closed when no terms or privacy version is published',async({},info)=>{
 const db=await startPostgresFixture(),fx=await createEmailFixture(db,{registrationPolicy:disabledRegistrationPolicy});
 const server=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email,registrationPolicy:disabledRegistrationPolicy});
 const origin=await server.listen({host:'127.0.0.1',port:0});
 const dir=info.outputPath('user-data');await mkdir(dir,{recursive:true});let app,page;
 async function start(){app=await launch({server:origin,dir});page=await app.firstWindow();await app.context().tracing.start({screenshots:true,snapshots:true});await expect(page.locator('.local-badge')).toBeVisible();}
 try {
  await start();
  await page.getByRole('button',{name:zh.settings,exact:true}).click();await page.getByRole('button',{name:zh.account,exact:true}).click();
  await page.getByRole('button',{name:zh.register,exact:true}).click();
  await expect(page.getByRole('status')).toContainText('注册暂不可用：服务尚未发布用户协议或隐私政策版本。');
  await expect(page.getByRole('link',{name:zh.terms,exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:zh.sendCode,exact:true})).toBeDisabled();
  await page.getByLabel(zh.email,{exact:true}).fill(address);
  await page.getByRole('checkbox',{name:/我已阅读并同意/}).check();
  await expect(page.getByRole('button',{name:zh.sendCode,exact:true})).toBeDisabled();
  expect(await challengeCount(db)).toBe(0);
  await page.getByRole('button',{name:zh.backLogin,exact:true}).click();
  await expect(page.getByRole('button',{name:zh.register,exact:true})).toBeVisible();
 } finally {await app?.close();await server.close();await db.stop();}
});

// A released version can change between the code request and the confirmation. The server refuses the
// outdated pair, the client drops the documents and the consent that covered them, and the screen returns
// to the address step so the current pair is read and agreed to before anything is requested again.
test('real Electron registration re-reads the released documents when the versions change under the attempt',async({},info)=>{
 const policy={enabled:true,terms:{version:'terms-2026-09-25',url:'https://siyue.test/terms'},privacy:{version:'privacy-2026-09-25',url:'https://siyue.test/privacy'}};
 const db=await startPostgresFixture(),fx=await createEmailFixture(db,{registrationPolicy:policy});
 const server=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email,registrationPolicy:policy});
 const origin=await server.listen({host:'127.0.0.1',port:0});
 const dir=info.outputPath('user-data');await mkdir(dir,{recursive:true});let app,page;
 async function start(){app=await launch({server:origin,dir});page=await app.firstWindow();await app.context().tracing.start({screenshots:true,snapshots:true});await expect(page.locator('.local-badge')).toBeVisible();}
 try {
  await start();
  await page.getByRole('button',{name:zh.settings,exact:true}).click();await page.getByRole('button',{name:zh.account,exact:true}).click();
  await page.getByRole('button',{name:zh.register,exact:true}).click();
  await page.getByLabel(zh.email,{exact:true}).fill(address);await page.getByRole('checkbox',{name:/我已阅读并同意/}).check();
  await page.getByRole('button',{name:zh.sendCode,exact:true}).click();
  await expect(page.getByLabel(zh.code,{exact:true})).toBeVisible();
  const otp=await latestCode(db,fx,address);
  // The released pair changes while the code step is being filled in.
  policy.terms={version:'terms-2026-09-26',url:'https://siyue.test/terms-2026-09-26'};
  await page.getByLabel(zh.code,{exact:true}).fill(otp);await page.getByLabel(zh.password,{exact:true}).fill(accountPassword);await page.getByLabel(zh.repeatPassword,{exact:true}).fill(accountPassword);
  await page.getByRole('button',{name:zh.createAccount,exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('用户协议或隐私政策已更新');
  // Back on the address step with the current documents: no consent, no account and no consent record.
  await expect(page.getByLabel(zh.email,{exact:true})).toHaveValue(address);
  await expect(page.getByRole('checkbox',{name:/我已阅读并同意/})).not.toBeChecked();
  await expect(page.getByRole('button',{name:zh.sendCode,exact:true})).toBeDisabled();
  await expect(page.getByRole('link',{name:zh.terms,exact:true})).toHaveAttribute('href','https://siyue.test/terms-2026-09-26');
  expect((await db.app.query('SELECT count(*) FROM siyue.account_emails')).rows[0].count).toBe('0');
  expect((await db.app.query('SELECT count(*) FROM siyue.account_consents')).rows[0].count).toBe('0');
  // The released cooldown for the first request passes, and the current pair is what gets recorded.
  fx.advance(61000);
  await page.getByRole('checkbox',{name:/我已阅读并同意/}).check();
  await page.getByRole('button',{name:zh.sendCode,exact:true}).click();
  await expect(page.getByLabel(zh.code,{exact:true})).toBeVisible();
  const next=await latestCode(db,fx,address);
  await page.getByLabel(zh.code,{exact:true}).fill(next);await page.getByLabel(zh.password,{exact:true}).fill(accountPassword);await page.getByLabel(zh.repeatPassword,{exact:true}).fill(accountPassword);
  await page.getByRole('button',{name:zh.createAccount,exact:true}).click();
  await expect(page.getByRole('status')).toContainText('已登录');
  expect((await db.app.query('SELECT terms_version,privacy_version FROM siyue.account_consents')).rows[0]).toEqual({terms_version:'terms-2026-09-26',privacy_version:'privacy-2026-09-25'});
 } finally {await app?.close();await server.close();await db.stop();}
});

// A deployment can close sign-up after a code was already requested. That is a decided refusal, not an
// outage: the code step cannot be completed, so the screen leaves it and shows the closed notice.
test('real Electron registration leaves the code step when the deployment closes sign-up',async({},info)=>{
 const policy={enabled:true,terms:{version:'terms-2026-09-25',url:'https://siyue.test/terms'},privacy:{version:'privacy-2026-09-25',url:'https://siyue.test/privacy'}};
 const db=await startPostgresFixture(),fx=await createEmailFixture(db,{registrationPolicy:policy});
 const server=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email,registrationPolicy:policy});
 const origin=await server.listen({host:'127.0.0.1',port:0});
 const dir=info.outputPath('user-data');await mkdir(dir,{recursive:true});let app,page;
 async function start(){app=await launch({server:origin,dir});page=await app.firstWindow();await app.context().tracing.start({screenshots:true,snapshots:true});await expect(page.locator('.local-badge')).toBeVisible();}
 try {
  await start();
  await page.getByRole('button',{name:zh.settings,exact:true}).click();await page.getByRole('button',{name:zh.account,exact:true}).click();
  await page.getByRole('button',{name:zh.register,exact:true}).click();
  await page.getByLabel(zh.email,{exact:true}).fill(address);await page.getByRole('checkbox',{name:/我已阅读并同意/}).check();
  await page.getByRole('button',{name:zh.sendCode,exact:true}).click();
  await expect(page.getByLabel(zh.code,{exact:true})).toBeVisible();
  const otp=await latestCode(db,fx,address);
  policy.enabled=false;policy.terms=null;policy.privacy=null;
  await page.getByLabel(zh.code,{exact:true}).fill(otp);await page.getByLabel(zh.password,{exact:true}).fill(accountPassword);await page.getByLabel(zh.repeatPassword,{exact:true}).fill(accountPassword);
  await page.getByRole('button',{name:zh.createAccount,exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('注册已关闭');
  await expect(page.getByRole('status')).toContainText('注册暂不可用：服务尚未发布用户协议或隐私政策版本。');
  await expect(page.getByRole('button',{name:zh.sendCode,exact:true})).toBeDisabled();
  expect((await db.app.query('SELECT count(*) FROM siyue.account_emails')).rows[0].count).toBe('0');
  expect((await db.app.query('SELECT count(*) FROM siyue.account_consents')).rows[0].count).toBe('0');
 } finally {await app?.close();await server.close();await db.stop();}
});
