#!/usr/bin/env node
/**
 * Shared manifest + integrity helper for the Siyue server deployment bundle.
 *
 * Why a Node helper instead of shell: the bundle digest needs SHA-256 over ~5k files, a JSON
 * manifest, symlink target checks and platform prebuild checks. Doing that with shasum/jq would
 * depend on tools the target host does not have and would be easy to get subtly wrong. Node is
 * already a hard requirement of the project.
 *
 * Subcommands:
 *   manifest --bundle <dir> --repo-root <dir> [--release <name>] [--target-platform linux/amd64] [--pnpm-version <v>]
 *   verify   --bundle <dir> [--json]
 *
 * This helper lists and hashes files only. It never reads or prints secret values.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile, readlink, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const MANIFEST_NAME = 'DEPLOY-MANIFEST.json';
export const MANIFEST_FORMAT_VERSION = 1;
export const MANIFEST_KIND = 'siyue-server-deploy';

/** Entrypoints the compose services and the migration step run. */
export const REQUIRED_ENTRYPOINTS = {
  api: 'app/dist/index.js',
  mailWorker: 'app/dist/mail-worker.js',
  migrate: 'app/dist/database-migrate.js',
};

/** Static documents the host nginx serves from the release root through its legal/ alias. */
export const REQUIRED_ASSETS = ['legal/terms.html', 'legal/privacy.html'];

const TARGET_PREBUILD_DIR = {
  'linux/amd64': 'linux-x64',
  'linux/arm64': 'linux-arm64',
  'darwin/amd64': 'darwin-x64',
  'darwin/arm64': 'darwin-arm64',
};

const EXCLUDED_PATTERNS = [
  '.env* and *.local (the API environment file lives outside the bundle)',
  '*.pem, *.key, *.p12, *.pfx, *.crt, id_rsa*',
  '*.test.js|mjs|cjs|ts|tsx and *.spec.*',
  'node_modules/**/{test,tests,__tests__}/',
  'node_modules/**/*.md and node_modules/**/*.map, EXCEPT LICENSE/LICENCE/COPYING/NOTICE/COPYRIGHT/AUTHORS/PATENTS/THIRD-PARTY* which are kept',
  'app/src, app/tests, app/public, app/.turbo, app/tsconfig.json, app/README.md',
  '.git/**',
];

export async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

