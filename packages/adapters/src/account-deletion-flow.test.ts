import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {AccountDeletionImpact,AuthClientErrorCode,AuthClientState,
  DeletionDependencyDisposition,DeletionStatus} from '@siyue/contracts';
import type {AppleAuthorize} from './apple-sign-in.js';
import {AuthClientError} from './auth-api-client.js';
import {createAccountDeletionFlow,type AccountDeletionFlowAuth,
  type AccountDeletionFlowController} from './account-deletion-flow.js';
import type {DeletionProgress,AuthController} from './auth-controller.js';

// Compile-time only: the real controller must satisfy both entry points this flow declares in full, so a
// signature drift breaks here instead of at a call site.
const controllerCompatibility:AccountDeletionFlowController={} as unknown as AuthController;
const authCompatibility:AccountDeletionFlowAuth={} as unknown as AuthController;
void controllerCompatibility;void authCompatibility;

const password='correct horse battery staple';
const stateKeys=['busy','completed','dispositionReady','error','families','locked','retryPending','status','step'];

/** One strict impact document. `role` absent means the subject only guards a child in that family. */
function impactOf(entries:readonly {familyId:string;role?:'owner'|'admin'|'member';children?:readonly string[]}[]):AccountDeletionImpact {
  const families:AccountDeletionImpact['families'][number][]=[];
  const guardianships:AccountDeletionImpact['guardianships'][number][]=[];
  for(const entry of entries) {
    if(entry.role)families.push({familyId:entry.familyId,role:entry.role,soleActiveOwner:entry.role==='owner',
      otherActiveAdultCount:1,otherActiveChildCount:entry.children?.length??0});
    for(const child of entry.children??[])guardianships.push({familyId:entry.familyId,childSubjectId:child,
      soleGuardian:false,otherGuardianCount:1,activeChildDeviceCount:1});
  }
  return {subjectId:randomUUID(),families,guardianships,
    activeChildDeviceCount:guardianships.reduce((total,row)=>total+row.activeChildDeviceCount,0)};
}

function progressOf(status:Partial<DeletionStatus>={}):DeletionProgress {
  return {deletionId:randomUUID(),expiresAt:new Date(Date.now()+86_400_000).toISOString(),
    status:{serverDataDeleted:false,providerRevocationPending:true,completedAt:null,lastErrorCode:null,...status}};
}

/** `keep` marks an answer that leaves the controller's submission slot open, the way a repeatable
 *  transport or unknown-outcome failure does. */
