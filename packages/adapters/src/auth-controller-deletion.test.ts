import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {AccountDeletionImpact,AccountDeletionRequest,DeletionStatus,SessionTokens} from '@siyue/contracts';
import {createAuthController} from './auth-controller.js';
import {AuthClientError,type AuthApiClient} from './auth-api-client.js';

const baseUrl='http://127.0.0.1:8787/v1';
// The contract's own password rule, plus a non-ASCII character to prove the value is never re-encoded.
// 16 Unicode code points, so the contract's own rule (15..128) accepts it.
const password='注销账号用的合成密码验证短语 🌙';
const at=(offsetMs:number)=>new Date(Date.now()+offsetMs).toISOString();
const uuid=()=>randomUUID();
const refreshSecret=()=>`${randomUUID()}.${'r'.repeat(43)}`;
const receiptSecret=()=>'s'.repeat(43);
const emptyImpact=(subjectId:string):AccountDeletionImpact=>({subjectId,families:[],guardianships:[],activeChildDeviceCount:0});
const progress:DeletionStatus={serverDataDeleted:false,providerRevocationPending:true,completedAt:null,lastErrorCode:null};
const deferred=()=>{let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return {promise,release};};

/** One issued session per call, so a test can tell whose bearer a request carried and which account a
 *  switch installed. */
function session(subjectKind:'adult'|'child'):SessionTokens {
  const access=at(600_000),absolute=at(30*24*60*60*1000);
  return {tokenType:'Bearer',accessToken:`access-${uuid()}`,accessExpiresAt:access,refreshToken:refreshSecret(),refreshExpiresAt:absolute,
    sessionAbsoluteExpiresAt:absolute,session:{subjectId:uuid(),subjectKind,sessionId:uuid(),expiresAt:access}};
}

/**
 * One device over an in-process account api and two protected records: the session record the
 * controller already owns and the separate deletion-receipt record under test. The api keeps one job
 * per caller key, so a repeated submission answers from the job that key created rather than making a
 * second one, and every request records the bearer it was handed.
 */
