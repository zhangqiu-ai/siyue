import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listChanges, main, validatePrBody } from './check-spec-pr.mjs';

test('finds active and archived proposals, excluding missing proposals', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'siyue-spec-pr-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['add-history', 'archive/2026-09-07-add-models', 'incomplete']) {
    const directory = join(root, 'openspec/changes', path);
    mkdirSync(directory, { recursive: true });
    if (path !== 'incomplete') writeFileSync(join(directory, 'proposal.md'), 'Proposal');
  }
  const changes = listChanges(root);
  assert.equal(validatePrBody('OpenSpec-Change: add-history', changes).ok, true);
  assert.equal(validatePrBody('OpenSpec-Change: add-models', changes).ok, true);
  assert.equal(validatePrBody('OpenSpec-Change: incomplete', changes).ok, false);
  assert.equal(validatePrBody('OpenSpec-Change: nonexistent', changes).ok, false);
});

test('requires exactly one declaration and rejects unsafe identifiers', () => {
  const changes = new Set(['add-history']);
  for (const body of [null, '', 'Description only', 'OpenSpec-Change:',
    'OpenSpec-Change: add-history\nOpenSpec-Exempt: 仅修改文档链接',
    'OpenSpec-Change: add-history\nOpenSpec-Change: add-history',
    'OpenSpec-Change: ../add-history', 'OpenSpec-Change: add_history',
    'OpenSpec-Change: Add-history', 'OpenSpec-Change: add--history',
    'OpenSpec-Change: $(touch /tmp/should-not-execute)']) {
    assert.equal(validatePrBody(body, changes).ok, false, String(body));
  }
});

test('accepts a concrete exemption and rejects placeholder reasons', () => {
  assert.equal(validatePrBody('OpenSpec-Exempt: 仅修正文档链接，不改变产品行为', new Set()).ok, true);
  for (const value of ['', '<具体原因>', '具体原因', 'TODO', 'TBD', 'N/A', '待补充', '无']) {
    assert.equal(validatePrBody(`OpenSpec-Exempt: ${value}`, new Set()).ok, false, value);
  }
});

test('ignores commented template examples and accepts CRLF', () => {
  const body = '<!--\nOpenSpec-Change: <change-id>\nOpenSpec-Exempt: <具体原因>\n-->\r\nOpenSpec-Change: add-history\r\n';
  assert.equal(validatePrBody(body, new Set(['add-history'])).ok, true);
});

test('skips local execution, rejects invalid events, and checks a PR event', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'siyue-spec-event-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(main({}, root), 0);
  assert.equal(main({ GITHUB_EVENT_NAME: 'pull_request' }, root), 1);
  const eventPath = join(root, 'event.json');
  const env = { GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: eventPath };
  writeFileSync(eventPath, JSON.stringify({ pull_request: { body: 'OpenSpec-Exempt: 仅调整文档格式' } }));
  assert.equal(main(env, root), 0);
  writeFileSync(eventPath, JSON.stringify({ pull_request: { body: '' } }));
  assert.equal(main(env, root), 1);
  writeFileSync(eventPath, '{}');
  assert.equal(main(env, root), 1);
});
