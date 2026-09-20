// add-family-video-whiteboard 任务 2.4 隔离 PoC 的行为测试（覆盖 VWA-01/VWA-02 存储侧）。
// 用例：重开后编辑再保存、失败保旧、子进程崩溃、附件损坏/缺失、未来版本、非法输入、
// 显式读取上一完整修订、单写者限制、跨进程重开。全部数据在 os.tmpdir() 的独立目录内合成；
// 题图是真实可解码的 1x1 PNG/JPEG（test-fixtures/synthetic-media.mjs），不是伪 PNG 签名。
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ERROR_CODES,
  LIMITS,
  openArchive,
  saveArchive,
  assertArchiveRoot,
} from './local-archive.mjs';
import { onePixelJpeg, onePixelPng } from './test-fixtures/synthetic-media.mjs';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-fixtures');
const crashWriter = path.join(fixturesDir, 'crash-writer.mjs');
const reopenReader = path.join(fixturesDir, 'reopen-reader.mjs');

// ---------- 夹具 ----------

async function makeRoot(t, prefix = 'siyue-vw-poc-') {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  return root;
}

const syntheticPng = () => onePixelPng();

function makeDraft(overrides = {}) {
  return {
    boardId: 'board-1',
    title: '合成题图练习',
    pages: [
      {
        pageId: 'page-1',
        imageRef: 'img-1',
        strokes: [
          {
            strokeId: 's-1',
            tool: 'pen',
            color: '#111111',
            width: 2,
            points: [{ x: 10, y: 20 }, { x: 30, y: 40 }],
          },
        ],
      },
    ],
    attachments: [
      { attachmentId: 'img-1', kind: 'problem-image', mediaType: 'image/png', bytes: syntheticPng() },
    ],
    ...overrides,
  };
}

function revisionDir(root, revision) {
  return path.join(root, 'revisions', `r-${String(revision).padStart(8, '0')}`);
}

function sha256hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await fsp.writeFile(file, JSON.stringify(value, null, 2));
}

// 修改修订目录内的文件，并同步 manifest 的 bytes/sha256，模拟“清单仍自洽但内容变化”。
async function repackEntry(root, revision, rel, mutate) {
  const dir = revisionDir(root, revision);
  const abs = path.join(dir, rel);
  const next = await mutate(await fsp.readFile(abs));
  if (next) await fsp.writeFile(abs, next);
  const stored = await fsp.readFile(abs);
  const manifest = await readJson(path.join(dir, 'manifest.json'));
  const entry = manifest.files.find((file) => file.path === rel);
  entry.bytes = stored.byteLength;
  entry.sha256 = sha256hex(stored);
  await writeJson(path.join(dir, 'manifest.json'), manifest);
  return manifest;
}

async function repackManifest(root, revision, mutate) {
  const manifestPath = path.join(revisionDir(root, revision), 'manifest.json');
  const next = mutate(await readJson(manifestPath));
  await writeJson(manifestPath, next);
  return next;
}

async function addOrphanManifestAttachment(root, revision, attachmentId) {
  const dir = revisionDir(root, revision);
  const rel = `attachments/${attachmentId}.png`;
  const bytes = syntheticPng(3, 32);
  await fsp.writeFile(path.join(dir, rel), bytes);
  await repackManifest(root, revision, (manifest) => ({
    ...manifest,
    files: [
      ...manifest.files,
      {
        path: rel,
        bytes: bytes.byteLength,
        sha256: sha256hex(bytes),
        attachmentId,
        kind: 'problem-image',
        mediaType: 'image/png',
      },
    ],
  }));
}

// 把修订的 manifest 与 snapshot 一起改成另一个 boardId，制造「修订内部自洽、但与指针不一致」的损坏。
async function rewriteRevisionBoardId(root, revision, boardId) {
  await repackEntry(root, revision, 'snapshot.json', (buffer) => {
    const snapshot = JSON.parse(buffer.toString('utf8'));
    snapshot.boardId = boardId;
    return Buffer.from(JSON.stringify(snapshot, null, 2));
  });
  await repackManifest(root, revision, (manifest) => ({ ...manifest, boardId }));
}

async function captureThrow(run, label = 'call') {
  try {
    await run();
  } catch (error) {
    return error;
  }
  assert.fail(`${label}: expected the call to throw`);
}

async function expectCode(run, code, label = 'call') {
  const error = await captureThrow(run, label);
  assert.equal(error.code, code, `${label}: expected ${code}, received ${error.code}: ${error.message}`);
  return error;
}

function runChild(script, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr });
    });
  });
}

function draftWithStrokes(count) {
  const points = Array.from({ length: count }, (_, index) => ({ x: index, y: index * 2 }));
  return makeDraft({
    pages: [
      {
        pageId: 'page-1',
        imageRef: 'img-1',
        strokes: [{ strokeId: 's-1', tool: 'pen', color: '#111111', width: 2, points }],
      },
    ],
  });
}

// ---------- 基本写入与重开 ----------

