import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureWorkspaceBuffer,hasPendingWorkspaceInput,readWorkspaceBuffer,retainedScopeOnSwitch,subscribeWorkspacePending,writeWorkspaceBuffer} from '../src/account/workspace-pending.ts';

test('unsubmitted plan input is tracked per space and readable again on return', () => {
  writeWorkspaceBuffer('qa-local:create.goal','create.goal','LOCAL-DRAFT');
  assert.equal(hasPendingWorkspaceInput('qa-local'),true);
  assert.equal(hasPendingWorkspaceInput('qa-a'),false);
  writeWorkspaceBuffer('qa-a:create.goal','create.goal','A-DRAFT');
  assert.equal(hasPendingWorkspaceInput('qa-a'),true);
  assert.equal(hasPendingWorkspaceInput('qa-local'),true);
  assert.equal(readWorkspaceBuffer('qa-a:create.goal',''),'A-DRAFT');
  assert.equal(readWorkspaceBuffer('qa-a:create.project',''),'');
});

test('manual project text and an unresolved manual draft keep the space pending', () => {
  writeWorkspaceBuffer('qa-manual:create.goal','create.goal','');
  writeWorkspaceBuffer('qa-manual:create.project','create.project','  Project name  ');
  assert.equal(hasPendingWorkspaceInput('qa-manual'),true);
  writeWorkspaceBuffer('qa-manual:create.project','create.project','   ');
  assert.equal(hasPendingWorkspaceInput('qa-manual'),false);
  writeWorkspaceBuffer('qa-unknown:create.goal','create.goal','');
  writeWorkspaceBuffer('qa-unknown:create.unknown','create.unknown',true);
  assert.equal(hasPendingWorkspaceInput('qa-unknown'),true);
});

test('explicit discard and a successful submit clear pending while untracked buffers never set it', () => {
  writeWorkspaceBuffer('qa-clear:create.goal','create.goal','DRAFT');
  writeWorkspaceBuffer('qa-clear:create.unknown','create.unknown',true);
  assert.equal(hasPendingWorkspaceInput('qa-clear'),true);
  writeWorkspaceBuffer('qa-clear:create.goal','create.goal','');
  writeWorkspaceBuffer('qa-clear:create.unknown','create.unknown',false);
  assert.equal(hasPendingWorkspaceInput('qa-clear'),false);
  writeWorkspaceBuffer('qa-clear:create.mode','create.mode','manual');
  ensureWorkspaceBuffer('qa-clear:ref:create.manual','ref:create.manual',{payload:null});
  assert.equal(hasPendingWorkspaceInput('qa-clear'),false);
});

test('a completed switch reports only a departed space that still holds input', () => {
  assert.equal(retainedScopeOnSwitch(null,'qa-switch'),null);
  writeWorkspaceBuffer('qa-switch:create.goal','create.goal','DRAFT');
  assert.equal(retainedScopeOnSwitch('qa-switch','qa-other'),'qa-switch');
  assert.equal(retainedScopeOnSwitch('qa-switch','qa-switch'),null);
  writeWorkspaceBuffer('qa-switch:create.goal','create.goal','');
  assert.equal(retainedScopeOnSwitch('qa-switch','qa-other'),null);
});

test('pending subscribers hear tracked writes only and stop after unsubscribe', () => {
  let heard=0;const unsubscribe=subscribeWorkspacePending(()=>{heard++;});
  writeWorkspaceBuffer('qa-listen:create.goal','create.goal','DRAFT');
  assert.equal(heard,1);
  writeWorkspaceBuffer('qa-listen:create.mode','create.mode','manual');
  assert.equal(heard,1);
  unsubscribe();
  writeWorkspaceBuffer('qa-listen:create.goal','create.goal','');
  assert.equal(heard,1);
});
