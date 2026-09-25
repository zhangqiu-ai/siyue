// Desktop account-deletion UI against the real product path: real Electron renderer, the real preload
// bridge, the real main-process auth controller and vaults, and the real Fastify runtime on an
// isolated temporary PostgreSQL cluster. Nothing here re-implements the flow or the server.
//
// What each case proves, and its limit:
//   * The Chinese case walks the whole surface a person sees: sign in, open the account panel, read the
//     real impact of two real families (one owned with a co-adult, a guarded child and an active child
//     device grant, one where the caller is only a member), settle each family, verify with the account
//     password and submit. The destructive route is deliberately still closed (DELETE /v1/me/account
//     answers 404, see docs/evidence/backend-auth-deletion-groundwork-2026-09-24.md), so the case also
//     proves the "result not confirmed" branch: the panel locks, keeps the original request and repeats
//     it with the same Idempotency-Key instead of starting a second deletion.
//   * The English case checks the same destructive copy in the other required locale, including the
//     platform-capability statement for Apple re-verification on desktop.
//   * The cold-start case seeds one accepted job row and one protected receipt for a previous run, so a
//     fresh process opens on receipt progress, reports the two cleanup dimensions apart, never renders
//     the receipt secret, and follows the same receipt to a completed job. Seeding the receipt is a test
//     fixture for a device that already submitted; the submission itself is not re-created here.
import {test,expect} from 'playwright/test';
import {_electron} from 'playwright';
import {createRequire} from 'node:module';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createEmailFixture,password} from '../../apps/server/tests/integration/email-fixture.mjs';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';
import {transaction} from '../../apps/server/dist/adapters/postgres/database.js';
import {createFamilyRepository} from '../../apps/server/dist/modules/families/repository.js';
import {createGuardianshipService} from '../../apps/server/dist/modules/families/guardianship.js';

const root=path.resolve(import.meta.dirname,'../..'),require=createRequire(path.join(root,'apps/desktop/package.json'));
const day=86_400_000,pepper=randomBytes(32);
let db,fx,server,address,families,guardianship;
/** Destructive submissions the desktop process actually sent: method, path and idempotency key only. */
let deletionRequests;

test.beforeAll(async()=>{
  db=await startPostgresFixture();fx=await createEmailFixture(db);
  families=createFamilyRepository(db.app);guardianship=createGuardianshipService(db.app,fx.service,pepper,fx.clock);
  server=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email});
  // A raw HTTP listener, not a Fastify hook: the closed destructive route is a 404 the framework never
  // routes, and this file still has to observe exactly how many attempts left the renderer.
  deletionRequests=[];
  server.server.on('request',request=>{
    if(request.method==='DELETE'&&request.url==='/v1/me/account')
      deletionRequests.push({key:request.headers['idempotency-key'],authorization:request.headers.authorization});
  });
  address=await server.listen({host:'127.0.0.1',port:0});
});
test.afterAll(async()=>{await server?.close();await db?.stop();});

async function launch(dataDir) {
  const env={...process.env,SIYUE_DATA_DIR:dataDir,SIYUE_AUTH_URL:address+'/v1',SIYUE_RENDERER_URL:''};
  delete env.ELECTRON_RUN_AS_NODE;
  const application=await _electron.launch({executablePath:require('electron'),args:[path.join(root,'apps/desktop')],
    cwd:root,env,chromiumSandbox:true,timeout:30_000});
  const page=await application.firstWindow();
  await expect(page.getByText(/本机空间 · 离线可用|Local space · Available offline/)).toHaveText(/离线可用|Available offline/);
  return {application,page};
}

/** One owned family with a co-adult, a guarded child and an active child device grant, plus one family
 *  where the caller is only a member. Every row is written through the real services or the schema they
 *  write, so the impact the panel shows is the server's own inventory. */