test('保存后可重开：快照、笔迹与合成题图附件都能取回', async (t) => {
  const root = await makeRoot(t);
  const saved = await saveArchive(root, makeDraft());
  assert.equal(saved.status, 'saved');
  assert.equal(saved.revision, 1);
  assert.equal(saved.previousRevision, null);
  assert.equal(saved.attachments[0].attachmentId, 'img-1');
  assert.equal(saved.attachments[0].bytes, syntheticPng().byteLength);

  const reopened = await openArchive(root, { includeAttachmentBytes: true });
  assert.equal(reopened.status, 'ok');
  assert.equal(reopened.revision, 1);
  assert.equal(reopened.isCurrentRevision, true);
  assert.equal(reopened.pages.length, 1);
  assert.equal(reopened.pages[0].imageRef, 'img-1');
  assert.deepEqual(reopened.pages[0].strokes[0].points, [{ x: 10, y: 20 }, { x: 30, y: 40 }]);
  assert.deepEqual(reopened.pages[0].strokes[0].strokeId, 's-1');
  assert.deepEqual(reopened.attachments[0].data, syntheticPng());
  assert.equal(reopened.attachments[0].sha256, sha256hex(syntheticPng()));
  assert.deepEqual(reopened.unreferencedRevisions, []);
  assert.deepEqual(reopened.stagingDirs, []);
  assert.ok(reopened.limitations.length > 0);

  assert.deepEqual((await fsp.readdir(root)).sort(), ['archive.json', 'revisions']);
  assert.deepEqual(await fsp.readdir(path.join(root, 'revisions')), ['r-00000001']);
  assert.deepEqual(
    (await fsp.readdir(revisionDir(root, 1))).sort(),
    ['attachments', 'manifest.json', 'snapshot.json'],
  );
  const pointer = await readJson(path.join(root, 'archive.json'));
  assert.equal(pointer.currentRevision, 1);
  assert.equal(pointer.boardId, 'board-1');
  assert.equal(pointer.schemaVersion, LIMITS.schemaVersion);
  // 读路径不加锁、不留下锁文件
  await assert.rejects(fsp.access(path.join(root, 'archive.lock')));
});

test('重开后编辑再保存：产生新修订，旧修订保持原样不被静默改写', async (t) => {
  const root = await makeRoot(t);
  await saveArchive(root, makeDraft());
  const snapshotBefore = await fsp.readFile(path.join(revisionDir(root, 1), 'snapshot.json'));

  const reopened = await openArchive(root);
  const edited = {
    ...makeDraft({ title: '重开后再编辑' }),
    pages: [
      ...reopened.pages,
      {
        pageId: 'page-2',
        imageRef: 'img-2',
        transform: { rotationDegrees: 90, scale: 1.5, translateX: 4, translateY: -6 },
        strokes: [{ strokeId: 's-2', tool: 'highlighter', color: '#ffcc00', width: 8, points: [{ x: 5, y: 5 }] }],
      },
    ],
    attachments: [
      ...makeDraft().attachments,
      { attachmentId: 'img-2', kind: 'problem-image', mediaType: 'image/jpeg', bytes: onePixelJpeg() },
    ],
  };
  const saved = await saveArchive(root, edited);
  assert.equal(saved.revision, 2);
  assert.equal(saved.previousRevision, 1);

  assert.deepEqual(await fsp.readFile(path.join(revisionDir(root, 1), 'snapshot.json')), snapshotBefore);
  const second = await openArchive(root, { includeAttachmentBytes: true });
  assert.equal(second.revision, 2);
  assert.equal(second.title, '重开后再编辑');
  assert.equal(second.pages.length, 2);
  assert.deepEqual(second.pages[1].transform, { rotationDegrees: 90, scale: 1.5, translateX: 4, translateY: -6 });
  assert.deepEqual(second.attachments.map((attachment) => attachment.attachmentId), ['img-1', 'img-2']);
  assert.deepEqual(second.attachments[1].data, onePixelJpeg());
  assert.deepEqual(second.attachments[1].data.subarray(0, 3), Buffer.from([0xff, 0xd8, 0xff]));
  assert.deepEqual(second.attachments[0].data, onePixelPng());
  assert.deepEqual((await fsp.readdir(path.join(root, 'revisions'))).sort(), ['r-00000001', 'r-00000002']);
});

test('多次保存：指针显式记录上一完整修订，历史修订不被自动删除', async (t) => {
  const root = await makeRoot(t);
  for (let index = 1; index <= 5; index += 1) {
    const saved = await saveArchive(root, draftWithStrokes(index));
    assert.equal(saved.revision, index);
    assert.equal(saved.previousRevision, index === 1 ? null : index - 1);
  }
  // PoC 没有保留数量策略，也没有自动清理：5 个修订全部留在磁盘上。
  assert.deepEqual(
    (await fsp.readdir(path.join(root, 'revisions'))).sort(),
    ['r-00000001', 'r-00000002', 'r-00000003', 'r-00000004', 'r-00000005'],
  );
  const pointer = await readJson(path.join(root, 'archive.json'));
  assert.equal(pointer.currentRevision, 5);
  assert.equal(pointer.previousRevision, 4);
  assert.equal(pointer.revisions, undefined, '指针不再携带修订窗口');

  const current = await openArchive(root);
  assert.equal(current.revision, 5);
  assert.equal(current.isCurrentRevision, true);
  assert.equal(current.pages[0].strokes[0].points.length, 5);
  assert.deepEqual(current.unreferencedRevisions, [1, 2, 3]);

  // 显式读取上一完整修订：只读，不改指针，也不把旧版本冒充成当前版本。
  const previous = await openArchive(root, { revision: 4, includeAttachmentBytes: true });
  assert.equal(previous.status, 'ok');
  assert.equal(previous.revision, 4);
  assert.equal(previous.requestedRevision, 4);
  assert.equal(previous.isCurrentRevision, false);
  assert.equal(previous.pointerRevision, 5);
  assert.equal(previous.pages[0].strokes[0].points.length, 4);
  assert.deepEqual(previous.attachments[0].data, onePixelPng());
  assert.equal((await readJson(path.join(root, 'archive.json'))).currentRevision, 5);

  // 指针未引用的更早修订不会被当作可读版本。
  await expectCode(() => openArchive(root, { revision: 3 }), ERROR_CODES.NOT_FOUND, '未引用的修订');
});

// ---------- 失败与崩溃保旧 ----------

