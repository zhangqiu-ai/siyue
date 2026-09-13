return await (async function runtime(figma, configs, pageId, expectedFonts, issueOffset) {
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
})(figma,[{"id":"512:28930","key":"revoked"},{"id":"512:29097","key":"transfer"},{"id":"512:29266","key":"transfer"}],"210:7",[],0);
