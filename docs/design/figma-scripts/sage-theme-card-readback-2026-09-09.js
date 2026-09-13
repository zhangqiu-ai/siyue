// Read-only recovery audit. No full-page main-component lookups.
const page = await figma.getNodeByIdAsync('210:7');
await figma.setCurrentPageAsync(page);
const ids = ['550:57', ...["221:1517", "403:4912", "442:6400", "452:10633", "452:10687", "452:10741", "461:12396", "461:12450", "461:12504", "461:12558", "461:12840", "461:12894", "461:12948", "461:13002", "463:12955", "463:13009", "463:13063", "463:14059", "463:14113", "463:14167", "466:17123", "466:17227", "470:14676", "470:14780", "470:14884", "470:14988", "470:15092", "470:15196", "473:29178", "473:29282", "473:29386", "473:29490", "473:29594", "473:29698", "473:29802", "473:29906", "473:30866", "473:30970", "473:31074", "473:31178", "473:31282", "473:31386", "473:31490", "473:31594", "479:19181", "479:19285", "479:19389", "479:19493", "479:19597", "479:19701", "479:19805", "479:19909", "513:40104", "513:40274", "513:40444", "513:40614", "513:40784", "513:40954", "513:41124", "513:41294"]];
const start = 0; // advance only after receiving and saving this batch
const limit = 10; // keep the tool response below its output limit
const rows = [];
for (const id of ids.slice(start, start + limit)) {
  const node = await figma.getNodeByIdAsync(id);
  if (!node) { rows.push({ id, missing: true }); continue; }
  const instance = node.children.length === 1 && node.children[0].type === 'INSTANCE' ? node.children[0] : null;
  const slot = instance?.findAllWithCriteria({ types: ['SLOT'] })[0];
  rows.push({
    id, type: node.type, layout: node.layoutMode, width: node.width, height: node.height,
    instance: instance ? { id: instance.id, x: instance.x, y: instance.y, width: instance.width, height: instance.height, properties: instance.componentProperties } : null,
    slot: slot ? { id: slot.id, width: slot.width, children: slot.children.map(child => ({ id: child.id, x: child.x, y: child.y, width: child.width, height: child.height, visible: child.visible, children: child.children?.map(bar => ({ id: bar.id, width: bar.width, visible: bar.visible })) })) } : null,
  });
}
return { createdNodeIds: [], mutatedNodeIds: [], start, next: Math.min(ids.length, start + limit), total: ids.length, rows };