function fixture({seed='adult',store=true,buildImpact,storageTimeoutMs}:{seed?:'anonymous'|'adult'|'child';store?:boolean;
  buildImpact?:(subjectId:string)=>AccountDeletionImpact;storageTimeoutMs?:number}={}) {
  const installationId=uuid(),first=session('adult'),child=session('child'),second=session('adult');
  const seeded=seed==='child'?child:seed==='adult'?first:null;
  const recovery=(value:SessionTokens)=>({subjectId:value.session.subjectId,subjectKind:value.session.subjectKind,sessionId:value.session.sessionId,
    refreshToken:value.refreshToken,refreshExpiresAt:value.refreshExpiresAt,absoluteExpiresAt:value.sessionAbsoluteExpiresAt,
    pendingRotationId:null,pendingSince:null});
  let record:string|null=seeded?JSON.stringify({schemaVersion:1,environment:'test',apiBaseUrl:baseUrl,installationId,
    active:recovery(seeded),revocations:[]}):null;
  const active=()=>JSON.parse(record!).active;
  const calls={reauth:[] as {token:string;action:string}[],impact:[] as string[],
    submit:[] as {token:string;key:string;input:AccountDeletionRequest}[],status:[] as {deletionId:string;receiptSecret:string}[],
    appleStart:[] as {token:string;action:string}[],appleGrants:[] as string[],appleComplete:0,native:0,login:0,refresh:0,logout:0};
  const jobs=new Map<string,{deletionId:string;receiptSecret:string;expiresAt:string}>();
  let failure:AuthClientError|null=null,gate:null|{promise:Promise<void>;release:()=>void}=null,entered:(()=>void)|null=null;
  let reauthGate:null|{promise:Promise<void>;release:()=>void}=null,reauthEntered:(()=>void)|null=null;
  let statusAnswer:unknown={...progress},grantExpiry:string|null=null,sessionWriteFailures=0,sessionWriteFailurePlain=false;
  const api={endpoint:{environment:'test' as const,apiBaseUrl:baseUrl},
    login:async()=>{calls.login++;return second;},
    refresh:async(refreshToken:string)=>{calls.refresh++;const current=active(),expiry=at(600_000);
      return {tokenType:'Bearer' as const,accessToken:`refreshed-${uuid()}`,accessExpiresAt:expiry,refreshToken,
        refreshExpiresAt:current.absoluteExpiresAt,sessionAbsoluteExpiresAt:current.absoluteExpiresAt,
        session:{subjectId:current.subjectId,subjectKind:current.subjectKind,sessionId:current.sessionId,expiresAt:expiry}};},
    logout:async()=>{calls.logout++;},
    reauthPassword:async(token:string,_password:string,_signal?:AbortSignal,action='change-password')=>{calls.reauth.push({token,action});
      if(reauthEntered){const notify=reauthEntered;reauthEntered=null;notify();}
      if(reauthGate)await reauthGate.promise;
      return {reauthGrant:refreshSecret(),expiresAt:grantExpiry??at(300_000)};},
    startAppleReauth:async(token:string,input:{action:string})=>{calls.appleStart.push({token,action:input.action});
      return {flowId:uuid(),transactionSecret:'t'.repeat(43),nonce:'n'.repeat(43),state:'x'.repeat(43),expiresAt:at(300_000)};},
    completeAppleReauth:async()=>{calls.appleComplete++;const grant=refreshSecret();calls.appleGrants.push(grant);
      return {reauthGrant:grant,expiresAt:at(300_000)};},
    deletionImpact:async(token:string)=>{calls.impact.push(token);const current=active();
      return buildImpact?buildImpact(current.subjectId):emptyImpact(current.subjectId);},
    submitDeletion:async(token:string,input:AccountDeletionRequest,key:string)=>{calls.submit.push({token,key,input});
      if(entered){const notify=entered;entered=null;notify();}
      if(gate)await gate.promise;
      if(failure){const throwing=failure;failure=null;throw throwing;}
      let job=jobs.get(key);
      if(!job){job={deletionId:uuid(),receiptSecret:receiptSecret(),expiresAt:at(60_000)};jobs.set(key,job);}
      return job;},
    deletionStatus:async(input:{deletionId:string;receiptSecret:string})=>{calls.status.push(input);
      const job=[...jobs.values()].find(value=>value.deletionId===input.deletionId);
      if(!job||job.receiptSecret!==input.receiptSecret)throw new AuthClientError('challenge_invalid');
      return statusAnswer;}};
  // The separate protected record: one receipt, writes that can be told to fail before or after the
  // value lands, and no fallback to the session record.
  let receiptRaw:string|null=null,receiptWrites=0,receiptFailures=0,receiptFailureStores=false,receiptWriteFailurePlain=false;
  let readGate:null|{promise:Promise<void>;release:()=>void}=null;
  const receiptVault={read:async()=>{if(readGate)await readGate.promise;return receiptRaw;},write:async(value:string)=>{receiptWrites++;
    if(receiptWriteFailurePlain){receiptWriteFailurePlain=false;throw new Error('native vault failure');}
    if(receiptFailures>0){receiptFailures--;if(receiptFailureStores)receiptRaw=value;throw new AuthClientError('storage_unavailable');}
    receiptRaw=value;}};
  const controller=createAuthController({api:api as unknown as AuthApiClient,newId:uuid,
    ...(storageTimeoutMs===undefined?{}:{storageTimeoutMs}),
    vault:{read:async()=>record,write:async(value:string)=>{if(sessionWriteFailures>0){sessionWriteFailures--;
      throw sessionWriteFailurePlain?new Error('native vault failure'):new AuthClientError('storage_unavailable');}record=value;}},
    ...(store?{deletionReceiptVault:receiptVault}:{})});
  return {controller,calls,jobs,first,child,second,active,
    // One synthetic provider authorization: it echoes the flow's own state and never contacts Apple.
    authorize:async({state}:{state:string})=>{calls.native++;return {state,identityToken:'synthetic.header.payload',authorizationCode:'synthetic-authorization-code'};},
    record:()=>record,receipt:()=>receiptRaw,receiptWrites:()=>receiptWrites,
    failOnce:(error:AuthClientError)=>{failure=error;},
    failReceiptWrites:(count:number,{afterStore=false}:{afterStore?:boolean}={})=>{receiptFailures=count;receiptFailureStores=afterStore;},
    failSessionWrites:(count:number,{plain=false}:{plain?:boolean}={})=>{sessionWriteFailures=count;sessionWriteFailurePlain=plain;},
    failReceiptWritePlainly:()=>{receiptWriteFailurePlain=true;},
    announceGrantExpiry:(value:string)=>{grantExpiry=value;},
    seedReceipt:(value:string|null)=>{receiptRaw=value;},
    announceStatus:(value:unknown)=>{statusAnswer=value;},
    holdRead(){readGate=deferred();},
    releaseRead(){readGate?.release();readGate=null;},
    holdSubmit(){const held=deferred();gate=held;},
    releaseSubmit(){gate?.release();gate=null;},
    nextSubmit(){return new Promise<void>(resolve=>{entered=resolve;});},
    holdReauth(){reauthGate=deferred();},
    releaseReauth(){reauthGate?.release();reauthGate=null;},
    nextReauth(){return new Promise<void>(resolve=>{reauthEntered=resolve;});}};
}