type Answer<T>={value?:T;error?:AuthClientErrorCode;thrown?:unknown;keep?:boolean};
type Deferred={promise:Promise<void>;resolve:()=>void};
function deferred():Deferred{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

/** Stand-in for the auth controller: it records the declaration it was handed, answers from a scripted
 *  queue and can hold one call open. `pending` is the controller's own repeatable submission slot. */
function fakeController(){
  const calls={impact:0,password:0,apple:0,retry:0,status:0};
  const plans:DeletionDependencyDisposition[]=[],passwords:string[]=[];
  const answers={impact:[] as Answer<AccountDeletionImpact>[],password:[] as Answer<void>[],
    apple:[] as Answer<void>[],retry:[] as Answer<void>[],status:[] as Answer<DeletionProgress|null>[]};
  let held:Deferred|null=null,pending=false;
  async function take<T>(queue:Answer<T>[],fallback:()=>T):Promise<T>{
    const gate=held;if(gate)await gate.promise;
    const answer=queue.shift();
    if(!answer)return fallback();
    if(answer.keep)pending=true;
    if(answer.thrown!==undefined)throw answer.thrown;
    if(answer.error)throw new AuthClientError(answer.error);
    return answer.value===undefined?fallback():answer.value;
  }
  const controller:AccountDeletionFlowController={
    deletionImpact(){calls.impact++;return take(answers.impact,()=>impactOf([]));},
    submitDeletionWithPassword(value,plan){calls.password++;passwords.push(value);plans.push(plan);
      return take(answers.password,()=>{pending=false;});},
    submitDeletionWithApple(_authorize,plan){calls.apple++;plans.push(plan);return take(answers.apple,()=>{pending=false;});},
    retryDeletion(){calls.retry++;return take(answers.retry,()=>{pending=false;});},
    deletionStatus(){calls.status++;return take(answers.status,()=>progressOf());},
    hasPendingDeletion:()=>pending,
  };
  return {controller,calls,plans,passwords,answers,
    hold(){held=deferred();},
    release(){const gate=held;held=null;gate?.resolve();}};
}

function fakeAuth(){
  const current={generation:0,status:'authenticated' as AuthClientState['status']};
  const listeners=new Set<()=>void>();
  return {getState:()=>({...current}),
    subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
    set(fields:Partial<typeof current>){Object.assign(current,fields);for(const listener of [...listeners])listener();},
    subscribers:()=>listeners.size};
}

function fixture(){const auth=fakeAuth(),fake=fakeController();
  return {auth,fake,flow:createAccountDeletionFlow(fake.controller,{auth})};}

/** The desktop renderer client, which has no native Apple flow and so omits the optional member. */
function fixtureWithoutApple(){
  const auth=fakeAuth(),fake=fakeController();
  const {submitDeletionWithApple,...rest}=fake.controller;
  void submitDeletionWithApple;
  return {auth,fake,flow:createAccountDeletionFlow(rest,{auth})};
}

test('an impact keeps every affected family unselected and refuses to continue until each one is chosen',async()=>{
  const {fake,flow}=fixture();
  const first=randomUUID(),second=randomUUID(),third=randomUUID(),child=randomUUID(),guarded=randomUUID();
  fake.answers.impact.push({value:impactOf([{familyId:first,role:'owner',children:[child]},
    {familyId:second,role:'member'},{familyId:third,children:[guarded]}])});
  assert.equal(await flow.loadImpact(),true);
  const loaded=flow.getState();
  assert.equal(loaded.step,'families');
  assert.deepEqual(loaded.families.map(row=>row.familyId),[first,second,third]);
  assert.deepEqual(loaded.families.map(row=>row.choice),[null,null,null]);
  assert.equal(loaded.dispositionReady,false);
  // A family the subject only guards a child in is its own row with no family role, and the guarded child
  // is reported under it rather than creating a second family entry.
  assert.equal(loaded.families[2]!.role,null);
  assert.equal(loaded.families[2]!.guardianships.length,1);
  assert.equal(loaded.families[0]!.guardianships[0]!.childSubjectId,child);
  assert.equal(flow.continue(),false);
  assert.equal(flow.getState().step,'families');
  assert.equal(flow.chooseDisposition({familyId:first,kind:'end-family-access'}),true);
  assert.equal(flow.getState().dispositionReady,false);
  assert.equal(flow.continue(),false);
  assert.equal(flow.chooseDisposition({familyId:second,kind:'end-family-access'}),true);
  assert.equal(flow.chooseDisposition({familyId:third,kind:'end-family-access'}),true);
  assert.equal(flow.getState().families[0]!.soleActiveOwner,true);
  assert.equal(flow.getState().dispositionReady,true);
  assert.equal(flow.continue(),true);
  assert.equal(flow.getState().step,'confirm');
});

test('a malformed choice or one naming an unimpacted family is refused instead of being matched to a row',async()=>{
  const {fake,flow}=fixture();
  const only=randomUUID();
  fake.answers.impact.push({value:impactOf([{familyId:only,role:'owner'}])});
  await flow.loadImpact();
  const refused:unknown[]=[{familyId:only,kind:'transfer'},{familyId:only,kind:'end-family-access',extra:1},
    {familyId:only,kind:'dissolve'},{familyId:randomUUID(),kind:'end-family-access'},{kind:'end-family-access'},
    {familyId:only,kind:'none'},null,'end-family-access'];
  for(const input of refused)assert.throws(()=>flow.chooseDisposition(input),{code:'invalid_request'},JSON.stringify(input));
  // Nothing was defaulted and the row is still unchosen, so a later continue still refuses.
  assert.equal(flow.getState().families[0]!.choice,null);
  assert.equal(flow.getState().dispositionReady,false);
  assert.equal(flow.continue(),false);
});

test('a failed impact read stays on the impact step and a later read recovers',async()=>{
  const {fake,flow}=fixture();
  fake.answers.impact.push({error:'unavailable'});
  await assert.rejects(flow.loadImpact(),{code:'unavailable'});
  assert.equal(flow.getState().step,'impact');
  assert.equal(flow.getState().error,'unavailable');
  assert.deepEqual(flow.getState().families,[]);
  const failure=new Error(`socket closed for ${password}`);
  fake.answers.impact.push({thrown:failure});
  await assert.rejects(flow.loadImpact(),error=>error instanceof AuthClientError&&error.code==='unavailable'&&!String(error).includes(password));
  const only=randomUUID();
  fake.answers.impact.push({value:impactOf([{familyId:only,role:'owner'}])});
  assert.equal(await flow.loadImpact(),true);
  assert.equal(flow.getState().step,'families');
  assert.equal(flow.getState().error,null);
});

test('an impact answer that breaks the strict contract is refused',async()=>{
  const {fake,flow}=fixture();
  fake.answers.impact.push({value:{subjectId:randomUUID(),families:[],guardianships:[],
    activeChildDeviceCount:0,subjectEmail:'a@b.c'} as unknown as AccountDeletionImpact});
  await assert.rejects(flow.loadImpact(),{code:'invalid_response'});
  assert.equal(flow.getState().step,'impact');
  assert.equal(flow.getState().error,'invalid_response');
});

test('a submission failure the controller did not keep returns to the family step with the choices intact',async()=>{
  const {fake,flow}=fixture();
  const only=randomUUID();
  fake.answers.impact.push({value:impactOf([{familyId:only,role:'owner'}])});
  await flow.loadImpact();
  flow.chooseDisposition({familyId:only,kind:'end-family-access'});
  flow.continue();
  fake.answers.password.push({error:'unavailable'});
  await assert.rejects(flow.submitWithPassword(password),{code:'unavailable'});
  const failed=flow.getState();
  assert.equal(failed.step,'families');
  assert.equal(failed.busy,false);
  assert.equal(failed.locked,false);
  assert.equal(failed.retryPending,false);
  assert.equal(failed.error,'unavailable');
  assert.deepEqual(failed.families[0]!.choice,{familyId:only,kind:'end-family-access'});
  // The caller may still edit: the failed request changed nothing on the server that this declaration owns.
  const recipient=randomUUID();
  assert.equal(flow.chooseDisposition({familyId:only,kind:'transfer',recipientSubjectId:recipient}),true);
  assert.equal(flow.continue(),true);
  assert.equal(flow.getState().step,'confirm');
});

test('an unknown submission outcome locks the declaration and only retryDeletion finishes it',async()=>{
  const {fake,flow}=fixture();
  const only=randomUUID();
  fake.answers.impact.push({value:impactOf([{familyId:only,role:'owner'}])});
  await flow.loadImpact();
  flow.chooseDisposition({familyId:only,kind:'end-family-access'});
  flow.continue();
  fake.answers.password.push({error:'deletion_outcome_unknown',keep:true});
  await assert.rejects(flow.submitWithPassword(password),{code:'deletion_outcome_unknown'});
  const locked=flow.getState();
  assert.equal(locked.step,'confirm');
  assert.equal(locked.locked,true);
  assert.equal(locked.retryPending,true);
  // A sent declaration can no longer be edited and no second submission starts.
  assert.equal(flow.chooseDisposition({familyId:only,kind:'end-family-access'}),false);
  assert.equal(flow.continue(),false);
  assert.equal(flow.backToFamilies(),false);
  assert.equal(flow.cancel(),false);
  await assert.rejects(flow.submitWithPassword(password),{code:'busy'});
  assert.equal(fake.calls.password,1);
  assert.equal(fake.calls.retry,0);
  fake.answers.status.push({value:progressOf({serverDataDeleted:true,providerRevocationPending:false,
    completedAt:new Date().toISOString()})});
  await flow.retry();
  assert.equal(fake.calls.retry,1);
  assert.equal(flow.getState().step,'progress');
  assert.equal(flow.getState().completed,true);
  assert.equal(flow.backToFamilies(),false);
});

test('a repeated retry failure keeps the lock and the retry option',async()=>{
  const {fake,flow}=fixture();
  const only=randomUUID();
  fake.answers.impact.push({value:impactOf([{familyId:only,role:'owner'}])});
  await flow.loadImpact();
  flow.chooseDisposition({familyId:only,kind:'end-family-access'});
  flow.continue();
  fake.answers.password.push({error:'timeout',keep:true});
  await assert.rejects(flow.submitWithPassword(password),{code:'timeout'});
  fake.answers.retry.push({error:'network',keep:true});
  await assert.rejects(flow.retry(),{code:'network'});
  assert.equal(flow.getState().step,'confirm');
  assert.equal(flow.getState().locked,true);
  assert.equal(flow.getState().retryPending,true);
  assert.equal(flow.getState().error,'network');
  fake.answers.retry.push({error:'deletion_dependencies',keep:true});
  await assert.rejects(flow.retry(),{code:'deletion_dependencies'});
  assert.equal(flow.getState().retryPending,true);
  assert.equal(flow.cancel(),false);
});

test('retry is refused when the controller holds nothing to finish',async()=>{
  const {fake,flow}=fixture();
  await assert.rejects(flow.retry(),{code:'operation_completed'});
  assert.equal(fake.calls.retry,0);
  assert.equal(flow.getState().retryPending,false);
});

test('progress never reports completion unless the receipt carries a completion instant',async()=>{
  const {fake,flow}=fixture();
  fake.answers.impact.push({value:impactOf([])});
  await flow.loadImpact();
  assert.equal(flow.getState().step,'confirm');
  fake.answers.password.push({});
  fake.answers.status.push({value:progressOf({serverDataDeleted:false,providerRevocationPending:true})});
  await flow.submitWithPassword(password);
  assert.deepEqual(fake.plans[0],{kind:'none'});
  assert.equal(flow.getState().step,'progress');
  assert.equal(flow.getState().status!.serverDataDeleted,false);
  assert.equal(flow.getState().status!.providerRevocationPending,true);
  assert.equal(flow.getState().completed,false);
  for(const status of [{serverDataDeleted:true,providerRevocationPending:true},
    {serverDataDeleted:true,providerRevocationPending:false}]) {
    fake.answers.status.push({value:progressOf(status)});
    assert.equal(await flow.loadProgress(),true);
    assert.equal(flow.getState().completed,false,JSON.stringify(status));
  }
  // A receipt this device cannot read is reported as no progress, never as a finished deletion.
  fake.answers.status.push({value:null});
  assert.equal(await flow.loadProgress(),false);
  assert.equal(flow.getState().status,null);
  assert.equal(flow.getState().completed,false);
  fake.answers.status.push({value:progressOf({serverDataDeleted:true,providerRevocationPending:false,
    completedAt:new Date().toISOString()})});
  assert.equal(await flow.loadProgress(),true);
  assert.equal(flow.getState().completed,true);
});

test('progress is only read in the progress step',async()=>{
  const {fake,flow}=fixture();
  assert.equal(await flow.loadProgress(),false);
  assert.equal(fake.calls.status,0);
  fake.answers.impact.push({value:impactOf([{familyId:randomUUID(),role:'owner'}])});
  await flow.loadImpact();
  assert.equal(await flow.loadProgress(),false);
  assert.equal(fake.calls.status,0);
});

test('the password is used for the call only and never reaches the published state',async()=>{
  const {fake,flow}=fixture();
  fake.answers.impact.push({value:impactOf([])});
  await flow.loadImpact();
  assert.deepEqual(Object.keys(flow.getState()).sort(),stateKeys);
  fake.answers.password.push({});
  fake.answers.status.push({value:progressOf()});
  await flow.submitWithPassword(password);
  assert.deepEqual(fake.passwords,[password]);
  assert.deepEqual(Object.keys(flow.getState()).sort(),stateKeys);
  assert.equal(JSON.stringify(flow.getState()).includes(password),false);
  // A password that breaks the contract is refused before the controller is asked.
  const other=fixture();
  other.fake.answers.impact.push({value:impactOf([])});
  await other.flow.loadImpact();
  await assert.rejects(other.flow.submitWithPassword('too-short'),{code:'invalid_request'});
  assert.equal(other.fake.calls.password,0);
  assert.equal(other.flow.getState().step,'confirm');
});

test('a transfer is sent verbatim with the recipient the caller named',async()=>{
  const {fake,flow}=fixture();
  const only=randomUUID(),recipient=randomUUID();
  fake.answers.impact.push({value:impactOf([{familyId:only,role:'owner'}])});
  await flow.loadImpact();
  flow.chooseDisposition({familyId:only,kind:'transfer',recipientSubjectId:recipient});
  flow.continue();
  fake.answers.password.push({});
  fake.answers.status.push({value:progressOf()});
  await flow.submitWithPassword(password);
  assert.deepEqual(fake.plans[0],{kind:'per-family',families:[{familyId:only,kind:'transfer',recipientSubjectId:recipient}]});
  assert.equal(flow.getState().step,'progress');
});

test('the Apple path sends the same declaration and refuses a non-function authorizer',async()=>{
  const {fake,flow}=fixture();
  const only=randomUUID(),child=randomUUID();
  fake.answers.impact.push({value:impactOf([{familyId:only,children:[child]}])});
  await flow.loadImpact();
  flow.chooseDisposition({familyId:only,kind:'end-family-access'});
  flow.continue();
  await assert.rejects(flow.submitWithApple(undefined as unknown as AppleAuthorize),{code:'invalid_request'});
  assert.equal(fake.calls.apple,0);
  fake.answers.apple.push({});
  fake.answers.status.push({value:progressOf()});
  await flow.submitWithApple(async()=>({identityToken:'t',authorizationCode:'c',state:'s'}));
  assert.equal(fake.calls.apple,1);
  assert.deepEqual(fake.plans[0],{kind:'per-family',families:[{familyId:only,kind:'end-family-access'}]});
  assert.equal(flow.getState().step,'progress');
});

test('a second submission is refused while the first is still in flight',async()=>{
  const {fake,flow}=fixture();
  fake.answers.impact.push({value:impactOf([])});
  await flow.loadImpact();
  fake.hold();
  const flight=flow.submitWithPassword(password);
  assert.equal(flow.getState().step,'submitting');
  await assert.rejects(flow.submitWithPassword(password),{code:'busy'});
  fake.answers.status.push({value:progressOf()});
  fake.release();
  await flight;
  assert.equal(fake.calls.password,1);
  assert.equal(flow.getState().step,'progress');
});

test('cancel clears the form and an impact answer that arrives afterwards is not published',async()=>{
  const {fake,flow}=fixture();
  const only=randomUUID();
  fake.hold();
  const flight=flow.loadImpact();
  assert.equal(flow.getState().busy,true);
  assert.equal(flow.cancel(),true);
  assert.equal(flow.getState().step,'impact');
  assert.equal(flow.getState().busy,false);
  fake.answers.impact.push({value:impactOf([{familyId:only,role:'owner'}])});
  fake.release();
  assert.equal(await flight,false);
  assert.deepEqual(flow.getState().families,[]);
  assert.equal(flow.getState().step,'impact');
});

test('an account generation change clears the old form and a late answer is not published',async()=>{
  const {auth,fake,flow}=fixture();
  const first=randomUUID(),second=randomUUID();
  fake.answers.impact.push({value:impactOf([{familyId:first,role:'owner'},{familyId:second,role:'member'}])});
  await flow.loadImpact();
  flow.chooseDisposition({familyId:first,kind:'end-family-access'});
  assert.notEqual(flow.getState().families[0]!.choice,null);
  // Another account arrives while a fresh read is still in flight.
  fake.hold();
  const flight=flow.loadImpact();
  auth.set({generation:1,status:'authenticated'});
  assert.equal(flow.getState().step,'impact');
  assert.deepEqual(flow.getState().families,[]);
  assert.equal(flow.getState().error,null);
  assert.equal(flow.getState().busy,false);
  fake.answers.impact.push({value:impactOf([{familyId:second,role:'member'}])});
  fake.release();
  assert.equal(await flight,false);
  assert.deepEqual(flow.getState().families,[]);
  assert.equal(flow.getState().step,'impact');
});

test('the flow own accepted deletion may settle into an anonymous generation and still reach progress',async()=>{
  const {auth,fake,flow}=fixture();
  const only=randomUUID();
  fake.answers.impact.push({value:impactOf([{familyId:only,role:'owner'}])});
  await flow.loadImpact();
  flow.chooseDisposition({familyId:only,kind:'end-family-access'});
  flow.continue();
  // The controller clears its local session as part of accepting the deletion, which bumps the generation
  // into anonymous before the submission promise resolves.
  fake.hold();
  const flight=flow.submitWithPassword(password);
  auth.set({generation:1,status:'anonymous'});
  assert.equal(flow.getState().step,'submitting');
  fake.answers.status.push({value:progressOf({serverDataDeleted:true,providerRevocationPending:true})});
  fake.release();
  await flight;
  const settled=flow.getState();
  assert.equal(settled.step,'progress');
  assert.equal(settled.completed,false);
  assert.equal(settled.locked,true);
  assert.equal(settled.status!.serverDataDeleted,true);
  assert.equal(settled.status!.providerRevocationPending,true);
  assert.equal(fake.calls.status,1);
});

test('a foreign anonymous generation still clears a flow that owns no submission',async()=>{
  const {auth,fake,flow}=fixture();
  fake.answers.impact.push({value:impactOf([{familyId:randomUUID(),role:'owner'}])});
  await flow.loadImpact();
  auth.set({generation:1,status:'anonymous'});
  assert.equal(flow.getState().step,'impact');
  assert.deepEqual(flow.getState().families,[]);
});

test('dispose clears this flow without disposing the shared controller and drops a late answer',async()=>{
  const {auth,fake,flow}=fixture();
  assert.equal(auth.subscribers(),1);
  fake.hold();
  const flight=flow.loadImpact();
  flow.dispose();
  assert.equal(auth.subscribers(),0);
  assert.equal('dispose' in fake.controller,false);
  assert.equal(flow.getState().step,'impact');
  assert.deepEqual(flow.getState().families,[]);
  fake.answers.impact.push({value:impactOf([{familyId:randomUUID(),role:'owner'}])});
  fake.release();
  assert.equal(await flight,false);
  assert.deepEqual(flow.getState().families,[]);
  // A disposed flow refuses further work instead of resuming the old account's form.
  assert.throws(()=>flow.chooseDisposition({familyId:randomUUID(),kind:'end-family-access'}),{code:'cancelled'});
  await assert.rejects(flow.loadImpact(),{code:'cancelled'});
});

test('a progress document that claims completion while a cleanup dimension is open is refused',async()=>{
  const {fake,flow}=fixture();
  fake.answers.impact.push({value:impactOf([])});
  await flow.loadImpact();
  fake.answers.password.push({});
  fake.answers.status.push({value:progressOf()});
  await flow.submitWithPassword(password);
  const completion=new Date().toISOString();
  const inconsistent=[
    {serverDataDeleted:false,providerRevocationPending:false,completedAt:completion},
    {serverDataDeleted:true,providerRevocationPending:true,completedAt:completion},
    {serverDataDeleted:false,providerRevocationPending:true,completedAt:completion},
  ];
  for(const status of inconsistent) {
    fake.answers.status.push({value:progressOf(status)});
    assert.equal(await flow.loadProgress(),false,JSON.stringify(status));
    assert.equal(flow.getState().completed,false,JSON.stringify(status));
    assert.equal(flow.getState().error,'invalid_response');
    assert.equal(flow.getState().status,null);
    assert.equal(flow.getState().step,'progress');
  }
  // Only a document that agrees with itself reports completion.
  fake.answers.status.push({value:progressOf({serverDataDeleted:true,providerRevocationPending:false,
    completedAt:completion})});
  assert.equal(await flow.loadProgress(),true);
  assert.equal(flow.getState().completed,true);
  assert.equal(flow.getState().error,null);
});

test('an external sign-out during a submission clears the form and a late failure never restores the old families',async()=>{
  const {auth,fake,flow}=fixture();
  const only=randomUUID();
  fake.answers.impact.push({value:impactOf([{familyId:only,role:'owner'}])});
  await flow.loadImpact();
  flow.chooseDisposition({familyId:only,kind:'end-family-access'});
  flow.continue();
  fake.hold();
  const flight=flow.submitWithPassword(password);
  // Another screen signs out: the controller enters `logging-out`, which is not this flow's own success.
  auth.set({generation:1,status:'logging-out'});
  assert.equal(flow.getState().step,'impact');
  assert.deepEqual(flow.getState().families,[]);
  assert.equal(flow.getState().locked,false);
  fake.answers.password.push({error:'cancelled'});
  fake.release();
  await assert.rejects(flight,{code:'cancelled'});
  assert.equal(flow.getState().step,'impact');
  assert.deepEqual(flow.getState().families,[]);
  assert.equal(flow.getState().retryPending,false);
  assert.equal(flow.getState().locked,false);
});

test('a generation jump larger than one is not adopted even when the new status is anonymous',async()=>{
  const {auth,fake,flow}=fixture();
  const only=randomUUID();
  fake.answers.impact.push({value:impactOf([{familyId:only,role:'owner'}])});
  await flow.loadImpact();
  flow.chooseDisposition({familyId:only,kind:'end-family-access'});
  flow.continue();
  fake.hold();
  const flight=flow.submitWithPassword(password);
  auth.set({generation:2,status:'anonymous'});
  assert.equal(flow.getState().step,'impact');
  assert.deepEqual(flow.getState().families,[]);
  fake.release();
  await assert.rejects(flight,{code:'cancelled'});
  assert.deepEqual(flow.getState().families,[]);
});

test('published state is frozen and a caller holding it cannot change what is submitted',async()=>{
  const {fake,flow}=fixture();
  const only=randomUUID(),recipient=randomUUID();
  fake.answers.impact.push({value:impactOf([{familyId:only,role:'owner',children:[randomUUID()]}])});
  await flow.loadImpact();
  // A refused step replaces nothing, so the published reference stays stable for a React store.
  const loaded=flow.getState();
  assert.equal(flow.getState(),loaded);
  assert.equal(flow.continue(),false);
  assert.equal(flow.getState(),loaded);
  assert.equal(Object.isFrozen(loaded),true);
  assert.equal(Object.isFrozen(loaded.families),true);
  assert.equal(Object.isFrozen(loaded.families[0]),true);
  assert.equal(Object.isFrozen(loaded.families[0]!.guardianships),true);
  flow.chooseDisposition({familyId:only,kind:'transfer',recipientSubjectId:recipient});
  const chosen=flow.getState();
  assert.notEqual(chosen,loaded);
  assert.equal(flow.getState(),chosen);
  // The caller keeps the object it was handed and edits it: the frozen snapshot refuses every write.
  assert.throws(()=>{(chosen.families[0]!.choice as {recipientSubjectId:string}).recipientSubjectId=randomUUID();},TypeError);
  assert.throws(()=>{(chosen.families as unknown as unknown[]).push({});},TypeError);
  assert.throws(()=>{(chosen.families[0]!.guardianships as unknown as unknown[]).push({});},TypeError);
  flow.continue();
  fake.answers.password.push({});
  fake.answers.status.push({value:progressOf()});
  await flow.submitWithPassword(password);
  // The declaration that reached the controller is the caller's own choice, not the edited copy.
  assert.deepEqual(fake.plans[0],{kind:'per-family',families:[{familyId:only,kind:'transfer',recipientSubjectId:recipient}]});
});

test('the explicit return to the family step keeps the choices already made',async()=>{
  const {fake,flow}=fixture();
  const first=randomUUID(),second=randomUUID(),recipient=randomUUID();
  fake.answers.impact.push({value:impactOf([{familyId:first,role:'owner'},{familyId:second,role:'member'}])});
  await flow.loadImpact();
  flow.chooseDisposition({familyId:first,kind:'end-family-access'});
  flow.chooseDisposition({familyId:second,kind:'end-family-access'});
  assert.equal(flow.continue(),true);
  assert.equal(flow.getState().step,'confirm');
  assert.equal(flow.backToFamilies(),true);
  assert.equal(flow.getState().step,'families');
  assert.equal(flow.getState().dispositionReady,true);
  assert.equal(flow.getState().error,null);
  assert.deepEqual(flow.getState().families.map(row=>row.choice?.kind),['end-family-access','end-family-access']);
  // The edited family is the one that reaches the controller, and the first decision survives the trip.
  assert.equal(flow.chooseDisposition({familyId:second,kind:'transfer',recipientSubjectId:recipient}),true);
  assert.equal(flow.continue(),true);
  fake.answers.password.push({});
  fake.answers.status.push({value:progressOf()});
  await flow.submitWithPassword(password);
  assert.deepEqual(fake.plans[0],{kind:'per-family',families:[{familyId:first,kind:'end-family-access'},
    {familyId:second,kind:'transfer',recipientSubjectId:recipient}]});
});

test('the family step is only re-entered from a decided family set',async()=>{
  const {fake,flow}=fixture();
  assert.equal(flow.backToFamilies(),false);
  assert.equal(flow.getState().step,'impact');
  // Nothing is affected, so there is no family choice to go back to and the step stays at confirm.
  fake.answers.impact.push({value:impactOf([])});
  await flow.loadImpact();
  assert.equal(flow.getState().step,'confirm');
  assert.equal(flow.backToFamilies(),false);
  assert.equal(flow.getState().step,'confirm');
});

test('resumeProgress enters progress from a surviving receipt without a password or a submission',async()=>{
  // A fresh flow is the state after a restart: no impact, no choices and no in-memory submission.
  const {fake,flow}=fixture();
  assert.equal(flow.getState().step,'impact');
  fake.answers.status.push({value:progressOf({serverDataDeleted:true,providerRevocationPending:true})});
  assert.equal(await flow.resumeProgress(),true);
  const resumed=flow.getState();
  assert.equal(resumed.step,'progress');
  assert.equal(resumed.locked,true);
  assert.equal(resumed.retryPending,false);
  assert.equal(resumed.error,null);
  assert.equal(resumed.completed,false);
  assert.equal(resumed.status!.serverDataDeleted,true);
  assert.equal(resumed.status!.providerRevocationPending,true);
  // The entry point takes no password and cannot submit.
  assert.equal(fake.calls.password,0);
  assert.equal(fake.calls.apple,0);
  assert.deepEqual(fake.plans,[]);
  assert.equal(fake.calls.impact,0);
});

test('a missing or expired receipt is neither progress nor completion',async()=>{
  const {fake,flow}=fixture();
  fake.answers.status.push({value:null});
  assert.equal(await flow.resumeProgress(),false);
  assert.equal(flow.getState().step,'impact');
  assert.equal(flow.getState().status,null);
  assert.equal(flow.getState().completed,false);
  assert.equal(flow.getState().error,null);
  // A document that claims completion while a cleanup dimension is open is refused, and still does not
  // enter progress or report completion.
  fake.answers.status.push({value:progressOf({serverDataDeleted:false,providerRevocationPending:false,
    completedAt:new Date().toISOString()})});
  assert.equal(await flow.resumeProgress(),false);
  assert.equal(flow.getState().step,'impact');
  assert.equal(flow.getState().completed,false);
  assert.equal(flow.getState().status,null);
  assert.equal(flow.getState().error,'invalid_response');
});

test('resumeProgress refuses while the controller still owns a submission',async()=>{
  const {fake,flow}=fixture();
  const only=randomUUID();
  fake.answers.impact.push({value:impactOf([{familyId:only,role:'owner'}])});
  await flow.loadImpact();
  flow.chooseDisposition({familyId:only,kind:'end-family-access'});
  flow.continue();
  fake.answers.password.push({error:'network',keep:true});
  await assert.rejects(flow.submitWithPassword(password),{code:'network'});
  const reads=fake.calls.status;
  assert.equal(await flow.resumeProgress(),false);
  // The in-memory submission owns the outcome, so no receipt is read behind it.
  assert.equal(fake.calls.status,reads);
  assert.equal(flow.getState().step,'confirm');
  assert.equal(flow.getState().locked,true);
  assert.equal(flow.getState().retryPending,true);
});

test('resumeProgress refreshes a progress that is already visible',async()=>{
  const {fake,flow}=fixture();
  const only=randomUUID();
  fake.answers.impact.push({value:impactOf([{familyId:only,role:'owner'}])});
  await flow.loadImpact();
  flow.chooseDisposition({familyId:only,kind:'end-family-access'});
  flow.continue();
  fake.answers.password.push({});
  fake.answers.status.push({value:progressOf()});
  await flow.submitWithPassword(password);
  assert.equal(flow.getState().step,'progress');
  fake.answers.status.push({value:progressOf({serverDataDeleted:true,providerRevocationPending:false,
    completedAt:new Date().toISOString()})});
  assert.equal(await flow.resumeProgress(),true);
  assert.equal(flow.getState().step,'progress');
  assert.equal(flow.getState().completed,true);
  assert.equal(fake.calls.status,2);
});

test('a controller without the Apple method refuses the Apple submission without submitting anything',async()=>{
  const cold=fixtureWithoutApple();
  // The capability refusal precedes the step guard: nothing is read, nothing is written, no step moves.
  const coldBefore=cold.flow.getState();
  await assert.rejects(cold.flow.submitWithApple(async()=>({identityToken:'t',authorizationCode:'c',state:'s'})),
    {code:'invalid_config'});
  assert.equal(cold.flow.getState(),coldBefore);
  assert.equal(cold.flow.getState().step,'impact');
  assert.equal(cold.fake.calls.impact,0);
  const {fake,flow}=fixtureWithoutApple();
  const only=randomUUID();
  fake.answers.impact.push({value:impactOf([{familyId:only,role:'owner'}])});
  await flow.loadImpact();
  flow.chooseDisposition({familyId:only,kind:'end-family-access'});
  flow.continue();
  const decided=flow.getState();
  await assert.rejects(flow.submitWithApple(async()=>({identityToken:'t',authorizationCode:'c',state:'s'})),
    {code:'invalid_config'});
  assert.equal(fake.calls.apple,0);
  assert.equal(fake.calls.password,0);
  assert.deepEqual(fake.plans,[]);
  // A refused Apple attempt leaves the decided declaration exactly as it was, so the same screen can
  // still submit with a password on a platform that has no Apple flow.
  assert.equal(flow.getState(),decided);
  assert.equal(flow.getState().step,'confirm');
  assert.equal(flow.getState().error,null);
  fake.answers.password.push({});
  fake.answers.status.push({value:progressOf()});
  await flow.submitWithPassword(password);
  assert.equal(flow.getState().step,'progress');
  assert.equal(fake.calls.password,1);
});
