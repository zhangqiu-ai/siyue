// iOS 原生拍题/选图回归：只操作名称含 QA 的专用模拟器与已安装的 Release 应用。
// 相册只加入合成题图，存档只读复制后核对；不写产品代码、不清理用户数据。
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,copyFile,writeFile,access,readFile,readdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import path from 'node:path';
const run=promisify(execFile),simctl=(...args)=>run('xcrun',['simctl',...args],{maxBuffer:64*1024*1024});
const brew=process.env.SIYUE_BREW??'/opt/homebrew/bin/brew';
const devices=[process.env.SIYUE_QA_IPHONE,process.env.SIYUE_QA_IPAD].filter(Boolean);
assert.ok(devices.length,'Set SIYUE_QA_IPHONE and/or SIYUE_QA_IPAD to the QA simulator UDIDs');
const app=process.env.SIYUE_IOS_APP;
const swift='apps/mobile/e2e/ExcalidrawUITests.swift',klass='ExcalidrawPhotoPickUITests';
const requestedOut=path.resolve(process.env.SIYUE_QA_OUTPUT??`artifacts/excalidraw-native/photo-picker-${Date.now()}`);
// 已有输出目录一律改用带时间戳的新目录，避免覆盖既有日志、快照与结果。
const out=(await access(requestedOut).then(()=>true,()=>false))&&(await readdir(requestedOut)).length?`${requestedOut}-${Date.now()}`:requestedOut;
// 补图标记放在跨运行的持久目录，否则每次新建输出目录都会重复 addmedia。
const state=path.resolve(process.env.SIYUE_QA_STATE??'/tmp/siyue-qa-state');
const derived=path.join(out,'derived'),runner=path.join(out,'runner');
// 输出目录可重复使用时不能复用已有工程，改用带时间戳的独立 runner 目录。
let runnerPath=runner;
const exercise=path.resolve('apps/mobile/assets/whiteboard/exercise.png');
await mkdir(out,{recursive:true});
if(out!==requestedOut)console.log(`Kept existing evidence, writing this run to ${out}`);
const slug=value=>value.replace(/[^A-Za-z0-9]+/g,'-').toLowerCase();
async function execute(file,args,options={}){try{const result=await run(file,args,{maxBuffer:128*1024*1024,...options});return {...result,code:0};}catch(error){return {stdout:error.stdout??'',stderr:error.stderr??'',code:typeof error.code==='number'?error.code:1};}}
async function writeLog(name,result){await writeFile(path.join(out,name),[result.stdout,result.stderr].filter(Boolean).join('\n'));return result;}
async function deviceList(){const {stdout}=await run('xcrun',['simctl','list','devices','-j']);return Object.entries(JSON.parse(stdout).devices).flatMap(([runtime,list])=>list.map(device=>({...device,runtime})));}
async function qaDevice(udid){
 const device=(await deviceList()).find(entry=>entry.udid===udid);
 assert.ok(device,`Unknown simulator ${udid}`);
 assert.match(device.name,/QA/,'Refusing to operate on a non-QA simulator');
 assert.ok(device.isAvailable,`Simulator ${device.name} is not available`);
 if(device.state!=='Booted')await simctl('boot',udid).catch(()=>{});
 await simctl('bootstatus',udid,'-b');
 return {...device,label:/iPhone/.test(device.name)?'iphone':/iPad/.test(device.name)?'ipad':slug(device.name)};
}
// 相册只补一次合成题图；标记跨运行持久，需要再补时显式设置 SIYUE_IOS_RESEED_PHOTOS=1。
// 断言只看被导入对象本身（类型、字节、坐标），相册里已有其它照片不改变判定。
async function seedPhoto(udid){
 await mkdir(state,{recursive:true});
 const marker=path.join(state,`photo-seeded-${udid}`);
 if(!process.env.SIYUE_IOS_RESEED_PHOTOS){try{await access(marker);return 'already-seeded';}catch{}}
 await simctl('addmedia',udid,exercise);
 await writeFile(marker,exercise);
 return 'seeded';
}
// 只读复制原生 kv-store，不触碰应用正在使用的数据库；快照前先结束应用以完成落盘。
async function store(udid,name,{required=true,label='device'}={}){
 await simctl('terminate',udid,'app.siyue.mobile').catch(()=>{});
 const {stdout}=await run('xcrun',['simctl','get_app_container',udid,'app.siyue.mobile','data']);
 // 文件名必须带设备标签，否则同一输出目录下后一台设备会覆盖前一台的快照证据。
 const copy=path.join(out,`${label}-${name}-store.sqlite`);
 await copyFile(path.join(stdout.trim(),'Documents','SQLite','ExpoSQLiteStorage'),copy);
 const db=new DatabaseSync(copy,{readOnly:true});
 try{
  const rows=db.prepare("SELECT key,value FROM storage WHERE key LIKE '%whiteboard.excalidraw.v2'").all();
  if(!rows.length){
   if(!required)return null;
   assert.fail(`No whiteboard revision in ${name}; the warm-up step must run on a blank QA install first`);
  }
  const row=rows.find(entry=>entry.key==='siyue.whiteboard.excalidraw.v2')??rows[0];
  return {key:row.key,board:JSON.parse(row.value)};
 } finally {db.close();}
}
const active=board=>board.pages.find(page=>page.id===board.activePageId);
const elements=(board,type)=>active(board).elements.filter(element=>element.type===type&&!element.isDeleted);
async function prepareRunner(){
 const exists=await access(path.join(runner,'WhiteboardTrial.xcodeproj')).then(()=>true,()=>false);
 if(exists)runnerPath=`${runner}-${Date.now()}`;
 const [cocoapods,ruby]=await Promise.all([run(brew,['--prefix','cocoapods']),run(brew,['--prefix','ruby'])]);
 const project=await execute(path.join(ruby.stdout.trim(),'bin','ruby'),['scripts/prepare-whiteboard-ui-tests.rb',runnerPath,swift],{env:{...process.env,GEM_HOME:path.join(cocoapods.stdout.trim(),'libexec')}});
 assert.equal(project.code,0,`Runner project generation failed: ${project.stderr}`);
 const build=await writeLog('build-for-testing.log',await execute('xcodebuild',['build-for-testing','-project',path.join(runnerPath,'WhiteboardTrial.xcodeproj'),'-scheme','WhiteboardTrialUITests','-sdk','iphonesimulator','-destination','generic/platform=iOS Simulator','-derivedDataPath',derived,'CODE_SIGNING_ALLOWED=NO']));
 assert.equal(build.code,0,'Runner build failed');
 return path.join(derived,'Build','Products','Debug-iphonesimulator','WhiteboardTrialUITests-Runner.app');
}
async function runTest(udid,name,label){
 const base=`${label}-${slug(name)}`,log=path.join(out,`${base}.log`),bundle=path.join(out,`${base}.xcresult`);
 // 单步墙钟上限，避免原生界面等待静默时无限阻塞整轮验证。
 const result=await writeLog(path.basename(log),await execute('xcodebuild',['test-without-building','-project',path.join(runnerPath,'WhiteboardTrial.xcodeproj'),'-scheme','WhiteboardTrialUITests','-destination',`platform=iOS Simulator,id=${udid}`,'-derivedDataPath',derived,'-resultBundlePath',bundle,'-parallel-testing-enabled','NO','-only-testing',`WhiteboardTrialUITests/${klass}/${name}`,'CODE_SIGNING_ALLOWED=NO'],{timeout:Number(process.env.SIYUE_QA_TEST_TIMEOUT??420000)}));
 const text=`${result.stdout}\n${result.stderr}`,executed=Number(text.match(/Executed (\d+) test/)?.[1]??0),boundary=text.match(/CAMERA_ENTRY_OPENED=(\S+) PROMPT=(\S+) DISMISS=(\S+)/),summary=text.match(/\*\* TEST (?:EXECUTE )?(?:SUCCEEDED|FAILED) \*\*/)?.[0]??'';
 // 独立 runner 可能复用旧包导致 0 项执行，必须核对实际执行数量。
 const passed=result.code===0&&executed>0&&!/TEST (?:EXECUTE )?FAILED/.test(text);
 if(!passed){
  await execute('xcrun',['xcresulttool','export','attachments','--path',bundle,'--output-path',path.join(out,`${base}-attachments`)]).catch(()=>{});
  console.log(`--- ${base} log tail ---
${(await readFile(log,'utf8')).split('\n').slice(-25).join('\n')}`);
 }
 return {name,passed,executed,exitCode:result.code,summary,boundary:boundary?{opened:boundary[1],prompt:boundary[2],dismiss:boundary[3]}:null,log:path.relative(process.cwd(),log)};
}
function verify(boards,steps){
 const baseline=boards.baseline.board,cancel=boards['after-cancel'].board,imported=boards['after-import'].board,moved=boards['after-move'].board,camera=boards['after-camera'].board;
 assert.equal(active(cancel).id,active(baseline).id,'Cancelled pick must keep the active page');
 assert.equal(elements(cancel,'image').length,elements(baseline,'image').length,'Cancelled pick must not import an image');
 assert.ok(elements(cancel,'freedraw').length>elements(baseline,'freedraw').length,'Cancelled pick must leave the board editable');
 const added=elements(imported,'image').filter(element=>!elements(cancel,'image').some(previous=>previous.id===element.id));
 assert.equal(added.length,1,'Import must add exactly one image element');
 assert.ok(imported.revision>cancel.revision,'Import must commit a new revision');
 assert.match(imported.files[added[0].fileId]?.dataURL??'',/^data:image\/jpeg;base64,[A-Za-z0-9+/=]{64,}$/,'Imported image must keep complete bytes');
 assert.ok(elements(imported,'freedraw').length>elements(cancel,'freedraw').length,'Imported page must stay editable');
 const movedImage=elements(moved,'image').find(element=>element.id===added[0].id);
 assert.ok(movedImage,'Moved page must keep the imported image');
 assert.equal(elements(moved,'image').length,elements(imported,'image').length,'Dragging must not import another image');
 assert.ok(movedImage.x!==added[0].x||movedImage.y!==added[0].y,`Dragging the imported image must move it (x ${added[0].x}->${movedImage.x}, y ${added[0].y}->${movedImage.y})`);
 assert.equal(elements(camera,'image').length,elements(moved,'image').length,'Camera boundary must not add an image');
 assert.equal(active(camera).id,active(moved).id,'Camera boundary must keep the active page');
 return {checks:['current board saves a verifiable baseline revision','cancelled pick keeps the board','import adds one image element with complete bytes','imported page stays editable','dragging moves the imported element','camera entry adds no object'],move:{from:{x:added[0].x,y:added[0].y},to:{x:movedImage.x,y:movedImage.y}},elementCounts:{images:elements(moved,'image').length,strokes:elements(moved,'freedraw').length},revisions:{baseline:baseline.revision,cancel:cancel.revision,import:imported.revision,move:moved.revision,camera:camera.revision},storeKey:boards['after-camera'].key,camera:steps.find(step=>step.name==='testCameraEntryOpensAndDismisses')?.boundary??null};
}
const report={startedAt:new Date().toISOString(),requestedOutput:requestedOut,output:out,devices:[],passed:true};
try{
 await access(exercise);
 const runnerApp=await prepareRunner();
 for(const udid of devices){
  const device=await qaDevice(udid);
  if(app)await simctl('install',udid,path.resolve(app));
  await run('xcrun',['simctl','get_app_container',udid,'app.siyue.mobile','app']);
  await simctl('install',udid,runnerApp);
  const entry={device:{udid,name:device.name,runtime:device.runtime},photos:await seedPhoto(udid),steps:[],passed:true};
  report.devices.push(entry);
  const boards={};
  // 先跑基线用例：保存当前白板，空白 QA 安装与已有作品都能得到可核对的修订号（本轮记录的是已有作品）。
  const plan=[['testSaveBoardRevisionForBaseline','baseline'],['testLibraryPickerCancelKeepsBoardUsable','after-cancel'],['testLibraryPickerImportPersistsEditableImage','after-import'],['testMoveImportedImage','after-move'],['testCameraEntryOpensAndDismisses','after-camera']];
  for(const [test,snapshot] of plan){
   // simctl 没有 camera 服务；显式要求时才用 reset all 复现首次授权提示分支。
   if(test==='testCameraEntryOpensAndDismisses'&&process.env.SIYUE_IOS_RESET_CAMERA_PERMISSION)await simctl('privacy',udid,'reset','all','app.siyue.mobile');
   const step=await runTest(udid,test,device.label);
   entry.steps.push(step);
   if(!step.passed){entry.passed=report.passed=false;break;}
   boards[snapshot]=await store(udid,snapshot,{label:device.label});
  }
  if(entry.passed){try{Object.assign(entry,verify(boards,entry.steps));}catch(error){entry.passed=report.passed=false;entry.failure=error.message;}}
 }
 await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));
 for(const entry of report.devices)console.log(`${entry.passed?'PASS':'FAIL'} ${entry.device.name}: ${entry.steps.map(step=>`${step.name}=${step.passed?'pass':`fail(${step.executed} executed, exit ${step.exitCode}, ${step.summary})`}`).join(' ')}${entry.failure?` — ${entry.failure}`:''}`);
 console.log(`Result: ${path.relative(process.cwd(),path.join(out,'result.json'))}`);
 if(!report.passed)process.exitCode=1;
}catch(error){report.error=String(error.message??error);report.passed=false;await writeFile(path.join(out,'result.json'),JSON.stringify(report,null,2));throw error;}
