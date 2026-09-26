import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceEditors} from '../src/account/workspace-editors.ts';
test('mobile editor retirement waits for all editors, rejects failed flush and permits retry',async()=>{
 const gate=createWorkspaceEditors();const requested=[];
 const a=gate.register('a',id=>requested.push(['a',id])),b=gate.register('b',id=>requested.push(['b',id]));
 const first=gate.flush(),parallel=gate.flush();assert.equal(requested.length,2);
 a.finish(requested[0][1],true);b.finish(requested[1][1],false);assert.equal(await first,false);assert.equal(await parallel,false);
 const next=gate.flush();a.finish(requested[0][1],true); // Late acknowledgement cannot finish the newer request.
 a.finish(requested[2][1],true);b.finish(requested[3][1],true);assert.equal(await next,true);
 a.dispose();b.dispose();assert.equal(await gate.flush(),true);
});
test('unmount and timeout do not claim a successful mobile save',async()=>{
 const gate=createWorkspaceEditors(10),entry=gate.register('lost',()=>{});const waiting=gate.flush();entry.dispose();assert.equal(await waiting,false);
 const second=gate.register('timeout',()=>{});assert.equal(await gate.flush(),false);second.dispose();
});
