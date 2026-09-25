import {test,expect} from 'playwright/test';
import {_electron} from 'playwright';
import {createRequire} from 'node:module';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {startPostgresFixture} from '../../apps/server/tests/integration/postgres-fixture.mjs';
import {createEmailFixture,password} from '../../apps/server/tests/integration/email-fixture.mjs';
import {createRuntimeApp} from '../../apps/server/dist/runtime-app.js';
const root=path.resolve(import.meta.dirname,'../..'),require=createRequire(path.join(root,'apps/desktop/package.json'));
test('actual desktop account spaces preserve guest and isolate A/B through restart',async({},info)=>{
 const db=await startPostgresFixture(),fx=await createEmailFixture(db);
 const server=createRuntimeApp(db.app,db.identity,{sessions:fx.service,email:fx.email});
 const address=await server.listen({host:'127.0.0.1',port:0});
 await fx.register('space-a@example.test');await fx.register('space-b@example.test');
 const directory=info.outputPath('user-data');await mkdir(directory,{recursive:true});let app,page;
 async function start(){const env={...process.env,SIYUE_DATA_DIR:directory,SIYUE_AUTH_URL:address+'/v1',SIYUE_RENDERER_URL:''};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({executablePath:require('electron'),args:[path.join(root,'apps/desktop')],cwd:root,env,chromiumSandbox:true});page=await app.firstWindow();await expect(page.getByRole('button',{name:'设置',exact:true})).toBeVisible();}
 const button=name=>page.getByRole('button',{name,exact:true});
 async function account(){if(await page.getByRole('dialog').isVisible())await button('关闭').click();await button('设置').click();await button('账号').click();}
 async function login(email,create){await account();await page.getByLabel('邮箱',{exact:true}).fill(email);await page.getByLabel('密码',{exact:true}).fill(password);await button('登录').click();
  if(create){await expect(page.getByText('当前空间：原本机空间',{exact:true})).toBeVisible();await button('在本机创建账号空间').click();}
  await expect.poll(async()=>page.evaluate(async()=>(await window.siyueDesktop.workspace({op:'state'})).value.scope?.kind)).toBe('account');
  const state=await page.evaluate(async()=>(await window.siyueDesktop.workspace({op:'state'})).value);await expect(page.getByTestId('workspace-content')).toHaveAttribute('data-workspace-revision',String(state.revision));
  if(await page.getByRole('dialog').isVisible()){await expect(page.getByText('当前空间：账号空间（仅本机）',{exact:true})).toBeVisible();await button('关闭').click();}
 }
 async function logout(){await account();await button('退出登录').click();
  await expect.poll(async()=>page.evaluate(async()=>(await window.siyueDesktop.workspace({op:'state'})).value.scope?.kind)).toBe('local');
  const state=await page.evaluate(async()=>(await window.siyueDesktop.workspace({op:'state'})).value);
  await expect(page.getByTestId('workspace-content')).toHaveAttribute('data-workspace-revision',String(state.revision));
  if(await page.getByRole('dialog').isVisible()){await button('关闭').click();await expect(page.getByRole('dialog')).not.toBeVisible();}
 }
 async function create(title){await button('手动创建').click();await page.getByLabel('目标标题',{exact:true}).fill(title);await page.locator('#projects').fill(title+' project');await button('创建可编辑草稿').click();await button('确认并正式保存').click();await expect(page.locator('.record-title').getByText(title,{exact:true})).toBeVisible();}
 async function beginUnsaved(title){await button('手动创建').click();await page.getByLabel('目标标题',{exact:true}).fill(title);await page.locator('#projects').fill(title+' project');}
 async function expectUnsaved(title){await expect(page.getByLabel('目标标题',{exact:true})).toHaveValue(title);await expect(page.locator('#projects')).toHaveValue(title+' project');}
 async function closeUnsaved(){await button('收起编辑（保留输入）').click();}
 async function board(draw=false,image=false){
  await button('白板').click();await expect(page.getByRole('status')).toHaveText('已保存到本机');
  if(image){await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.join(root,'apps/mobile/assets/whiteboard/exercise.png'));await button('选图').click();await expect(page.getByRole('status')).toHaveText('已保存到本机');}
  if(draw){await page.getByTitle('自由书写 — P 或 7',{exact:true}).click();const box=await page.locator('canvas.interactive').boundingBox();await page.mouse.move(box.x+box.width*.3,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.6,{steps:10});await page.mouse.up();}
  await button('返回').click();await expect(button('设置')).toBeVisible();
  return page.evaluate(async()=>{const reply=JSON.parse(await window.siyueDesktop.whiteboard(JSON.stringify({version:1,session:'space-board-inspection',requestId:crypto.randomUUID(),op:'load'})));if(!reply.ok)throw Error(reply.error);const board=reply.value.board;return {elements:board.pages[0].elements.filter(element=>!element.isDeleted).map(({id,type,fileId})=>({id,type,...(fileId?{fileId}:{})})),files:board.files};});
 }
 async function titles(){return page.evaluate(async()=>{const reply=await window.siyueDesktop.invoke({requestId:crypto.randomUUID(),method:'snapshot',args:[]});if(!reply.ok)throw Error(reply.error.code);return reply.value.goals.map(goal=>goal.title);});}
 try{
  await start();await create('Guest record');await beginUnsaved('Guest unsaved');
  await login('space-a@example.test',true);expect(await titles()).toEqual([]);await beginUnsaved('A unsaved');
  await logout();await login('space-b@example.test',true);expect(await titles()).toEqual([]);await expect(page.locator('#goal-input')).toHaveValue('');await beginUnsaved('B unsaved');
  await logout();await login('space-a@example.test',false);await expectUnsaved('A unsaved');await logout();expect(await titles()).toEqual(['Guest record']);await expectUnsaved('Guest unsaved');
  await login('space-b@example.test',false);await expectUnsaved('B unsaved');await closeUnsaved();await create('B private');expect(await board()).toEqual({elements:[],files:{}});const bInk=await board(true);expect(bInk.elements).toHaveLength(1);expect(bInk.files).toEqual({});
  await logout();await login('space-a@example.test',false);await expectUnsaved('A unsaved');await closeUnsaved();await create('A private');const aInk=await board(true,true);expect(aInk.elements.map(e=>e.type).sort()).toEqual(['freedraw','image']);expect(Object.keys(aInk.files)).toHaveLength(1);expect(Object.values(aInk.files)[0].dataURL).toMatch(/^data:image\/jpeg;base64,/);expect(bInk).not.toEqual(aInk);
  await logout();expect(await titles()).toEqual(['Guest record']);await expectUnsaved('Guest unsaved');await login('space-b@example.test',false);
  await app.close();app=undefined;await start();await expect.poll(titles).toEqual(['B private']);expect(await board()).toEqual(bInk);
  await logout();expect(await titles()).toEqual(['Guest record']);await login('space-a@example.test',false);await expect.poll(titles).toEqual(['A private']);expect(await board()).toEqual(aInk);
  await app.close();app=undefined;await db.app.query('UPDATE siyue.auth_sessions SET revoked_at=now() WHERE revoked_at IS NULL');await start();
  await expect.poll(titles).toEqual(['Guest record']);await login('space-a@example.test',false);await expect.poll(titles).toEqual(['A private']);
 }finally{await app?.close();await server.close();await db.stop();}
});
