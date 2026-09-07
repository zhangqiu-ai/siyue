import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { checkRelease, readReleaseState, validateRelease } from './check-release.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'siyue-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const path of ['package.json', 'apps/mobile/package.json', 'apps/desktop/package.json', 'packages/domain/package.json']) {
    write(path, JSON.stringify({ version: '0.0.1', dependencies: { library: '9.9.9' } }));
  }
  write('apps/mobile/app.json', JSON.stringify({ expo: { version: '0.0.1' } }));
  write('planning/releases/0.0.1.md', '# 0.0.1\n状态：开发中\n[聊天历史](../../openspec/changes/add-history/)\n');
  write('CHANGELOG.md', '# 发布记录\n\n## [0.0.1] — 未发布\n');
  write('openspec/changes/add-history/proposal.md', '# Proposal\nTarget release: 0.0.1\n');
  write('openspec/changes/archive/2026-09-07-old/proposal.md', 'Old proposal without a target');
  return { root, write, remove: (path) => rmSync(join(root, path)) };
}

const fails = (root, fragment) => {
  const result = checkRelease(root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes(fragment)), result.errors.join('\n'));
};

test('accepts aligned releases, ignores archive and dependency versions', (t) => {
  const { root, write } = fixture(t);
  const state = readReleaseState(root);
  const before = structuredClone(state);
  assert.deepEqual(validateRelease(state), { ok: true, errors: [] });
  assert.deepEqual(state, before);
  write('CHANGELOG.md', '## [0.0.1] — 2026-09-07\n');
  write('planning/releases/0.0.1.md', '# 0.0.1\n状态：已发布\nadd-history\n');
  assert.equal(checkRelease(root).ok, true);
});

test('rejects each application, package and Expo version drift', (t) => {
  const { root, write } = fixture(t);
  for (const path of ['apps/mobile/package.json', 'apps/desktop/package.json', 'packages/domain/package.json', 'apps/mobile/app.json']) {
    const document = (version) => JSON.stringify(path.endsWith('app.json') ? { expo: { version } } : { version });
    write(path, document('0.0.2'));
    fails(root, path);
    write(path, document('0.0.1'));
  }
});

test('requires valid root version, current plan title and lifecycle state', (t) => {
  const { root, write } = fixture(t);
  write('package.json', '{ invalid JSON');
  fails(root, 'package.json');
  write('package.json', '{"version":"0.0.1"}');
  write('planning/releases/0.0.1.md', '# Wrong\n状态：待定\nadd-history');
  fails(root, '缺少版本标题');
  fails(root, '缺少有效版本状态');
});

test('rejects missing version plan and changelog', (t) => {
  const { root, remove } = fixture(t);
  remove('planning/releases/0.0.1.md');
  remove('CHANGELOG.md');
  fails(root, '缺少当前版本计划');
  fails(root, 'CHANGELOG.md');
});

test('rejects missing, duplicate, malformed and commented release assignments', (t) => {
  const { root, write, remove } = fixture(t);
  const path = 'openspec/changes/add-history/proposal.md';
  for (const proposal of ['# Proposal', 'Target release: 0.0.1\nTarget release: 0.0.1', 'Target release: ../other', '<!-- Target release: 0.0.1 -->']) {
    write(path, proposal);
    fails(root, '必须且只能声明');
  }
  remove(path);
  fails(root, '必须且只能声明');
});

test('rejects unknown target and missing plan registration', (t) => {
  const { root, write } = fixture(t);
  write('openspec/changes/add-history/proposal.md', 'Target release: 0.0.2');
  fails(root, '目标版本计划不存在');
  write('planning/releases/0.0.2.md', '# 0.0.2\n状态：开发中\n');
  fails(root, '未登记此变更');
  write('planning/releases/0.0.2.md', '# 0.0.2\n状态：开发中\nadd-history\n');
  assert.equal(checkRelease(root).ok, true);
});


test('CLI returns nonzero on invalid release records without echoing file contents', (t) => {
  const { root, write } = fixture(t);
  const script = fileURLToPath(new URL('./check-release.mjs', import.meta.url));
  assert.equal(spawnSync(process.execPath, [script], { cwd: root }).status, 0);
  write('openspec/changes/add-history/proposal.md', 'private-fixture-value');
  const result = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /必须且只能声明/);
  assert.ok(!`${result.stdout}${result.stderr}`.includes('private-fixture-value'));
});
