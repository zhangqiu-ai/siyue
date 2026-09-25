import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

// Android native QA for the production AccountScreen device-session UI.
// The caller prepares the environment: the isolated APK app.siyue.mobile.accountqa is already installed
// (this script never clears or uninstalls it) and tests/e2e/native-account-server.mjs is already
// listening on loopback :18787 (this script never starts or stops it). Only synthetic fixture accounts
// are used; no production resource, credential or secret is read.
const run=promisify(execFile),adb='/opt/homebrew/share/android-commandlinetools/platform-tools/adb',serial=process.env.SIYUE_QA_ANDROID??'emulator-5554',pkg='app.siyue.mobile.accountqa',accountPassword='siyue-native-test-password',taggedDevice='QA registration device';
assert.match(serial,/^emulator-\d+$/);
const out=path.resolve(`artifacts/account-ui-android-device-sessions-${Date.now()}`);await mkdir(out,{recursive:true});
const command=(...args)=>run(adb,['-s',serial,...args],{maxBuffer:4*1024*1024});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const {stdout:sizes}=await command('shell','wm','size');
const [,screenWidth,screenHeight]=sizes.match(/(\d+)x(\d+)/).map(Number);
const qaCopy={
 zh:{entry:'QA 中文明色',email:'邮箱',password:'密码',signIn:'登录',signOut:'退出登录',manageDevices:'管理登录设备',refreshDevices:'刷新设备列表',reauthPassword:'当前邮箱密码',revokeOther:'撤销此设备',revokeAll:'退出所有设备',confirmOther:'确定撤销此设备的登录会话？',confirmAll:'确定退出所有设备？当前设备也会退出。',current:'本设备',other:'其他设备',lastActive:'最近活动',deviceRevoked:'该设备已退出。',devicesRevoked:'所有设备均已退出。'},
 en:{entry:'QA English dark',email:'Email',password:'Password',signIn:'Sign in',signOut:'Sign out',manageDevices:'Manage signed-in devices',refreshDevices:'Refresh device list',reauthPassword:'Current email password',revokeOther:'Sign out other device',revokeAll:'Sign out all devices',confirmOther:'Sign out this device?',confirmAll:'Sign out all devices, including this one?',current:'This device',other:'Other device',lastActive:'Last active',deviceRevoked:'The device session was revoked.',devicesRevoked:'All device sessions were revoked.'}
};
const boxes=node=>{const [x1,y1,x2,y2]=node.bounds.match(/\d+/g).map(Number);return{x1,y1,x2,y2,cx:Math.round((x1+x2)/2),cy:Math.round((y1+y2)/2)};};
const onScreen=node=>{const b=boxes(node);return b.y1>=0&&b.y2<=screenHeight&&b.y2>b.y1;};
const says=(node,label)=>[node.text,node['content-desc']].some(value=>value?.toLowerCase()===label.toLowerCase());
const mentions=(node,fragment)=>[node.text,node['content-desc']].some(value=>value?.includes(fragment));
// A session row label is "<device label> · <this device|other device>"; row hints also contain " · ".
const sessionLabels=(all,copy)=>all.filter(node=>{const text=node.text??'';return text.endsWith(` · ${copy.current}`)||text.endsWith(` · ${copy.other}`);});
async function nodes(){
 await command('shell','uiautomator','dump','--compressed','/sdcard/siyue-account-qa.xml');
 const {stdout}=await command('shell','cat','/sdcard/siyue-account-qa.xml');
 await writeFile(path.join(out,'latest.xml'),stdout);
 return [...stdout.matchAll(/<node\b([^>]+)>/g)].map(m=>Object.fromEntries([...m[1].matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)].map(v=>[v[1],v[2]??v[3]])));
}
async function scroll(direction){
 const x=String(Math.round(screenWidth/2)),from=Math.round(screenHeight*(direction==='down'?.72:.34)),to=Math.round(screenHeight*(direction==='down'?.38:.66));
 await command('shell','input','swipe',x,String(from),x,String(to),'420');
}
const signature=all=>all.map(node=>`${node.class}:${node.bounds}`).join(';');
const onScreenMatch=(all,match)=>all.filter(match).find(node=>node.clickable==='true'&&onScreen(node))??all.filter(match).find(onScreen);
async function scanSteps(inspect,steps,direction){
 let previous=null;
 for(let i=0;i<steps;i++){
  const all=await nodes(),found=inspect(all);
  if(found)return found;
  const current=signature(all);
  if(current===previous)return null;
  previous=current;
  await scroll(direction);await pause(300);
 }
 return null;
}
// UIAutomator dumps only the viewport, so a missing control is searched near the current position,
// then up to the top of the content (notices render there), then down through the whole page.
async function scan(inspect,description){
 const found=await scanSteps(inspect,2,'down')??await scanSteps(inspect,12,'up')??await scanSteps(inspect,12,'down');
 if(found)return found;
 throw Error(`Missing native control on screen: ${description}`);
}
const revealWhere=(match,description)=>scan(all=>onScreenMatch(all,match),description);
const reveal=label=>revealWhere(node=>says(node,label),label),revealEdit=label=>revealWhere(node=>node.class==='android.widget.EditText'&&says(node,label),`${label} input`);
// Screen titles reuse product labels ("登录"), so taps only accept the clickable accessibility node.
const revealControl=label=>revealWhere(node=>says(node,label)&&node.clickable==='true',label);
async function find(label,attempts=30){
 for(let i=0;i<attempts;i++){
  const all=await nodes(),matches=all.filter(node=>says(node,label));
  const node=matches.find(candidate=>candidate.clickable==='true')??matches[0];
  if(node)return node;
  await pause(300);
 }
 throw Error(`Missing native control: ${label}`);
}
async function tapNode(node){const {cx,cy}=boxes(node);await command('shell','input','tap',String(cx),String(cy));}
async function tap(label){const node=await revealControl(label);console.log(`tap ${label}`);await tapNode(node);await pause(500);}
async function capture(name){const {stdout}=await run(adb,['-s',serial,'exec-out','screencap','-p'],{encoding:'buffer',maxBuffer:10*1024*1024});await writeFile(path.join(out,`${name}.png`),stdout);}
async function launch(){await command('shell','am','force-stop',pkg);await command('shell','am','start','-W','-n',`${pkg}/app.siyue.mobile.MainActivity`);await pause(900);}
async function dismissKeyboard(){
 const {stdout}=await command('shell','dumpsys','input_method');
 if(/mInputShown=true/.test(stdout)){await command('shell','input','keyevent','4');await pause(600);}
}
async function typeInto(label,value,{verify=true}={}){
 const node=await revealEdit(label);await tapNode(node);await pause(300);
 await command('shell','input','text',value);await pause(400);
 const readField=async()=>(await nodes()).find(candidate=>candidate.class==='android.widget.EditText'&&says(candidate,label));
 let typed=await readField();
 for(let i=0;i<8&&!(typed&&(verify?typed.text===value:(typed.text??'').length>0));i++){await pause(300);typed=await readField();}
 assert.ok(typed,`Missing text input: ${label}`);
 if(verify)assert.equal(typed.text??'',value,`${label} shows the typed value`);
 else assert.ok((typed.text??'').length>0,`${label} received input`);
}
async function enterAccount(copy){
 for(let i=0;i<20;i++){
  const all=await nodes(),entry=all.find(node=>says(node,copy.entry)&&node.clickable==='true');
  if(entry){await tapNode(entry);await pause(800);return;}
  // "Navigate up" only exists on a pushed route, so a restored account screen is accepted even while
  // its sign-in form or sign-out control happens to be outside the current viewport.
  if(all.some(node=>says(node,copy.email)||says(node,copy.signOut)||says(node,'Navigate up')))return;
  await pause(300);
 }
 throw Error('QA app showed neither the account entry screen nor the account screen');
}
async function ensureSignedOut(copy){
 for(let i=0;i<6;i++){await scroll('up');await pause(250);}
 for(let i=0;i<12;i++){
  const all=await nodes();
  if(all.some(node=>says(node,copy.email)))return true;
  if(all.some(node=>says(node,copy.signOut))){await tap(copy.signOut);await reveal(copy.email);return false;}
  await scroll('down');await pause(350);
 }
 throw Error('Account screen showed neither the sign-in form nor a sign-out control');
}
async function confirmDialog(message,button){
 await find(message);
 const targets=(await nodes()).filter(node=>says(node,button)&&node.clickable==='true'&&node['content-desc']!==button);
 assert.equal(targets.length,1,`Exactly one system dialog button "${button}" confirms "${message}"`);
 await tapNode(targets[0]);await pause(800);
}
const sessionRow=(copy,kind,tag)=>revealWhere(node=>(node.text??'').includes(`· ${kind}`)&&(tag===undefined||(node.text??'').includes(tag)),`device session row ${tag??kind} · ${kind}`);
function rowScope(all,label,copy){
 const top=boxes(label).y1,bounds=sessionLabels(all,copy).map(node=>boxes(node).y1).filter(y=>y>top);
 const bottom=bounds.length?Math.min(...bounds):top+460;
 return all.filter(node=>boxes(node).y1>=top&&boxes(node).y1<bottom);
}
async function rowControl(copy,kind,tag,control){
 return scan(all=>{
  const label=all.find(node=>(node.text??'').includes(`· ${kind}`)&&(node.text??'').includes(tag));
  if(!label)return null;
  const candidates=rowScope(all,label,copy).filter(node=>(node['content-desc']??'').toLowerCase()===control.toLowerCase());
  assert.ok(candidates.length<=1,`Row "${tag}" exposes at most one ${control} control`);
  return candidates.find(onScreen)??null;
 },`the ${control} control in the ${kind} row "${tag}"`);
}
// UIAutomator only dumps nodes inside the viewport, so absence has to be proven by sweeping the list.
async function listed(copy,tag){
 const all=await nodes();
 return all.some(node=>(node.text??'').includes(`· ${copy.other}`)&&(node.text??'').includes(tag));
}
async function sweepAbsent(copy,tag,steps=8){
 for(let i=0;i<6;i++){await scroll('up');await pause(350);}
 for(let i=0;i<steps;i++){
  if(await listed(copy,tag))throw Error(`Revoked device session ${tag} is still listed`);
  await scroll('down');await pause(350);
 }
}
async function runLocale(locale){
 const copy=qaCopy[locale],email=`native-${locale}@example.test`;
 await launch();await enterAccount(copy);
 const signedOutAtStart=await ensureSignedOut(copy);
 await capture(`${locale}-sign-in`);
 await typeInto(copy.email,email);
 await typeInto(copy.password,accountPassword,{verify:false});
 await capture(`${locale}-credentials-entered`);
 await dismissKeyboard();
 await tap(copy.signIn);await revealControl(copy.signOut);
 await capture(`${locale}-signed-in`);
 await tap(copy.manageDevices);await revealEdit(copy.reauthPassword);
 const current=await sessionRow(copy,copy.current);
 assert.equal(sessionLabels(await nodes(),copy).filter(node=>(node.text??'').endsWith(` · ${copy.current}`)).length,1,'Exactly one session is marked as this device');
 const other=await sessionRow(copy,copy.other,taggedDevice);
 const otherScope=rowScope(await nodes(),other,copy);
 const otherHint=otherScope.find(node=>mentions(node,copy.lastActive));
 assert.ok(otherHint,'The tagged session row states its last activity');
 assert.ok(otherHint.text.includes('ios'),'The tagged session is the seeded iOS registration session');
 const blocked=await rowControl(copy,copy.other,taggedDevice,copy.revokeOther);
 const enabledWithoutPassword=blocked.enabled;
 await tapNode(blocked);await pause(1500);
 assert.equal((await nodes()).some(node=>says(node,copy.confirmOther)),false,'Revoking another device stays blocked until the current email password is re-entered');
 await capture(`${locale}-reauth-required`);
 await typeInto(copy.reauthPassword,accountPassword,{verify:false});
 await dismissKeyboard();
 await capture(`${locale}-devices-before-revoke`);
 await tapNode(await rowControl(copy,copy.other,taggedDevice,copy.revokeOther));
 await confirmDialog(copy.confirmOther,copy.revokeOther);
 await reveal(copy.deviceRevoked);
 await tap(copy.refreshDevices);
 await sweepAbsent(copy,taggedDevice);
 await sessionRow(copy,copy.current);
 await capture(`${locale}-devices-after-revoke`);
 await typeInto(copy.reauthPassword,accountPassword,{verify:false});
 await dismissKeyboard();
 await tap(copy.revokeAll);
 await confirmDialog(copy.confirmAll,copy.revokeAll);
 await reveal(copy.devicesRevoked);
 await capture(`${locale}-all-devices-revoked`);
 await reveal(copy.email);
 const signedOut=(await nodes());
 assert.equal(signedOut.some(node=>says(node,copy.signOut)),false,'Revoking every session signs this device out');
 assert.equal(signedOut.some(node=>says(node,copy.revokeAll)),false,'The device list is gone after revoking every session');
 await capture(`${locale}-signed-out-after-revoke-all`);
 await launch();await enterAccount(copy);
 await reveal(copy.email);
 const restarted=await nodes();
 assert.equal(restarted.some(node=>says(node,copy.signOut)),false,'A cold restart must not restore the revoked session');
 assert.equal(restarted.some(node=>(node.text??'').includes(taggedDevice)),false,'The revoked device stays absent after a cold restart');
 await capture(`${locale}-cold-restart-signed-out`);
 return {locale,account:email,startedSignedOut:signedOutAtStart,currentDevice:current.text,taggedDevice:other.text,taggedDevicePlatform:otherHint.text,revokeOtherEnabledWithoutPassword:enabledWithoutPassword,passwordReauthenticationRequired:true,otherDeviceRevoked:true,otherDeviceAbsentAfterServerRefresh:true,revokeAllDevices:true,coldRestartSignedOut:true};
}
const probe=await fetch('http://127.0.0.1:18787/v1/auth/providers').catch(()=>null);
assert.ok(probe?.ok,'The synthetic loopback fixture must already be running: node tests/e2e/native-account-server.mjs (this script neither starts nor stops it)');
const locales=process.env.SIYUE_QA_LOCALE?[process.env.SIYUE_QA_LOCALE]:['zh','en'];
assert.ok(locales.every(locale=>locale==='zh'||locale==='en'),'SIYUE_QA_LOCALE must be zh or en');
await command('reverse','tcp:18787','tcp:18787');
try{
 const results=[];
 for(const locale of locales)results.push(await runLocale(locale));
 await writeFile(path.join(out,'result.json'),JSON.stringify({status:'passed',cases:results.length,checks:results,scope:'Android emulator; isolated QA APK against the synthetic loopback fixture; production AccountScreen device session list, password reauth, single-session revocation, revoke-all and cold restart',out},null,2));
 console.log(`Android device-session QA: ${results.length}/${results.length} locales passed. Evidence: ${out}`);
}catch(error){await capture('failure');throw error;}
finally{await command('reverse','--remove','tcp:18787');}