async function seedDependencies(account) {
  const ownerId=account.tokens.session.subjectId;
  const owned=await transaction(db.app,client=>families.create(client,ownerId,createHash('sha256').update(randomUUID()).digest('hex')));
  const coAdult=await fx.issue();
  await db.app.query('INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,$3)',
    [owned.familyId,coAdult.session.subjectId,'member']);
  await guardianship.create(account.tokens.accessToken,{familyId:owned.familyId,displayName:'Synthetic Child',
    consentPolicyVersion:'guardian-consent-v1',consentConfirmed:true,expectedMembershipVersion:owned.membershipVersion,
    expectedFamilyVersion:owned.familyVersion},randomUUID());
  const relationship=(await db.app.query('SELECT r.version AS relationship_version, s.credential_version FROM siyue.guardian_relationships r JOIN siyue.subjects s ON s.id=r.guardian_subject_id WHERE r.family_id=$1 AND r.guardian_subject_id=$2',
    [owned.familyId,ownerId])).rows[0];
  const child=(await db.app.query('SELECT child_subject_id FROM siyue.guardian_relationships WHERE family_id=$1 AND guardian_subject_id=$2',
    [owned.familyId,ownerId])).rows[0];
  await db.app.query('INSERT INTO siyue.device_grants(id,child_subject_id,guardian_id,family_id,installation_id,platform,device_label,guardian_relationship_version,guardian_credential_version,scopes,expires_at) VALUES($1,$2,$3,$4,$5,\'ios\',\'Synthetic iPad\',$6,$7,ARRAY[]::text[],$8)',
  [randomUUID(),child.child_subject_id,ownerId,owned.familyId,randomUUID(),
    relationship.relationship_version,relationship.credential_version,new Date(Date.now()+29*day)]);
  const otherAdult=await fx.issue();
  const shared=await transaction(db.app,client=>families.create(client,otherAdult.session.subjectId,
    createHash('sha256').update(randomUUID()).digest('hex')));
  await db.app.query('INSERT INTO siyue.family_memberships(family_id,subject_id,role) VALUES($1,$2,$3)',
    [shared.familyId,ownerId,'member']);
  return {owned,shared};
}

async function signIn(page,account) {
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByRole('button',{name:'账号',exact:true}).click();
  await page.getByLabel('邮箱',{exact:true}).fill(account.address);
  await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'登录',exact:true}).click();
  await expect(page.getByText('已登录',{exact:true})).toBeVisible();
}