const login=(controller:ReturnType<typeof createAuthController>)=>controller.login({email:'next@example.test',password,platform:'android'});
const storedRecord=(value:string)=>JSON.parse(value) as {schemaVersion:number;environment:string;apiBaseUrl:string;subjectId:string;
  receipt:{deletionId:string;receiptSecret:string;expiresAt:string}};
const foreignReceipt=(environment:string,expiresAt:string)=>JSON.stringify({schemaVersion:1,environment,apiBaseUrl:baseUrl,
  subjectId:uuid(),receipt:{deletionId:uuid(),receiptSecret:receiptSecret(),expiresAt}});

test('a lost submission response repeats the same key and bearer and then completes',async()=>{
  const f=fixture();await f.controller.bootstrap();
  const refreshes=f.calls.refresh;
  await f.controller.deletionImpact();
  f.failOnce(new AuthClientError('network'));
  await assert.rejects(f.controller.submitDeletionWithPassword(password,{kind:'none'}),{code:'network'});
  // A transport loss is not a lost session: the same account stays signed in with one repeatable attempt.
  assert.equal(f.controller.getState().status,'authenticated');
  assert.equal(f.controller.hasPendingDeletion(),true);
  assert.equal(f.controller.getState().deletionPending,true);
  assert.equal(f.calls.submit.length,1);
  await f.controller.retryDeletion();
  assert.equal(f.calls.submit.length,2);
  assert.equal(f.calls.submit[0]!.key,f.calls.submit[1]!.key);
  assert.equal(f.calls.submit[0]!.token,f.calls.submit[1]!.token);
  // One re-verification, one job and no new refresh: the retry reuses the attempt rather than replumbing it.
  assert.equal(f.calls.reauth.length,1);
  assert.equal(f.jobs.size,1);
  assert.equal(f.calls.refresh,refreshes);
  assert.equal(f.controller.getState().status,'anonymous');
  assert.equal(f.controller.hasPendingDeletion(),false);
  assert.equal(f.controller.getState().deletionPending,false);
  const stored=storedRecord(f.receipt()!);
  assert.equal(JSON.parse(f.record()!).active,null);
  assert.equal(stored.subjectId,f.first.session.subjectId);
  assert.equal(stored.receipt.deletionId,[...f.jobs.values()][0]!.deletionId);
  // The receipt secret is a local proof: it never enters the published client state.
  assert.equal(JSON.stringify(f.controller.getState()).includes(stored.receipt.receiptSecret),false);
});

