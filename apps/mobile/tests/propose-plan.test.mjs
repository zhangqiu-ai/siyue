import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalClient } from '@siyue/adapters';
import { openNodeStore } from '@siyue/adapters/node';
import { createCommandService, createRunService } from '@siyue/domain';
import { proposePlan } from '../src/space/propose-plan.ts';

function dependencies(session) {
  return {
    getSessionSignal: () => session.signal,
    isActive: () => true,
    getCredentials: async () => { throw new Error('unexpected credential access'); },
    fetcher: async () => { throw new Error('unexpected network request'); },
  };
}

test('session invalidation while opening storage cannot start generation', async () => {
  const session = new AbortController();
  let called = false;
  await assert.rejects(proposePlan('Goal', async () => {
    session.abort();
    return {propose: async () => { called = true; }};
  }, dependencies(session)), {code: 'cancelled'});
  assert.equal(called, false);
});

test('captured session remains connected during draft persistence even after replacement', async () => {
  const session = new AbortController();
  const deps = dependencies(session);
  deps.getCredentials = async () => ({baseUrl: 'https://example.invalid/v1', model: 'synthetic', apiKey: 'synthetic'});
  let capturedSignal;
  await assert.rejects(proposePlan('Goal', async () => ({
    propose: async (goal, signal, provider) => {
      assert.equal(goal, 'Goal');
      assert.equal(typeof provider.propose, 'function');
      assert.equal(provider.execution.modelVersion, 'synthetic');
      capturedSignal = signal;
      assert.equal(signal.aborted, false);
      deps.getSessionSignal = () => new AbortController().signal;
      session.abort();
      assert.equal(signal.aborted, true);
      throw Object.assign(new Error('cancelled persistence'), {code: 'cancelled'});
    },
  }), deps), {code: 'cancelled'});
  assert.equal(capturedSignal.aborted, true);
});

for (const cancelDuringSave of [false, true]) {
  test(`configured transport to SQLite draft preserves confirmation boundary (cancel during save: ${cancelDuringSave})`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'siyue-plan-wiring-'));
    const store = openNodeStore(join(directory, 'synthetic.sqlite'));
    t.after(async () => { await store.close(); await rm(directory, {recursive: true}); });
    const {spaceId, actorId} = await store.initialize('synthetic-owner', randomUUID());
    const now = () => new Date().toISOString();
    const actor = {id: actorId, kind: 'user'};
    const session = new AbortController();
    const service = createCommandService({store, now, newId: randomUUID, hash: value => createHash('sha256').update(value).digest('hex')});
    const client = createLocalClient({
      service: {...service, async createDraft(...args) {
        const draft = await service.createDraft(...args);
        if (cancelDuringSave) session.abort();
        return draft;
      }},
      runService: createRunService({store, now, newId: randomUUID}),
      spaceId, actor, now, newId: randomUUID,
      propose: async () => { throw new Error('must not use default provider'); },
    });
    const plan = {title: 'English', projectTitles: ['Work practice'], taskTitles: ['Introduction']};
    const deps = dependencies(session);
    deps.getCredentials = async () => ({baseUrl: 'https://example.invalid/v1', model: 'synthetic', apiKey: 'synthetic'});
    deps.fetcher = async () => new Response(`data: ${JSON.stringify({choices: [{delta: {content: JSON.stringify(plan)}}]})}\n\ndata: [DONE]\n\n`, {headers: {'Content-Type': 'text/event-stream'}});
    const operation = proposePlan('English', async () => client, deps);
    if (cancelDuringSave) {
      await assert.rejects(operation, {code: 'cancelled'});
      const snapshot = await client.snapshot();
      assert.equal(snapshot.drafts[0].status, 'cancelled');
      assert.equal(snapshot.runs[0].status, 'cancelled');
      assert.equal(snapshot.goals.length, 0);
      assert.equal(snapshot.tasks.length, 0);
    } else {
      const draft = await operation;
      const before = await client.snapshot();
      assert.equal(before.runs[0].executor, 'compatible');
      assert.equal(before.runs[0].modelVersion, 'synthetic');
      assert.equal(before.runs[0].usage, null);
      assert.equal(before.goals.length, 0);
      assert.equal(before.tasks.length, 0);
      await client.confirmDraft(draft.id, draft.version);
      const after = await client.snapshot();
      assert.equal(after.goals[0].title, 'English');
      assert.equal(after.projects[0].goalId, after.goals[0].id);
      assert.equal(after.tasks[0].projectId, after.projects[0].id);
    }
  });
}

test('cancelling pending credentials never starts a recorded run', async () => {
  const session = new AbortController();
  const deps = dependencies(session);
  let started = false;
  deps.getCredentials = () => new Promise(() => {});
  const operation = proposePlan('Goal', async () => ({propose: async () => { started = true; }}), deps);
  setTimeout(() => session.abort(), 0);
  await assert.rejects(operation, {code: 'cancelled'});
  assert.equal(started, false);
});

