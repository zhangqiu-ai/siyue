import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(path.resolve('apps/desktop/package.json'));
const esbuild = require('esbuild');
console.log('esbuild', esbuild.version);
const result = await esbuild.build({entryPoints:[path.resolve('packages/whiteboard/src/Editor.tsx')],bundle:true,format:'esm',jsx:'transform',outfile:path.resolve('packages/whiteboard/.tmp/editor.js'),logLevel:'silent'});
console.log('errors', result.errors.length);