test('a failed receipt write is retried from the cached receipt without a second destructive request',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.deletionImpact();
  f.failReceiptWrites(1);
  await assert.rejects(f.controller.submitDeletionWithPassword(password,{kind:'none'}),{code:'storage_unavailable'});
  // The accepted job is kept with the session still signed in, because nothing was persisted yet.
  assert.equal(f.controller.hasPendingDeletion(),true);
  assert.equal(f.controller.getState().status,'secure-storage-unavailable');
  assert.equal(f.controller.getState().error,'storage_unavailable');
  assert.equal(f.controller.getState().deletionPending,true);
  assert.equal(f.receipt(),null);
  await f.controller.retryDeletion();
  assert.equal(f.calls.submit.length,1);
  assert.equal(f.calls.reauth.length,1);
  assert.equal(f.receiptWrites(),2);
  assert.equal(f.controller.getState().status,'anonymous');
});

test('a receipt the failed write already stored may be rewritten for the same job',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.deletionImpact();
  f.failReceiptWrites(1,{afterStore:true});
  await assert.rejects(f.controller.submitDeletionWithPassword(password,{kind:'none'}),{code:'storage_unavailable'});
  const written=storedRecord(f.receipt()!);
  await f.controller.retryDeletion();
  assert.equal(f.calls.submit.length,1);
  assert.deepEqual(storedRecord(f.receipt()!),written);
  assert.equal(f.controller.getState().status,'anonymous');
});

test('an account switch during the submission keeps the new account and writes no receipt',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.deletionImpact();
  f.holdSubmit();
  const sent=f.controller.submitDeletionWithPassword(password,{kind:'none'});
  await f.nextSubmit();
  await login(f.controller);
  const refused=assert.rejects(sent,{code:'cancelled'});
  f.releaseSubmit();
  await refused;
  assert.equal(f.controller.getState().status,'authenticated');
  assert.equal(f.controller.getState().account?.subjectId,f.second.session.subjectId);
  assert.equal(JSON.parse(f.record()!).active.subjectId,f.second.session.subjectId);
  assert.equal(f.receipt(),null);
  assert.equal(f.receiptWrites(),0);
  // The switched generation dropped the submission, so the new account can preview its own.
  assert.equal(f.controller.hasPendingDeletion(),false);
  assert.equal(f.calls.submit.length,1);
});

test('a child session is refused before any deletion request is spent',async()=>{
  const f=fixture({seed:'child'});await f.controller.bootstrap();
  assert.equal(f.controller.getState().status,'authenticated');
  await assert.rejects(f.controller.deletionImpact(),{code:'adult_required'});
  await assert.rejects(f.controller.submitDeletionWithPassword(password,{kind:'none'}),{code:'adult_required'});
  assert.equal(f.calls.impact.length,0);
  assert.equal(f.calls.reauth.length,0);
  assert.equal(f.calls.submit.length,0);
});

test('a preview belongs to one generation, session and subject',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.deletionImpact();
  await login(f.controller);
  await assert.rejects(f.controller.submitDeletionWithPassword(password,{kind:'none'}),{code:'invalid_request'});
  assert.equal(f.calls.submit.length,0);
  // The refusal was about the stale preview, not about the account: its own preview settles normally.
  await f.controller.deletionImpact();
  await f.controller.submitDeletionWithPassword(password,{kind:'none'});
  assert.equal(f.calls.submit.length,1);
  assert.equal(f.calls.submit[0]!.input.confirmation,true);
});

test('an impact about another subject is refused instead of cached',async()=>{
  const f=fixture({buildImpact:subjectId=>({...emptyImpact(subjectId),subjectId:uuid()})});await f.controller.bootstrap();
  await assert.rejects(f.controller.deletionImpact(),{code:'invalid_response'});
  // Nothing was cached, so a submission has no preview to settle.
  await assert.rejects(f.controller.submitDeletionWithPassword(password,{kind:'none'}),{code:'invalid_request'});
  assert.equal(f.calls.submit.length,0);
});

