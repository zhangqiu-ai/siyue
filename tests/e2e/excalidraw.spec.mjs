import { test, expect } from './desktop-fixture.mjs';

async function open(desktop) {
  await desktop.page.getByRole('button',{name:'白板',exact:true}).click();
  await expect(desktop.page.locator('.excalidraw canvas').first()).toBeVisible();
}
async function draw(page,key='p') {
  await page.getByTitle(key==='r'?'矩形 — R 或 2':'自由书写 — P 或 7',{exact:true}).click();
  const box=await page.locator('.excalidraw canvas.interactive').boundingBox();
  await page.mouse.move(box.x+box.width*.35,box.y+box.height*.5);
  await page.mouse.down();await page.mouse.move(box.x+box.width*.65,box.y+box.height*.55,{steps:15});await page.mouse.up();
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
}
// Independent read-only inspection through the same scoped bridge. Does not mutate scene/API.
async function stored(page) {
  return page.evaluate(async()=>{
    // Separate loading session is used only after editor exits, so it cannot replace the live editor's session.
    const reply=JSON.parse(await window.siyueDesktop.whiteboard(JSON.stringify({version:1,session:'test-inspection',requestId:crypto.randomUUID(),op:'load'})));
    if(!reply.ok)throw Error(reply.error);return reply.value.board;
  });
}
test('Excalidraw actual editor saves strokes, isolates page history and reopens offline',async({desktop})=>{
  await open(desktop);const page=desktop.page;
  await draw(page);
  await page.getByRole('button',{name:'新建页',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'页',exact:true})).toHaveValue(/.+/);
  await draw(page,'r');
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button',{name:'重做',exact:true}).click();
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('已保存到本机');
  await page.getByRole('button',{name:'返回',exact:true}).click();
  const before=await stored(page);
  expect(before.pages).toHaveLength(2);
  expect(before.pages[0].elements.filter(e=>!e.isDeleted).map(e=>e.type)).toEqual(['freedraw']);
  expect(before.pages[1].elements.filter(e=>!e.isDeleted).map(e=>e.type)).toEqual(['rectangle']);
  await desktop.restart();await open(desktop);
  await expect(desktop.page.getByRole('combobox',{name:'页',exact:true})).toHaveValue(before.activePageId);
  await desktop.page.getByRole('button',{name:'返回',exact:true}).click();
  const after=await stored(desktop.page);
  expect(after.pages).toEqual(before.pages);
});

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
function readDisk(desktop) {
 const db=new DatabaseSync(path.join(desktop.dataDir,'siyue-whiteboard.sqlite'),{readOnly:true});
 try{return JSON.parse(db.prepare('SELECT value FROM board_storage WHERE key=?').get('siyue.whiteboard.excalidraw.v2').value);}finally{db.close();}
}
test('native image adapter stores full bytes; failed disk commit preserves original and UI retries',async({desktop})=>{
 await desktop.chooseImage(path.resolve('apps/mobile/assets/whiteboard/exercise.png'));
 await open(desktop);const page=desktop.page;
 const requests=[];page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});
 await page.getByRole('button',{name:'选图',exact:true}).click();
 await expect(page.getByRole('status')).toHaveText('已保存到本机');
 await expect.poll(()=>Object.keys(readDisk(desktop).files).length).toBe(1);
 const original=readDisk(desktop);expect(original.pages[0].elements.some(e=>e.type==='image')).toBe(true);
 expect(Object.values(original.files)[0].dataURL).toMatch(/^data:image\/jpeg;base64,/);
 const db=new DatabaseSync(path.join(desktop.dataDir,'siyue-whiteboard.sqlite'));
 db.exec("CREATE TRIGGER fail_board BEFORE INSERT ON board_storage BEGIN SELECT RAISE(FAIL,'synthetic disk full'); END");
 try {
  await page.getByTitle('自由书写 — P 或 7',{exact:true}).click();
  const box=await page.locator('canvas.interactive').boundingBox();
  await page.mouse.move(box.x+box.width*.35,box.y+box.height*.7);await page.mouse.down();await page.mouse.move(box.x+box.width*.65,box.y+box.height*.75,{steps:15});await page.mouse.up();
  await expect(page.getByRole('alert')).toContainText('保存失败');
  expect(readDisk(desktop)).toEqual(original);
 } finally {db.exec('DROP TRIGGER fail_board');db.close();}
 await page.getByRole('button',{name:'保存',exact:true}).click();await expect(page.getByRole('status')).toHaveText('已保存到本机');
 expect(readDisk(desktop).pages[0].elements.filter(e=>!e.isDeleted).map(e=>e.type)).toEqual(['image','freedraw']);
 await desktop.restart();await open(desktop);
 await expect(desktop.page.getByRole('status')).toHaveText('已保存到本机');
 expect(Object.values(readDisk(desktop).files)[0].dataURL).toBe(Object.values(original.files)[0].dataURL);
 const previousZoom=parseFloat(await desktop.page.getByRole('button',{name:'重置缩放',exact:true}).innerText());
 await desktop.page.getByRole('button',{name:'放大',exact:true}).click();
 await desktop.page.getByRole('button',{name:'返回',exact:true}).click();
 expect(readDisk(desktop).pages[0].appState.zoom.value).toBeGreaterThan(previousZoom/100);
 expect(requests).toEqual([]);
});

