import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const visibleText = (text) => text.replace(/<!--[\s\S]*?-->/g, '');

export function readReleaseState(root) {
  const read = (path) => existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null;
  const children = (path) => existsSync(join(root, path))
    ? readdirSync(join(root, path), { withFileTypes: true }).filter((entry) => entry.isDirectory()) : [];
  const manifests = { 'package.json': read('package.json'), 'apps/mobile/app.json': read('apps/mobile/app.json') };
  for (const directory of ['apps', 'packages']) {
    for (const entry of children(directory)) {
      const path = `${directory}/${entry.name}/package.json`;
      if (existsSync(join(root, path))) manifests[path] = read(path);
    }
  }
  const plans = {};
  const planDirectory = join(root, 'planning/releases');
  if (existsSync(planDirectory)) {
    for (const entry of readdirSync(planDirectory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) plans[entry.name.slice(0, -3)] = read(`planning/releases/${entry.name}`);
    }
  }
  const proposals = {};
  for (const entry of children('openspec/changes')) {
    if (entry.name !== 'archive') proposals[entry.name] = read(`openspec/changes/${entry.name}/proposal.md`);
  }
  return { manifests, plans, proposals, changelog: read('CHANGELOG.md') };
}

// Pure validation; diagnostics contain paths and rules, never file contents or credentials.
export function validateRelease({ manifests, plans, proposals, changelog }) {
  const errors = [];
  const versions = {};
  for (const [path, source] of Object.entries(manifests)) {
    try {
      const document = JSON.parse(source);
      versions[path] = path === 'apps/mobile/app.json' ? document.expo?.version : document.version;
    } catch {
      errors.push(`${path}: 缺少或无法解析版本配置。`);
    }
  }
  const version = versions['package.json'];
  if (typeof version !== 'string' || !versionPattern.test(version)) {
    errors.push('package.json: 当前版本必须为 x.y.z。');
  } else {
    for (const path of Object.keys(manifests)) {
      if (versions[path] !== version) errors.push(`${path}: 版本必须与根 package.json 一致。`);
    }
    const plan = plans[version];
    if (typeof plan !== 'string') {
      errors.push(`planning/releases/${version}.md: 缺少当前版本计划。`);
    } else {
      const lines = visibleText(plan).split(/\r?\n/).map((line) => line.trim());
      if (!lines.includes(`# ${version}`)) errors.push(`planning/releases/${version}.md: 缺少版本标题。`);
      if (!lines.some((line) => /^状态：(?:开发中|已发布)$/.test(line))) errors.push(`planning/releases/${version}.md: 缺少有效版本状态。`);
    }
    const escapedVersion = version.replaceAll('.', '\\.');
    if (typeof changelog !== 'string' || !new RegExp(`^## \\[${escapedVersion}\\] — (?:未发布|\\d{4}-\\d{2}-\\d{2})\\s*$`, 'm').test(visibleText(changelog))) {
      errors.push('CHANGELOG.md: 缺少当前版本的未发布或日期标题。');
    }
  }
  for (const [changeId, proposal] of Object.entries(proposals)) {
    const path = `openspec/changes/${changeId}/proposal.md`;
    const lines = typeof proposal === 'string' ? visibleText(proposal).split(/\r?\n/).filter((line) => /^\s*Target release:/.test(line)) : [];
    const match = lines.length === 1 ? /^Target release: (\S+)\s*$/.exec(lines[0]) : null;
    if (!match || !versionPattern.test(match[1])) {
      errors.push(`${path}: 必须且只能声明一行 Target release: x.y.z。`);
      continue;
    }
    const plan = plans[match[1]];
    if (typeof plan !== 'string') {
      errors.push(`${path}: 目标版本计划不存在。`);
    } else if (!visibleText(plan).includes(changeId)) {
      errors.push(`${path}: 目标版本计划未登记此变更。`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function checkRelease(root = process.cwd()) {
  return validateRelease(readReleaseState(root));
}

export function main(root = process.cwd()) {
  try {
    const result = checkRelease(root);
    if (result.ok) console.log('版本记录检查通过；交付状态与验收证据仍需人工核对。');
    else for (const error of result.errors) console.error(error);
    return result.ok ? 0 : 1;
  } catch {
    console.error('版本记录检查失败：无法读取项目配置或版本记录。');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main();
