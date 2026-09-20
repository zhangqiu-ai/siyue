// Native Android regression against an installed, embedded Release app. Dedicated emulator only.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import path from 'node:path';
const run=promisify(execFile),adb=process.env.ADB??'/opt/homebrew/share/android-commandlinetools/platform-tools/adb';
const serial=process.env.SIYUE_QA_ANDROID??'emulator-5554';
assert.match(serial,/^emulator-\d+$/,'Never operate on a physical/user device');
const out=path.resolve(process.env.SIYUE_QA_OUTPUT??`artifacts/excalidraw-android-${Date.now()}`);
await mkdir(out,{recursive:true});
async function command(...args){return (await run(adb,['-s',serial,...args],{maxBuffer:40*1024*1024})).stdout;}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function tree(){await command('shell','uiautomator','dump','--compressed','/sdcard/siyue-excalidraw-qa.xml');const xml=await command('shell','cat','/sdcard/siyue-excalidraw-qa.xml');await writeFile(path.join(out,'latest.xml'),xml);return [...xml.matchAll(/<node\b([^>]+)>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(x=>[x[1],x[2]])));}
function bounds(node){const v=node.bounds.match(/\d+/g).map(Number);return {x:v[0],y:v[1],width:v[2]-v[0],height:v[3]-v[1]};}
let systemDialogs=0;
async function find(label){for(let i=0;i<10;i++){
 const nodes=await tree();
 if(nodes.some(n=>["System UI isn't responding","Pixel Launcher isn't responding"].includes(n.text))){
  if(++systemDialogs>2)throw Error('QA emulator system repeatedly unresponsive');
  await capture('system-anr-'+systemDialogs);
  const close=nodes.find(n=>n.text==='Close app');assert.ok(close);const b=bounds(close);
  await command('shell','input','tap',String(Math.round(b.x+b.width/2)),String(Math.round(b.y+b.height/2)));await pause(1000);continue;
 }
 const n=nodes.find(n=>n.text===label||n['content-desc']===label);if(n)return n;await pause(350);
}throw Error(`Native control missing: ${label}`);}
async function tap(label){const b=bounds(await find(label));await command('shell','input','tap',String(Math.round(b.x+b.width/2)),String(Math.round(b.y+b.height/2)));}
async function capture(name){const {stdout}=await run(adb,['-s',serial,'exec-out','screencap','-p'],{encoding:'buffer',maxBuffer:10*1024*1024});await writeFile(path.join(out,name+'.png'),stdout);}
async function disk(name){const file=path.join(out,name+'.sqlite');await command('pull','/data/user/0/app.siyue.mobile/files/SQLite/ExpoSQLiteStorage',file);const db=new DatabaseSync(file,{readOnly:true});try{return JSON.parse(db.prepare('SELECT value FROM storage WHERE key=?').get('siyue.whiteboard.excalidraw.v2').value);}finally{db.close();}}
const launch=()=>command('shell','am','start','-W','-a','android.intent.action.VIEW','-d','siyue:///whiteboard','app.siyue.mobile');
try {
 assert.match(await command('shell','id'),/uid=0/,'QA image must allow adb root for read-only SQLite evidence');
 await command('shell','svc','wifi','disable');await command('shell','svc','data','disable');
 let connectivity='';
 for(let i=0;i<20;i++){connectivity=await command('shell','dumpsys','connectivity');if(/Active default network: (none|null)/.test(connectivity))break;await pause(500);}
 await writeFile(path.join(out,'network.txt'),connectivity);
 assert.match(connectivity.match(/Active default network: .*/)?.[0]??'',/Active default network: (none|null)/,'Offline test requires no default network');
 await launch();await find('选图');await tap('新建页');await tap('自由书写 — P 或 7');
 const canvas=bounds(await find('绘制 Canvas'));
 const point=(dx,dy)=>[String(Math.round(canvas.x+canvas.width*dx)),String(Math.round(canvas.y+canvas.height*dy))];
 await command('shell','input','swipe',...point(.3,.5),...point(.7,.55),'450');
 await tap('保存');await find('已保存到本机');
 const first=await disk('saved-ink'),id=first.activePageId;
 assert.equal(first.pages.find(p=>p.id===id).elements.filter(e=>!e.isDeleted&&e.type==='freedraw').length,1);
 await tap('撤销');await tap('保存');await find('已保存到本机');
 assert.equal((await disk('undone')).pages.find(p=>p.id===id).elements.filter(e=>!e.isDeleted).length,0);
 await tap('重做');await tap('保存');await find('已保存到本机');await capture('android-ink');
 await command('push',path.resolve('apps/mobile/assets/whiteboard/exercise.png'),'/sdcard/Pictures/SiyueExcalidraw.png');
 await command('shell','am','broadcast','-a','android.intent.action.MEDIA_SCANNER_SCAN_FILE','-d','file:///sdcard/Pictures/SiyueExcalidraw.png');
 await tap('选图');await find('Photos');await command('shell','input','keyevent','BACK');await find('已保存到本机');
 await tap('选图');await find('Photos');
 let photo;
 for(let i=0;i<10&&!photo;i++){photo=(await tree()).find(n=>n['content-desc']?.startsWith('Photo taken on'));if(!photo)await pause(500);}
 assert.ok(photo,'Synthetic local photo must be offered by system picker');const photoBounds=bounds(photo);
 await command('shell','input','tap',String(Math.round(photoBounds.x+photoBounds.width/2)),String(Math.round(photoBounds.y+photoBounds.height/2)));
 await find('已保存到本机');const imported=await disk('imported-image');
 const importedElement=imported.pages.find(p=>p.id===id).elements.find(e=>e.type==='image');assert.ok(importedElement);assert.match(imported.files[importedElement.fileId].dataURL,/^data:image\/jpeg;base64,/);await capture('android-image');
 const saved=await disk('before-restart');await command('shell','am','force-stop','app.siyue.mobile');await launch();await find('已保存到本机');
 const reopened=await disk('cold-reopen');assert.equal(reopened.activePageId,id);assert.deepEqual(reopened.pages,saved.pages);assert.deepEqual(reopened.files,saved.files);await capture('android-cold-reopen');
 await writeFile(path.join(out,'result.json'),JSON.stringify({passed:true,systemDialogs,package:'app.siyue.mobile',offline:true,activePageId:id,revision:reopened.revision,scenarios:['native pen','undo','redo','new page','native photo cancel/import','complete image bytes','SQLite ink','force-stop cold reopen']},null,2));
 console.log(`PASS Android native offline editor: ${out}`);
} catch(error){await capture('failure').catch(()=>{});throw error;}
finally {await command('shell','svc','wifi','enable');await command('shell','svc','data','enable');}