test('a device without the separate receipt record refuses to submit or read back a deletion',async()=>{
  const f=fixture({store:false});await f.controller.bootstrap();
  await f.controller.deletionImpact();
  await assert.rejects(f.controller.submitDeletionWithPassword(password,{kind:'none'}),{code:'invalid_config'});
  await assert.rejects(f.controller.deletionStatus(),{code:'invalid_config'});
  assert.equal(f.calls.submit.length,0);
  assert.equal(f.calls.status.length,0);
});

test('one submission owns the device until it settles',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.deletionImpact();
  f.holdSubmit();
  const first=f.controller.submitDeletionWithPassword(password,{kind:'none'});
  await f.nextSubmit();
  await assert.rejects(f.controller.submitDeletionWithPassword(password,{kind:'none'}),{code:'busy'});
  await assert.rejects(f.controller.retryDeletion(),{code:'busy'});
  assert.equal(f.calls.reauth.length,1);
  assert.equal(f.calls.submit.length,1);
  f.releaseSubmit();
  await first;
  assert.equal(f.controller.getState().status,'anonymous');
});

test('the declared handling must settle exactly the affected families',async()=>{
  const familyId=uuid(),guardianFamilyId=uuid();
  const impact=(subjectId:string):AccountDeletionImpact=>({subjectId,
    families:[{familyId,role:'owner',soleActiveOwner:true,otherActiveAdultCount:0,otherActiveChildCount:0}],
    guardianships:[{familyId:guardianFamilyId,childSubjectId:uuid(),soleGuardian:true,otherGuardianCount:0,activeChildDeviceCount:1}],
    activeChildDeviceCount:1});
  const f=fixture({buildImpact:impact});await f.controller.bootstrap();
  const preview=await f.controller.deletionImpact();
  assert.deepEqual(preview.families.map(family=>family.familyId),[familyId]);
  // `none` is refused while any family is affected, and so is a settled set that misses or adds one.
  for(const disposition of [{kind:'none'} as const,{kind:'per-family',families:[{familyId}]},
    {kind:'per-family',families:[{familyId,kind:'end-family-access'} as const,{familyId:uuid(),kind:'end-family-access'} as const]}]) {
    await assert.rejects(f.controller.submitDeletionWithPassword(password,disposition),{code:'invalid_request'});
  }
  assert.equal(f.calls.reauth.length,0);
  await assert.rejects(f.controller.submitDeletionWithPassword(password,{kind:'per-family',families:[]}),{code:'invalid_request'});
  await assert.rejects(f.controller.submitDeletionWithPassword('short',{kind:'per-family',families:[{familyId,kind:'end-family-access'}]}),{code:'invalid_request'});
  await assert.rejects(f.controller.submitDeletionWithPassword(password,{kind:'none'}),{code:'invalid_request'});
  await f.controller.submitDeletionWithPassword(password,{kind:'per-family',families:[{familyId,kind:'end-family-access'},
    {familyId:guardianFamilyId,kind:'end-family-access'}]});
  assert.deepEqual(f.calls.submit[0]!.input.dependencyDisposition,{kind:'per-family',families:[{familyId,kind:'end-family-access'},
    {familyId:guardianFamilyId,kind:'end-family-access'}]});
  assert.equal(f.calls.reauth[0]!.action,'delete-account');
});

test('an unexpired receipt of another job is not replaced, while an elapsed one may be',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.deletionImpact();
  const other=storedRecord(foreignReceipt('test',at(60_000)));
  f.seedReceipt(JSON.stringify(other));
  await assert.rejects(f.controller.submitDeletionWithPassword(password,{kind:'none'}),{code:'busy'});
  // The refusal costs no grant and no destructive request.
  assert.equal(f.calls.reauth.length,0);
  assert.equal(f.calls.submit.length,0);
  assert.equal(f.controller.hasPendingDeletion(),false);
  f.seedReceipt(foreignReceipt('test',at(-1_000)));
  await f.controller.submitDeletionWithPassword(password,{kind:'none'});
  assert.equal(f.calls.submit.length,1);
  assert.equal(f.controller.getState().status,'anonymous');
});

