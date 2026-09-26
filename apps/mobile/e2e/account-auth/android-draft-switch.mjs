import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

const run=promisify(execFile),adb='/opt/homebrew/share/android-commandlinetools/platform-tools/adb',serial=process.env.SIYUE_QA_ANDROID??'emulator-5554',pkg='app.siyue.mobile.accountqa';
assert.match(serial,/^emulator-\d+$/);
const out=path.resolve(`artifacts/account-ui-android-draft-switch-${Date.now()}`);await mkdir(out,{recursive:true});
const command=(...args)=>run(adb,['-s',serial,...args],{maxBuffer:4*1024*1024});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function nodes(){
 await command('shell','uiautomator','dump','--compressed','/sdcard/siyue-account-qa.xml');
 const {stdout}=await command('shell','cat','/sdcard/siyue-account-qa.xml');
 await writeFile(path.join(out,'latest.xml'),stdout);
 return [...stdout.matchAll(/<node\b([^>]+)>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)].map(v=>[v[1],v[2]??v[3]])));
}
async function find(label){
 let visible=[];
 for(let i=0;i<30;i++){
  const all=await nodes();visible=all.flatMap(n=>[n.text,n['content-desc']]).filter(Boolean);
  const matches=all.filter(n=>[n.text,n['content-desc']].some(s=>s?.toLowerCase()===label.toLowerCase()));
  const match=matches.find(n=>n.clickable==='true'||n.class==='android.widget.EditText')??matches[0];
  if(match)return match;
  await pause(300);
 }
 throw Error(`Missing native control: ${label}; visible=${visible.join('|')}`);
}
async function tapNode(node){const [x,y,r,b]=node.bounds.match(/\d+/g).map(Number);await command('shell','input','tap',String(Math.round((x+r)/2)),String(Math.round((y+b)/2)));}
async function tap(label){const node=await find(label);console.log(`tap ${label}`);await tapNode(node);}
async function dismissKeyboard(){const {stdout}=await command('shell','dumpsys','input_method'),shown=/mInputShown=true/.test(stdout);console.log(`keyboard visible=${shown}`);if(shown)await command('shell','input','keyevent','4');}
async function field(label){const node=(await nodes()).find(n=>n.class==='android.widget.EditText'&&n['content-desc']===label);assert.ok(node,`Missing text input: ${label}`);return node;}
async function capture(name){const {stdout}=await run(adb,['-s',serial,'exec-out','screencap','-p'],{encoding:'buffer',maxBuffer:10*1024*1024});await writeFile(path.join(out,name+'.png'),stdout);}
async function launch(){await command('shell','am','force-stop',pkg);await command('shell','am','start','-W','-n',`${pkg}/app.siyue.mobile.MainActivity`);}
async function login(email,password,locale){
 await tap(email);await command('shell','input','text',`native-${locale}@example.test`);
 await tap(password);await command('shell','input','text','siyue-qa-native7');
 await capture(`${locale}-login-before-submit`);
 await tap(email==='邮箱'?'登录':'Sign in');
 await find(email==='邮箱'?'退出登录':'Sign out');
}
async function enterPlan(locale){
 const en=locale==='en',entry=en?'QA English Plan Draft':'QA 中文计划草稿',fieldLabel=en?'Goal name':'目标名称';
 await tap(entry);await find(fieldLabel);return {fieldLabel,en};
}
async function keepAndReturn(en){
 await dismissKeyboard();
 await tap(en?'Back':'返回');
 await find(en?'Discard unsaved changes?':'舍弃未保存的修改？');
 await tap(en?'Keep input and go back':'保留输入并返回');
}
async function assertGoal(label,value){
 const node=await field(label);assert.equal(node.text??'',value,`${label} should equal the value in the active workspace`);
}
async function runLocale(locale){
 const en=locale==='en',entry=en?'QA English dark':'QA 中文明色',accountRoute=en?'QA English dark':'QA 中文明色',email=en?'Email':'邮箱',password=en?'Password':'密码',planField=en?'Goal name':'目标名称';
 const localToken=`QA-LOCAL-${locale.toUpperCase()}`,accountToken=`QA-ACCOUNT-${locale.toUpperCase()}`;
 await command('shell','pm','clear',pkg);await launch();await enterPlan(locale);
 await tapNode(await field(planField));await command('shell','input','text',localToken);await assertGoal(planField,localToken);await keepAndReturn(en);await find(entry);
 await tap(accountRoute);await find(email);await login(email,password,locale);
 await tap(en?'Create an account space on this device':'在本机创建账号空间');
 await find(en?'Space switched. Your unsubmitted input is still kept on this device; switch back to continue editing.':'已切换空间。上一个空间的未提交输入仍保留在本机，切回该空间可继续编辑。');
 await find(en?'Current space: account space (on this device)':'当前空间：账号空间（仅本机）');await capture(`${locale}-switch-notice`);
 await tap('Navigate up');await enterPlan(locale);await assertGoal(planField,'');
 await tapNode(await field(planField));await command('shell','input','text',accountToken);await assertGoal(planField,accountToken);await keepAndReturn(en);await find(entry);
 await tap(accountRoute);await find(en?'Sign out':'退出登录');await tap(en?'Sign out':'退出登录');await find(email);
 await tap('Navigate up');await find(entry);await enterPlan(locale);await assertGoal(planField,localToken);await capture(`${locale}-local-restored`);await keepAndReturn(en);await find(entry);
 await tap(accountRoute);await find(email);await login(email,password,locale);
 await tap('Navigate up');await find(entry);await enterPlan(locale);await assertGoal(planField,accountToken);await capture(`${locale}-account-restored`);
 return {locale,localDraftRestored:true,accountDraftRestored:true,switchNotice:true,newSpaceStartsEmpty:true};
}

await command('reverse','tcp:18787','tcp:18787');
try{
 const results=[];
 const locales=process.env.SIYUE_QA_LOCALE?[process.env.SIYUE_QA_LOCALE]:['zh','en'];
 assert.ok(locales.every(locale=>locale==='zh'||locale==='en'),'SIYUE_QA_LOCALE must be zh or en');
 for(const locale of locales)results.push(await runLocale(locale));
 await writeFile(path.join(out,'result.json'),JSON.stringify({status:'passed',cases:results.length,checks:results,scope:'Android API 36 emulator; isolated QA package, synthetic PostgreSQL accounts; production PlanCreateScreen and AccountScreen',out},null,2));
 console.log(`Android account-space draft switch QA: ${results.length}/${results.length} locales passed. Evidence: ${out}`);
}catch(error){await capture('failure');throw error;}
finally{await command('reverse','--remove','tcp:18787');}
