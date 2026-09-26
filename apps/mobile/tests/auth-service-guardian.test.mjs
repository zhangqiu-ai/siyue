import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {registerHooks} from 'node:module';

/**
 * The mobile factory is the only place that decides which endpoint and which transport the account
 * controller's faces may use. This test runs the real service against the real shared adapters build and
 * a stubbed native/expo surface, so it proves the guardian reads and the one approval leave this app on
 * the one fixed API prefix through expo/fetch with the adult bearer and nothing else.
 */
const baseUrl='https://api.qiugeapp.com/api/siyue/v1';
const at=(offsetMs)=>new Date(Date.now()+offsetMs).toISOString();
const opaque=()=>`${randomUUID()}.${'p'.repeat(43)}`;
const json=(body)=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});

const store=new Map(),requests=[];
const adult={subjectId:randomUUID(),sessionId:randomUUID()},childSubjectId=randomUUID(),familyId=randomUUID();
const accessToken=`mobile-access-${randomUUID()}`,refreshToken=opaque();
const accessExpiresAt=at(600_000),absolute=at(30*24*60*60*1000);
// The one action-bound grant the guardian's own re-verification issues, and the five-minute deadline the
// pairing, the grant and the approval all answer with.
const reauthGrant=opaque(),expiresAt=at(300_000);
store.set('siyue.auth.v1.production',JSON.stringify({schemaVersion:1,environment:'production',apiBaseUrl:baseUrl,installationId:randomUUID(),
  active:{...adult,subjectKind:'adult',refreshToken,refreshExpiresAt:absolute,absoluteExpiresAt:absolute,pendingRotationId:null,pendingSince:null},
  revocations:[]}));
globalThis.__siyueGuardianStore=store;
globalThis.__siyueGuardianFetch=async(url,init)=>{
  requests.push({url,method:init.method,headers:init.headers,body:init.body===undefined?undefined:JSON.parse(init.body)});
  if(url===baseUrl+'/auth/refresh')return json({data:{tokenType:'Bearer',accessToken,accessExpiresAt,refreshToken,
    refreshExpiresAt:absolute,sessionAbsoluteExpiresAt:absolute,session:{...adult,subjectKind:'adult',expiresAt:accessExpiresAt}}});
  if(url===baseUrl+`/families/${familyId}/children`)return json({data:{items:[{childSubjectId,familyId,
    guardianSubjectId:adult.subjectId,relationshipVersion:1,familyVersion:1,displayName:'小玥'}]}});
  if(url===baseUrl+'/auth/reauth/password')return json({data:{reauthGrant,expiresAt}});
  if(url.endsWith('/preview'))return json({data:{deviceLabel:'客厅 iPad',platform:'ios',
    expiresAt,child:{childSubjectId,displayName:'小玥'}}});
  if(url.endsWith('/approve'))return json({data:{status:'approved',expiresAt}});
  return new Response('null',{status:404,headers:{'content-type':'application/json'}});
};

// The native surface the service imports: Keychain, the non-secret install marker, the id source, the
// managed transport and the platform name. None of them is under test here.
const modules={
  'expo-secure-store':`export const WHEN_UNLOCKED_THIS_DEVICE_ONLY=6;export async function isAvailableAsync(){return true;}
    export async function getItemAsync(key){return globalThis.__siyueGuardianStore.get(key)??null;}
    export async function setItemAsync(key,value){globalThis.__siyueGuardianStore.set(key,value);}`,
  'expo-crypto':`export {randomUUID} from 'node:crypto';`,
  'expo/fetch':`export const fetch=(...args)=>globalThis.__siyueGuardianFetch(...args);`,
  'expo-sqlite':`const rows=new Map();export async function openDatabaseAsync(){return {async execAsync(){},
    async getFirstAsync(_sql,args){return rows.get(args[0])??null;},async runAsync(_sql,args){rows.set(args[0],{schema_version:1,initialized:1});}};}`,
  'react-native':`export const Platform={OS:'ios'};`,
};
globalThis.__DEV__=false;
const hook=registerHooks({resolve(specifier,context,next){const source=modules[specifier]??null;
  return source?{url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true}
    :next(context.parentURL?.includes('/apps/mobile/src/')&&specifier.startsWith('.')&&!/\.[a-z]+$/.test(specifier)?specifier+'.ts':specifier,context);}});
const {mobileAuthService}=await import('../src/account/auth-service.ts');hook.deregister();

test('the mobile account controller reads and approves one pairing through the same fixed endpoint and expo/fetch',async()=>{
  const service=mobileAuthService();
  await service.bootstrap();
  assert.equal(service.getState().status,'authenticated');
  const children=await service.guardianChildren(familyId);
  assert.deepEqual(children,[{childSubjectId,familyId,guardianSubjectId:adult.subjectId,
    relationshipVersion:1,familyVersion:1,displayName:'小玥'}]);
  const requestToken='r'.repeat(43),pairingId=randomUUID();
  const preview=await service.guardianPairingPreview(pairingId,requestToken,childSubjectId);
  assert.equal(preview.child.childSubjectId,childSubjectId);
  // One bearer per read, on this app's own base URL, and the preview carries the request token and the
  // proposed child alone — never a poll secret, a family role or a cookie.
  assert.deepEqual(requests.map(item=>[item.method,item.url]),[
    ['POST',baseUrl+'/auth/refresh'],
    ['GET',`${baseUrl}/families/${familyId}/children`],
    ['POST',`${baseUrl}/device-pairings/${pairingId}/preview`],
  ]);
  for(const item of requests.slice(1))assert.equal(item.headers.Authorization,`Bearer ${accessToken}`);
  assert.deepEqual(requests[2].body,{requestToken,childSubjectId});
  // The same controller then approves that previewed request: one action-bound re-verification, the
  // guardian's own current relationship version and one approval, all on the same session bearer.
  const approved=await service.approveChildPairingWithPassword({pairingId,requestToken,childSubjectId,familyId},'synthetic-password-1');
  assert.deepEqual(approved,{status:'approved',expiresAt});
  const approval=requests.slice(3);
  assert.deepEqual(approval.map(item=>[item.method,item.url]),[
    ['GET',`${baseUrl}/families/${familyId}/children`],
    ['POST',baseUrl+'/auth/reauth/password'],
    ['POST',`${baseUrl}/device-pairings/${pairingId}/approve`],
  ]);
  assert.deepEqual(approval[1].body,{password:'synthetic-password-1',action:'approve-child-device'});
  // The grant is handed to exactly one route and never travels with the request token anywhere else.
  assert.deepEqual(approval[2].body,{requestToken,childSubjectId,reauthGrant,expectedGuardianVersion:1});
  for(const item of approval)assert.equal(item.headers.Authorization,`Bearer ${accessToken}`);
  for(const published of [JSON.stringify(service.getState()),store.get('siyue.auth.v1.production')]){
    assert.equal(published.includes(accessToken),false);
    assert.equal(published.includes(requestToken),false);
    assert.equal(published.includes(reauthGrant),false);
  }
  await service.dispose();
});
