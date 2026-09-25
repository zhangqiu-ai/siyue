import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createResendTransport, resendConfigSchema } from '../../dist/adapters/mail/resend.js';
const run=promisify(execFile);
const apiKey='re_synthetic_0000000000000000000000';
const from='siyue@example.test';
const code='000012';
const config={provider:'resend',apiKey,from};
const payload={template:'verification',to:'synthetic@example.test',locale:'en-US',purpose:'register',code};
// The adapter runs in a child process with a replaced global fetch, so the fixed endpoint, headers and
// body are observed exactly as the adapter would send them, and no real provider request is made.
// The child reports booleans for the seam and the API key, so its output cannot leak either.
const childScript=`
import {createResendTransport} from './dist/adapters/mail/resend.js';
const setup=JSON.parse(process.argv[1]);
const seen=[];
globalThis.fetch=async(url,init)=>{
 const headers=new Headers(init.headers);
 const body=JSON.parse(String(init.body));
 seen.push({url:String(url),method:init.method,redirect:init.redirect,cache:init.cache,credentials:init.credentials,
  authorizationHeader:headers.get('authorization')===('Bearer '+setup.config.apiKey),
  contentType:headers.get('content-type'),idempotencyKey:headers.get('idempotency-key'),headerNames:[...headers.keys()].sort(),
  bodyKeys:Object.keys(body).sort(),from:body.from,to:body.to,subject:body.subject,textHasCode:body.text.includes(setup.code),
  hasAbortSignal:init.signal instanceof AbortSignal});
 if(setup.behavior==='network') throw new TypeError('fetch failed');
 if(setup.behavior==='hang') return new Promise((_resolve,reject)=>{
  // A real hung request keeps a socket open, so hold the loop with a ref'd timer until the bounded
  // wait aborts this attempt.
  const idle=setTimeout(()=>reject(new Error('synthetic provider never answered')),30_000);
  init.signal.addEventListener('abort',()=>{clearTimeout(idle);reject(new DOMException('The operation was aborted.','AbortError'));});
 });
 return new Response(setup.behavior==='accepted'?'{"id":"synthetic"}':'{"message":"synthetic"}',{status:setup.status,headers:{'content-type':'application/json'}});
};
const transport=createResendTransport(setup.config,{timeoutMs:setup.timeoutMs});
const results=[];
for(let index=0;index<setup.calls;index++)results.push(await transport.send(setup.jobId,setup.payload));
transport.close();
process.stdout.write(JSON.stringify({results,seen,closed:true}));
`;
async function send({behavior='accepted',status=200,timeoutMs=2000,calls=1,jobId='synthetic-job'}={}) {
 const setup={config,payload,code,behavior,status,timeoutMs,calls,jobId};
 const result=await run(process.execPath,['--input-type=module','-e',childScript,JSON.stringify(setup)],
  {cwd:new URL('../..',import.meta.url),env:{PATH:process.env.PATH},timeout:20_000,maxBuffer:65_536});
 return {...JSON.parse(result.stdout),out:result.stdout,stderr:result.stderr};
}

test('Resend adapter posts the fixed template to the fixed HTTPS endpoint with a per-job idempotency key',async()=>{
 const {results,seen,out,stderr,closed}=await send({calls:2});
 assert.equal(closed,true);
 assert.deepEqual(results,['accepted','accepted']);
 assert.equal(seen.length,2);
 for(const request of seen){
  assert.equal(request.url,'https://api.resend.com/emails');
  assert.equal(request.method,'POST');
  assert.equal(request.redirect,'error');
  assert.equal(request.cache,'no-store');
  assert.equal(request.credentials,'omit');
  assert.equal(request.authorizationHeader,true);
  assert.equal(request.contentType,'application/json');
  assert.equal(request.idempotencyKey,'siyue/synthetic-job');
  assert.equal(request.hasAbortSignal,true);
  assert.deepEqual(request.headerNames,['authorization','content-type','idempotency-key']);
  assert.deepEqual(request.bodyKeys,['from','subject','text','to']);
  assert.equal(request.from,'Siyue <siyue@example.test>');
  assert.deepEqual(request.to,['synthetic@example.test']);
  assert.equal(request.textHasCode,true);
  assert.match(request.subject,/Siyue/);
 }
 assert.equal(seen[0].idempotencyKey,seen[1].idempotencyKey);
 for(const output of [out,stderr]) {assert.equal(output.includes(apiKey),false);assert.equal(output.includes(code),false);}
});

// Classification follows the provider's published error taxonomy: only the explicit rate/quota reply is
// retryable, refused requests are terminal, and anything the provider may already have accepted stays unknown.
test('only the explicit 429 is retryable, refusals are rejected, and ambiguous replies stay uncertain',async()=>{
 for(const [status,expected] of [[200,'accepted'],[201,'accepted'],[429,'retryable'],[400,'rejected'],[401,'rejected'],[403,'rejected'],[404,'rejected'],[405,'rejected'],[422,'rejected'],[409,'uncertain'],[500,'uncertain'],[503,'uncertain']]) {
  const {results}=await send({status,behavior:'accepted'});
  assert.equal(results[0],expected,`status ${status}`);
 }
});

test('a failed connection and a bounded timeout are uncertain and never silently resent',async()=>{
 const network=await send({behavior:'network',calls:2});
 assert.deepEqual(network.results,['uncertain','uncertain']);
 assert.equal(network.seen.length,2);
 const started=Date.now();
 const hang=await send({behavior:'hang',timeoutMs:60,calls:2});
 assert.deepEqual(hang.results,['uncertain','uncertain']);
 assert.ok(Date.now()-started>=100,'timeout did not bound both attempts');
});

test('the Resend file accepts only the provider, key and From address and cannot move the endpoint',()=>{
 assert.equal(resendConfigSchema.safeParse({provider:'resend',apiKey:'re_synthetic',from}).success,true);
 for(const value of [
  {provider:'smtp',apiKey:'re_synthetic',from},                                  // provider is fixed
  {provider:'resend',apiKey:'',from},                                            // no empty key
  {provider:'resend',apiKey:'re synthetic',from},                                // no whitespace in key
  {provider:'resend',apiKey:'re_synthetic',from:'siyue'},                        // From must be an address
  {provider:'resend',apiKey:'re_synthetic',from,endpoint:'https://synthetic.invalid/emails'}, // endpoint is not configurable
  {provider:'resend',apiKey:'re_synthetic',from,host:'smtp.example.invalid'},     // nor is the host
  {provider:'resend',apiKey:'re_synthetic',from,to:'other@example.test'},         // recipient comes from the job
 ]) {
  assert.equal(resendConfigSchema.safeParse(value).success,false,JSON.stringify(value));
 }
 assert.throws(()=>createResendTransport(config,{timeoutMs:0}),/invalid_timeout/);
});
