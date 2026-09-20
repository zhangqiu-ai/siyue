import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(new URL('../packages/whiteboard/package.json', import.meta.url));
const fonts = path.join(path.dirname(require.resolve('@excalidraw/excalidraw')), 'fonts');
for (const app of ['mobile', 'desktop']) {
  const destination = new URL(`../apps/${app}/public/excalidraw/fonts/`, import.meta.url);
  await mkdir(destination, { recursive: true });
  await cp(fonts, destination, { recursive: true });
}
console.log('Local Excalidraw fonts copied for Metro DOM and Electron bundles.');

const cssPath=path.join(path.dirname(require.resolve('@excalidraw/excalidraw')), 'index.css');
let css=await readFile(cssPath,'utf8');
for(const match of [...css.matchAll(/url\(["']?(\.\/fonts\/[^)"']+)["']?\)/g)]) {
 const bytes=await readFile(path.resolve(path.dirname(cssPath),match[1]));
 css=css.replace(match[0],`url("data:font/woff2;base64,${bytes.toString('base64')}")`);
}
await mkdir(new URL('../packages/whiteboard/generated/',import.meta.url),{recursive:true});
await writeFile(new URL('../packages/whiteboard/generated/excalidraw.css',import.meta.url),css);
