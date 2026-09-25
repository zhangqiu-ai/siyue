import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {AccountDeletionRequest,AuthClientErrorCode,DeletionReceipt} from '@siyue/contracts';
import {createAccountDeletionAttempt} from './account-deletion-attempt.js';
import {AuthClientError,type AuthApiClient} from './auth-api-client.js';

const token='synthetic-access-token';
const opaqueGrant=()=>`${randomUUID()}.${'g'.repeat(43)}`;
const request=():AccountDeletionRequest=>({reauthGrant:opaqueGrant(),confirmation:true,dependencyDisposition:{kind:'none'}});
const receipt=():DeletionReceipt=>({deletionId:randomUUID(),receiptSecret:'R'.repeat(43),expiresAt:new Date(Date.now()+86_400_000).toISOString()});
const denied=(error:unknown)=>error instanceof AuthClientError&&error.code==='invalid_request';
type Submission={token:string;input:AccountDeletionRequest;key:string};
/** The next answer the fake route gives: a receipt, one client error code, or a foreign throw. */
type Answer={receipt?:DeletionReceipt;error?:AuthClientErrorCode;thrown?:unknown};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}

/** Stand-in for the submission route: it records exactly what was sent, answers with the next
 *  scripted result and can hold one request open so a second run overlaps the first. No session,
 *  grant store or server outside this process is involved. */
function fakeApi(){
 const sent:Submission[]=[],answers:Answer[]=[];
 let gate:{promise:Promise<void>;resolve:()=>void}|null=null;
 const submitDeletion:Pick<AuthApiClient,'submitDeletion'>['submitDeletion']=(bearer,input,key,signal)=>{
  sent.push({token:bearer,input,key});
  const held=gate;
  return (held?held.promise:Promise.resolve()).then(()=>{
   if(signal?.aborted)throw new AuthClientError('cancelled');
   const answer=answers.shift()??{receipt:receipt()};
   if(answer.thrown!==undefined)throw answer.thrown;
   if(answer.error)throw new AuthClientError(answer.error);
   return answer.receipt!;
  });
 };
 return {api:{submitDeletion} as Pick<AuthApiClient,'submitDeletion'>,sent,
  answer:(next:Answer)=>{answers.push(next);},
  hold(){gate=deferred();},
  release(){const held=gate;gate=null;held?.resolve();}};
}
function attemptFixture(input:AccountDeletionRequest=request(),key:string=randomUUID()){
 const fake=fakeApi();
 const attempt=createAccountDeletionAttempt({api:fake.api,accessToken:token,input,key});
 return {fake,attempt,input,key};
}

test('a body, key or bearer that breaks the contract is refused before anything is sent',()=>{
 const fake=fakeApi(),valid=request(),family=randomUUID();
 const base={api:fake.api,accessToken:token as unknown,input:valid as unknown,key:randomUUID() as unknown};
 // A valid body builds one attempt and stays unsent until the caller runs it.
 createAccountDeletionAttempt({api:fake.api,accessToken:token,input:valid,key:randomUUID()});
 assert.equal(fake.sent.length,0);
 const invalid:Array<Record<string,unknown>>=[
  // A widened body, an absent confirmation, a foreign grant and a family settled twice are refused
  // instead of reaching the route — and an extra field is refused even when its value is `undefined`,
  // so nothing can be smuggled past the strict contract.
  {input:{...valid,subjectId:randomUUID()}},
  {input:{...valid,extra:undefined}},
  {input:{reauthGrant:valid.reauthGrant,dependencyDisposition:{kind:'none'}}},
  {input:{...valid,reauthGrant:'not-a-grant'}},
  {input:{...valid,dependencyDisposition:{kind:'per-family',families:[]}}},
  {input:{...valid,dependencyDisposition:{kind:'per-family',families:[
   {familyId:family,kind:'end-family-access'},{familyId:family,kind:'end-family-access'}]}}},
  // The key is the caller's own UUID and the bearer is the caller's nonblank token: neither is minted,
  // repaired or coerced here, and a non-string bearer is refused rather than stringified.
  {key:''},{key:'not-a-uuid'},{key:randomUUID().replace(/-/g,'')},{key:randomUUID()+'.'},{key:undefined},
  {accessToken:''},{accessToken:'   '},{accessToken:'\n\t'},{accessToken:42},{accessToken:null},{accessToken:undefined},
 ];
 for(const over of invalid)assert.throws(()=>createAccountDeletionAttempt({...base,...over} as never),denied,JSON.stringify(over));
 assert.equal(fake.sent.length,0);
});

