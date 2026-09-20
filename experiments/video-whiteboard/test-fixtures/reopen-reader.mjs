// 测试夹具：用独立进程重新打开归档并输出摘要，验证跨进程文件重开（非浏览器验收）。
// 用法：node reopen-reader.mjs <archiveRoot> [--recover] [--revision=N]
import { openArchive } from '../local-archive.mjs';

const [root, ...flags] = process.argv.slice(2);
if (!root) {
  process.stderr.write('usage: reopen-reader.mjs <archiveRoot> [--recover]\n');
  process.exit(2);
}

const revisionFlag = flags.find((flag) => flag.startsWith('--revision='));
const options = { recover: flags.includes('--recover') };
if (revisionFlag) options.revision = Number(revisionFlag.slice('--revision='.length));

try {
  const archive = await openArchive(root, options);
  process.stdout.write(JSON.stringify({
    status: archive.status,
    boardId: archive.boardId,
    revision: archive.revision,
    pointerRevision: archive.pointerRevision,
    previousRevision: archive.previousRevision,
    pages: archive.pages.length,
    strokeCount: archive.pages.reduce((total, page) => total + page.strokes.length, 0),
    attachments: archive.attachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      bytes: attachment.bytes,
      sha256: attachment.sha256,
    })),
    issues: archive.issues.map((issue) => issue.code),
    unreferencedRevisions: archive.unreferencedRevisions,
    stagingDirs: archive.stagingDirs,
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.code ?? 'unknown', message: error.message }));
  process.exit(4);
}
