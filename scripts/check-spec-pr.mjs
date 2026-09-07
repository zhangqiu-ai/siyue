import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const changeIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function listChanges(root) {
  const changes = new Set();
  const directory = join(root, 'openspec/changes');
  if (!existsSync(directory)) return changes;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'archive') {
      for (const archived of readdirSync(join(directory, 'archive'), { withFileTypes: true })) {
        const match = /^\d{4}-\d{2}-\d{2}-(.+)$/.exec(archived.name);
        if (archived.isDirectory() && match && changeIdPattern.test(match[1]) &&
            isFile(join(directory, 'archive', archived.name, 'proposal.md'))) {
          changes.add(match[1]);
        }
      }
    } else if (changeIdPattern.test(entry.name) && isFile(join(directory, entry.name, 'proposal.md'))) {
      changes.add(entry.name);
    }
  }
  return changes;
}

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

// Only checks association and a non-placeholder reason; scope and approval need review.
export function validatePrBody(body, changes) {
  const lines = (typeof body === 'string' ? body : '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\r?\n/)
    .map((line) => /^\s*OpenSpec-(Change|Exempt):\s*(.*?)\s*$/.exec(line))
    .filter(Boolean);
  if (lines.length !== 1) {
    return { ok: false, message: 'PR 正文必须且只能填写一行 OpenSpec-Change: <change-id> 或 OpenSpec-Exempt: <具体原因>。' };
  }
  const [, kind, value] = lines[0];
  if (kind === 'Change') {
    if (!changeIdPattern.test(value)) {
      return { ok: false, message: 'OpenSpec-Change 必须是小写字母、数字及单连字符组成的 change-id。' };
    }
    if (!changes.has(value)) {
      return { ok: false, message: 'OpenSpec-Change 未对应活动或已归档变更中的 proposal.md。' };
    }
  } else if (value.length < 4 || /[<>]/.test(value) ||
      /^(?:todo|tbd|none|n\/a|reason|具体原因|填写原因|待填写|待补充|待定|无)[.。!！\s]*$/i.test(value)) {
    return { ok: false, message: 'OpenSpec-Exempt 必须填写具体原因，不能留空或使用占位内容。' };
  }
  return { ok: true, message: 'OpenSpec PR 关联检查通过；范围、豁免合理性与审批仍需人工审查。' };
}

export function main(env = process.env, root = process.cwd()) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request') {
    console.log('OpenSpec PR 关联检查跳过：当前不是 pull_request 事件。');
    return 0;
  }
  try {
    if (!env.GITHUB_EVENT_PATH) throw new Error('缺少 GITHUB_EVENT_PATH。');
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    if (!event.pull_request || typeof event.pull_request !== 'object') {
      throw new Error('事件未包含 pull_request。');
    }
    const result = validatePrBody(event.pull_request.body, listChanges(root));
    (result.ok ? console.log : console.error)(result.message);
    return result.ok ? 0 : 1;
  } catch {
    console.error('OpenSpec PR 关联检查失败：无法读取有效的 pull_request 事件或变更目录。');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
