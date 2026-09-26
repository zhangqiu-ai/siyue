import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
const run=promisify(execFile),adb='/opt/homebrew/share/android-commandlinetools/platform-tools/adb',serial=process.env.SIYUE_QA_ANDROID??'emulator-5554';
assert.match(serial,/^emulator-\d+$/);
const out=path.resolve(`artifacts/account-ui-android-${Date.now()}`),pkg='app.siyue.mobile.accountqa';await mkdir(out,{recursive:true});
const command=(...args)=>run(adb,['-s',serial,...args],{maxBuffer:4*1024*1024});
const imageMode=process.argv.includes('--images');
const vaultLossMode=process.argv.includes('--vault-loss');
const draftDiscardMode=process.argv.includes('--draft-discard');
const draftIsolationMode=process.argv.includes('--draft-isolation');
const whiteboardMode=imageMode||process.argv.includes('--whiteboard'),workspaceMode=whiteboardMode||process.argv.includes('--workspace');
const boards=new Map();let imageLabel;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function nodes(){await command('shell','uiautomator','dump','--compressed','/sdcard/siyue-account-qa.xml');const {stdout}=await command('shell','cat','/sdcard/siyue-account-qa.xml');await writeFile(path.join(out,'latest.xml'),stdout);return [...stdout.matchAll(/<node\b([^>]+)>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)].map(v=>[v[1],v[2]??v[3]])));}
let systemFailures=0;
async function find(label){for(let i=0;i<15;i++){
 const all=await nodes();
 if(all.some(n=>["System UI isn't responding","Pixel Launcher isn't responding"].includes(n.text))){
  if(++systemFailures>2)throw Error('QA emulator system repeatedly unresponsive');
  await capture(`system-anr-${systemFailures}`);const close=all.find(n=>n.text==='Close app');assert.ok(close);
  await tapNode(close);await pause(1000);continue;
 }
 const matches=all.filter(n=>[n.text,n['content-desc']].some(s=>s?.toLowerCase()===label.toLowerCase()));
 const node=matches.find(n=>n.clickable==='true')??matches[0];if(node)return node;await pause(400);
}throw Error(`Missing native control: ${label}`);}
async function tapNode(node){const [x,y,r,b]=node.bounds.match(/\d+/g).map(Number);await command('shell','input','tap',String(Math.round((x+r)/2)),String(Math.round((y+b)/2)));}
async function tap(label){const node=await find(label),[x,y,r,b]=node.bounds.match(/\d+/g).map(Number),px=Math.round((x+r)/2),py=Math.round((y+b)/2);console.log(`tap ${label} at ${px},${py} (${node['content-desc']||node.text})`);await command('shell','input','tap',String(px),String(py));}
async function capture(name){const {stdout}=await run(adb,['-s',serial,'exec-out','screencap','-p'],{encoding:'buffer',maxBuffer:10*1024*1024});await writeFile(path.join(out,name+'.png'),stdout);}
async function launch(){await command('shell','am','force-stop',pkg);await command('shell','am','start','-W','-n',`${pkg}/app.siyue.mobile.MainActivity`);}
async function inspectBoard(){
 const before=(await nodes()).find(n=>n['content-desc']?.startsWith('QA Board {'))?.['content-desc'];
 await tap('QA Inspect saved board');
 for(let i=0;i<15;i++){
  const value=(await nodes()).find(n=>n['content-desc']?.startsWith('QA Board {'))?.['content-desc'];
  if(value&&value!==before){const parsed=JSON.parse(value.slice('QA Board '.length).replaceAll('&quot;','"').replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>'));delete parsed.inspectionId;return parsed;}
  await pause(200);
 }throw Error('No native board inspection result');
}
async function drawBoard(en){
 await tap('QA Whiteboard');await find(en?'Photos':'选图');
 if(imageMode&&!en){await tap('选图');await find(imageLabel);const matches=(await nodes()).filter(n=>n['content-desc']===imageLabel);assert.equal(matches.length,1,'The seeded image has a unique picker label');await tapNode(matches[0]);await find('已保存到本机');}
 await tap(en?'Draw':'自由书写');
 const all=await nodes(),web=all.find(n=>n.class==='android.webkit.WebView');assert.ok(web,'Native WebView exists');
 const [x,y,r,b]=web.bounds.match(/\d+/g).map(Number);
 await command('shell','input','swipe',String(Math.round(x+(r-x)*.30)),String(Math.round(y+(b-y)*.60)),String(Math.round(x+(r-x)*.70)),String(Math.round(y+(b-y)*.65)),'550');
 // Resume via the launcher and verify the whiteboard remains usable with both strokes preserved.
 await command('shell','input','keyevent','3');await pause(800);
 await command('shell','am','start','-W','-n',`${pkg}/app.siyue.mobile.MainActivity`);
 await find(en?'Photos':'选图');await tap(en?'Draw':'自由书写');
 await command('shell','input','swipe',String(Math.round(x+(r-x)*.30)),String(Math.round(y+(b-y)*.72)),String(Math.round(x+(r-x)*.70)),String(Math.round(y+(b-y)*.77)),'550');
 await tap(en?'Save':'保存');await find(en?'Saved locally':'已保存到本机');await capture(en?'en-board-ink':'zh-board-ink');
 await tap(en?'Back':'返回');await find('QA Whiteboard');
}
async function cancelImage(en,expected){
 await tap('QA Whiteboard');await find(en?'Saved locally':'已保存到本机');
 await tap(en?'Photos':'选图');await find('Albums');
 await command('shell','input','keyevent','4');
 await find(en?'Photos':'选图');await find(en?'Saved locally':'已保存到本机');
 await capture(en?'en-image-cancel':'zh-image-cancel');
 await tap(en?'Back':'返回');await find('QA Whiteboard');
 assert.deepEqual(await inspectBoard(),expected,'Cancelling system photo selection preserves the existing editable board and image files');
}
if(imageMode){
 await command('shell','mkdir','-p','/sdcard/Pictures/SiyueQA');
 await command('push','apps/mobile/assets/whiteboard/exercise.png','/sdcard/Pictures/SiyueQA/siyue-qa-exercise.png');
 await command('shell','am','broadcast','-a','android.intent.action.MEDIA_SCANNER_SCAN_FILE','-d','file:///sdcard/Pictures/SiyueQA/siyue-qa-exercise.png');
 const {stdout}=await command('shell',`content query --uri content://media/external/images/media --projection date_modified:datetaken --where "_display_name='siyue-qa-exercise.png'"`);
 assert.equal((stdout.match(/Row:/g)??[]).length,1,'One seeded synthetic image is indexed');
 const modified=/date_modified=(\d+)/.exec(stdout),taken=/datetaken=(\d+)/.exec(stdout);assert.ok(modified);
 const zone=(await command('shell','getprop','persist.sys.timezone')).stdout.trim();
 const date=new Date(taken?Number(taken[1]):Number(modified[1])*1000);
 imageLabel='Photo taken on '+new Intl.DateTimeFormat('en-US',{timeZone:zone,month:'short',day:'numeric',year:'numeric'}).format(date)+' '+new Intl.DateTimeFormat('en-US',{timeZone:zone,hour:'numeric',minute:'2-digit',hour12:true}).format(date);
}
await command('reverse','tcp:18787','tcp:18787');
try{
 if(vaultLossMode){
  await command('shell','pm','clear',pkg);await launch();await tap('QA 中文明色');await find('邮箱');
  await command('shell','input','keyevent','4');await find('QA Remove initialized auth vault');await tap('QA Remove initialized auth vault');await find('QA vault item removed');
  await launch();await tap('QA 中文明色');await find('登录凭据无法读取，原件已保留。请联系支持，不要清空本机内容。');
  let fields=(await nodes()).filter(n=>n.class==='android.widget.EditText');assert.equal(fields.length,0,'A missing initialized SecureStore item must not show an empty sign-in form');await capture('zh-vault-item-missing');
  await launch();await tap('QA 中文明色');await find('登录凭据无法读取，原件已保留。请联系支持，不要清空本机内容。');fields=(await nodes()).filter(n=>n.class==='android.widget.EditText');assert.equal(fields.length,0,'A second cold launch must not reveal a newly written empty record');
  await command('shell','input','keyevent','4');await find('QA English dark');await tap('QA English dark');await find('Sign-in data cannot be read. The original is preserved. Contact support; do not clear local content.');
  fields=(await nodes()).filter(n=>n.class==='android.widget.EditText');assert.equal(fields.length,0,'The English error state must also preserve the original');await capture('en-vault-item-missing');
  await writeFile(path.join(out,'result.json'),JSON.stringify({status:'passed',cases:2,vaultItemMissing:true,locales:['zh-CN','en'],scope:'Android emulator, app-owned Expo SecureStore item removal and cold launch',out},null,2));
  console.log(`Android SecureStore loss QA: 2 passed. Evidence: ${out}`);
}else if(draftDiscardMode){
  for(const locale of ['zh','en']){
   const en=locale==='en',qa=en?'QA English Plan Draft':'QA 中文计划草稿',goalLabel=en?'Goal name':'目标名称',back=en?'Back':'返回';
   if(locale==='zh')await launch();await tap(qa);await find(goalLabel);
   const input=(await nodes()).find(n=>n.class==='android.widget.EditText'&&n['content-desc']===goalLabel);assert.ok(input,'Production goal field is exposed to native accessibility');
   await tapNode(input);const token=`QA-DISCARD-${locale.toUpperCase()}`;await command('shell','input','text',token);await find(token);
   await command('shell','input','keyevent','4');await find(goalLabel);await tap(back);
   await find(en?'Discard unsaved changes?':'舍弃未保存的修改？');await find(en?'Your unsubmitted goal input will be lost.':'尚未提交的目标输入将丢失。');
   await tap(en?'Keep editing':'继续编辑');
   const kept=(await nodes()).find(n=>n.class==='android.widget.EditText'&&n['content-desc']===goalLabel);assert.equal(kept?.text,token,'Keep editing must retain the current input');
   await tap(back);await find(en?'Discard unsaved changes?':'舍弃未保存的修改？');await tap(en?'Discard changes':'舍弃修改');await find('QA Plan Draft');await tap('QA Plan Draft');await find(goalLabel);
   const restored=(await nodes()).find(n=>n.class==='android.widget.EditText'&&n['content-desc']===goalLabel);assert.ok(restored);assert.equal(restored.text??'', '', 'Discard must clear the namespace-scoped in-process draft');
   await capture(`${locale}-draft-discard-cleared`);
   if(locale==='zh'){await tap(back);await find('QA English Plan Draft');}
   else{
    await tap(back);await find('QA English dark');await tap('QA English dark');await find('Email');
    await tap('Email');await command('shell','input','text','native-en@example.test');await tap('Password');await command('shell','input','text','siyue-qa-native7');
    await command('shell','input','keyevent','4');await tap('Sign in');await find('Sign out');
    await tap('Create an account space on this device');await find('Current space: account space (on this device)');await capture('account-page-after-discard');
   }
  }
  await writeFile(path.join(out,'result.json'),JSON.stringify({status:'passed',cases:3,locales:['zh-CN','en'],keepEditingRetainsDraft:true,discardClearsInProcessDraft:true,formalAccountLoginAndSpaceCreation:true,scope:'Android emulator QA app; production PlanCreateScreen native navigation alert and production AccountScreen login/space creation',out},null,2));
  console.log(`Android draft/account navigation QA: 3 passed. Evidence: ${out}`);
 }else if(draftIsolationMode){
  const field='目标名称',entry='QA 中文空间草稿';
  await launch();await tap(entry);await find(field);
  async function goal(){const current=(await nodes()).find(n=>n.class==='android.widget.EditText'&&n['content-desc']===field);assert.ok(current,'Production goal field is exposed to native accessibility');return current.text??'';}
  async function typeGoal(value,name){const current=(await nodes()).find(n=>n.class==='android.widget.EditText'&&n['content-desc']===field);assert.ok(current);await tapNode(current);await command('shell','input','text',value);assert.equal(await goal(),value);await capture(name);await command('shell','input','keyevent','4');}
  async function enterReadyScope(expected){
   for(let i=0;i<50;i++){
   const all=await nodes();
    if(all.some(n=>n.text===entry||n['content-desc']===entry)){await tap(entry);continue;}
    const failure=all.find(n=>n.text?.startsWith('qa_dependencies_missing:'))?.text;if(failure)throw Error(failure);
    if(all.some(n=>n.text===`QA Scope ready ${expected}`||n['content-desc']===`QA Scope ready ${expected}`))return;
    await pause(300);
   }
   throw Error(`Workspace QA did not become ready in ${expected} scope`);
  }
  assert.equal(await goal(),'','Local draft starts empty');await typeGoal('QA-LOCAL-DRAFT','local-draft');
  await tap('QA Scope A');await enterReadyScope('account');assert.equal(await goal(),'','A starts without the local draft');await typeGoal('QA-ACCOUNT-A-DRAFT','account-a-draft');
  await tap('QA Scope B');await enterReadyScope('account');assert.equal(await goal(),'','B starts without A or local draft');await typeGoal('QA-ACCOUNT-B-DRAFT','account-b-draft');
  await tap('QA Scope A');await enterReadyScope('account');assert.equal(await goal(),'QA-ACCOUNT-A-DRAFT','Returning to A restores only A draft');await capture('account-a-restored');
  await tap('QA Local');await enterReadyScope('local');assert.equal(await goal(),'QA-LOCAL-DRAFT','Returning to local restores only local draft');await capture('local-restored');
  await writeFile(path.join(out,'result.json'),JSON.stringify({status:'passed',cases:4,scopeOrder:['local','account A','account B','account A','local'],accountDraftsIsolated:true,processLocalDraftsRestored:true,scope:'Android emulator QA app; real test AuthController, WorkspaceProvider and production PlanCreateScreen; test-only controls select seeded synthetic accounts',out},null,2));
  console.log(`Android draft scope isolation QA: 4 passed. Evidence: ${out}`);
 }else for(const locale of ['zh','en']){
  const en=locale==='en',qa=en?'QA English dark':'QA 中文明色',email=en?'Email':'邮箱',password=en?'Password':'密码',signIn=en?'Sign in':'登录',signOut=en?'Sign out':'退出登录';
  await launch();await tap(qa);
  if(locale==='zh'&&process.argv.includes('--provider-outage')){
   const message='账号服务暂不可用，请稍后重试。';await find(message);
   assert.equal((await nodes()).filter(n=>n.text===message).length,1,'Show one actionable outage message');
   await capture('provider-outage');await tap('重试');
  }
  await find(email);await capture(`${locale}-sign-in`);
  await tap(email);await command('shell','input','text',`native-${locale}@example.test`);
  await tap(password);await command('shell','input','text','siyue-qa-native7');await capture(`${locale}-input`);
  await command('shell','input','keyevent','4');await tap(signIn);await find(signOut);await capture(`${locale}-signed-in`);
  if(workspaceMode){await tap(en?'Create an account space on this device':'在本机创建账号空间');await find(en?'Current space: account space (on this device)':'当前空间：账号空间（仅本机）');await find(signOut);await capture(`${locale}-account-space`);}
  if(whiteboardMode){await command('shell','input','keyevent','4');await find('QA Whiteboard');const empty=await inspectBoard();assert.equal(empty.scope,'account');assert.equal(empty.elements.length,0);await drawBoard(en);const saved=await inspectBoard();assert.equal(saved.elements.filter(e=>e.type==='freedraw').length,2,'Both the pre-background and resumed touch strokes persisted');if(imageMode){assert.equal(saved.elements.filter(e=>e.type==='image').length,en?0:1);if(!en)assert.notEqual(saved.fileDigest,empty.fileDigest,'Selected image file bytes must be persisted');else assert.equal(saved.fileDigest,empty.fileDigest,'B has no A image files');}boards.set(locale,saved);if(imageMode)await cancelImage(en,saved);}
  await launch();if(whiteboardMode){await find('QA Whiteboard');assert.deepEqual(await inspectBoard(),boards.get(locale),'Same namespace, strokes and files after cold restart');}await tap(qa);await find(signOut);if(workspaceMode)await find(en?'Current space: account space (on this device)':'当前空间：账号空间（仅本机）');
  await tap(signOut);await find(email);await launch();if(whiteboardMode){await find('QA Whiteboard');const guest=await inspectBoard();assert.equal(guest.scope,'local');assert.equal(guest.elements.length,0);}await tap(qa);await find(email);
 }
 if(whiteboardMode){
  await launch();await tap('QA 中文明色');await tap('邮箱');await command('shell','input','text','native-zh@example.test');await tap('密码');await command('shell','input','text','siyue-qa-native7');await command('shell','input','keyevent','4');await tap('登录');await find('当前空间：账号空间（仅本机）');await command('shell','input','keyevent','4');await find('QA Whiteboard');assert.deepEqual(await inspectBoard(),boards.get('zh'),'Returning to A restores A and not B');
  await tap('QA 中文明色');await tap('退出登录');await find('邮箱');
 }
 if(!vaultLossMode&&!draftDiscardMode&&!draftIsolationMode){await writeFile(path.join(out,'result.json'),JSON.stringify({status:'passed',cases:2,workspaceCreation:workspaceMode,whiteboardRecovery:whiteboardMode,whiteboardForegroundResume:whiteboardMode,whiteboardImages:imageMode,whiteboardImageCancel:imageMode,providerOutage:process.argv.includes('--provider-outage'),scope:'Android emulator, real SecureStore and loopback PostgreSQL API; login/restart/logout in zh light and en dark',out},null,2));console.log(`Android account QA: 2 passed. Evidence: ${out}`);}
}catch(error){await capture('failure');throw error;}
finally{await command('reverse','--remove','tcp:18787');}