test('失败保旧：提交前失败不移动指针，仍可打开最近完整版本', async (t) => {
  const root = await makeRoot(t);
  await saveArchive(root, makeDraft());
  const pointerBefore = await fsp.readFile(path.join(root, 'archive.json'));
  const snapshotBefore = await fsp.readFile(path.join(revisionDir(root, 1), 'snapshot.json'));

  const error = await captureThrow(() =>
    saveArchive(root, makeDraft({ title: '不应提交' }), {
      faults: { afterStagingWritten: () => { throw new Error('注入：暂存后磁盘写入失败'); } },
    }),
  );
  assert.equal(error.message, '注入：暂存后磁盘写入失败');
  assert.deepEqual(await fsp.readFile(path.join(root, 'archive.json')), pointerBefore);
  assert.deepEqual(await fsp.readFile(path.join(revisionDir(root, 1), 'snapshot.json')), snapshotBefore);
  assert.deepEqual(await fsp.readdir(path.join(root, 'revisions')), ['r-00000001']);

  const reopened = await openArchive(root);
  assert.equal(reopened.status, 'ok');
  assert.equal(reopened.revision, 1);
  assert.equal(reopened.title, '合成题图练习');
  assert.deepEqual(reopened.stagingDirs, []);
  assert.deepEqual(reopened.unreferencedRevisions, []);
});

test('失败保旧：修订已重命名但指针写入失败时，旧指针与旧修订保持可用', async (t) => {
  const root = await makeRoot(t);
  await saveArchive(root, makeDraft());
  const pointerBefore = await fsp.readFile(path.join(root, 'archive.json'));

  const error = await captureThrow(() =>
    saveArchive(root, makeDraft({ title: '半提交' }), {
      faults: { afterRevisionRenamed: () => { throw new Error('注入：指针提交前中断'); } },
    }),
  );
  assert.equal(error.message, '注入：指针提交前中断');
  assert.deepEqual(await fsp.readFile(path.join(root, 'archive.json')), pointerBefore);
  const stillOld = await openArchive(root);
  assert.equal(stillOld.revision, 1);
  assert.equal(stillOld.title, '合成题图练习');
  assert.deepEqual(await fsp.readdir(path.join(root, 'revisions')), ['r-00000001']);

  const retried = await saveArchive(root, makeDraft({ title: '重试成功' }));
  assert.equal(retried.revision, 2);
  assert.equal((await openArchive(root)).title, '重试成功');
});

test('子进程崩溃：暂存中断不破坏指针，残留暂存目录只被如实报告', async (t) => {
  const root = await makeRoot(t);
  await saveArchive(root, makeDraft());
  const pointerBefore = await fsp.readFile(path.join(root, 'archive.json'));

  const child = await runChild(crashWriter, [root, 'after-staging-written', 'board-1']);
  assert.equal(child.code, 70, child.stderr);
  assert.deepEqual(await fsp.readFile(path.join(root, 'archive.json')), pointerBefore);

  const afterCrash = await openArchive(root);
  assert.equal(afterCrash.status, 'ok');
  assert.equal(afterCrash.revision, 1);
  assert.equal(afterCrash.stagingDirs.length, 1, '崩溃残留的暂存目录应被如实报告');
  assert.deepEqual(afterCrash.unreferencedRevisions, []);

  // 崩溃进程没有机会释放锁；PoC 不自动回收，必须先由调用方确认无写者并手动删除。
  const lockPath = path.join(root, 'archive.lock');
  const busy = await expectCode(() => saveArchive(root, makeDraft()), ERROR_CODES.ARCHIVE_BUSY, '崩溃遗留锁');
  assert.equal(busy.details.reason, 'stale-lock');
  assert.ok(await fsp.stat(lockPath), '崩溃遗留锁必须保持原样');
  await fsp.rm(lockPath);

  const saved = await saveArchive(root, makeDraft({ title: '崩溃后继续编辑' }));
  assert.equal(saved.revision, 2);
  // PoC 不自动清理残留目录，也不让残留影响下一个修订号。
  const leftovers = (await fsp.readdir(path.join(root, 'revisions'))).filter((name) => name.startsWith('.staging-'));
  assert.deepEqual(leftovers, afterCrash.stagingDirs);
  const reopened = await openArchive(root);
  assert.equal(reopened.revision, 2);
  assert.equal(reopened.title, '崩溃后继续编辑');
  assert.deepEqual(reopened.stagingDirs, afterCrash.stagingDirs);
});

test('子进程崩溃：指针提交前中断留下未引用修订，不被冒充为当前版本', async (t) => {
  const root = await makeRoot(t);
  await saveArchive(root, makeDraft());
  const pointerBefore = await fsp.readFile(path.join(root, 'archive.json'));

  const child = await runChild(crashWriter, [root, 'after-revision-renamed', 'board-1']);
  assert.equal(child.code, 71, child.stderr);
  assert.deepEqual(await fsp.readFile(path.join(root, 'archive.json')), pointerBefore);
  assert.ok(await fsp.stat(revisionDir(root, 2)), '未确认的修订保留在磁盘等待显式清理');

  const reopened = await openArchive(root);
  assert.equal(reopened.status, 'ok');
  assert.equal(reopened.revision, 1);
  assert.equal(reopened.pointerRevision, 1);
  assert.deepEqual(reopened.unreferencedRevisions, [2]);
  // 未被指针引用的修订不会被静默当作当前版本读取。
  await expectCode(() => openArchive(root, { revision: 2 }), ERROR_CODES.NOT_FOUND, '未引用修订');

  // 崩溃写者的锁只能由调用方确认后手动移除；读路径不受影响。
  const lockPath = path.join(root, 'archive.lock');
  const busy = await expectCode(() => saveArchive(root, makeDraft()), ERROR_CODES.ARCHIVE_BUSY, '崩溃遗留锁');
  assert.equal(busy.details.reason, 'stale-lock');
  assert.ok(await fsp.stat(lockPath), '崩溃遗留锁必须保持原样');
  await fsp.rm(lockPath);

  // 下次保存把未引用修订当作已占用编号，产生新修订且不改写旧数据。
  const saved = await saveArchive(root, makeDraft({ title: '崩溃后继续' }));
  assert.equal(saved.revision, 3);
  assert.equal(saved.previousRevision, 1);
  assert.equal((await openArchive(root)).revision, 3);
});