test('a corrupt or foreign receipt record is refused instead of overwritten',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.deletionImpact();
  f.seedReceipt('not-json');
  await assert.rejects(f.controller.submitDeletionWithPassword(password,{kind:'none'}),{code:'storage_corrupt'});
  await assert.rejects(f.controller.deletionStatus(),{code:'storage_corrupt'});
  assert.equal(f.calls.submit.length,0);
  // A record written by another endpoint is refused the same way, and the refused submission leaves it
  // exactly as it was instead of replacing it with this device's own job.
  await f.controller.bootstrap();
  await f.controller.deletionImpact();
  const foreign=foreignReceipt('development',at(60_000));
  f.seedReceipt(foreign);
  await assert.rejects(f.controller.submitDeletionWithPassword(password,{kind:'none'}),{code:'storage_corrupt'});
  assert.equal(f.calls.submit.length,0);
  assert.equal(f.receipt(),foreign);
});

test('deletion progress reads the receipt without a session and never publishes it',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.deletionImpact();
  await f.controller.submitDeletionWithPassword(password,{kind:'none'});
  const stored=storedRecord(f.receipt()!),answer={serverDataDeleted:true,providerRevocationPending:false,completedAt:at(0),lastErrorCode:null};
  f.announceStatus(answer);
  // The device is anonymous: the stored receipt secret is the whole proof, and only the minimum shape
  // travels back — no secret and no subject.
  assert.equal(f.controller.getState().status,'anonymous');
  const read=await f.controller.deletionStatus();
  assert.deepEqual(Object.keys(read!).sort(),['deletionId','expiresAt','status']);
  assert.equal(read!.deletionId,stored.receipt.deletionId);
  assert.deepEqual(read!.status,answer);
  assert.deepEqual(f.calls.status,[{deletionId:stored.receipt.deletionId,receiptSecret:stored.receipt.receiptSecret}]);
  assert.equal(JSON.stringify(read).includes(stored.receipt.receiptSecret),false);
  assert.equal(JSON.stringify(read).includes(stored.subjectId),false);
  assert.equal(JSON.stringify(f.controller.getState()).includes(stored.receipt.receiptSecret),false);
  // An elapsed receipt and an empty record both read as nothing to check, without spending a request.
  f.seedReceipt(foreignReceipt('test',at(-1_000)));
  assert.equal(await f.controller.deletionStatus(),null);
  f.seedReceipt(null);
  assert.equal(await f.controller.deletionStatus(),null);
  assert.equal(f.calls.status.length,1);
});

test('the cached preview is independent of the impact a caller edits',async()=>{
  const f=fixture({buildImpact:emptyImpact});await f.controller.bootstrap();
  const preview=await f.controller.deletionImpact();
  // A caller that edits what it was shown cannot change what a later submission settles: the cached
  // preview is its own copy, so these families never become part of the request.
  preview.families.push({familyId:uuid(),role:'owner',soleActiveOwner:true,otherActiveAdultCount:0,otherActiveChildCount:0});
  preview.activeChildDeviceCount=9;
  await f.controller.submitDeletionWithPassword(password,{kind:'none'});
  assert.equal(f.calls.submit.length,1);
  assert.deepEqual(f.calls.submit[0]!.input.dependencyDisposition,{kind:'none'});
});

test('a preview already owned by a submission in flight is not replaced',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.deletionImpact();
  f.holdSubmit();
  const first=f.controller.submitDeletionWithPassword(password,{kind:'none'});
  await f.nextSubmit();
  await assert.rejects(f.controller.deletionImpact(),{code:'busy'});
  assert.equal(f.calls.impact.length,1);
  f.releaseSubmit();
  await first;
  assert.equal(f.controller.getState().status,'anonymous');
});