test('a repeat after a retryable outcome repeats the same bearer, body and key without asking for a grant',async()=>{
 for(const code of ['network','timeout','unavailable','deletion_outcome_unknown','invalid_response'] as const){
  const input=request(),{fake,attempt,key}=attemptFixture(input);
  fake.answer({error:code});
  await assert.rejects(attempt.run(),{code});
  assert.equal(attempt.canRetry(),true);
  const issued=receipt();fake.answer({receipt:issued});
  assert.deepEqual(await attempt.run(),issued);
  assert.equal(fake.sent.length,2);
  // The attempt re-sends its own snapshot object, so both requests carry the same bytes, the same
  // bearer and the caller's one key: nothing is re-verified and no second grant is asked for.
  assert.equal(fake.sent[0]!.input,fake.sent[1]!.input);
  assert.deepEqual(fake.sent[0],{token,input:JSON.parse(JSON.stringify(input)),key});
  assert.deepEqual(fake.sent[1],fake.sent[0]);
 }
});

test('any other outcome ends the attempt instead of replaying a spent request',async()=>{
 for(const code of ['busy','rate_limited','reauth_required','invalid_request','cancelled','storage_unavailable','challenge_invalid',
  'deletion_dependencies','deletion_receipt_unrecoverable','deletion_request_conflict','adult_required','identity_not_found'] as const){
  const {fake,attempt}=attemptFixture();
  fake.answer({error:code});
  await assert.rejects(attempt.run(),{code});
  assert.equal(attempt.canRetry(),false);
  // The attempt is over: a repeat is refused locally, so the spent grant and the bearer are never
  // presented again and the caller has to re-verify before submitting under a fresh key.
  await assert.rejects(attempt.run(),{code:'cancelled'});
  assert.equal(fake.sent.length,1);
 }
});

test('a caller that keeps editing its own input cannot change the body a repeat sends',async()=>{
 const familyId=randomUUID(),recipient=randomUUID();
 const transfer={familyId,kind:'transfer' as const,recipientSubjectId:recipient};
 const input:AccountDeletionRequest={reauthGrant:opaqueGrant(),confirmation:true,
  dependencyDisposition:{kind:'per-family',families:[transfer]}};
 const snapshot=JSON.parse(JSON.stringify(input)) as AccountDeletionRequest;
 const {fake,attempt}=attemptFixture(input);
 // The caller keeps editing after the attempt captured its body: another recipient, another grant and
 // a field the contract would have refused all appear in the caller's own copy.
 transfer.recipientSubjectId=randomUUID();
 input.reauthGrant=opaqueGrant();
 (input as AccountDeletionRequest&{subjectId?:string}).subjectId=randomUUID();
 fake.answer({error:'timeout'});
 await assert.rejects(attempt.run(),{code:'timeout'});
 fake.answer({receipt:receipt()});
 await attempt.run();
 assert.deepEqual(fake.sent.map(call=>call.input),[snapshot,snapshot]);
 assert.equal(fake.sent[0]!.input,fake.sent[1]!.input);
});

test('two overlapping runs refuse the second as busy and spend one submission',async()=>{
 const {fake,attempt}=attemptFixture();
 fake.hold();
 const running=attempt.run();
 assert.equal(fake.sent.length,1);
 await assert.rejects(attempt.run(),{code:'busy'});
 const issued=receipt();fake.answer({receipt:issued});
 fake.release();
 assert.deepEqual(await running,issued);
 assert.equal(fake.sent.length,1);
});