test('单写者锁：未知/损坏/陈旧锁一律失败关闭，锁只能由持有者释放', async (t) => {
  const root = await makeRoot(t);
  await saveArchive(root, makeDraft());
  const lockPath = path.join(root, 'archive.lock');

  // 活写者：明确报忙。
  await writeJson(lockPath, { pid: process.pid, token: 'other-writer', startedAt: new Date().toISOString() });
  const busy = await expectCode(() => saveArchive(root, makeDraft()), ERROR_CODES.ARCHIVE_BUSY, '活写者');
  assert.equal(busy.details.reason, 'live-writer');
  assert.equal(busy.details.holder.pid, process.pid);

  // 刚创建、还没写入 JSON 的锁（两个写者抢锁时的真实窗口）：不可读即失败关闭，不猜测、不删除。
  await fsp.writeFile(lockPath, '');
  const empty = await expectCode(() => saveArchive(root, makeDraft()), ERROR_CODES.ARCHIVE_BUSY, '空锁文件');
  assert.equal(empty.details.reason, 'unreadable-lock');
  assert.equal(await fsp.readFile(lockPath, 'utf8'), '', '未知锁不得被删除或改写');

  for (const raw of ['{ not json', '"writer"', 'null']) {
    await fsp.writeFile(lockPath, raw);
    const broken = await expectCode(() => saveArchive(root, makeDraft()), ERROR_CODES.ARCHIVE_BUSY, '损坏锁 ' + raw);
    assert.equal(broken.details.reason, 'unreadable-lock');
    assert.equal(await fsp.readFile(lockPath, 'utf8'), raw, '损坏锁不得被删除或改写');
  }

  // 崩溃写者留下的陈旧锁：PoC 不自动回收，只如实报忙。
  await fsp.rm(lockPath);
  const child = await runChild(crashWriter, [root, 'stale-lock']);
  assert.equal(child.code, 0, child.stderr);
  const staleHolder = await readJson(lockPath);
  assert.notEqual(staleHolder.pid, process.pid);
  const stale = await expectCode(() => saveArchive(root, makeDraft()), ERROR_CODES.ARCHIVE_BUSY, '陈旧锁');
  assert.equal(stale.details.reason, 'stale-lock');
  assert.equal((await readJson(lockPath)).token, 'stale', '陈旧锁必须原样保留，等调用方确认后手动删除');

  // 调用方确认没有写者运行后手动删除锁，写入才恢复。
  await fsp.rm(lockPath);
  const saved = await saveArchive(root, makeDraft({ title: '显式清理锁后写入' }));
  assert.equal(saved.revision, 2);
  await assert.rejects(fsp.access(lockPath), '正常写入后应释放自己持有的锁');
});

test('单写者锁：释放前核实 token，不得删除期间被替换的锁', async (t) => {
  const root = await makeRoot(t);
  const lockPath = path.join(root, 'archive.lock');
  const replacement = { pid: process.pid, token: 'replacement-writer', startedAt: new Date().toISOString() };

  const error = await captureThrow(() =>
    saveArchive(root, makeDraft(), {
      faults: {
        afterStagingWritten: async () => {
          await writeJson(lockPath, replacement);
          throw new Error('注入：锁文件在保存期间被替换');
        },
      },
    }),
  );
  assert.equal(error.message, '注入：锁文件在保存期间被替换');
  assert.deepEqual(await readJson(lockPath), replacement, '释放锁时 token 不符必须原样保留替代锁');
});

// ---------- 损坏、缺失与未来版本 ----------

test('附件损坏：拒绝重开、不覆盖原件，可回退到最近完整版本', async (t) => {
  const root = await makeRoot(t);
  await saveArchive(root, makeDraft());
  await saveArchive(root, makeDraft({ title: '第二次保存' }));
  const attachmentPath = path.join(revisionDir(root, 2), 'attachments', 'img-1.png');
  const corrupted = await fsp.readFile(attachmentPath);
  corrupted[corrupted.length - 1] ^= 0xff;
  await fsp.writeFile(attachmentPath, corrupted);

  const error = await expectCode(() => openArchive(root), ERROR_CODES.CORRUPT_ARCHIVE);
  assert.equal(error.details.revision, 2);
  assert.equal(error.details.path, 'attachments/img-1.png');
  assert.deepEqual(await fsp.readFile(attachmentPath), corrupted, '损坏原件不得被覆盖或删除');

  const recovered = await openArchive(root, { recover: true });
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.revision, 1);
  assert.equal(recovered.pointerRevision, 2);
  assert.equal(recovered.isCurrentRevision, false);
  assert.deepEqual(recovered.issues.map((issue) => issue.code), [ERROR_CODES.CORRUPT_ARCHIVE]);
  assert.equal((await readJson(path.join(root, 'archive.json'))).currentRevision, 2, '恢复读取不改写指针');
});

test('附件缺失：拒绝重开并指出缺失路径', async (t) => {
  const root = await makeRoot(t);
  await saveArchive(root, makeDraft());
  await saveArchive(root, makeDraft({ title: '第二次保存' }));
  await fsp.rm(path.join(revisionDir(root, 2), 'attachments', 'img-1.png'));

  const error = await expectCode(() => openArchive(root), ERROR_CODES.MISSING_ATTACHMENT);
  assert.equal(error.details.revision, 2);
  assert.equal(error.details.path, 'attachments/img-1.png');
  const recovered = await openArchive(root, { recover: true });
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.revision, 1);
  assert.deepEqual(recovered.issues.map((issue) => issue.code), [ERROR_CODES.MISSING_ATTACHMENT]);
});

