import {test,expect} from 'playwright/test';
import {_electron} from 'playwright';
import {createRequire} from 'node:module';
import path from 'node:path';
import {mkdir} from 'node:fs/promises';
import {randomUUID,randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createEmailFixture,password} from '../../apps/server/tests/integration/email-fixture.mjs';
import {createAccountDeletionJobStore} from '../../apps/server/dist/modules/auth/account-deletion-jobs.js';
import {createAccountDeletionImpactService} from '../../apps/server/dist/modules/auth/account-deletion-impact.js';
import {createAccountDeletionAcceptKernel} from '../../apps/server/dist/modules/auth/account-deletion-accept.js';
import {createAccountDeletionIdempotencyStore} from '../../apps/server/dist/modules/auth/account-deletion-idempotency.js';
import {createAccountDeletionSubmission} from '../../apps/server/dist/modules/auth/account-deletion-submission.js';
import {createAccountDeletionGuardedCleanupRunner} from '../../apps/server/dist/modules/auth/account-deletion-guarded-runner.js';
import {createAppleRevocationOutbox} from '../../apps/server/dist/identities/apple/revocation-outbox.js';
import {createAppleRevocationPostgresStore} from '../../apps/server/dist/identities/apple/revocation-postgres.js';
import {createDeletionLedgerStore} from '../../apps/server/dist/account-deletion-ledger/ledger-store.js';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';

let db,fx,ledger,app,url;
const headers=token=>({authorization:`Bearer ${token}`});
test.beforeAll(async()=>{
  db=await startPostgresFixture();fx=await createEmailFixture(db);
  const socket=(await db.admin.query("SELECT current_setting('unix_socket_directories') AS socket")).rows[0].socket;
  const bin=process.env.SIYUE_TEST_POSTGRES_BIN??'/opt/homebrew/opt/postgresql@17/bin';
  execFileSync(`${bin}/psql`,['-h',socket,'-U','siyue_test_admin','-d','postgres','-f',fileURLToPath(new URL('../../apps/server/provision/deletion-ledger.sql',import.meta.url))],{
    env:{...process.env,LC_ALL:'C',SIYUE_DELETION_LEDGER_DATABASE:'siyue_deletion_ledger',SIYUE_DELETION_LEDGER_ENVIRONMENT:'test',SIYUE_DELETION_LEDGER_APP_PASSWORD:randomBytes(32).toString('hex')},stdio:'pipe'});
  ledger=createDeletionLedgerStore(db.poolFor('siyue_deletion_ledger_app','siyue_deletion_ledger'),{database:'siyue_deletion_ledger',environment:'test'},fx.clock);
  const idem=createAccountDeletionIdempotencyStore(db.app,fx.cipher,randomBytes(32),fx.clock);
  const queue=createAppleRevocationOutbox({store:createAppleRevocationPostgresStore(db.app),cipher:fx.cipher,revoke:async()=>{throw Error('unexpected provider');},clock:fx.clock});
  const accept=createAccountDeletionAcceptKernel(db.app,fx.service,createAccountDeletionImpactService(db.app,fx.service,fx.clock),createAccountDeletionJobStore(db.app,fx.clock),queue,ledger,fx.clock,idem);
  app=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email,deletionSubmission:createAccountDeletionSubmission(db.app,accept,idem,ledger)});
  url=await app.listen({host:'127.0.0.1',port:0});
});
test.afterAll(async()=>{await app?.close();await db?.stop();});
async function proof(request,token){const response=await request.post(url+'/v1/auth/reauth/password',{headers:headers(token),data:{password,action:'delete-account'}});expect(response.status()).toBe(200);return (await response.json()).data.reauthGrant;}


const root=path.resolve(import.meta.dirname,'../..'),require=createRequire(path.join(root,'apps/desktop/package.json'));
async function launch(dataDir){
  const env={...process.env,SIYUE_DATA_DIR:dataDir,SIYUE_AUTH_URL:url+'/v1',SIYUE_RENDERER_URL:''};delete env.ELECTRON_RUN_AS_NODE;
  const application=await _electron.launch({executablePath:require('electron'),args:[path.join(root,'apps/desktop')],cwd:root,env,chromiumSandbox:true});
  const page=await application.firstWindow();await expect(page.locator('.local-badge')).toHaveText(/离线可用|Available offline/);return {application,page};
}
async function login(page,account){
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'账号',exact:true}).click();await page.getByLabel('邮箱',{exact:true}).fill(account.address);
  await page.getByLabel('密码',{exact:true}).fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await expect(page.getByText('已登录',{exact:true})).toBeVisible();
}
test('real desktop deletion accepts and restores receipt progress after process restart',async({},info)=>{
  const account=await fx.register(),dir=info.outputPath('user-data');await mkdir(dir,{recursive:true});
  let {application,page}=await launch(dir);
  try{
    await login(page,account);await page.getByRole('button',{name:'注销账号',exact:true}).click();
    await page.getByRole('button',{name:'查看影响并继续',exact:true}).click();
    await page.getByLabel(/^用 .+ 的密码确认$/).fill(password);
    await page.getByLabel('我确认以上家庭处置，并同意注销账号。').check();
    await page.screenshot({path:info.outputPath('deletion-confirm.png')});
    await page.getByRole('button',{name:'提交注销请求',exact:true}).click();
    await expect(page.getByRole('heading',{name:'注销处理进度',exact:true})).toBeVisible();
    await createAccountDeletionGuardedCleanupRunner(db.app,{ledger,clock:fx.clock}).sweep();
    await application.close();({application,page}=await launch(dir));
    await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'账号',exact:true}).click();
    await page.getByRole('button',{name:'注销处理进度',exact:true}).click();
    await expect(page.getByRole('heading',{name:'注销处理进度',exact:true})).toBeVisible();
    await expect(page.getByText('已受理并完成',{exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath('deletion-restored.png')});
  }finally{await application.close();}
});
test('recipient confirms both responsibilities in the product before a candidate becomes accepted',async({},info)=>{
  const owner=await fx.register(),recipient=await fx.register();
  const family=(await app.inject({method:'POST',url:'/v1/families',headers:{...headers(owner.tokens.accessToken),'idempotency-key':randomUUID()}})).json().data.familyId;
  await db.app.query("INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,'member')",[family,recipient.tokens.session.subjectId]);
  const dir=info.outputPath('recipient-data');await mkdir(dir,{recursive:true});const {application,page}=await launch(dir);
  try{
    await login(page,recipient);await page.getByRole('button',{name:'查看家庭责任',exact:true}).click();
    await page.getByRole('button',{name:'查看责任范围',exact:true}).click();
    const confirm=page.getByRole('button',{name:'确认接受责任',exact:true});await expect(confirm).toBeDisabled();
    await page.getByLabel('我接受家庭管理责任',{exact:true}).check();await expect(confirm).toBeDisabled();
    await page.getByLabel('我接受适用的监护责任',{exact:true}).check();await confirm.click();
    await expect(page.getByText('已记录你的接受确认。',{exact:true})).toBeVisible();
    const result=await app.inject({method:'GET',url:`/v1/families/${family}/deletion-recipients`,headers:headers(owner.tokens.accessToken)});
    expect(result.json().data[0].management).toBe('accepted');
    expect((await db.app.query('SELECT owner_subject_id FROM siyue.families WHERE id=$1',[family])).rows[0].owner_subject_id).toBe(owner.tokens.session.subjectId);
  }finally{await application.close();}
});