test('the local session clear can be retried after the receipt is durable',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.deletionImpact();
  f.failSessionWrites(1);
  await assert.rejects(f.controller.submitDeletionWithPassword(password,{kind:'none'}),{code:'storage_unavailable'});
  // The accepted job and its durable receipt survive; only the local clear failed, so nothing has been
  // reported as signed out and the device still knows it owes a retry.
  assert.equal(f.controller.getState().status,'secure-storage-unavailable');
  assert.equal(f.controller.getState().error,'storage_unavailable');
  assert.equal(f.controller.getState().deletionPending,true);
  assert.equal(f.controller.hasPendingDeletion(),true);
  assert.equal(storedRecord(f.receipt()!).receipt.deletionId,[...f.jobs.values()][0]!.deletionId);
  assert.notEqual(JSON.parse(f.record()!).active,null);
  // The retry needs no session and repeats nothing destructive.
  await f.controller.retryDeletion();
  assert.equal(f.calls.submit.length,1);
  assert.equal(f.calls.reauth.length,1);
  assert.equal(JSON.parse(f.record()!).active,null);
  assert.equal(f.controller.getState().status,'anonymous');
  assert.equal(f.controller.getState().deletionPending,false);
});

test('a native receipt-write failure is reported as storage and stays retryable',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.deletionImpact();
  f.failReceiptWritePlainly();
  await assert.rejects(f.controller.submitDeletionWithPassword(password,{kind:'none'}),{code:'storage_unavailable'});
  assert.equal(f.controller.hasPendingDeletion(),true);
  assert.equal(f.receipt(),null);
  await f.controller.retryDeletion();
  assert.equal(f.calls.submit.length,1);
  assert.equal(storedRecord(f.receipt()!).receipt.deletionId,[...f.jobs.values()][0]!.deletionId);
  assert.equal(f.controller.getState().status,'anonymous');
});

test('a re-verification deadline the client cannot read does not pass',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.deletionImpact();
  f.announceGrantExpiry('not-a-date');
  await assert.rejects(f.controller.submitDeletionWithPassword(password,{kind:'none'}),{code:'invalid_response'});
  assert.equal(f.calls.submit.length,0);
  assert.equal(f.controller.hasPendingDeletion(),false);
  assert.equal(f.controller.getState().deletionPending,false);
  // The refused flow left nothing behind, so a fresh attempt with a readable deadline still settles.
  f.announceGrantExpiry(at(300_000));
  await f.controller.submitDeletionWithPassword(password,{kind:'none'});
  assert.equal(f.calls.submit.length,1);
  assert.equal(f.controller.getState().status,'anonymous');
});

test('a receipt read that never settles is bounded by the storage timeout',async()=>{
  const f=fixture({storageTimeoutMs:40});await f.controller.bootstrap();
  f.holdRead();
  await assert.rejects(f.controller.deletionStatus(),{code:'storage_unavailable'});
  f.releaseRead();
  // The same protected record still serves the ordinary flow once the native read answers.
  await f.controller.deletionImpact();
  await f.controller.submitDeletionWithPassword(password,{kind:'none'});
  assert.equal(f.controller.getState().status,'anonymous');
});

test('deletion progress validates the answer and refuses a receipt of another account',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.deletionImpact();
  await f.controller.submitDeletionWithPassword(password,{kind:'none'});
  // A loose or over-long answer never becomes a progress report.
  f.announceStatus({...progress,serverDataDeleted:'yes'});
  await assert.rejects(f.controller.deletionStatus(),{code:'invalid_response'});
  f.announceStatus({...progress,receiptSecret:'leak'});
  await assert.rejects(f.controller.deletionStatus(),{code:'invalid_response'});
  // Anonymous devices may read their own receipt; a signed-in other account may not.
  f.announceStatus(progress);
  assert.deepEqual((await f.controller.deletionStatus())!.status,progress);
  const spent=f.calls.status.length;
  await login(f.controller);
  await assert.rejects(f.controller.deletionStatus(),{code:'busy'});
  assert.equal(f.calls.status.length,spent);
});