test('normal app quit flushes pending ink before shutting down SQLite',async({desktop})=>{
 await open(desktop);const page=desktop.page;
 await page.getByTitle('自由书写 — P 或 7',{exact:true}).click();
 const box=await page.locator('canvas.interactive').boundingBox();
 await page.mouse.move(box.x+box.width*.35,box.y+box.height*.5);await page.mouse.down();
 await page.mouse.move(box.x+box.width*.65,box.y+box.height*.6,{steps:4});await page.mouse.up();
 // No Save click or debounce wait: graceful close must flush the pending revision.
 await desktop.restart();await open(desktop);
 await expect(desktop.page.getByRole('status')).toHaveText('已保存到本机');
 expect(readDisk(desktop).pages[0].elements.filter(e=>!e.isDeleted).map(e=>e.type)).toEqual(['freedraw']);
});

test('erase, undo, select/move, page switch and confirmed delete remain editable',async({desktop})=>{
 await open(desktop);const page=desktop.page;await draw(page);
 const original=readDisk(desktop).pages[0].elements[0];
 await page.getByTitle('橡皮 — E 或 0',{exact:true}).click();
 const box=await page.locator('canvas.interactive').boundingBox();
 await page.mouse.click(box.x+box.width*.5,box.y+box.height*.525);
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await expect.poll(()=>readDisk(desktop).pages[0].elements.filter(e=>!e.isDeleted).length).toBe(0);
 await page.getByRole('button',{name:'撤销',exact:true}).click();
 await page.getByTitle('选择 — V 或 1',{exact:true}).click();
 await page.mouse.move(box.x+box.width*.5,box.y+box.height*.525);await page.mouse.down();
 await page.mouse.move(box.x+box.width*.5+60,box.y+box.height*.525+60,{steps:8});await page.mouse.up();
 await page.getByRole('button',{name:'保存',exact:true}).click();
 await expect.poll(()=>readDisk(desktop).pages[0].elements.find(e=>!e.isDeleted)?.x).not.toBe(original.x);
 const pageOne=readDisk(desktop).pages[0];
 await page.getByRole('button',{name:'新建页',exact:true}).click();await draw(page,'r');
 await page.getByRole('combobox',{name:'页',exact:true}).selectOption(pageOne.id);
 // History starts fresh per page; selection in page two cannot undo page one.
 await expect(page.getByRole('button',{name:'撤销',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'删除页',exact:true}).click();
 await page.getByRole('alertdialog').getByRole('button',{name:'取消',exact:true}).click();
 expect(readDisk(desktop).pages).toHaveLength(2);
 await page.getByRole('button',{name:'删除页',exact:true}).click();
 await page.getByRole('alertdialog').getByRole('button',{name:'删除页',exact:true}).click();
 await expect.poll(()=>readDisk(desktop).pages.length).toBe(1);
 expect(readDisk(desktop).pages[0].elements.filter(e=>!e.isDeleted).map(e=>e.type)).toEqual(['rectangle']);
});

test('English dark editor fits narrow window with upstream text and shape tools',async({desktop})=>{
 const page=desktop.page;
 await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'English',exact:true}).click();await page.getByRole('button',{name:'Close',exact:true}).click();
 const legacyDb=new DatabaseSync(path.join(desktop.dataDir,'siyue-whiteboard.sqlite'));
 legacyDb.prepare('INSERT OR REPLACE INTO board_storage VALUES (?,?)').run('siyue.whiteboard.trial.v1',JSON.stringify({schemaVersion:1,pages:[{id:'legacy-page',background:'blank',strokes:[]}]}));legacyDb.close();
 await page.emulateMedia({colorScheme:'dark'});await desktop.resize(390,844);
 await page.getByRole('button',{name:'Whiteboard',exact:true}).click();
 await expect(page.locator('.excalidraw.theme--dark')).toBeVisible();
 await expect(page.getByRole('button',{name:'Convert old board copy',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Photos',exact:true})).toBeInViewport();
 await expect(page.getByRole('button',{name:'Save',exact:true})).toBeInViewport();
 await expect(page.getByRole('button',{name:'New page',exact:true})).toBeInViewport();
 const size=await page.locator('canvas.interactive').boundingBox();expect(size.width).toBeGreaterThan(350);expect(size.height).toBeGreaterThan(650);
 await page.getByTitle('Text — T or 8',{exact:true}).click();
 await page.mouse.click(size.x+size.width*.3,size.y+size.height*.4);await page.keyboard.type('Editable homework');await page.keyboard.press('Escape');
 await page.getByRole('button',{name:'Save',exact:true}).click();
 await expect.poll(()=>readDisk(desktop).pages[0].elements.some(e=>e.type==='text'&&e.text==='Editable homework')).toBe(true);
 await desktop.restart();await desktop.page.getByRole('button',{name:'Whiteboard',exact:true}).click();
 await expect(desktop.page.getByRole('status')).toHaveText('Saved locally');
});