/** Returns the sorted, bundle-relative list of files and symlinks. Directories are implied. */
export async function collectEntries(root, { skip } = {}) {
  const out = [];
  async function visit(relative) {
    const directory = relative === '' ? root : path.join(root, relative);
    const items = (await readdir(directory, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const item of items) {
      const child = relative === '' ? item.name : relative + '/' + item.name;
      if (skip?.(child)) continue;
      const absolute = path.join(root, child);
      if (item.isSymbolicLink()) {
        out.push({ path: child, type: 'symlink', target: await readlink(absolute) });
      } else if (item.isDirectory()) {
        await visit(child);
      } else if (item.isFile()) {
        const info = await lstat(absolute);
        out.push({ path: child, type: 'file', size: info.size, sha256: await sha256File(absolute) });
      } else {
        out.push({ path: child, type: 'unsupported' });
      }
    }
  }
  await visit('');
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Attribution files that must survive pruning: dropping them strips third-party licenses. */
export function isLicenseFile(relative) {
  const base = path.posix.basename(relative).toLowerCase();
  return /^(license|licence|unlicense|copying|notice|copyright|authors|patents|third-party|thirdparty)/.test(base);
}

/** Files that must never reach a deploy bundle. Returns a reason string, or null when the path is fine. */
export function forbiddenReason(relative, { allowlist = [] } = {}) {
  if (allowlist.includes(relative)) return null;
  const base = path.posix.basename(relative);
  const segments = relative.split('/');
  if (segments.includes('.git')) return 'git_directory';
  if (segments.includes('.turbo')) return 'turbo_cache';
  if (/^\.[eE][nN][vV](\..+)?$/.test(base)) return 'env_file';
  if (/\.local$/.test(base)) return 'local_override';
  if (/\.(pem|key|p12|pfx|crt|csr)$/i.test(base)) return 'private_key_material';
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(base)) return 'ssh_private_key';
  if (/\.(test|spec)\.(js|mjs|cjs|ts|tsx)$/.test(base)) return 'test_file';
  if (segments.some(segment => ['test', 'tests', '__tests__'].includes(segment))) return 'test_directory';
  // Only the deployed package's own build config is a problem; several npm packages legitimately
  // ship a tsconfig.json inside node_modules, and it is never loaded at runtime.
  if (relative === 'app/tsconfig.json') return 'dev_config';
  return null;
}

async function collectMigrations(bundle) {
  const directory = path.join(bundle, 'app/migrations');
  let names;
  try {
    names = (await readdir(directory)).filter(name => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
  } catch {
    return [];
  }
  return Promise.all(names.map(async name => ({ version: name, sha256: await sha256File(path.join(directory, name)) })));
}

/** Native binaries must come from npm-shipped prebuilds; a compiled build/ means host-specific bytes. */
async function collectNativeModules(bundle, targetPlatform) {
  const nativeFiles = [];
  const visited = new Set();
  async function visit(absolute, relative) {
    // node_modules is a web of symlinks into .pnpm; resolve each target once so the same binary is
    // not counted through several paths.
    const identity = await realpath(absolute).catch(() => absolute);
    if (visited.has(identity)) return;
    visited.add(identity);
    let items = [];
    try {
      items = await readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const child = relative + '/' + item.name;
      if (item.isSymbolicLink()) {
        const resolved = await realpath(path.join(absolute, item.name)).catch(() => null);
        if (resolved) await visit(resolved, child);
      } else if (item.isDirectory()) {
        await visit(path.join(absolute, item.name), child);
      } else if (item.name.endsWith('.node')) {
        nativeFiles.push(child);
      }
    }
  }
  await visit(path.join(bundle, 'app/node_modules'), 'app/node_modules');
  const prebuildDir = TARGET_PREBUILD_DIR[targetPlatform] ?? null;
  return {
    prebuildDir,
    nativeFiles: nativeFiles.sort(),
    compiled: nativeFiles.filter(file => !file.includes('/prebuilds/')).sort(),
    targetPrebuilds: prebuildDir ? nativeFiles.filter(file => file.includes('/prebuilds/' + prebuildDir + '/')).sort() : [],
  };
}

async function gitInfo(repoRoot) {
  const git = async args => (await execFileAsync('git', ['-C', repoRoot, ...args])).stdout.trim();
  try {
    const commit = await git(['rev-parse', 'HEAD']);
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = (await git(['status', '--porcelain'])).split('\n').filter(Boolean);
    return {
      gitCommit: commit,
      gitCommitShort: commit.slice(0, 12),
      gitBranch: branch,
      worktreeDirty: status.length > 0,
      worktreeChanges: status.length,
      untrackedChanges: status.filter(line => line.startsWith('??')).length,
    };
  } catch {
    return { gitCommit: null, gitCommitShort: null, gitBranch: null, worktreeDirty: null, worktreeChanges: null, untrackedChanges: null };
  }
}

export async function buildManifest({ bundle, repoRoot, release, targetPlatform = 'linux/amd64', pnpmVersion = 'unknown' }) {
  const entries = await collectEntries(bundle, { skip: child => child === MANIFEST_NAME });
  const source = await gitInfo(repoRoot);
  const appPackage = JSON.parse(await readFile(path.join(bundle, 'app/package.json'), 'utf8'));
  const manifest = {
    formatVersion: MANIFEST_FORMAT_VERSION,
    kind: MANIFEST_KIND,
    release,
    createdAtUtc: new Date().toISOString(),
    source,
    build: {
      buildHost: process.platform + '/' + process.arch,
      targetPlatform,
      nodeVersion: process.version,
      pnpmVersion,
      packageName: appPackage.name,
      packageVersion: appPackage.version,
      packageJsonSha256: await sha256File(path.join(bundle, 'app/package.json')),
    },
    inputs: {
      pnpmLockSha256: await sha256File(path.join(repoRoot, 'pnpm-lock.yaml')),
      pnpmWorkspaceSha256: await sha256File(path.join(repoRoot, 'pnpm-workspace.yaml')),
      bundledPnpmLockSha256: await sha256File(path.join(bundle, 'source/pnpm-lock.yaml')),
    },
    entrypoints: REQUIRED_ENTRYPOINTS,
    assets: REQUIRED_ASSETS,
    migrations: await collectMigrations(bundle),
    nativeModules: await collectNativeModules(bundle, targetPlatform),
    excluded: EXCLUDED_PATTERNS,
    licenses: entries.filter(entry => entry.type === 'file' && isLicenseFile(entry.path)).map(entry => entry.path),
    fileCount: entries.filter(entry => entry.type === 'file').length,
    totalBytes: entries.filter(entry => entry.type === 'file').reduce((sum, entry) => sum + entry.size, 0),
    files: entries,
  };
  await writeFile(path.join(bundle, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export async function verifyBundle({ bundle }) {
  const failures = [];
  const notes = [];
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(bundle, MANIFEST_NAME), 'utf8'));
  } catch (error) {
    return { ok: false, failures: ['manifest_unreadable: ' + error.message], notes, manifest: null };
  }
  if (manifest.kind !== MANIFEST_KIND || manifest.formatVersion !== MANIFEST_FORMAT_VERSION) {
    failures.push('manifest_kind_or_version_unsupported: ' + manifest.kind + '@' + manifest.formatVersion);
  }

  const expected = new Map((manifest.files ?? []).map(entry => [entry.path, entry]));
  const actual = await collectEntries(bundle, { skip: child => child === MANIFEST_NAME });
  const actualMap = new Map(actual.map(entry => [entry.path, entry]));

  for (const entry of actual) {
    const reason = forbiddenReason(entry.path, { allowlist: ['siyue.env.example', '.dockerignore'] });
    if (reason) failures.push('forbidden_file: ' + entry.path + ' (' + reason + ')');
  }
  for (const entry of actual) {
    const recorded = expected.get(entry.path);
    if (!recorded) {
      failures.push('unexpected_file: ' + entry.path + ' (not in manifest; keep env files outside the bundle)');
      continue;
    }
    if (recorded.type !== entry.type) failures.push('type_mismatch: ' + entry.path + ' (' + recorded.type + ' -> ' + entry.type + ')');
    if (entry.type === 'file' && (recorded.sha256 !== entry.sha256 || recorded.size !== entry.size)) {
      failures.push('checksum_mismatch: ' + entry.path);
    }
    if (entry.type === 'symlink') {
      if (recorded.target !== entry.target) failures.push('symlink_target_mismatch: ' + entry.path);
      if (path.isAbsolute(entry.target)) failures.push('absolute_symlink: ' + entry.path + ' -> ' + entry.target);
      else if (!path.resolve(bundle, path.dirname(entry.path), entry.target).startsWith(bundle + path.sep)) {
        // A relative link that climbs out of the bundle dangles or points back into the build machine.
        failures.push('escaping_symlink: ' + entry.path + ' -> ' + entry.target);
      }
    }
  }
  for (const entry of expected.values()) {
    if (!actualMap.has(entry.path)) failures.push('missing_file: ' + entry.path);
  }

  for (const [name, relative] of Object.entries(manifest.entrypoints ?? REQUIRED_ENTRYPOINTS)) {
    if (!actualMap.has(relative)) failures.push('missing_entrypoint: ' + name + ' (' + relative + ')');
  }
  for (const relative of manifest.assets ?? REQUIRED_ASSETS) {
    if (!actualMap.has(relative)) failures.push('missing_asset: ' + relative);
  }

  const imports = new Set();
  for (const entry of actual) {
    if (!entry.path.startsWith('app/dist/') || !entry.path.endsWith('.js')) continue;
    const source = await readFile(path.join(bundle, entry.path), 'utf8');
    for (const match of source.matchAll(/from\s*['"](@siyue\/[^'"]+)['"]/g)) imports.add(match[1]);
  }
  for (const specifier of [...imports].sort()) {
    try {
      await stat(path.join(bundle, 'app/node_modules', specifier, 'package.json'));
    } catch {
      failures.push('unresolved_workspace_dependency: ' + specifier);
    }
  }
  if (imports.size === 0) failures.push('no_workspace_imports_found_in_dist');

  const migrations = await collectMigrations(bundle);
  const recordedMigrations = manifest.migrations ?? [];
  if (migrations.length !== recordedMigrations.length) {
    failures.push('migration_count_mismatch: manifest ' + recordedMigrations.length + ', files ' + migrations.length);
  } else {
    migrations.forEach((migration, index) => {
      if (recordedMigrations[index].version !== migration.version || recordedMigrations[index].sha256 !== migration.sha256) {
        failures.push('migration_checksum_mismatch: ' + migration.version);
      }
    });
  }
  if (migrations.length === 0) failures.push('no_migrations_found');

  const bundledLock = actualMap.get('source/pnpm-lock.yaml');
  if (!bundledLock || bundledLock.sha256 !== manifest.inputs?.pnpmLockSha256) {
    failures.push('bundled_lockfile_differs_from_build_lockfile');
  }

  const nativeFiles = manifest.nativeModules?.nativeFiles ?? [];
  if (nativeFiles.length > 0) {
    const prebuildDir = manifest.nativeModules?.prebuildDir ?? null;
    if (!prebuildDir) failures.push('unknown_target_platform: ' + manifest.build?.targetPlatform);
    else if ((manifest.nativeModules?.targetPrebuilds ?? []).length === 0) failures.push('no_prebuild_for_target_platform: ' + prebuildDir);
    if ((manifest.nativeModules?.compiled ?? []).length > 0) {
      failures.push('compiled_native_binary_present: ' + manifest.nativeModules.compiled.join(', '));
    }
    notes.push('native prebuilds for ' + prebuildDir + ': ' + (manifest.nativeModules?.targetPrebuilds ?? []).length);
  } else {
    notes.push('no native modules found');
  }
  const licenseFiles = actual.filter(entry => entry.type === 'file' && isLicenseFile(entry.path));
  if (licenseFiles.length === 0 && actual.length > 100) {
    failures.push('no_license_files_preserved: a dependency tree without LICENSE/NOTICE files means pruning stripped attribution');
  } else {
    notes.push('third-party license/notice files preserved: ' + licenseFiles.length);
  }
  notes.push('release=' + manifest.release + ' files=' + manifest.fileCount + ' bytes=' + manifest.totalBytes + ' target=' + manifest.build?.targetPlatform);
  return { ok: failures.length === 0, failures, notes, manifest };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!args.bundle) throw new Error('missing --bundle');
  const bundle = path.resolve(args.bundle);
  if (command === 'manifest') {
    if (!args['repo-root']) throw new Error('missing --repo-root');
    const manifest = await buildManifest({
      bundle,
      repoRoot: path.resolve(args['repo-root']),
      release: args.release ?? 'unversioned',
      targetPlatform: args['target-platform'] ?? 'linux/amd64',
      pnpmVersion: args['pnpm-version'] ?? 'unknown',
    });
    process.stdout.write(JSON.stringify({
      release: manifest.release,
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
      targetPlatform: manifest.build.targetPlatform,
      migrations: manifest.migrations.length,
      nativeFiles: manifest.nativeModules.nativeFiles.length,
    }) + '\n');
    return;
  }
  if (command === 'verify') {
    const result = await verifyBundle({ bundle });
    if (args.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else {
      for (const note of result.notes) process.stdout.write('note: ' + note + '\n');
      for (const failure of result.failures) process.stdout.write('FAIL: ' + failure + '\n');
      process.stdout.write(result.ok ? 'verify: ok\n' : 'verify: failed (' + result.failures.length + ' finding(s))\n');
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error('unknown_command:' + (command ?? ''));
}

const isEntrypoint = process.argv[1]
  ? await realpath(process.argv[1]).then(resolved => resolved === new URL(import.meta.url).pathname, () => false)
  : false;
if (isEntrypoint) {
  main().catch(error => {
    process.stderr.write('artifact.mjs failed: ' + error.message + '\n');
    process.exitCode = 1;
  });
}