test('不完整附件：快照引用或清单多出附件时拒绝重开', async (t) => {
  const root = await makeRoot(t);
  await saveArchive(root, makeDraft());

  await repackEntry(root, 1, 'snapshot.json', (buffer) => {
    const snapshot = JSON.parse(buffer.toString('utf8'));
    snapshot.pages[0].imageRef = 'img-ghost';
    return Buffer.from(JSON.stringify(snapshot, null, 2));
  });
  const ghost = await expectCode(() => openArchive(root), ERROR_CODES.MISSING_ATTACHMENT);
  assert.equal(ghost.details.imageRef, 'img-ghost');

  await repackEntry(root, 1, 'snapshot.json', (buffer) => {
    const snapshot = JSON.parse(buffer.toString('utf8'));
    snapshot.pages[0].imageRef = 'img-1';
    return Buffer.from(JSON.stringify(snapshot, null, 2));
  });
  await addOrphanManifestAttachment(root, 1, 'img-extra');
  const orphan = await expectCode(() => openArchive(root), ERROR_CODES.CORRUPT_ARCHIVE);
  assert.deepEqual(orphan.details.attachmentIds, ['img-extra']);
});

test('未来版本：指针、清单或快照 schemaVersion 过高时拒绝且不改动数据', async (t) => {
  const root = await makeRoot(t);
  await saveArchive(root, makeDraft());
  const pointerPath = path.join(root, 'archive.json');
  const pointer = await readJson(pointerPath);

  await writeJson(pointerPath, { ...pointer, schemaVersion: 2 });
  const pointerError = await expectCode(() => openArchive(root), ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION);
  assert.equal(pointerError.details.schemaVersion, 2);
  await expectCode(() => saveArchive(root, makeDraft()), ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION);
  assert.equal((await readJson(pointerPath)).schemaVersion, 2, '未来版本数据不得被覆盖');
  await writeJson(pointerPath, pointer);

  await repackManifest(root, 1, (manifest) => ({ ...manifest, schemaVersion: 2 }));
  await expectCode(() => openArchive(root), ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION);
  await repackManifest(root, 1, (manifest) => ({ ...manifest, schemaVersion: 1 }));

  await repackEntry(root, 1, 'snapshot.json', (buffer) => {
    const snapshot = JSON.parse(buffer.toString('utf8'));
    snapshot.schemaVersion = 2;
    return Buffer.from(JSON.stringify(snapshot, null, 2));
  });
  await expectCode(() => openArchive(root, { recover: true }), ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION);
  assert.equal((await readJson(pointerPath)).currentRevision, 1);
});

test('saveArchive 守卫可恢复引用：当前修订损坏或未来 schema 时拒绝推进指针', async (t) => {
  // 当前修订字节损坏：不能把 pointer.previousRevision 改成损坏修订，丢掉仍可用的上一完整版本。
  const corruptRoot = await makeRoot(t);
  await saveArchive(corruptRoot, makeDraft({ title: '完整版本 1' }));
  await saveArchive(corruptRoot, makeDraft({ title: '完整版本 2' }));
  const corruptPointerPath = path.join(corruptRoot, 'archive.json');
  const corruptPointerBefore = await fsp.readFile(corruptPointerPath);
  const corruptedAttachment = path.join(revisionDir(corruptRoot, 2), 'attachments', 'img-1.png');
  const corruptedBytes = await fsp.readFile(corruptedAttachment);
  corruptedBytes[corruptedBytes.length - 1] ^= 0xff;
  await fsp.writeFile(corruptedAttachment, corruptedBytes);

  const corruptError = await expectCode(
    () => saveArchive(corruptRoot, makeDraft({ title: '不应提交' })),
    ERROR_CODES.CORRUPT_ARCHIVE,
    '当前修订损坏',
  );
  assert.equal(corruptError.details.revision, 2);
  assert.deepEqual(await fsp.readFile(corruptPointerPath), corruptPointerBefore, '拒绝推进时指针必须原样保留');
  const recoveredFromCorruption = await openArchive(corruptRoot, { recover: true });
  assert.equal(recoveredFromCorruption.status, 'recovered');
  assert.equal(recoveredFromCorruption.revision, 1);
  assert.deepEqual(recoveredFromCorruption.issues.map((issue) => issue.code), [ERROR_CODES.CORRUPT_ARCHIVE]);

  // 当前快照是未来 schema：同样必须拒绝推进 pointer，保留 currentRevision/previousRevision 两个显式引用。
  const futureRoot = await makeRoot(t);
  await saveArchive(futureRoot, makeDraft({ title: '完整版本 1' }));
  await saveArchive(futureRoot, makeDraft({ title: '完整版本 2' }));
  const futurePointerPath = path.join(futureRoot, 'archive.json');
  const futurePointerBefore = await fsp.readFile(futurePointerPath);
  await repackEntry(futureRoot, 2, 'snapshot.json', (buffer) => {
    const snapshot = JSON.parse(buffer.toString('utf8'));
    snapshot.schemaVersion = LIMITS.schemaVersion + 1;
    return Buffer.from(JSON.stringify(snapshot, null, 2));
  });

  const futureError = await expectCode(
    () => saveArchive(futureRoot, makeDraft({ title: '不应提交' })),
    ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
    '当前修订未来 schema',
  );
  assert.equal(futureError.details.schemaVersion, LIMITS.schemaVersion + 1);
  assert.deepEqual(await fsp.readFile(futurePointerPath), futurePointerBefore, '未来 schema 不得触发指针推进');
  assert.equal((await readJson(futurePointerPath)).currentRevision, 2);
  assert.equal((await readJson(futurePointerPath)).previousRevision, 1);

  // manifest 自己是未来 schema 时，同样不能把当前修订从可恢复引用里换掉。
  const manifestRoot = await makeRoot(t);
  await saveArchive(manifestRoot, makeDraft({ title: '完整版本 1' }));
  await saveArchive(manifestRoot, makeDraft({ title: '完整版本 2' }));
  const manifestPointerPath = path.join(manifestRoot, 'archive.json');
  const manifestPointerBefore = await fsp.readFile(manifestPointerPath);
  await repackManifest(manifestRoot, 2, (manifest) => ({ ...manifest, schemaVersion: LIMITS.schemaVersion + 1 }));
  const manifestError = await expectCode(
    () => saveArchive(manifestRoot, makeDraft({ title: '不应提交' })),
    ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION,
    '当前 manifest 未来 schema',
  );
  assert.equal(manifestError.details.revision, 2);
  assert.deepEqual(await fsp.readFile(manifestPointerPath), manifestPointerBefore, '未来 manifest 不得触发指针推进');
});

