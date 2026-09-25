import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createEmailRegistration,emailRegistrationActions,type EmailRegistrationActions} from './email-registration.js';
import {createAuthController} from './auth-controller.js';
import {AuthClientError,type AuthApiClient} from './auth-api-client.js';
const password='a long synthetic password';
const released={enabled:true,terms:{version:'terms-2026-09-25',url:'https://siyue.test/terms'},privacy:{version:'privacy-2026-09-25',url:'https://siyue.test/privacy'}};
function fixture(overrides:Partial<EmailRegistrationActions>={}) {
 let now=1000,requests=0,registers=0,issued:ReturnType<typeof challenge>|null=null;
 const challenge=()=>({challengeId:randomUUID(),requestSecret:'x'.repeat(43),expiresAt:new Date(now+600_000).toISOString(),resendAfterSeconds:60});
 const actions:EmailRegistrationActions={registrationPolicy:async()=>released,
  requestRegistration:async()=>{requests++;issued=challenge();return issued;},register:async()=>{registers++;},...overrides};
 const flow=createEmailRegistration(actions,randomUUID,()=>now);
 flow.set('email','synthetic@example.test');
 return {flow,advance:(ms:number)=>{now+=ms;},requests:()=>requests,registers:()=>registers,issued:()=>issued};
}
test('an unreleased policy blocks both the code request and the confirmation',async()=>{
 let policyCalls=0;
 const fx=fixture({registrationPolicy:async()=>{policyCalls++;return {enabled:false,terms:null,privacy:null};}}),{flow}=fx;
 await flow.sendCode('en-US');
 assert.equal(flow.getState().error,'policy_unavailable');assert.equal(fx.requests(),0);assert.equal(policyCalls,1);
 // Even filled in completely, a screen that never saw released documents cannot confirm.
 flow.set('password',password);flow.set('repeatPassword',password);flow.set('code','123456');flow.setConsent(true);
 await flow.confirm();
 assert.equal(flow.getState().step,'email');assert.equal(fx.registers(),0);
});
test('confirmation carries the versions the server released, not one supplied by the screen',async()=>{
 const seen:Array<{input:Record<string,unknown>;key:string}>=[];
 const fx=fixture({register:async(input,key)=>{seen.push({input:input as Record<string,unknown>,key});}}),{flow}=fx;
 await flow.sendCode('zh-CN');assert.equal(flow.getState().step,'verify');assert.equal(fx.requests(),1);
 flow.set('code','123456');flow.set('password',password);flow.set('repeatPassword',password);flow.set('displayName','  思玥家长  ');
 flow.setConsent(true);await flow.confirm();
 assert.equal(flow.getState().step,'complete');assert.equal(seen.length,1);
 const confirmed=seen[0]!.input;
 assert.deepEqual(confirmed,{challengeId:fx.issued()!.challengeId,requestSecret:'x'.repeat(43),
   code:'123456',password,displayName:'思玥家长',termsVersion:released.terms.version,privacyVersion:released.privacy.version});
 // Exactly the strict confirm payload: no address, no locale and no remembered version travel with it.
 assert.deepEqual(Object.keys(confirmed).sort(),['challengeId','code','displayName','password','privacyVersion','requestSecret','termsVersion']);
});
test('confirm without consent, with a wrong password or a bad code never reaches the server',async()=>{
 const fx=fixture(),{flow}=fx;
 await flow.sendCode('en-US');
 flow.set('code','123456');flow.set('password',password);flow.set('repeatPassword',password);
 await flow.confirm();assert.equal(flow.getState().error,'consent_required');
 flow.setConsent(true);flow.set('repeatPassword','a different long password');
 await flow.confirm();assert.equal(flow.getState().error,'password_mismatch');
 flow.set('repeatPassword',password);flow.set('password','short');
 await flow.confirm();assert.equal(flow.getState().error,'password_policy');
 flow.set('password',password);flow.set('code','abcdef');
 await flow.confirm();assert.equal(flow.getState().error,'code_invalid');
 assert.equal(fx.registers(),0);assert.equal(flow.hasPendingRetry(),false);
});
test('an unknown confirmation result freezes the payload and repeats the identical key',async()=>{
 const seen:Array<{input:unknown;key:string}>=[];let fail=true;
 const fx=fixture({register:async(input,key)=>{seen.push({input,key});if(fail){fail=false;throw new AuthClientError('timeout');}}}),{flow}=fx;
 await flow.sendCode('en-US');
 flow.set('code','123456');flow.set('password',password);flow.set('repeatPassword',password);flow.setConsent(true);
 await flow.confirm();
 assert.equal(flow.getState().retryPending,true);assert.equal(flow.hasPendingRetry(),true);
 // The locked form cannot drift from the payload the original key already covers.
 flow.set('code','000000');flow.setConsent(false);
 assert.equal(flow.getState().code,'123456');assert.equal(flow.getState().accepted,true);
 // Re-reading the released policy is not a new intent and must not rotate the key.
 await flow.loadPolicy();await flow.retry();
 assert.equal(seen.length,2);assert.deepEqual(seen[0],seen[1]);assert.equal(flow.getState().step,'complete');
});
test('a lost code request keeps its key while a delivered code makes a later resend a new request',async()=>{
 const seen:Array<{input:unknown;key:string}>=[],fx=fixture({requestRegistration:async(input,key)=>{seen.push({input,key});
   if(seen.length===1)throw new AuthClientError('network');
   return {challengeId:randomUUID(),requestSecret:'x'.repeat(43),expiresAt:new Date(700_000).toISOString(),resendAfterSeconds:60};}}),{flow}=fx;
 await flow.sendCode('zh-CN');assert.equal(flow.getState().retryPending,true);assert.equal(fx.requests(),0);
 await flow.retry();
 assert.equal(seen.length,2);assert.deepEqual(seen[0],seen[1]);assert.equal(flow.getState().step,'verify');
 await flow.resend('zh-CN');assert.equal(seen.length,2);
 fx.advance(60_000);await flow.resend('zh-CN');
 assert.equal(seen.length,3);assert.notEqual(seen[2]!.key,seen[0]!.key);assert.deepEqual(seen[2]!.input,seen[0]!.input);
});
test('a refusal to repeat costs no key, and secrets never survive the screen',async()=>{
 const seen:Array<{input:unknown;key:string}>=[],fx=fixture({register:async(input,key)=>{seen.push({input,key});throw new AuthClientError('rate_limited',30);}}),{flow}=fx;
 await flow.sendCode('en-US');
 flow.set('code','123456');flow.set('password',password);flow.set('repeatPassword',password);flow.setConsent(true);
 await flow.confirm();assert.equal(flow.getState().error,'rate_limited');assert.equal(flow.hasPendingRetry(),false);
 await flow.confirm();assert.equal(seen.length,1);
 fx.advance(30_000);await flow.confirm();
 // A corrected refusal is a new attempt, never a silent reuse of the refused request's key.
 assert.equal(seen.length,2);assert.notEqual(seen[1]!.key,seen[0]!.key);
 flow.dispose();
 assert.equal(flow.getState().password,'');assert.equal(flow.getState().code,'');assert.equal(flow.getState().repeatPassword,'');
});
test('an unreachable policy read is reported and a later read releases the request',async()=>{
 let fail=true;
 const fx=fixture({registrationPolicy:async()=>{if(fail)throw new AuthClientError('network');return released;}}),{flow}=fx;
 await flow.sendCode('en-US');
 assert.equal(flow.getState().error,'policy_unavailable');assert.equal(flow.getState().policyError,'network');assert.equal(fx.requests(),0);
 fail=false;await flow.loadPolicy();
 assert.equal(flow.getState().policyError,null);assert.equal(flow.getState().policy?.enabled,true);
 await flow.sendCode('en-US');assert.equal(flow.getState().step,'verify');assert.equal(fx.requests(),1);
});
test('a rolled pair drops the consent and the stale versions before another attempt',async()=>{
 let policy:{enabled:boolean;terms:{version:string;url:string}|null;privacy:{version:string;url:string}|null}=released,loads=0;
 const seen:Array<{input:Record<string,unknown>;key:string}>=[];
 const fx=fixture({registrationPolicy:async()=>{loads++;return policy as never;},
   register:async(input,key)=>{seen.push({input:input as Record<string,unknown>,key});
     if(seen.length===1)throw new AuthClientError('policy_changed');}}),{flow}=fx;
 await flow.sendCode('en-US');
 flow.set('code','123456');flow.set('password',password);flow.set('repeatPassword',password);flow.setConsent(true);
 await flow.confirm();
 assert.equal(flow.getState().error,'policy_changed');
 // The confirmed versions are stale, so the refused attempt is not kept for replay and the consent
 // given for the old documents does not carry over.
 assert.equal(flow.getState().retryPending,false);assert.equal(flow.hasPendingRetry(),false);
 assert.equal(flow.getState().policy,null);assert.equal(flow.getState().accepted,false);
 const loadsAfterRefusal=loads;
 await flow.confirm();assert.equal(flow.getState().error,'consent_required');assert.equal(seen.length,1);
 assert.equal(loads,loadsAfterRefusal);
 policy={enabled:true,terms:{version:'terms-2026-10-02',url:'https://siyue.test/terms'},
   privacy:{version:'privacy-2026-10-02',url:'https://siyue.test/privacy'}};
 flow.setConsent(true);await flow.confirm();
 assert.equal(flow.getState().step,'complete');assert.equal(seen.length,2);
 assert.notEqual(seen[1]!.key,seen[0]!.key);
 assert.deepEqual(seen[1]!.input,{...seen[0]!.input,termsVersion:'terms-2026-10-02',privacyVersion:'privacy-2026-10-02'});
 assert.equal(loads>loadsAfterRefusal,true);
});
test('a closed deployment answers the next request without a write until the pair is read again',async()=>{
 let policy:{enabled:boolean;terms:{version:string;url:string}|null;privacy:{version:string;url:string}|null}=released,registers=0;
 const fx=fixture({registrationPolicy:async()=>policy as never,
   register:async()=>{registers++;throw new AuthClientError('registration_closed');}}),{flow}=fx;
 await flow.sendCode('en-US');
 flow.set('code','123456');flow.set('password',password);flow.set('repeatPassword',password);flow.setConsent(true);
 await flow.confirm();
 assert.equal(flow.getState().error,'registration_closed');
 assert.equal(flow.getState().retryPending,false);assert.equal(flow.hasPendingRetry(),false);
 assert.equal(flow.getState().policy,null);
 // The deployment really is closed now: the next request reads the pair again and makes no call.
 policy={enabled:false,terms:null,privacy:null};
 await flow.back();assert.equal(flow.getState().step,'email');
 await flow.sendCode('en-US');
 assert.equal(flow.getState().error,'policy_unavailable');assert.equal(registers,1);assert.equal(fx.requests(),1);
});
test('a lost confirmation is repeated under its own key until the shared session store holds one session',async()=>{
 const baseUrl='http://127.0.0.1:8787/v1',challengeId=randomUUID();
 const session=(subjectId:string)=>{const expiresAt=new Date(Date.now()+600_000).toISOString(),absolute=new Date(Date.now()+86_400_000).toISOString();
   return {tokenType:'Bearer' as const,accessToken:`access-${randomUUID()}`,accessExpiresAt:expiresAt,
     refreshToken:`${subjectId}.${'r'.repeat(43)}`,refreshExpiresAt:absolute,sessionAbsoluteExpiresAt:absolute,
     session:{subjectId,subjectKind:'adult' as const,sessionId:randomUUID(),expiresAt}};};
 const byKey=new Map<string,ReturnType<typeof session>>();let issued=0,loseAnswer=true;
 const keys:string[]=[];
 // The server commits the account and its session, then the answer is lost: the retry has to resume
 // that same operation instead of registering a second account.
 const api={endpoint:{environment:'test' as const,apiBaseUrl:baseUrl},
   registrationPolicy:async()=>released,
   requestRegistration:async()=>({challengeId,requestSecret:'x'.repeat(43),expiresAt:new Date(Date.now()+600_000).toISOString(),resendAfterSeconds:60}),
   register:async(_input:{installationId:string},key:string)=>{keys.push(key);
     if(!byKey.has(key)){byKey.set(key,session(randomUUID()));issued++;}
     if(loseAnswer){loseAnswer=false;throw new AuthClientError('timeout');}
     return byKey.get(key)!;}} as unknown as AuthApiClient;
 let vaultRaw:string|null=null;
 const controller=createAuthController({api,vault:{read:async()=>vaultRaw,write:async(value:string)=>{vaultRaw=value;}},newId:randomUUID});
 await controller.bootstrap();
 const registration=createEmailRegistration(emailRegistrationActions(controller,'ios'),randomUUID);
 registration.set('email','synthetic@example.test');
 await registration.sendCode('zh-CN');
 registration.set('code','123456');registration.set('password',password);registration.set('repeatPassword',password);registration.setConsent(true);
 await registration.confirm();
 assert.equal(registration.getState().retryPending,true);assert.equal(controller.getState().status,'anonymous');
 await registration.retry();
 assert.equal(registration.getState().step,'complete');assert.equal(controller.getState().status,'authenticated');
 assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);assert.equal(issued,1);
 // The shared protected record holds the one session that was actually issued, and nothing else.
 const persisted=JSON.parse(vaultRaw!);
 assert.equal(persisted.active.subjectId,controller.getState().session?.subjectId);
 assert.equal(persisted.active.refreshToken,byKey.get(keys[0]!)!.refreshToken);
 for(const secret of [password,'123456',challengeId,'x'.repeat(43)]) assert.equal(vaultRaw!.includes(secret),false);
});
