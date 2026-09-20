// 测试夹具：真实子进程在指定阶段终止，验证崩溃不会破坏指针和最近完整版本。
// 用法：node crash-writer.mjs <archiveRoot> <after-staging-written|after-revision-renamed|stale-lock> [boardId]
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { saveArchive } from '../local-archive.mjs';
import { onePixelPng } from './synthetic-media.mjs';

const [root, phase, boardId = 'board-crash'] = process.argv.slice(2);
if (!root || !phase) {
  process.stderr.write('usage: crash-writer.mjs <archiveRoot> <phase> [boardId]\n');
  process.exit(2);
}

const draft = {
  boardId,
  title: '合成题图',
  pages: [
    {
      pageId: 'page-1',
      imageRef: 'img-crash',
      strokes: [{ strokeId: 's-crash', tool: 'pen', color: '#222222', width: 3, points: [{ x: 1, y: 2 }] }],
    },
  ],
  attachments: [{ attachmentId: 'img-crash', kind: 'problem-image', mediaType: 'image/png', bytes: onePixelPng() }],
};

if (phase === 'stale-lock') {
  // 模拟写进程崩溃后留下的陈旧锁：写入锁文件后直接退出，不做清理。
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  await fsp.writeFile(
    path.join(root, 'archive.lock'),
    JSON.stringify({ pid: process.pid, token: 'stale', startedAt: new Date().toISOString(), task: 'video-whiteboard-poc' }),
  );
  process.exit(0);
}

const faults = {
  'after-staging-written': () => process.exit(70),
  'after-revision-renamed': () => process.exit(71),
};
const fault = faults[phase];
if (!fault) {
  process.stderr.write(`unknown phase: ${phase}\n`);
  process.exit(2);
}

try {
  await saveArchive(root, draft, { faults: { [phase.replace(/-([a-z])/g, (_, c) => c.toUpperCase())]: fault } });
} catch (error) {
  process.stderr.write(`unexpected error: ${error.message}\n`);
  process.exit(3);
}
process.stderr.write('saveArchive returned without hitting the requested crash phase\n');
process.exit(20);