test('boardId 一致性：直接打开与恢复都要求修订与 pointer.boardId 一致', async (t) => {
  const root = await makeRoot(t);
  await saveArchive(root, makeDraft({ title: '完整版本 1' }));
  await saveArchive(root, makeDraft({ title: '完整版本 2' }));

  // 当前修订的 manifest/snapshot 一起改成 board-2：修订内部自洽，但与 pointer.boardId 不一致。
  await rewriteRevisionBoardId(root, 2, 'board-2');
  const direct = await expectCode(() => openArchive(root), ERROR_CODES.CORRUPT_ARCHIVE, '当前修订 boardId 不一致');
  assert.equal(direct.details.revision, 2);
  assert.equal(direct.details.expected, 'board-1');
  assert.equal(direct.details.received, 'board-2');

  // 恢复路径同样核对 pointer.boardId：当前修订不一致时只能回退到上一完整修订。
  const recovered = await openArchive(root, { recover: true });
  assert.equal(recovered.status, 'recovered');
  assert.equal(recovered.revision, 1);
  assert.equal(recovered.boardId, 'board-1');
  assert.deepEqual(recovered.issues.map((issue) => issue.code), [ERROR_CODES.CORRUPT_ARCHIVE]);

  // 若被引用的两个修订都不匹配 pointer.boardId，恢复也不能返回带错误 boardId 的数据。
  await rewriteRevisionBoardId(root, 1, 'board-2');
  const noComplete = await expectCode(
    () => openArchive(root, { recover: true }),
    ERROR_CODES.CORRUPT_ARCHIVE,
    '恢复路径 boardId 不一致',
  );
  assert.equal(noComplete.details.pointerRevision, 2);
  assert.deepEqual(
    noComplete.details.issues.map((issue) => issue.code),
    [ERROR_CODES.CORRUPT_ARCHIVE, ERROR_CODES.CORRUPT_ARCHIVE],
  );
});

// ---------- 非法输入与限制 ----------