test('an accepted submission is cached and handed back as a copy without a second request',async()=>{
 const {fake,attempt}=attemptFixture();
 const issued=receipt();fake.answer({receipt:issued});
 const first=await attempt.run();
 assert.deepEqual(first,issued);
 // Editing what the caller received cannot damage the receipt the attempt still owes a failed secure
 // write, and the storage recovery reads it back without touching the route again.
 first.receiptSecret='X'.repeat(43);
 const second=await attempt.run();
 assert.deepEqual(second,issued);assert.notEqual(second,first);
 assert.equal(attempt.canRetry(),true);
 assert.equal(fake.sent.length,1);
});

test('an answer that does not satisfy the receipt contract is refused and stays repeatable',async()=>{
 const {fake,attempt}=attemptFixture();
 for(const wrong of [{deletionId:randomUUID(),receiptSecret:'R'.repeat(42),expiresAt:new Date().toISOString()},
  {deletionId:'not-a-uuid',receiptSecret:'R'.repeat(43),expiresAt:new Date().toISOString()},
  {deletionId:randomUUID(),receiptSecret:'R'.repeat(43)},
  {deletionId:randomUUID(),receiptSecret:'R'.repeat(43),expiresAt:new Date().toISOString(),accessToken:token}]){
  fake.answer({receipt:wrong as DeletionReceipt});
  await assert.rejects(attempt.run(),{code:'invalid_response'});
  assert.equal(attempt.canRetry(),true);
 }
 const issued=receipt();fake.answer({receipt:issued});
 assert.deepEqual(await attempt.run(),issued);
 assert.equal(fake.sent.length,5);
});

test('clear drops the cached receipt and the credentials, and every later run is cancelled',async()=>{
 const {fake,attempt}=attemptFixture();
 fake.answer({receipt:receipt()});
 await attempt.run();
 attempt.clear();
 assert.equal(attempt.canRetry(),false);
 await assert.rejects(attempt.run(),{code:'cancelled'});
 assert.equal(fake.sent.length,1);
 // A cleared attempt is dead even when a repeatable failure was staged: the bearer is gone, so the
 // caller re-verifies and submits under its own new key instead of reusing this instance.
 const staged=attemptFixture();staged.fake.answer({error:'network'});
 await assert.rejects(staged.attempt.run(),{code:'network'});
 assert.equal(staged.attempt.canRetry(),true);
 staged.attempt.clear();
 assert.equal(staged.attempt.canRetry(),false);
 await assert.rejects(staged.attempt.run(),{code:'cancelled'});
 assert.equal(staged.fake.sent.length,1);
});

test('clear during a submission discards the answer that arrives afterwards',async()=>{
 const {fake,attempt}=attemptFixture();
 fake.hold();
 const running=attempt.run();
 attempt.clear();
 fake.answer({receipt:receipt()});
 fake.release();
 // The request was already sent when clear() landed, so its receipt is not returned, not cached and
 // not handed to any later run.
 await assert.rejects(running,{code:'cancelled'});
 assert.equal(attempt.canRetry(),false);
 await assert.rejects(attempt.run(),{code:'cancelled'});
 assert.equal(fake.sent.length,1);
});

test('an abort that arrives before dispatch is refused without spending the staged repeat',async()=>{
 const {fake,attempt}=attemptFixture();
 fake.answer({error:'network'});
 await assert.rejects(attempt.run(),{code:'network'});
 const control=new AbortController();control.abort();
 await assert.rejects(attempt.run(control.signal),{code:'cancelled'});
 assert.equal(fake.sent.length,1);assert.equal(attempt.canRetry(),true);
 const issued=receipt();fake.answer({receipt:issued});
 assert.deepEqual(await attempt.run(),issued);
 assert.equal(fake.sent.length,2);
});

test('a foreign throw is reported as an outage without its message and no credential reaches the surface',async()=>{
 const {fake,attempt}=attemptFixture();
 assert.deepEqual(Object.keys(attempt).sort(),['canRetry','clear','run']);
 assert.equal(JSON.stringify(attempt).includes(token),false);
 fake.answer({thrown:new Error(`socket closed for ${token}`)});
 await assert.rejects(attempt.run(),error=>error instanceof AuthClientError&&error.code==='unavailable'&&!String(error).includes(token));
 assert.equal(attempt.canRetry(),true);
});
