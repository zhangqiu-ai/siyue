/** Generate read-only Figma route audits. No Figma/network calls run locally.
 * API: generateAudit(batch, mergedFrames, { phoneFrames, pageId, issueOffset }).
 * CLI: node THIS.mjs check [MERGED.json]
 *      node THIS.mjs generate [MERGED.json|--default] [offset=0] [count=8] [issueOffset=0]
 * MERGED may be an array or {frames:[...]}. Default merges saved resume + resumed.
 * Run each generated body with use_figma AFTER loading its required skill.
 * Repeat each batch with nextIssueOffset until null; pass=false is never hidden
 * by output pagination. Generated code is guarded below 45,000 characters;
 * the complete index uses tuples and a shared key dictionary. This checks edges, not whether every required control
 * has an edge, semantic identity/permissions, screenshots, or actual clicks.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const designDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const rowsOf = value => Array.isArray(value) ? value : value.frames;
const token = f => [f.key, f.lang, f.theme, f.mode].join('|');

export function mergeFrames(...inputs) {
  const ids = new Map(), tokens = new Map();
  for (const input of inputs) {
    assert(Array.isArray(rowsOf(input)), 'Expected a frame array or {frames:[]}');
    for (const f of rowsOf(input)) {
      assert(typeof f.id === 'string' && f.id && typeof f.key === 'string', 'Frame needs id/key');
      assert(['zh', 'en'].includes(f.lang) && ['light', 'dark'].includes(f.theme), `Invalid locale/theme: ${f.id}`);
      assert(['landscape', 'portrait'].includes(f.mode), `Invalid iPad orientation: ${f.id}`);
      const compact = Object.fromEntries(['id', 'key', 'lang', 'theme', 'mode'].map(k => [k, f[k]]));
      assert(!ids.has(f.id) || token(ids.get(f.id)) === token(compact), `Conflicting ID: ${f.id}`);
      assert(!tokens.has(token(compact)) || tokens.get(token(compact)) === f.id, `Duplicate matrix slot: ${token(compact)}`);
      ids.set(f.id, compact); tokens.set(token(compact), f.id);
    }
  }
  return [...ids.values()];
}

export function loadFrames(path) {
  return path && path !== '--default' ? mergeFrames(read(resolve(path))) : mergeFrames(
    read(resolve(designDir, 'account-family-ipad-resume-2026-09-09.json')),
    read(resolve(designDir, 'account-family-ipad-resumed-2026-09-09.json')),
  );
}
export const loadPhones = () => read(resolve(designDir, 'account-family-phone-index-2026-09-09.json')).frames;

// Serialized as a function body into Figma; keep this independent of Node APIs.
async function auditRuntime(figma, configs, frameTuples, keys, phoneIds, pageId, issueOffset) {
  const page = await figma.getNodeByIdAsync(pageId);
  if (!page || page.type !== 'PAGE') return { summary: { pass: false, fatal: 'missing-page', pageId }, issues: [] };
  await figma.setCurrentPageAsync(page);
  // Tuple = [id, key index, bits: English=4, dark=2, portrait=1].
  const known = new Map(frameTuples.map(([id, k, v]) => [id, { id, key: keys[k], lang: v & 4 ? 'en' : 'zh', theme: v & 2 ? 'dark' : 'light', mode: v & 1 ? 'portrait' : 'landscape' }])), phones = new Set(phoneIds), cache = new Map();
  const issues = [], byCode = {};
  const summary = { requestedFrames: configs.length, checkedFrames: 0, visibleReactionNodes: 0, visibleActions: 0, visibleLinks: 0, explicitSwitches: 0, issueCount: 0, byCode, pass: false };
  const short = value => String(value ?? '').slice(0, 100);
  function issue(code, f, node, target, detail) {
    byCode[code] = (byCode[code] || 0) + 1;
    issues.push({ code, frame: f.id, key: f.key, from: node?.id ?? f.id, ...(target ? { to: short(target) } : {}), ...(detail ? { detail: short(detail) } : {}) });
  }
  async function get(id) {
    if (!cache.has(id)) {
      try { cache.set(id, { node: await figma.getNodeByIdAsync(id) }); }
      catch (error) { cache.set(id, { node: null, error: short(error.message) }); }
    }
    return cache.get(id);
  }
  function visible(node, root) {
    for (let p = node; p; p = p.parent) {
      if ('visible' in p && !p.visible || 'opacity' in p && p.opacity === 0) return false;
      if (p.id === root.id) return true;
    }
    return false;
  }
  function disabledAncestor(node, root) {
    for (let p = node; p; p = p.parent) {
      if (p.type === 'INSTANCE') for (const [name, prop] of Object.entries(p.componentProperties || {})) {
        const key = name.split('#')[0].toLowerCase(), val = String(prop.value).toLowerCase();
        if ((key === 'enabled' && val === 'false') || (key === 'disabled' && val === 'true') || (['state', 'status'].includes(key) && val === 'disabled')) return p.id;
      }
      if (p.id === root.id) break;
    }
    return null;
  }
  function switchIntent(node, root) {
    // Exact node names are grounded in switches-dialogs-2026-09-09.js.
    const names = { '中文': ['lang', 'zh'], '简体中文': ['lang', 'zh'], 'English': ['lang', 'en'], '明色': ['theme', 'light'], '暗色': ['theme', 'dark'] };
    for (let p = node; p; p = p.parent) {
      if (names[p.name]) return names[p.name];
      if (p.id === root.id) break;
    }
    return null;
  }
  function actions(reaction) {
    return Array.isArray(reaction.actions) ? reaction.actions : reaction.action ? [reaction.action] : [];
  }
  // Conditional Figma actions can nest actions; don't silently skip their targets.
  function flatten(list) {
    const result = [];
    for (const a of list) {
      result.push(a);
      if (a.type === 'CONDITIONAL') for (const block of a.conditionalBlocks || []) result.push(...flatten(block.actions || []));
    }
    return result;
  }
  for (const f of configs) {
    const lookup = await get(f.id), root = lookup.node;
    if (!root) { issue(lookup.error ? 'root-read-error' : 'missing-root', f, null, null, lookup.error); continue; }
    if (root.type !== 'FRAME' || root.parent?.id !== pageId) { issue('invalid-root', f, root); continue; }
    summary.checkedFrames++;
    if ((root.width > root.height ? 'landscape' : 'portrait') !== f.mode) issue('root-orientation-mismatch', f, root);
    for (const node of [root, ...root.findAll(() => true)]) {
      if (!visible(node, root) || !('reactions' in node) || !node.reactions?.length) continue;
      summary.visibleReactionNodes++;
      const disabled = disabledAncestor(node, root);
      if (disabled) issue('disabled-reaction', f, node, null, disabled);
      for (const reaction of node.reactions) for (const action of flatten(actions(reaction))) {
        summary.visibleActions++;
        const destination = action.destinationId;
        if (!destination) {
          if (action.type === 'NODE') issue('missing-destination-id', f, node);
          if (['URL', 'BACK', 'CLOSE'].includes(action.type)) issue('unverifiable-navigation', f, node, null, action.type);
          continue;
        }
        summary.visibleLinks++;
        if (destination === root.id) issue('self-root', f, node, destination);
        if (phones.has(destination)) issue('phone-target', f, node, destination);
        const target = known.get(destination), read = await get(destination);
        if (!read.node) issue(read.error ? 'target-read-error' : 'missing-target', f, node, destination, read.error);
        if (!target) { issue('unknown-ipad-target', f, node, destination); continue; }
        if (read.node && (read.node.type !== 'FRAME' || read.node.parent?.id !== pageId)) issue('invalid-target-root', f, node, destination);
        if (target.mode !== f.mode) issue('cross-orientation', f, node, destination);
        if (read.node && (read.node.width > read.node.height ? 'landscape' : 'portrait') !== target.mode) issue('target-orientation-mismatch', f, node, destination);
        const intent = switchIntent(node, root);
        const languageSwitch = f.key === 'language' && target.key === 'language' && intent?.[0] === 'lang' && target.lang === intent[1] && target.theme === f.theme;
        const themeSwitch = f.key === 'appearance' && target.key === 'appearance' && intent?.[0] === 'theme' && target.theme === intent[1] && target.lang === f.lang;
        if (target.lang !== f.lang && !languageSwitch) issue('cross-language', f, node, destination);
        if (target.theme !== f.theme && !themeSwitch) issue('cross-theme', f, node, destination);
        if (target.lang !== f.lang && languageSwitch || target.theme !== f.theme && themeSwitch) summary.explicitSwitches++;
      }
    }
  }
  summary.issueCount = issues.length; summary.pass = issues.length === 0;
  // UTF-8 budget, not UTF-16 length: Chinese text can otherwise breach 18KB.
  function bytes(value) {
    let count = 0;
    for (const char of JSON.stringify(value)) { const n = char.codePointAt(0); count += n <= 127 ? 1 : n <= 2047 ? 2 : n <= 65535 ? 3 : 4; }
    return count;
  }
  const result = { summary, issueOffset, returnedIssues: 0, nextIssueOffset: null, issues: [] };
  for (let i = issueOffset; i < issues.length; i++) {
    result.issues.push(issues[i]); result.returnedIssues = result.issues.length;
    result.nextIssueOffset = i + 1 < issues.length ? i + 1 : null;
    if (bytes(result) > 17500) {
      result.issues.pop(); result.returnedIssues--; result.nextIssueOffset = i; break;
    }
  }
  return result;
}

export function generateAudit(batch, frames, options = {}) {
  const all = mergeFrames(frames), rows = mergeFrames(batch), ids = new Set(all.map(f => f.id));
  assert(rows.length > 0 && rows.length <= 32, 'Use 1–32 frames per audit; default 8');
  for (const f of rows) assert(ids.has(f.id) && token(all.find(x => x.id === f.id)) === token(f), `Unknown batch frame: ${f.id}`);
  const { pageId = '210:7', phoneFrames = loadPhones(), issueOffset = 0 } = options;
  assert(Number.isInteger(issueOffset) && issueOffset >= 0, 'issueOffset must be a non-negative integer');
  const phoneIds = phoneFrames.map(f => typeof f === 'string' ? f : f.id);
  assert(phoneIds.every(id => typeof id === 'string') && !phoneIds.some(id => ids.has(id)), 'Phone/iPad indices overlap or are invalid');
  const keys = [...new Set(all.map(f => f.key))], keyIndices = new Map(keys.map((key, i) => [key, i]));
  const tuples = all.map(f => [f.id, keyIndices.get(f.key), (f.lang === 'en' ? 4 : 0) | (f.theme === 'dark' ? 2 : 0) | (f.mode === 'portrait' ? 1 : 0)]);
  const code = `return await (${auditRuntime.toString()})(figma,${JSON.stringify(rows)},${JSON.stringify(tuples)},${JSON.stringify(keys)},${JSON.stringify(phoneIds)},${JSON.stringify(pageId)},${issueOffset});`;
  assert(code.length < 45000, `Generated code is ${code.length} characters; exceeds the 45,000-character budget`);
  return code;
}

export async function selfTest() {
  const f = (id, key = 'home', lang = 'zh', theme = 'light', mode = 'landscape') => ({ id, key, lang, theme, mode });
  const configs = [f('a'), f('b', 'goal'), f('c', 'goal', 'en'), f('d', 'goal', 'zh', 'dark'), f('e', 'goal', 'zh', 'light', 'portrait'), f('lang', 'language'), f('en', 'language', 'en')];
  const page = { id: 'p', type: 'PAGE' }, nodes = new Map();
  const make = c => ({ ...c, type: 'FRAME', visible: true, width: c.mode === 'portrait' ? 820 : 1180, height: c.mode === 'portrait' ? 1180 : 900, parent: page, reactions: [], children: [], findAll() { const walk = n => (n.children || []).flatMap(x => [x, ...walk(x)]); return walk(this); } });
  for (const c of configs) nodes.set(c.id, make(c));
  const link = (root, id, target, extra = {}) => { const node = { id, type: 'FRAME', name: id, visible: true, parent: nodes.get(root), reactions: [{ actions: [{ type: 'NODE', destinationId: target }] }], ...extra }; nodes.get(root).children.push(node); return node; };
  link('a', 'ok', 'b'); link('a', 'self', 'a'); link('a', 'phone', 'phone'); link('a', 'missing', 'gone'); link('a', 'language-bad', 'c'); link('a', 'theme-bad', 'd'); link('a', 'orientation-bad', 'e');
  link('a', 'hidden', 'gone', { visible: false });
  const disabled = link('a', 'disabled', 'b', { type: 'INSTANCE', componentProperties: { 'Enabled#1:2': { value: false } } });
  disabled.children = [{ id: 'disabled-child', type: 'TEXT', visible: true, parent: disabled, reactions: [{ actions: [{ type: 'NODE', destinationId: 'b' }] }] }];
  link('lang', 'English', 'en'); link('lang', 'wrong-control', 'c');
  nodes.set('phone', make(f('phone'))); nodes.set('p', page);
  const mock = { getNodeByIdAsync: async id => nodes.get(id) ?? null, setCurrentPageAsync: async () => {} };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const code = generateAudit([configs[0], configs[5]], configs, { pageId: 'p', phoneFrames: ['phone'] });
  const result = await new AsyncFunction('figma', code)(mock);
  assert.equal(result.summary.visibleLinks, 11); assert.equal(result.summary.explicitSwitches, 1);
  for (const kind of ['self-root', 'phone-target', 'unknown-ipad-target', 'missing-target', 'cross-language', 'cross-theme', 'cross-orientation', 'disabled-reaction']) assert(result.summary.byCode[kind] > 0, kind);
  assert.equal(result.summary.byCode['disabled-reaction'], 2); assert(!result.issues.some(x => x.from === 'hidden'));
  assert(!result.issues.some(x => x.from === 'English')); assert(result.issues.some(x => x.from === 'wrong-control' && x.code === 'cross-language'));
  link('en', 'simplified-option', 'lang', { name: '简体中文' });
  link('en', 'ordinary-back', 'lang', { name: '返回' });
  const simplified = await new AsyncFunction('figma', generateAudit([configs[6]], configs, { pageId: 'p', phoneFrames: ['phone'] }))(mock);
  assert.equal(simplified.summary.explicitSwitches, 1);
  assert(!simplified.issues.some(x => x.from === 'simplified-option'));
  assert(simplified.issues.some(x => x.from === 'ordinary-back' && x.code === 'cross-language'));
  for (let i = 0; i < 500; i++) link('a', `missing-${i}`, `未找到-${i}`);
  const many = await new AsyncFunction('figma', code)(mock);
  assert(Buffer.byteLength(JSON.stringify(many)) < 18000 && many.nextIssueOffset > 0 && many.summary.pass === false);
  const next = await new AsyncFunction('figma', generateAudit([configs[0], configs[5]], configs, { pageId: 'p', phoneFrames: ['phone'], issueOffset: many.nextIssueOffset }))(mock);
  assert.equal(next.summary.issueCount, many.summary.issueCount); assert.notEqual(next.issues[0].from, many.issues[0].from);
  const batch32 = Array.from({ length: 32 }, (_, i) => f(`batch-${i}`, `screen-${i}`));
  for (const row of batch32) nodes.set(row.id, make(row));
  const clean = await new AsyncFunction('figma', generateAudit(batch32, batch32, { pageId: 'p', phoneFrames: ['phone'] }))(mock);
  assert.equal(clean.summary.checkedFrames, 32); assert(clean.summary.pass);
  for (const row of batch32) for (let i = 0; i < 20; i++) link(row.id, `${row.id}-edge-${i}`, `未找到-${i}`);
  let cursor = 0, pages = 0, returned = 0, maxOutputBytes = 0;
  do {
    const result = await new AsyncFunction('figma', generateAudit(batch32, batch32, { pageId: 'p', phoneFrames: ['phone'], issueOffset: cursor }))(mock);
    const bytes = Buffer.byteLength(JSON.stringify(result)); maxOutputBytes = Math.max(maxOutputBytes, bytes);
    assert(bytes < 18000 && result.summary.checkedFrames === 32 && result.summary.issueCount === 1280 && !result.summary.pass);
    returned += result.returnedIssues; pages++;
    assert(result.nextIssueOffset === null || result.nextIssueOffset > cursor, 'Pagination must advance');
    cursor = result.nextIssueOffset;
  } while (cursor !== null);
  assert.equal(returned, 1280);
  return { mockChecks: ['valid route', 'self root', 'phone target', 'missing node', 'cross language/theme/orientation', 'hidden reaction ignored', 'disabled instance and descendant', 'explicit language selection only', '简体中文 option allowed; ordinary 返回 still rejected', 'UTF-8 output cap and pagination'], batch32: { checkedFrames: 32, injectedIssues: returned, pages, maxOutputBytes }, figmaExecution: 'not run' };
}

async function main(args) {
  const [command = 'check', path, offset = '0', count = '8', issueOffset = '0'] = args;
  const frames = loadFrames(path);
  if (command === 'generate') return generateAudit(frames.slice(Number(offset), Number(offset) + Number(count)), frames, { issueOffset: Number(issueOffset) });
  assert(command === 'check', 'Commands: check [MERGED.json], generate [MERGED.json|--default] [offset] [count] [issueOffset]');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let maxCodeCharacters = 0;
  for (let i = 0; i < frames.length; i += 8) {
    const code = generateAudit(frames.slice(i, i + 8), frames);
    maxCodeCharacters = Math.max(maxCodeCharacters, code.length); new AsyncFunction('figma', code);
  }
  // Full 96 × 4 × 2 matrix, using conservative 13-character mock node IDs.
  // Checks the eventual payload before all remote frames exist; does not imply creation.
  const projected = loadPhones().flatMap((f, i) => ['landscape', 'portrait'].map((mode, j) => ({ id: `999999:${String(i * 2 + j).padStart(6, '0')}`, key: f.key, lang: f.variant.split('-')[0], theme: f.variant.split('-')[1], mode })));
  let projectedMaxCodeCharacters = 0;
  for (let i = 0; i < projected.length; i += 32) {
    const code = generateAudit(projected.slice(i, i + 32), projected);
    projectedMaxCodeCharacters = Math.max(projectedMaxCodeCharacters, code.length); new AsyncFunction('figma', code);
  }
  return JSON.stringify({ frames: frames.length, batches: Math.ceil(frames.length / 8), maxCodeCharacters, projectedFullMatrix: { frames: projected.length, batches: Math.ceil(projected.length / 32), maxBatchSize: 32, mockNodeIdCharacters: 13, maxCodeCharacters: projectedMaxCodeCharacters, limit: 45000 }, generatedJavaScriptParse: 'passed', ...await selfTest() }, null, 2);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(await main(process.argv.slice(2)) + '\n'); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
