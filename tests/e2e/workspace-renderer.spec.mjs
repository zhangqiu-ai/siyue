import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {test,expect} from './desktop-fixture.mjs';
test('workspace replacement preserves unsaved local text and rejects retired requests',async({desktop})=>{
 const page=desktop.page;
 await page.getByRole('button',{name:'手动创建',exact:true}).click();
 await page.getByLabel('目标标题',{exact:true}).fill('Retained local draft');
 const result=await page.evaluate(async()=>{
  const bridge=window.siyueDesktop,old=await bridge.workspace({op:'state'});
  await bridge.workspace({op:'retry'});
  const rejected=await bridge.invoke({requestId:crypto.randomUUID(),method:'snapshot',args:[],workspaceRevision:old.value.revision});
  return rejected;
 });
 expect(result.ok).toBe(false);expect(result.error.code).toBe('cancelled');
 await expect(page.getByLabel('目标标题',{exact:true})).toHaveValue('Retained local draft');
});

test('workspace retirement flushes pending whiteboard ink before reopening',async({desktop})=>{
 const page=desktop.page;
 await page.getByRole('button',{name:'白板',exact:true}).click();
 await page.getByTitle('自由书写 — P 或 7',{exact:true}).click();
 const box=await page.locator('canvas.interactive').boundingBox();
 await page.mouse.move(box.x+box.width*.3,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.6,{steps:10});await page.mouse.up();
 await page.evaluate(()=>window.siyueDesktop.workspace({op:'retry'}));
 await expect(page.getByRole('status')).toHaveText('已保存到本机');
 await page.getByRole('button',{name:'返回',exact:true}).click();
 const board=await page.evaluate(async()=>JSON.parse(await window.siyueDesktop.whiteboard(JSON.stringify({version:1,session:'retirement-inspection',requestId:crypto.randomUUID(),op:'load'}))));
 expect(board.ok).toBe(true);expect(board.value.board.pages[0].elements.some(element=>element.type==='freedraw'&&!element.isDeleted)).toBe(true);
});

test('failed whiteboard flush blocks workspace replacement and retries original ink',async({desktop})=>{
 const page=desktop.page;
 await page.getByRole('button',{name:'白板',exact:true}).click();
 await expect(page.getByRole('status')).toHaveText('已保存到本机');
 const db=new DatabaseSync(path.join(desktop.dataDir,'siyue-whiteboard.sqlite'));
 const read=()=>db.prepare('SELECT value FROM board_storage WHERE key=?').get('siyue.whiteboard.excalidraw.v2')?.value;
 const original=read();
 db.exec("CREATE TRIGGER fail_board BEFORE INSERT ON board_storage BEGIN SELECT RAISE(FAIL,'synthetic disk full'); END");
 try{
  await page.getByTitle('自由书写 — P 或 7',{exact:true}).click();const box=await page.locator('canvas.interactive').boundingBox();
  await page.mouse.move(box.x+box.width*.3,box.y+box.height*.5);await page.mouse.down();await page.mouse.move(box.x+box.width*.6,box.y+box.height*.6,{steps:10});await page.mouse.up();
  await page.evaluate(()=>window.siyueDesktop.workspace({op:'retry'}));
  await expect(page.getByText('无法打开当前空间，已保存的内容仍保留。',{exact:true})).toBeVisible();expect(read()).toBe(original);
  db.exec('DROP TRIGGER fail_board');
  await page.getByRole('button',{name:'重试',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  expect(JSON.parse(read()).pages[0].elements.some(element=>element.type==='freedraw'&&!element.isDeleted)).toBe(true);
 }finally{db.exec('DROP TRIGGER IF EXISTS fail_board');db.close();}
});