test('Chinese deletion flow settles every real family, locks on an unknown outcome and retries the same request',async({},info)=>{
  const account=await fx.register('deletion-ui-zh@example.test');
  const seeded=await seedDependencies(account);
  deletionRequests=[];
  const dataDir=info.outputPath('user-data');await mkdir(dataDir,{recursive:true});
  const {application,page}=await launch(dataDir);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  try {
    await signIn(page,account);
    await page.getByRole('button',{name:'注销账号',exact:true}).click();

    // Impact: the two facts a person must know before any family is touched.
    await expect(page.getByRole('heading',{name:'注销前',exact:true})).toBeVisible();
    await expect(page.getByText('思玥服务端的账号资料会被删除，包括当前登录方式与所有设备会话。',{exact:true})).toBeVisible();
    await expect(page.getByText('本机内容保留在本机，不会上传，也不会被删除。',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'查看影响并继续',exact:true}).click();

    // Families: one row per real family, in the server's own inventory order.
    const cards=page.getByRole('region',{name:/^家庭 [0-9a-f]{8}$/});
    await expect(cards).toHaveCount(2);
    const owned=cards.nth(0);
    await expect(owned).toContainText('你的角色：所有者');
    await expect(owned).toContainText('你是唯一所有者');
    await expect(owned).toContainText('其他有效成人：1');
    await expect(owned).toContainText('其他儿童：1');
    await expect(owned).toContainText('监护儿童：1（唯一监护 1）；有效儿童设备授权：1');
    await expect(cards.nth(1)).toContainText('你的角色：成员');
    await expect(page.getByText('家庭以编号区分；转交时可查看有效成人及其接受状态。',{exact:true})).toBeVisible();

    // A handover stays unselectable while the eligible adults of a family cannot be read at all, and the
    // panel says so instead of offering a fabricated recipient.
    const transfer=owned.getByRole('button',{name:'转交家庭管理',exact:true});
    await expect(transfer).toBeVisible();
    await expect(transfer).toBeEnabled();
    await transfer.click();
    await expect(owned.getByRole('button',{name:/等待本人接受/})).toBeDisabled();
    const continueButton=page.getByRole('button',{name:'继续',exact:true});
    await expect(continueButton).toBeDisabled();

    await owned.getByRole('button',{name:'结束管理，家庭冻结待复核',exact:true}).click();
    await expect(continueButton).toBeDisabled();
    await cards.nth(1).getByRole('button',{name:'结束本人家庭访问',exact:true}).click();
    await expect(continueButton).toBeEnabled();
    await continueButton.click();

    // Confirm: the declaration the server receives, a second explicit confirmation, and the platform
    // capability for re-verification.
    await expect(page.getByRole('heading',{name:'再次验证并确认',exact:true})).toBeVisible();
    const summary=page.getByRole('dialog',{name:'账号',exact:true});
    await expect(summary).toContainText('结束管理（家庭冻结待复核）');
    await expect(summary).toContainText('结束本人家庭访问');
    await expect(page.getByText('本设备不支持 Apple 再验证。',{exact:true})).toBeVisible();
    const submit=page.getByRole('button',{name:'提交注销请求',exact:true});
    await expect(submit).toBeDisabled();
    const verification=page.getByLabel(/^用 .+ 的密码确认$/);
    await verification.fill('a wrong synthetic password');
    await page.getByLabel('我确认以上家庭处置，并同意注销账号。').check();
    await expect(submit).toBeEnabled();
    await submit.click();

    // A refused re-verification returns to the family step with the server's own wording and claims
    // nothing: no destructive request left the process.
    await expect(page.getByRole('alert')).toContainText('邮箱或密码不正确。');
    await expect(page.getByRole('heading',{name:'逐个处理家庭',exact:true})).toBeVisible();
    expect(deletionRequests).toHaveLength(0);

    await continueButton.click();
    await verification.fill(password);
    await page.getByLabel('我确认以上家庭处置，并同意注销账号。').check();
    await page.getByRole('button',{name:'提交注销请求',exact:true}).click();

    // The destructive route is still closed, so the outcome is unconfirmed: the panel locks the
    // declaration, keeps the password field out of reach and offers the original request again.
    await expect.poll(()=>deletionRequests.length).toBe(1);
    await expect(page.getByText('提交结果尚未确认',{exact:true})).toBeVisible();
    await expect(page.getByText('请重试原请求。系统会复用同一请求与同一请求键，不会创建第二份注销。',{exact:true})).toBeVisible();
    await expect(verification).toHaveCount(0);
    await expect(page.getByRole('button',{name:'提交注销请求',exact:true})).toHaveCount(0);
    expect(deletionRequests).toHaveLength(1);
    expect(deletionRequests[0].key).toMatch(/^[0-9a-f-]{36}$/i);
    expect(deletionRequests[0].authorization).toMatch(/^Bearer /);

    await page.getByRole('button',{name:'重试原请求',exact:true}).click();
    await expect(page.getByText('提交结果尚未确认',{exact:true})).toBeVisible();
    await expect.poll(()=>deletionRequests.length).toBe(2);
    expect(deletionRequests[1].key).toBe(deletionRequests[0].key);
    expect(errors).toEqual([]);
    // The real dependency rows stay untouched: this case never accepted a deletion, so nothing may have
    // been frozen, dissolved or revoked by the client.
    expect((await db.app.query('SELECT count(*)::int AS n FROM siyue.account_deletion_jobs')).rows[0].n).toBe(0);
    expect((await db.app.query('SELECT status FROM siyue.families WHERE id=$1',[seeded.owned.familyId])).rows[0].status).toBe('active');
  } finally {await application.close();}
});