test('非法输入：在写入前拒绝，且不留下归档文件', async (t) => {
  const root = await makeRoot(t);
  const tooManyAttachments = Array.from({ length: LIMITS.maxAttachmentsPerRevision + 1 }, (_, index) => ({
    attachmentId: `img-${index}`,
    kind: 'problem-image',
    mediaType: 'image/png',
    bytes: syntheticPng(1, 8),
  }));
  const toolongPoints = Array.from({ length: LIMITS.maxPointsPerStroke + 1 }, (_, index) => ({ x: index, y: index }));
  const cases = [
    ['draft 不是对象', () => saveArchive(root, null), ERROR_CODES.INVALID_INPUT],
    ['boardId 含路径字符', () => saveArchive(root, makeDraft({ boardId: '../evil' })), ERROR_CODES.INVALID_INPUT],
    ['boardId 过长', () => saveArchive(root, makeDraft({ boardId: 'b'.repeat(65) })), ERROR_CODES.INVALID_INPUT],
    ['title 过长', () => saveArchive(root, makeDraft({ title: 't'.repeat(LIMITS.maxTitleLength + 1) })), ERROR_CODES.INVALID_INPUT],
    ['pages 为空', () => saveArchive(root, makeDraft({ pages: [] })), ERROR_CODES.INVALID_INPUT],
    ['pages 不是数组', () => saveArchive(root, makeDraft({ pages: 'page-1' })), ERROR_CODES.INVALID_INPUT],
    [
      '笔迹工具未知',
      () => saveArchive(root, makeDraft({ pages: [{ pageId: 'page-1', strokes: [{ strokeId: 's-1', tool: 'spray', points: [{ x: 1, y: 1 }] }] }] })),
      ERROR_CODES.INVALID_INPUT,
    ],
    [
      '笔迹宽度为 0',
      () => saveArchive(root, makeDraft({ pages: [{ pageId: 'page-1', strokes: [{ strokeId: 's-1', width: 0, points: [{ x: 1, y: 1 }] }] }] })),
      ERROR_CODES.INVALID_INPUT,
    ],
    [
      '坐标不是有限数字',
      () => saveArchive(root, makeDraft({ pages: [{ pageId: 'page-1', strokes: [{ strokeId: 's-1', points: [{ x: Number.NaN, y: 1 }] }] }] })),
      ERROR_CODES.INVALID_INPUT,
    ],
    [
      '坐标超出上限',
      () => saveArchive(root, makeDraft({ pages: [{ pageId: 'page-1', strokes: [{ strokeId: 's-1', points: [{ x: LIMITS.maxCoordinate + 1, y: 1 }] }] }] })),
      ERROR_CODES.INVALID_INPUT,
    ],
    ['附件 id 含路径分隔', () => saveArchive(root, makeDraft({ attachments: [{ attachmentId: '../evil', kind: 'problem-image', mediaType: 'image/png', bytes: syntheticPng() }] })), ERROR_CODES.INVALID_INPUT],
    ['附件 id 重复', () => saveArchive(root, makeDraft({ attachments: [...makeDraft().attachments, ...makeDraft().attachments] })), ERROR_CODES.INVALID_INPUT],
    ['附件媒体类型不支持', () => saveArchive(root, makeDraft({ attachments: [{ attachmentId: 'img-1', kind: 'problem-image', mediaType: 'image/gif', bytes: syntheticPng() }] })), ERROR_CODES.INVALID_INPUT],
    ['附件字节为空', () => saveArchive(root, makeDraft({ attachments: [{ attachmentId: 'img-1', kind: 'problem-image', mediaType: 'image/png', bytes: Buffer.alloc(0) }] })), ERROR_CODES.INVALID_INPUT],
    ['附件传入的是路径字符串', () => saveArchive(root, makeDraft({ attachments: [{ attachmentId: 'img-1', kind: 'problem-image', mediaType: 'image/png', bytes: '/etc/hosts' }] })), ERROR_CODES.INVALID_INPUT],
    ['附件超过单个大小上限', () => saveArchive(root, makeDraft({ attachments: [{ attachmentId: 'img-1', kind: 'problem-image', mediaType: 'image/png', bytes: Buffer.alloc(LIMITS.maxAttachmentBytes + 1, 1) }] })), ERROR_CODES.LIMIT_EXCEEDED],
    ['附件数量超限', () => saveArchive(root, makeDraft({ pages: [{ pageId: 'page-1', strokes: [] }], attachments: tooManyAttachments })), ERROR_CODES.LIMIT_EXCEEDED],
    ['笔迹点数超限', () => saveArchive(root, makeDraft({ pages: [{ pageId: 'page-1', strokes: [{ strokeId: 's-1', tool: 'pen', points: toolongPoints }] }] })), ERROR_CODES.LIMIT_EXCEEDED],
    [
      '快照引用未提供的附件',
      () => saveArchive(root, makeDraft({ pages: [{ pageId: 'page-1', imageRef: 'img-missing', strokes: [] }] })),
      ERROR_CODES.MISSING_ATTACHMENT,
    ],
    ['openArchive revision 为 0', () => openArchive(root, { revision: 0 }), ERROR_CODES.INVALID_INPUT],
    ['openArchive revision 非整数', () => openArchive(root, { revision: 1.5 }), ERROR_CODES.INVALID_INPUT],
    ['saveArchive faults 不是对象', () => saveArchive(root, makeDraft(), { faults: 'nope' }), ERROR_CODES.INVALID_INPUT],
    ['saveArchive now 不是函数', () => saveArchive(root, makeDraft(), { now: 'later' }), ERROR_CODES.INVALID_INPUT],
    [
      '附件字节与声明的媒体类型不符',
      () => saveArchive(root, makeDraft({ attachments: [{ attachmentId: 'img-1', kind: 'problem-image', mediaType: 'image/png', bytes: Buffer.from('not a png at all') }] })),
      ERROR_CODES.INVALID_INPUT,
    ],
  ];
  for (const [label, run, code] of cases) {
    await expectCode(run, code, label);
  }
  assert.deepEqual(await fsp.readdir(root), [], '非法输入不得留下归档文件或暂存目录');
});

test('资源限制：快照超过字节预算时拒绝且不落盘', async (t) => {
  const root = await makeRoot(t);
  const points = Array.from({ length: LIMITS.maxPointsPerStroke }, (_, index) => ({
    x: 999999.5 - index,
    y: -999999.25 + index,
  }));
  const error = await expectCode(
    () =>
      saveArchive(
        root,
        makeDraft({ pages: [{ pageId: 'page-1', strokes: [{ strokeId: 's-1', tool: 'pen', points }] }] }),
      ),
    ERROR_CODES.LIMIT_EXCEEDED,
  );
  assert.ok(error.message.includes('maxSnapshotBytes'), error.message);
  const leftovers = (await fsp.readdir(root)).filter((name) => name !== 'revisions');
  assert.deepEqual(leftovers, [], '失败后不得留下指针或临时文件');
  assert.deepEqual(await fsp.readdir(path.join(root, 'revisions')), [], '失败后不得留下暂存目录');
});

test('路径限制：拒绝相对路径、根目录、家目录、文件与符号链接', async (t) => {
  const root = await makeRoot(t);
  await assertArchiveRoot(root, { create: false });
  await expectCode(() => saveArchive('relative/archive', makeDraft()), ERROR_CODES.INVALID_INPUT);
  await expectCode(() => saveArchive(path.parse(root).root, makeDraft()), ERROR_CODES.UNSAFE_PATH);
  await expectCode(() => saveArchive(os.homedir(), makeDraft()), ERROR_CODES.UNSAFE_PATH);
  await expectCode(() => openArchive(path.join(root, 'missing', 'nested', 'archive')), ERROR_CODES.NOT_FOUND);

  // 允许在两层以上的新目录下创建归档，但不越出调用方指定的根。
  const nested = path.join(root, 'nested', 'archive');
  const nestedSaved = await saveArchive(nested, makeDraft());
  assert.equal(nestedSaved.revision, 1);
  assert.equal((await openArchive(nested)).revision, 1);
  assert.deepEqual(await fsp.readdir(root), ['nested'], '被拒绝的根目录不得留下归档文件');

  const filePath = path.join(await makeRoot(t), 'not-a-directory');
  await fsp.writeFile(filePath, 'x');
  await expectCode(() => saveArchive(filePath, makeDraft()), ERROR_CODES.UNSAFE_PATH);
  await expectCode(() => openArchive(filePath), ERROR_CODES.UNSAFE_PATH);

  const target = path.join(await makeRoot(t), 'real-root');
  await fsp.mkdir(target);
  const linkPath = path.join(await makeRoot(t), 'linked-root');
  await fsp.symlink(target, linkPath, 'dir');
  await expectCode(() => saveArchive(linkPath, makeDraft()), ERROR_CODES.UNSAFE_PATH);

  await expectCode(() => openArchive(path.join(root, 'absent-archive')), ERROR_CODES.NOT_FOUND);
});

