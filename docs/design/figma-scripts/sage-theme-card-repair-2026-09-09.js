// Run only after Figma access is restored and current nodes have been read back.
// Idempotent repair: preserves each wrapper ID, size, and prototype reactions.
const page = await figma.getNodeByIdAsync('210:7');
await figma.setCurrentPageAsync(page);
const main = await figma.getNodeByIdAsync('550:57');
if (!main || main.type !== 'COMPONENT' || main.children.length !== 5) {
  throw new Error('Unexpected focus-card master; inspect before modifying.');
}
for (const text of main.findAll(n => n.type === 'TEXT')) {
  for (const segment of text.getStyledTextSegments(['fontName'])) {
    await figma.loadFontAsync(segment.fontName);
  }
}
main.layoutMode = 'NONE';
const positions = [[20, 16], [20, 48], [20, 84], [20, 97], [20, 129]];
const mutatedNodeIds = [main.id];
for (let index = 0; index < main.children.length; index++) {
  const child = main.children[index];
  child.x = positions[index][0];
  child.y = positions[index][1];
  child.constraints = { horizontal: 'STRETCH', vertical: 'MIN' };
  mutatedNodeIds.push(child.id);
}
const rows = [];
for (const id of ["221:1517", "403:4912", "442:6400", "452:10633", "452:10687", "452:10741", "461:12396", "461:12450", "461:12504", "461:12558", "461:12840", "461:12894", "461:12948", "461:13002", "463:12955", "463:13009", "463:13063", "463:14059", "463:14113", "463:14167", "466:17123", "466:17227", "470:14676", "470:14780", "470:14884", "470:14988", "470:15092", "470:15196", "473:29178", "473:29282", "473:29386", "473:29490", "473:29594", "473:29698", "473:29802", "473:29906", "473:30866", "473:30970", "473:31074", "473:31178", "473:31282", "473:31386", "473:31490", "473:31594", "479:19181", "479:19285", "479:19389", "479:19493", "479:19597", "479:19701", "479:19805", "479:19909", "513:40104", "513:40274", "513:40444", "513:40614", "513:40784", "513:40954", "513:41124", "513:41294"]) {
  const wrapper = await figma.getNodeByIdAsync(id);
  if (!wrapper) throw new Error('Missing expected wrapper: ' + id);
  if (wrapper.children.length !== 1 || wrapper.children[0].type !== 'INSTANCE') continue;
  const instance = wrapper.children[0];
  if (!instance.componentProperties['Title#562:1']) {
    throw new Error('Unexpected nested instance: ' + id);
  }
  const width = wrapper.width;
  const height = wrapper.height;
  const reactions = JSON.stringify(wrapper.reactions);
  wrapper.layoutMode = 'NONE';
  wrapper.resize(width, height);
  instance.resize(width, height);
  instance.x = 0;
  instance.y = 0;
  if (instance.x !== 0 || instance.y !== 0 || instance.width !== width || instance.height !== height || JSON.stringify(wrapper.reactions) !== reactions) {
    throw new Error('Wrapper repair did not preserve geometry/routes: ' + id);
  }
  mutatedNodeIds.push(wrapper.id, instance.id);
  rows.push({ id, instance: instance.id, width, height, x: instance.x, y: instance.y });
}
return { createdNodeIds: [], mutatedNodeIds, rows };