test('English deletion copy states the same consequences on desktop',async({},info)=>{
  const account=await fx.register('deletion-ui-en@example.test');
  const dataDir=info.outputPath('user-data');await mkdir(dataDir,{recursive:true});
  const {application,page}=await launch(dataDir);
  try {
    await page.getByRole('button',{name:'设置',exact:true}).click();
    await page.getByRole('button',{name:'English',exact:true}).click();
    await page.getByRole('button',{name:'Account',exact:true}).click();
    await page.getByLabel('Email',{exact:true}).fill(account.address);
    await page.getByLabel('Password',{exact:true}).fill(password);
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await expect(page.getByText('Signed in',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Delete account',exact:true}).click();

    await expect(page.getByRole('heading',{name:'Before you delete',exact:true})).toBeVisible();
    await expect(page.getByText('Your Siyue server account data is deleted, including your sign-in methods and every device session.',{exact:true})).toBeVisible();
    await expect(page.getByText('Content on this device stays here. It is not uploaded and not deleted.',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Review impact and continue',exact:true}).click();

    // No family is affected here, so the flow states the empty disposition and asks for the second
    // confirmation and the password verification the desktop can actually perform.
    await expect(page.getByRole('heading',{name:'Verify and confirm',exact:true})).toBeVisible();
    await expect(page.getByText('I confirm these family dispositions and that my account should be deleted.',{exact:true})).toBeVisible();
    await expect(page.getByText('Apple re-verification is not available on this device.',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Submit deletion request',exact:true})).toBeDisabled();
    await page.getByLabel(/^Confirm with the password for /).fill(password);
    await page.getByLabel('I confirm these family dispositions and that my account should be deleted.').check();
    await expect(page.getByRole('button',{name:'Submit deletion request',exact:true})).toBeEnabled();
  } finally {await application.close();}
});

test('a cold start opens on receipt progress and follows the same receipt to completion',async({},info)=>{
  const account=await fx.register('deletion-ui-cold@example.test');
  const subjectId=account.tokens.session.subjectId,deletionId=randomUUID(),receiptSecret=randomBytes(32).toString('base64url');
  const expiresAt=new Date(Date.now()+day);
  await db.app.query('INSERT INTO siyue.account_deletion_jobs(id,subject_id,state,requested_at,local_data_deleted,provider_revocation_pending,receipt_secret_hash,receipt_expires_at) VALUES($1,$2,\'accepted\',$3,false,true,$4,$5)',
  [deletionId,subjectId,new Date(Date.now()-60_000),createHash('sha256').update(receiptSecret).digest('hex'),expiresAt]);
  const dataDir=info.outputPath('user-data');await mkdir(dataDir,{recursive:true});

  // A device that already accepted a deletion holds the receipt in its own protected store and no
  // session. The record is written with the same OS protection the app reads, then the process is
  // replaced, which is what "cold start" means here.
  // The protected store is unreadable outside the app, so the main process encrypts the record and the
  // test writes those bytes to the directory the app was configured with.
  const first=await launch(dataDir);
  const sealed=await first.application.evaluate(({safeStorage},record)=>
    Array.from(safeStorage.encryptString(JSON.stringify(record))),
  {schemaVersion:1,environment:'development',apiBaseUrl:address+'/v1',subjectId,
    receipt:{deletionId,receiptSecret,expiresAt:expiresAt.toISOString()}});
  const receiptDirectory=path.join(dataDir,'auth','development','deletion-receipt');
  await mkdir(receiptDirectory,{recursive:true,mode:0o700});
  await writeFile(path.join(receiptDirectory,'recovery.enc'),Buffer.from(sealed),{mode:0o600});
  await first.application.close();

  const {application,page}=await launch(dataDir);
  try {
    await page.getByRole('button',{name:'设置',exact:true}).click();
    await page.getByRole('button',{name:'账号',exact:true}).click();
    // The local session is gone, so the surviving receipt is offered next to the sign-in form.
    await page.getByRole('button',{name:'注销处理进度',exact:true}).click();

    await expect(page.getByRole('heading',{name:'注销处理进度',exact:true})).toBeVisible();
    const progress=page.getByRole('dialog',{name:'账号',exact:true});
    await expect(progress).toContainText('服务端资料');
    await expect(progress).toContainText('尚未完成');
    await expect(progress).toContainText('Apple 登录撤销');
    await expect(progress).toContainText('待撤销');
    await expect(progress).toContainText('处理中');
    await expect(page.getByText('家庭复核进度不在回执内，无法在本机显示。家庭处于冻结待复核时，请保留本页信息并联系思玥支持核实。',{exact:true})).toHaveCount(0);
    await expect(page.getByText('本页只反映思玥服务端与外部登录撤销的进度，不代表本机或其他离线副本的数据已删除。',{exact:true})).toBeVisible();
    expect(await page.content()).not.toContain(receiptSecret);
    expect(await page.content()).not.toContain(deletionId);

    // Both cleanup dimensions finish: the same receipt now reports completion instead of claiming it
    // early, and the page follows the server's own answer.
    await db.app.query("UPDATE siyue.account_deletion_jobs SET state='completed',local_data_deleted=true,provider_revocation_pending=false,completed_at=$2 WHERE id=$1",
    [deletionId,new Date()]);
    await page.getByRole('button',{name:'刷新进度',exact:true}).click();
    await expect(page.getByText('已受理并完成',{exact:true})).toBeVisible();
    await expect(progress).toContainText('已清理');
    await expect(progress).toContainText('无待处理撤销');
  } finally {await application.close();}
});
