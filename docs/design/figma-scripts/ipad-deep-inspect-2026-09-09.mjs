/** Local generator only; no Figma calls are made by this module.
 * generateDeepInspect(rows, {pageId='210:7', expectedFonts=[], issueOffset=0})
 * Explicit children traversal (including INSTANCE), with per-node ID hydration.
 * Run generated JS separately after loading the required figma-use skill.
 * CLI: check | generate FILE.json [offset=0] [count=2] [issueOffset=0]
 * Compact: {compact:true}, 1–32 frames; CLI generate-compact FILE OFFSET COUNT.
 * Compact defaults: 3,000 nodes/frame, 48,000 nodes/batch. Hitting a cap fails
 * coverage explicitly. Detailed-mode generated bodies remain byte-identical.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function runtime(figma, configs, pageId, expectedFonts, issueOffset) {
  const issues = [], frames = [], byCode = {};
  const short = x => String(x ?? '').slice(0, 100);
  function issue(code, frame, node, detail) {
    byCode[code] = (byCode[code] || 0) + 1;
    issues.push({ code, frame, node, ...(detail ? { detail: short(detail) } : {}) });
  }
  const page = await figma.getNodeByIdAsync(pageId);
  if (!page) return { pass: false, fatal: 'missing-page', pageId };
  await figma.setCurrentPageAsync(page);
  const refs = new Map();
  async function ref(id) {
    if (!refs.has(id)) {
      try { refs.set(id, { node: await figma.getNodeByIdAsync(id) }); }
      catch (error) { refs.set(id, { node: null, error: short(error.message) }); }
    }
    return refs.get(id);
  }
  for (const c of configs) {
    const initialIssues = issues.length;
    const f = { id: c.id, key: c.key, nodes: 0, hydratedNodes: 0, hydrationFailures: 0, visibleNodes: 0, textNodes: 0, visibleTextNodes: 0, fontsChecked: 0, instances: 0, componentReferencesChecked: 0, reactions: 0, destinationReferencesChecked: 0, rootBoundsChecked: 0, childCollectionsRead: 0, fonts: {}, textSamples: [], textExpectedInstances: 0, emptyTextExpectedInstances: 0 };
    const rootResult = await ref(c.id), root = rootResult.node;
    if (!root) { issue('missing-root', c.id, c.id, rootResult.error); f.issueCount = 1; f.pass = false; frames.push(f); continue; }
    const rootBox = root.absoluteBoundingBox;
    if (!rootBox) issue('root-bounds-unavailable', c.id, c.id);
    const visited = new Set();
    function disabled(node) {
      if (node.type !== 'INSTANCE') return false;
      for (const [name, prop] of Object.entries(node.componentProperties || {})) {
        const key = name.split('#')[0].toLowerCase(), value = String(prop.value).toLowerCase();
        if (key === 'enabled' && value === 'false' || key === 'disabled' && value === 'true' || ['state', 'status'].includes(key) && value === 'disabled') return true;
      }
      return false;
    }
    async function walk(direct, ancestorsVisible, disabledId, clipping) {
      if (visited.has(direct.id)) { issue('repeated-node', c.id, direct.id); return 0; }
      visited.add(direct.id);
      // Read direct children first as a fallback; hydration must not silently erase them.
      let directChildren = [];
      if ('children' in direct) {
        try { directChildren = Array.from(direct.children); }
        catch (error) { issue('direct-children-read-error', c.id, direct.id, error.message); }
      }
      const hydrated = await ref(direct.id);
      let node = hydrated.node || direct;
      if (hydrated.node) f.hydratedNodes++;
      else { f.hydrationFailures++; issue('hydration-failed', c.id, direct.id, hydrated.error); }
      f.nodes++;
      const isVisible = ancestorsVisible && (!('visible' in node) || node.visible) && (!('opacity' in node) || node.opacity !== 0);
      if (isVisible) f.visibleNodes++;
      const box = node.absoluteBoundingBox;
      if (isVisible && box && rootBox && node.id !== root.id) {
        f.rootBoundsChecked++;
        if (box.x < rootBox.x - 1 || box.y < rootBox.y - 1 || box.x + box.width > rootBox.x + rootBox.width + 1 || box.y + box.height > rootBox.y + rootBox.height + 1) issue('outside-root', c.id, node.id, node.name);
        if (node.type === 'TEXT') for (const clip of clipping) if (box.x < clip.x - 1 || box.y < clip.y - 1 || box.x + box.width > clip.x + clip.width + 1 || box.y + box.height > clip.y + clip.height + 1) { issue('text-exceeds-clipping-ancestor', c.id, node.id, clip.id); break; }
      } else if (isVisible && !box) issue('node-bounds-unavailable', c.id, node.id, node.name);
      let textCount = 0;
      if (node.type === 'TEXT') {
        f.textNodes++;
        if (isVisible) {
          f.visibleTextNodes++; textCount++;
          if (f.textSamples.length < 6) f.textSamples.push({ id: node.id, text: short(node.characters) });
          try {
            if (node.hasMissingFont) issue('missing-font', c.id, node.id, node.name);
            const segments = node.getStyledTextSegments(['fontName']);
            if (node.characters.length && !segments.length) issue('font-segments-unavailable', c.id, node.id);
            for (const segment of segments) {
              f.fontsChecked++;
              const family = segment.fontName?.family;
              if (!family) issue('font-name-unavailable', c.id, node.id);
              else {
                f.fonts[family] = (f.fonts[family] || 0) + 1;
                if (expectedFonts.length && !expectedFonts.includes(family)) issue('unexpected-font', c.id, node.id, family);
              }
            }
          } catch (error) { issue('font-read-error', c.id, node.id, error.message); }
        }
      }
      if (node.type === 'INSTANCE') {
        f.instances++;
        try { const main = await node.getMainComponentAsync(); f.componentReferencesChecked++; if (!main) issue('missing-component-reference', c.id, node.id, node.name); }
        catch (error) { issue('component-read-error', c.id, node.id, error.message); }
      }
      const currentDisabled = disabledId || (disabled(node) ? node.id : null);
      if (isVisible && 'reactions' in node && node.reactions?.length) {
        f.reactions += node.reactions.length;
        if (currentDisabled) issue('disabled-reaction', c.id, node.id, currentDisabled);
        async function inspectActions(actions) {
          for (const action of actions) {
            if (action.type === 'CONDITIONAL') for (const block of action.conditionalBlocks || []) await inspectActions(block.actions || []);
            if (action.destinationId) {
              f.destinationReferencesChecked++;
              const target = await ref(action.destinationId);
              if (!target.node) issue('missing-reaction-target', c.id, node.id, action.destinationId);
              if (action.destinationId === c.id) issue('self-root-reaction', c.id, node.id);
            } else if (action.type === 'NODE') issue('missing-destination-id', c.id, node.id);
          }
        }
        for (const r of node.reactions) await inspectActions(r.actions || (r.action ? [r.action] : []));
      }
      let children = directChildren;
      if ('children' in node) {
        f.childCollectionsRead++;
        try {
          const current = Array.from(node.children);
          // Union direct and hydrated children by ID, so an empty proxy isn't accepted.
          const byId = new Map(directChildren.map(x => [x.id, x]));
          for (const child of current) byId.set(child.id, child);
          children = [...byId.values()];
          if (directChildren.length && !current.length) issue('hydrated-children-empty', c.id, node.id, node.name);
        } catch (error) { issue('children-read-error', c.id, node.id, error.message); }
      }
      const nextClipping = 'clipsContent' in node && node.clipsContent && box ? [...clipping, { ...box, id: node.id }] : clipping;
      for (const child of children) textCount += await walk(child, isVisible, currentDisabled, nextClipping);
      if (node.type === 'INSTANCE' && isVisible && /alert|button|list.?row|table.?cell|对话框|按钮/i.test(node.name)) {
        f.textExpectedInstances++;
        if (!textCount) { f.emptyTextExpectedInstances++; issue('zero-text-in-expected-instance', c.id, node.id, node.name); }
      }
      return textCount;
    }
    await walk(root, true, null, []);
    if (!f.visibleTextNodes) issue('zero-visible-text-coverage', c.id, c.id);
    if (f.visibleTextNodes && !f.fontsChecked) issue('zero-font-coverage', c.id, c.id);
    f.issueCount = issues.length - initialIssues; f.pass = f.issueCount === 0;
    frames.push(f);
  }
  const summary = { pass: issues.length === 0, requestedFrames: configs.length, issueCount: issues.length, byCode };
  const output = { summary, frames, issueOffset, returnedIssues: 0, nextIssueOffset: null, issues: [] };
  function bytes(value) { let n = 0; for (const ch of JSON.stringify(value)) { const p = ch.codePointAt(0); n += p <= 127 ? 1 : p <= 2047 ? 2 : p <= 65535 ? 3 : 4; } return n; }
  if (bytes(output) > 17000) throw new Error('Coverage summary exceeds output budget; inspect one frame per call.');
  for (let i = issueOffset; i < issues.length; i++) {
    output.issues.push(issues[i]); output.returnedIssues++;
    output.nextIssueOffset = i + 1 < issues.length ? i + 1 : null;
    if (bytes(output) > 17500) { output.issues.pop(); output.returnedIssues--; output.nextIssueOffset = i; break; }
  }
  return output;
}

function compactRuntimeSource(maxNodesPerFrame, maxTotalNodes) {
  let source = runtime.toString();
  const replace = (before, after) => {
    assert(source.includes(before), `Deep-inspect anchor changed: ${before}`);
    source = source.replace(before, after);
  };
  replace('const issues = [], frames = [], byCode = {};', `const issues = [], frames = [], byCode = {}; let totalNodes = 0;
  function compactFrame(f) { return Object.fromEntries(['id','key','visibleTextNodes','fontsChecked','instances','componentReferencesChecked','hydrationFailures','issueCount','pass','fonts'].map(k=>[k,f[k]])); }`);
  replace('async function walk(direct, ancestorsVisible, disabledId, clipping) {', `async function walk(direct, ancestorsVisible, disabledId, clipping) {
      if (f.nodes >= ${maxNodesPerFrame} || totalNodes >= ${maxTotalNodes}) {
        if (!f.traversalLimitReached) issue('traversal-limit-incomplete', c.id, direct.id, 'Coverage incomplete; rerun this frame with a larger node budget');
        f.traversalLimitReached = true; return 0;
      }`);
  replace('f.nodes++;', 'f.nodes++; totalNodes++;');
  source = source.replaceAll('frames.push(f)', 'frames.push(compactFrame(f))');
  // Match the compact-mode 17KB request even when issue pagination is needed.
  replace('if (bytes(output) > 17500)', 'if (bytes(output) > 16500)');
  replace('if (bytes(output) > 17000)', 'if (bytes(output) > 16000)');
  return source;
}

export function generateDeepInspect(rows, { pageId = '210:7', expectedFonts = [], issueOffset = 0, compact = false, maxNodesPerFrame = 3000, maxTotalNodes = 48000 } = {}) {
  assert(Array.isArray(rows) && rows.length > 0 && rows.length <= (compact ? 32 : 3), compact ? 'Use 1–32 compact frames' : 'Use 1–3 frames per call');
  assert(rows.every(x => typeof x.id === 'string' && x.id), 'Recorded frame IDs required');
  assert(new Set(rows.map(x => x.id)).size === rows.length, 'Duplicate frame IDs');
  assert(Number.isInteger(issueOffset) && issueOffset >= 0);
  const configs = rows.map(({ id, key }) => ({ id, key }));
  assert(Number.isInteger(maxNodesPerFrame) && maxNodesPerFrame > 0 && maxNodesPerFrame <= 100000);
  assert(Number.isInteger(maxTotalNodes) && maxTotalNodes > 0 && maxTotalNodes <= 200000);
  const source = compact ? compactRuntimeSource(maxNodesPerFrame, maxTotalNodes) : runtime.toString();
  const code = `return await (${source})(figma,${JSON.stringify(configs)},${JSON.stringify(pageId)},${JSON.stringify(expectedFonts)},${issueOffset});`;
  assert(code.length < 45000); return code;
}

export async function selfTest() {
  const page = { id: 'p', type: 'PAGE' }, nodes = new Map([['p', page]]);
  const make = (id, type, parent, extra = {}) => {
    const n = { id, name: id, type, parent, visible: true, opacity: 1, absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 }, ...extra };
    nodes.set(id, n); if (parent?.children) parent.children.push(n); return n;
  };
  const root = make('r', 'FRAME', page, { children: [], findAll: () => [], findAllWithCriteria: () => [] });
  const alert = make('alert', 'INSTANCE', root, { children: [], getMainComponentAsync: async () => ({ id: 'main' }), componentProperties: {} });
  const column = make('Title and Description', 'FRAME', alert, { children: [] });
  const title = make('title', 'TEXT', column, { characters: '共享确认', hasMissingFont: true, getStyledTextSegments: () => [{ fontName: { family: 'Noto Sans SC' } }] });
  make('buttons', 'FRAME', alert, { children: [] });
  const mock = { getNodeByIdAsync: async id => nodes.get(id) || null, setCurrentPageAsync: async () => {} };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let result = await new AsyncFunction('figma', generateDeepInspect([{ id: 'r' }], { pageId: 'p' }))(mock);
  assert.equal(result.frames[0].visibleTextNodes, 1); assert.equal(result.frames[0].instances, 1); assert.equal(result.frames[0].fontsChecked, 1);
  assert.equal(result.summary.byCode['missing-font'], 1); assert(!result.summary.byCode['zero-visible-text-coverage']);
  title.hasMissingFont = false; title.absoluteBoundingBox.x = 101;
  alert.componentProperties.Enabled = { value: 'False' }; title.reactions = [{ actions: [{ type: 'NODE', destinationId: 'missing' }] }];
  result = await new AsyncFunction('figma', generateDeepInspect([{ id: 'r' }], { pageId: 'p' }))(mock);
  for (const code of ['outside-root', 'disabled-reaction', 'missing-reaction-target']) assert(result.summary.byCode[code], code);
  title.visible = false;
  result = await new AsyncFunction('figma', generateDeepInspect([{ id: 'r' }], { pageId: 'p' }))(mock);
  assert(result.summary.byCode['zero-visible-text-coverage']); assert(result.summary.byCode['zero-text-in-expected-instance']);
  const batches = [];
  for (let i = 0; i < 32; i++) {
    const r = make(`batch-${i}`, 'FRAME', page, { children: [] });
    const a = make(`alert-${i}`, 'INSTANCE', r, { children: [], getMainComponentAsync: async () => ({ id: 'main' }), componentProperties: {} });
    make(`text-${i}`, 'TEXT', a, { characters: '完整实例文字', hasMissingFont: false, getStyledTextSegments: () => [{ fontName: { family: 'Noto Sans SC' } }] });
    batches.push({ id: r.id, key: 'confirm-share' });
  }
  const compactChecks = [];
  for (const count of [16, 32]) {
    const r = await new AsyncFunction('figma', generateDeepInspect(batches.slice(0, count), { pageId: 'p', compact: true }))(mock);
    assert(r.summary.pass && r.frames.length === count);
    assert(r.frames.every(f => f.visibleTextNodes === 1 && f.fontsChecked === 1 && f.instances === 1 && f.componentReferencesChecked === 1 && !('textSamples' in f)));
    const bytes = Buffer.byteLength(JSON.stringify(r)); assert(bytes < 17000);
    compactChecks.push({ count, visibleTextNodes: r.frames.reduce((sum, f) => sum + f.visibleTextNodes, 0), bytes });
  }
  const capped = await new AsyncFunction('figma', generateDeepInspect(batches.slice(0, 16), { pageId: 'p', compact: true, maxNodesPerFrame: 2 }))(mock);
  assert(!capped.summary.pass && capped.summary.byCode['traversal-limit-incomplete'] === 16);
  const totalCapped = await new AsyncFunction('figma', generateDeepInspect(batches.slice(0, 16), { pageId: 'p', compact: true, maxTotalNodes: 4 }))(mock);
  assert(!totalCapped.summary.pass && totalCapped.summary.byCode['traversal-limit-incomplete']);
  return { parse: 'passed', explicitInstanceRecursion: 'passed despite mocked findAll returning []', fontBoundsReferencesReactions: 'passed', zeroTextFails: 'passed', compactChecks, traversalCapsFailExplicitly: 'passed', figmaExecution: 'not run' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command = 'check', file, offset = '0', count = '2', issueOffset = '0'] = process.argv.slice(2);
    if (command === 'check') process.stdout.write(JSON.stringify(await selfTest(), null, 2) + '\n');
    else {
      assert(['generate', 'generate-compact'].includes(command) && file, 'Use check, generate or generate-compact FILE [offset] [count] [issueOffset]');
      const data = JSON.parse(readFileSync(resolve(file), 'utf8')), rows = Array.isArray(data) ? data : data.frames;
      process.stdout.write(generateDeepInspect(rows.slice(Number(offset), Number(offset) + Number(count)), { issueOffset: Number(issueOffset), compact: command === 'generate-compact' }) + '\n');
    }
  } catch (error) { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }
}
