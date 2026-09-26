// Tests for the deployment bundle manifest/verification helper.
// Run: node --test scripts/server-deploy/lib/artifact.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildManifest, isLicenseFile, verifyBundle } from './artifact.mjs';

const repoRoot = path.resolve(new URL('../../..', import.meta.url).pathname);
const lockfile = await readFile(path.join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
const workspace = await readFile(path.join(repoRoot, 'pnpm-workspace.yaml'), 'utf8');

const baseFiles = {
  'app/package.json': JSON.stringify({ name: '@siyue/server', version: '0.0.1', type: 'module', dependencies: { '@siyue/contracts': 'workspace:*' } }),
  'app/dist/index.js': "import { schema } from '@siyue/contracts';\nexport const api = schema;\n",
  'app/dist/mail-worker.js': "export const worker = 1;\n",
  'app/dist/database-migrate.js': "export const migrate = 1;\n",
  'app/migrations/0001_identity_core.sql': 'CREATE SCHEMA siyue;\n',
  'app/migrations/0002_email_auth.sql': 'CREATE TABLE siyue.t (id int);\n',
  'app/node_modules/@siyue/contracts/package.json': JSON.stringify({ name: '@siyue/contracts', type: 'module' }),
  'app/node_modules/lib/package.json': JSON.stringify({ name: 'lib', type: 'module' }),
  'legal/terms.html': '<!doctype html><title>terms</title>\n',
  'legal/privacy.html': '<!doctype html><title>privacy</title>\n',
  'source/pnpm-lock.yaml': lockfile,
  'source/pnpm-workspace.yaml': workspace,
  Dockerfile: 'FROM node:22-bookworm-slim\n',
  'docker-compose.yml': 'services: {}\n',
  'siyue.env.example': 'SIYUE_ENVIRONMENT=production\n',
  'DEPLOY.md': '# deploy\n',
};

async function makeBundle(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'siyue-artifact-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'bundle');
  for (const [relative, content] of Object.entries(baseFiles)) {
    const file = path.join(bundle, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return { root, bundle };
}

async function expectFailure(bundle, fragment) {
  const result = await verifyBundle({ bundle });
  assert.equal(result.ok, false, 'expected verification to fail');
  assert.ok(
    result.failures.some(failure => failure.includes(fragment)),
    'expected a failure containing ' + fragment + ', got ' + JSON.stringify(result.failures),
  );
}

test('a well-formed bundle passes verification', async t => {
  const { bundle } = await makeBundle(t);
  await buildManifest({ bundle, repoRoot, release: 'test-0.0.1' });
  const result = await verifyBundle({ bundle });
  assert.deepEqual(result.failures, []);
  assert.equal(result.manifest.release, 'test-0.0.1');
  assert.equal(result.manifest.migrations.length, 2);
  assert.equal(result.manifest.entrypoints.mailWorker, 'app/dist/mail-worker.js');
});

test('tampered content is detected by checksum', async t => {
  const { bundle } = await makeBundle(t);
  await buildManifest({ bundle, repoRoot, release: 'test' });
  await writeFile(path.join(bundle, 'app/dist/index.js'), 'export const api = 2;\n');
  await expectFailure(bundle, 'checksum_mismatch: app/dist/index.js');
});

test('environment files, local overrides and private keys are rejected', async t => {
  const { bundle } = await makeBundle(t);
  await buildManifest({ bundle, repoRoot, release: 'test' });
  await writeFile(path.join(bundle, '.env'), 'SIYUE_DATABASE_URL=postgresql://x\n');
  await expectFailure(bundle, 'forbidden_file: .env (env_file)');
});

test('private key material and local overrides are rejected', async t => {
  const { bundle } = await makeBundle(t);
  await writeFile(path.join(bundle, 'app/node_modules/lib/secret.key'), 'private\n');
  await buildManifest({ bundle, repoRoot, release: 'test' });
  await expectFailure(bundle, 'secret.key (private_key_material)');
});

test('tests and turbo caches are rejected', async t => {
  const { bundle } = await makeBundle(t);
  await buildManifest({ bundle, repoRoot, release: 'test' });
  await writeFile(path.join(bundle, 'app/dist/extra.test.js'), 'export {};\n');
  await expectFailure(bundle, 'forbidden_file: app/dist/extra.test.js (test_file)');
});

test('files added after manifest creation are reported', async t => {
  const { bundle } = await makeBundle(t);
  await buildManifest({ bundle, repoRoot, release: 'test' });
  await writeFile(path.join(bundle, 'extra.txt'), 'unexpected\n');
  await expectFailure(bundle, 'unexpected_file: extra.txt');
});

test('deleted files are reported', async t => {
  const { bundle } = await makeBundle(t);
  await buildManifest({ bundle, repoRoot, release: 'test' });
  await rm(path.join(bundle, 'app/dist/mail-worker.js'));
  await expectFailure(bundle, 'missing_file: app/dist/mail-worker.js');
});

test('a missing legal document is reported', async t => {
  const { bundle } = await makeBundle(t);
  await buildManifest({ bundle, repoRoot, release: 'test' });
  await rm(path.join(bundle, 'legal/privacy.html'));
  await expectFailure(bundle, 'missing_asset: legal/privacy.html');
});

test('third-party attribution files are counted and never forbidden', async t => {
  const { bundle } = await makeBundle(t);
  await writeFile(path.join(bundle, 'app/node_modules/lib/LICENSE.md'), 'MIT\n');
  await writeFile(path.join(bundle, 'app/node_modules/lib/NOTICE.txt'), 'notice\n');
  await writeFile(path.join(bundle, 'app/node_modules/lib/readme.md'), 'nope\n');
  assert.equal(isLicenseFile('app/node_modules/lib/LICENSE.md'), true);
  assert.equal(isLicenseFile('app/node_modules/lib/NOTICE.txt'), true);
  assert.equal(isLicenseFile('app/node_modules/lib/readme.md'), false);
  const manifest = await buildManifest({ bundle, repoRoot, release: 'test' });
  assert.ok(manifest.licenses.includes('app/node_modules/lib/LICENSE.md'));
  assert.ok(manifest.licenses.includes('app/node_modules/lib/NOTICE.txt'));
  assert.ok(!manifest.licenses.includes('app/node_modules/lib/readme.md'));
  const result = await verifyBundle({ bundle });
  assert.deepEqual(result.failures, []);
});

test('absolute symlinks are rejected and relative ones accepted', async t => {
  const { root, bundle } = await makeBundle(t);
  await symlink(path.join(root, 'outside'), path.join(bundle, 'app/node_modules/lib-link'));
  await buildManifest({ bundle, repoRoot, release: 'test' });
  await expectFailure(bundle, 'absolute_symlink: app/node_modules/lib-link');
});

test('relative symlinks that climb out of the bundle are rejected', async t => {
  const { bundle } = await makeBundle(t);
  await symlink('../../../../outside', path.join(bundle, 'app/node_modules/lib-link'));
  await buildManifest({ bundle, repoRoot, release: 'test' });
  await expectFailure(bundle, 'escaping_symlink: app/node_modules/lib-link');
});

test('unresolved workspace dependency is reported', async t => {
  const { bundle } = await makeBundle(t);
  await writeFile(path.join(bundle, 'app/dist/index.js'), "import { x } from '@siyue/missing';\nexport const api = x;\n");
  await buildManifest({ bundle, repoRoot, release: 'test' });
  await expectFailure(bundle, 'unresolved_workspace_dependency: @siyue/missing');
});

test('migration checksum drift is reported', async t => {
  const { bundle } = await makeBundle(t);
  await buildManifest({ bundle, repoRoot, release: 'test' });
  await writeFile(path.join(bundle, 'app/migrations/0002_email_auth.sql'), 'CREATE TABLE siyue.t (id bigint);\n');
  await expectFailure(bundle, 'migration_checksum_mismatch: 0002_email_auth.sql');
});

test('a bundle whose lockfile differs from the build lockfile is reported', async t => {
  const { bundle } = await makeBundle(t);
  await buildManifest({ bundle, repoRoot, release: 'test' });
  await writeFile(path.join(bundle, 'source/pnpm-lock.yaml'), lockfile + '# drift\n');
  await expectFailure(bundle, 'bundled_lockfile_differs_from_build_lockfile');
});

test('a bundle without a manifest fails closed', async t => {
  const { bundle } = await makeBundle(t);
  await expectFailure(bundle, 'manifest_unreadable');
});

test('the deployed package tsconfig is rejected while a dependency tsconfig is allowed', async t => {
  const { bundle } = await makeBundle(t);
  await writeFile(path.join(bundle, 'app/node_modules/lib/tsconfig.json'), '{}\n');
  await writeFile(path.join(bundle, 'app/tsconfig.json'), '{}\n');
  await buildManifest({ bundle, repoRoot, release: 'test' });
  const result = await verifyBundle({ bundle });
  assert.ok(result.failures.includes('forbidden_file: app/tsconfig.json (dev_config)'));
  assert.equal(result.failures.length, 1);
});