test('an Apple deletion proves the account once and stores the receipt',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.deletionImpact();
  await f.controller.submitDeletionWithApple(f.authorize,{kind:'none'});
  assert.equal(f.calls.native,1);
  assert.deepEqual(f.calls.appleStart.map(entry=>entry.action),['delete-account']);
  assert.equal(f.calls.appleComplete,1);
  // No password re-verification, one provider flow, and the provider's grant is the only one submitted.
  assert.equal(f.calls.reauth.length,0);
  assert.equal(f.calls.submit.length,1);
  assert.equal(f.calls.submit[0]!.input.reauthGrant,f.calls.appleGrants[0]);
  assert.equal(f.calls.submit[0]!.input.confirmation,true);
  assert.deepEqual(f.calls.submit[0]!.input.dependencyDisposition,{kind:'none'});
  // The provider flow and the submission carried the same session bearer.
  assert.equal(f.calls.submit[0]!.token,f.calls.appleStart[0]!.token);
  assert.equal(storedRecord(f.receipt()!).subjectId,f.first.session.subjectId);
  assert.equal(f.controller.getState().status,'anonymous');
  assert.equal(f.controller.getState().deletionPending,false);
});

test('a lost Apple submission repeats its key without another provider authorization',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.deletionImpact();
  f.failOnce(new AuthClientError('network'));
  await assert.rejects(f.controller.submitDeletionWithApple(f.authorize,{kind:'none'}),{code:'network'});
  assert.equal(f.controller.hasPendingDeletion(),true);
  assert.equal(f.controller.getState().deletionPending,true);
  await f.controller.retryDeletion();
  // The repeat replays the keyed body: one native prompt, one grant, one job.
  assert.equal(f.calls.native,1);
  assert.equal(f.calls.appleStart.length,1);
  assert.equal(f.calls.appleComplete,1);
  assert.equal(f.calls.submit.length,2);
  assert.equal(f.calls.submit[0]!.key,f.calls.submit[1]!.key);
  assert.equal(f.calls.submit[0]!.token,f.calls.submit[1]!.token);
  assert.equal(f.jobs.size,1);
  assert.equal(f.controller.getState().status,'anonymous');
});

test('an account switch during an Apple submission keeps the new account',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.deletionImpact();
  f.holdSubmit();
  const sent=f.controller.submitDeletionWithApple(f.authorize,{kind:'none'});
  await f.nextSubmit();
  await login(f.controller);
  const refused=assert.rejects(sent,{code:'cancelled'});
  f.releaseSubmit();
  await refused;
  assert.equal(f.controller.getState().status,'authenticated');
  assert.equal(f.controller.getState().account?.subjectId,f.second.session.subjectId);
  assert.equal(JSON.parse(f.record()!).active.subjectId,f.second.session.subjectId);
  assert.equal(f.receipt(),null);
  assert.equal(f.receiptWrites(),0);
  assert.equal(f.controller.hasPendingDeletion(),false);
});

test('a switch while the re-verification is in flight never dispatches the deletion',async()=>{
  const f=fixture();await f.controller.bootstrap();
  await f.controller.deletionImpact();
  f.holdReauth();
  const sent=f.controller.submitDeletionWithPassword(password,{kind:'none'});
  await f.nextReauth();
  await login(f.controller);
  const refused=assert.rejects(sent,{code:'cancelled'});
  f.releaseReauth();
  await refused;
  // The provider/password step answered to a generation that no longer exists, so its grant is dropped
  // with the attempt it belonged to and nothing was ever dispatched under the new account's signal.
  assert.equal(f.calls.submit.length,0);
  assert.equal(f.calls.reauth.length,1);
  assert.equal(f.receipt(),null);
  assert.equal(f.controller.hasPendingDeletion(),false);
  assert.equal(f.controller.getState().status,'authenticated');
  assert.equal(f.controller.getState().account?.subjectId,f.second.session.subjectId);
  assert.equal(JSON.parse(f.record()!).active.subjectId,f.second.session.subjectId);
});
