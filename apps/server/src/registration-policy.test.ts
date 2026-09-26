import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { disabledRegistrationPolicy,readRegistrationPolicy } from './registration-policy.js';

const directory=mkdtempSync(join(tmpdir(),'siyue-registration-policy-'));
after(()=>rmSync(directory,{recursive:true,force:true}));
let written=0;
const file=(body:string)=>{const path=join(directory,`policy-${written++}.json`);writeFileSync(path,body);return path;};
const released={enabled:true,terms:{version:'terms-2026-09-25',url:'https://siyue.app/terms'},
  privacy:{version:'privacy-2026-09-25',url:'https://siyue.app/privacy'}};
const rejected=/^Error: invalid_registration_policy_configuration$/;
/** A policy body is refused as a whole, never partially applied or trimmed into something usable. */
const refused=(body:string)=>assert.rejects(readRegistrationPolicy({SIYUE_REGISTRATION_POLICY_FILE:file(body)}),rejected);

test('a missing or empty configuration closes sign-up with the shared disabled policy',async()=>{
  for(const env of [{},{SIYUE_REGISTRATION_POLICY_FILE:undefined},{SIYUE_REGISTRATION_POLICY_FILE:''}])
    assert.equal(await readRegistrationPolicy(env as NodeJS.ProcessEnv),disabledRegistrationPolicy);
  assert.deepEqual(disabledRegistrationPolicy,{enabled:false,terms:null,privacy:null});
  assert.equal(Object.isFrozen(disabledRegistrationPolicy),true);
});

test('a released pair keeps its own versions and is frozen',async()=>{
  const policy=await readRegistrationPolicy({SIYUE_REGISTRATION_POLICY_FILE:file(JSON.stringify(released))});
  assert.deepEqual(policy,released);
  assert.equal(policy.enabled,true);
  if(!policy.enabled)return;
  assert.equal(Object.isFrozen(policy),true);assert.equal(Object.isFrozen(policy.terms),true);assert.equal(Object.isFrozen(policy.privacy),true);
  // The shared schema normalizes surrounding whitespace and refuses an empty version.
  const padded=JSON.stringify({...released,terms:{...released.terms,version:'  terms-2026-09-25  '},privacy:{...released.privacy,version:'\tprivacy-2026-09-25\n'}});
  const paddedPolicy=await readRegistrationPolicy({SIYUE_REGISTRATION_POLICY_FILE:file(padded)});
  assert.equal(paddedPolicy.enabled,true);
  if(paddedPolicy.enabled){assert.equal(paddedPolicy.terms.version,'terms-2026-09-25');
    assert.equal(paddedPolicy.privacy.version,'privacy-2026-09-25');}
});

test('document links must be plain https without credentials or a fragment',async()=>{
  for(const url of ['http://siyue.app/terms','https://parent:secret@siyue.app/terms','https://siyue.app/terms#v2',
    'javascript:alert(1)','data:text/html,synthetic','/terms','siyue.app/terms',''])
    await refused(JSON.stringify({...released,terms:{...released.terms,url}}));
  // Surrounding whitespace is normalized by the URL parser instead of becoming another target, so
  // this stays the same https document; the reader returns the configured text unchanged.
  const spaced=await readRegistrationPolicy({SIYUE_REGISTRATION_POLICY_FILE:file(JSON.stringify({...released,terms:{...released.terms,url:'  https://siyue.app/terms  '}}))});
  assert.equal(spaced.enabled,true);
  if(spaced.enabled) assert.equal(new URL(spaced.terms.url).href,'https://siyue.app/terms');
});

test('a half published, extra or unbounded document is refused',async()=>{
  for(const body of [
    {...released,privacy:null},{...released,terms:null},{...released,enabled:false},{...released,enabled:'true'},
    {...released,terms:{...released.terms,version:''}},{...released,terms:{...released.terms,version:'   '}},
    {...released,terms:{...released.terms,version:'v'.repeat(81)}},{...released,terms:{...released.terms,notice:'synthetic'}},
    {...released,notice:'synthetic'},{terms:released.terms,privacy:released.privacy},[released],'synthetic',null,42,
  ]) await refused(JSON.stringify(body));

});

test('unreadable or oversized policy files fail closed',async()=>{
  await assert.rejects(readRegistrationPolicy({SIYUE_REGISTRATION_POLICY_FILE:join(directory,'missing.json')}),rejected);
  const asDirectory=join(directory,'as-directory');mkdirSync(asDirectory);
  await assert.rejects(readRegistrationPolicy({SIYUE_REGISTRATION_POLICY_FILE:asDirectory}),rejected);
  // A valid pair padded past the 8 KiB ceiling is refused by size instead of being read or truncated.
  await refused(JSON.stringify(released)+' '.repeat(8192));
  await refused('{not json');
});