for (const cancelSource of ['request', 'session']) {
  test(`cancellation immediately ends pending storage (${cancelSource}) and ignores its late result`, async () => {
    const session = new AbortController();
    const request = new AbortController();
    let resolveStorage;
    let started = false;
    const operation = proposePlan('Goal', () => new Promise(resolve => { resolveStorage = resolve; }), dependencies(session), request.signal)
      .then(() => 'completed', error => error.code);
    await Promise.resolve();
    (cancelSource === 'request' ? request : session).abort();
    let timer;
    try {
      assert.equal(await Promise.race([operation, new Promise(resolve => { timer = setTimeout(() => resolve('still waiting'), 100); })]), 'cancelled');
    } finally {
      clearTimeout(timer);
      resolveStorage({propose: async () => { started = true; }});
      await operation;
    }
    assert.equal(started, false);
  });
}

test('request and execution metadata use one credential snapshot despite later source mutation', async () => {
  const session = new AbortController();
  const deps = dependencies(session);
  const credentials = {baseUrl: 'https://example.invalid/v1', model: 'original-model', apiKey: 'synthetic-original'};
  let reads = 0;
  let execution;
  let request;
  deps.getCredentials = async () => { reads += 1; return credentials; };
  const plan = {title: 'English', projectTitles: ['Practice'], taskTitles: ['Introduction']};
  deps.fetcher = async (url, options) => {
    request = {url, body: JSON.parse(options.body), authorization: new Headers(options.headers).get('Authorization')};
    return new Response(`data: ${JSON.stringify({choices: [{delta: {content: JSON.stringify(plan)}}]})}\n\ndata: [DONE]\n\n`, {headers: {'Content-Type': 'text/event-stream'}});
  };
  const result = await proposePlan('English', async () => ({
    propose: async (goal, signal, provider) => {
      execution = provider.execution;
      Object.assign(credentials, {baseUrl: 'https://changed.invalid/v1', model: 'changed-model', apiKey: 'synthetic-changed'});
      return provider.propose(goal, signal);
    },
  }), deps);
  assert.deepEqual(result, plan);
  assert.equal(reads, 1);
  assert.equal(request.url, 'https://example.invalid/v1/chat/completions');
  assert.equal(request.authorization, 'Bearer synthetic-original');
  assert.equal(request.body.model, 'original-model');
  assert.equal(execution.modelVersion, request.body.model);
  assert.equal(execution.executor, 'compatible');
});

for (const ending of ['missing-done', 'length', 'tool_calls']) {
  test(`complete JSON with ${ending} never creates a draft or formal records`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'siyue-incomplete-plan-'));
    const store = openNodeStore(join(directory, 'synthetic.sqlite'));
    t.after(async () => { await store.close(); await rm(directory, {recursive: true}); });
    const {spaceId, actorId} = await store.initialize('synthetic-owner', randomUUID());
    const now = () => new Date().toISOString();
    const client = createLocalClient({
      service: createCommandService({store, now, newId: randomUUID, hash: value => createHash('sha256').update(value).digest('hex')}),
      runService: createRunService({store, now, newId: randomUUID}),
      spaceId, actor: {id: actorId, kind: 'user'}, now, newId: randomUUID,
      propose: async () => { throw new Error('must not use default provider'); },
    });
    const deps = dependencies(new AbortController());
    deps.getCredentials = async () => ({baseUrl: 'https://example.invalid/v1', model: 'synthetic', apiKey: 'synthetic'});
    const plan = {title: 'English', projectTitles: ['Practice'], taskTitles: ['Introduction']};
    const content = `data: ${JSON.stringify({choices: [{delta: {content: JSON.stringify(plan)}}]})}\n\n`;
    const terminal = ending === 'missing-done' ? '' : `data: ${JSON.stringify({choices: [{delta: {}, finish_reason: ending}]})}\n\ndata: [DONE]\n\n`;
    let calls = 0;
    deps.fetcher = async () => { calls += 1; return new Response(content + terminal, {headers: {'Content-Type': 'text/event-stream'}}); };
    await assert.rejects(proposePlan('English', async () => client, deps));
    const snapshot = await client.snapshot();
    assert.equal(calls, 1);
    assert.equal(snapshot.runs.length, 1);
    assert.equal(snapshot.runs[0].status, 'failed');
    assert.equal(snapshot.runs[0].executor, 'compatible');
    assert.equal(snapshot.runs[0].usage, null);
    assert.equal(snapshot.drafts.length, 0);
    assert.equal(snapshot.goals.length, 0);
    assert.equal(snapshot.projects.length, 0);
    assert.equal(snapshot.tasks.length, 0);
  });
}