test('路径限制：清单越界路径与符号链接附件被拒绝', async (t) => {
  const root = await makeRoot(t);
  await saveArchive(root, makeDraft());
  await repackManifest(root, 1, (manifest) => ({
    ...manifest,
    files: [
      ...manifest.files,
      { path: '../escape.png', bytes: 16, sha256: 'a'.repeat(64), attachmentId: 'img-escape', kind: 'problem-image', mediaType: 'image/png' },
    ],
  }));
  const escape = await expectCode(() => openArchive(root), ERROR_CODES.UNSAFE_PATH);
  assert.equal(escape.details.path, '../escape.png');

  await repackManifest(root, 1, (manifest) => ({
    ...manifest,
    files: manifest.files.filter((file) => file.path !== '../escape.png'),
  }));
  assert.equal((await openArchive(root)).status, 'ok');

  const attachmentPath = path.join(revisionDir(root, 1), 'attachments', 'img-1.png');
  await fsp.rm(attachmentPath);
  await fsp.symlink('/etc/hosts', attachmentPath);
  await expectCode(() => openArchive(root), ERROR_CODES.UNSAFE_PATH);
});

test('路径限制：revisions 与 attachments 父目录为符号链接时拒绝', async (t) => {
  const root = await makeRoot(t);
  await saveArchive(root, makeDraft());

  // attachments/ 是父目录符号链接，即使末端 img-1.png 是普通文件也不能读取。
  const attachmentsDir = path.join(revisionDir(root, 1), 'attachments');
  const realAttachments = path.join(root, 'real-attachments');
  await fsp.rename(attachmentsDir, realAttachments);
  await fsp.symlink(realAttachments, attachmentsDir, 'dir');
  const attachmentOpen = await expectCode(
    () => openArchive(root),
    ERROR_CODES.UNSAFE_PATH,
    'attachments 父目录符号链接',
  );
  assert.match(attachmentOpen.message, /real directory/);
  const attachmentSave = await expectCode(
    () => saveArchive(root, makeDraft({ title: '不应穿透 attachments 符号链接' })),
    ERROR_CODES.UNSAFE_PATH,
    'save 拒绝 attachments 父目录符号链接',
  );
  assert.match(attachmentSave.message, /real directory/);
  assert.deepEqual(
    (await fsp.readdir(realAttachments)).sort(),
    ['img-1.png'],
    '保存不得穿透 attachments 符号链接写入外部目录',
  );

  // 还原 attachments 后，再验证 revisions/ 父目录符号链接同样被拒绝。
  await fsp.rm(attachmentsDir);
  await fsp.rename(realAttachments, attachmentsDir);
  assert.equal((await openArchive(root)).status, 'ok');

  const revisionsDirPath = path.join(root, 'revisions');
  const realRevisions = path.join(root, 'real-revisions');
  await fsp.rename(revisionsDirPath, realRevisions);
  await fsp.symlink(realRevisions, revisionsDirPath, 'dir');
  const revisionsOpen = await expectCode(
    () => openArchive(root),
    ERROR_CODES.UNSAFE_PATH,
    'revisions 父目录符号链接',
  );
  assert.match(revisionsOpen.message, /real directory/);
  const revisionsSave = await expectCode(
    () => saveArchive(root, makeDraft({ title: '不应穿透 revisions 符号链接' })),
    ERROR_CODES.UNSAFE_PATH,
    'save 拒绝 revisions 父目录符号链接',
  );
  assert.match(revisionsSave.message, /real directory/);
  assert.deepEqual(await fsp.readdir(realRevisions), ['r-00000001'], '不得穿透 revisions 符号链接写入外部目录');
});

// ---------- 跨进程重开 ----------

test('跨进程重开：独立 Node 进程读取同一归档并核对修订与附件哈希', async (t) => {
  const root = await makeRoot(t);
  const saved = await saveArchive(root, makeDraft({ title: '跨进程核对' }));
  const child = await runChild(reopenReader, [root]);
  assert.equal(child.code, 0, child.stderr);
  const summary = JSON.parse(child.stdout);
  assert.equal(summary.status, 'ok');
  assert.equal(summary.boardId, 'board-1');
  assert.equal(summary.revision, saved.revision);
  assert.equal(summary.pointerRevision, saved.revision);
  assert.equal(summary.pages, 1);
  assert.equal(summary.strokeCount, 1);
  assert.deepEqual(summary.attachments, [
    { attachmentId: 'img-1', bytes: syntheticPng().byteLength, sha256: sha256hex(syntheticPng()) },
  ]);
  assert.deepEqual(summary.unreferencedRevisions, []);
  assert.deepEqual(summary.stagingDirs, []);
});

test('跨进程重开：唯一修订损坏时独立进程如实报告失败', async (t) => {
  const root = await makeRoot(t);
  await saveArchive(root, makeDraft());
  const attachmentPath = path.join(revisionDir(root, 1), 'attachments', 'img-1.png');
  const corrupted = await fsp.readFile(attachmentPath);
  corrupted[0] ^= 0xff;
  await fsp.writeFile(attachmentPath, corrupted);

  const child = await runChild(reopenReader, [root, '--recover']);
  assert.equal(child.code, 4);
  const summary = JSON.parse(child.stdout);
  assert.equal(summary.error, ERROR_CODES.CORRUPT_ARCHIVE);
});
