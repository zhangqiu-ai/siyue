// 隔离可行性 PoC（add-family-video-whiteboard 任务 2.4）：家庭视频白板的
// 「可编辑白板快照 + 合成题图附件」本地原子归档。覆盖 VWA-01/VWA-02 的存储侧。
//
// 边界：不接入应用、不读取真实家庭文件、不使用生产数据、不安装依赖、不做云同步。
// 范围克制：只有 saveArchive/openArchive 两个主接口，加路径与资源校验、故障注入；
// 不做修订自动清理与保留数量策略（O03 数据清理未定），不做全盘扫描或静默恢复。
// 已知限制见 POC_LIMITATIONS：单写者、未做移动端适配、附件只接受调用方传入的字节。

import { createHash, randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SUPPORTED_SCHEMA_VERSION = 1;

export const ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'invalid_input',
  UNSUPPORTED_SCHEMA_VERSION: 'unsupported_schema_version',
  CORRUPT_ARCHIVE: 'corrupt_archive',
  MISSING_ATTACHMENT: 'missing_attachment',
  ARCHIVE_BUSY: 'archive_busy',
  UNSAFE_PATH: 'unsafe_path',
  LIMIT_EXCEEDED: 'limit_exceeded',
  NOT_FOUND: 'not_found',
});

export class ArchiveError extends Error {
  constructor(code, message, details = null) {
    super(`${code}: ${message}`);
    this.name = 'ArchiveError';
    this.code = code;
    this.details = details;
  }
}

export const LIMITS = Object.freeze({
  schemaVersion: SUPPORTED_SCHEMA_VERSION,
  idPattern: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
  boardIdPattern: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
  mediaTypes: Object.freeze({ 'image/png': '.png', 'image/jpeg': '.jpg' }),
  allowedTools: Object.freeze(['pen', 'highlighter', 'eraser']),
  maxAttachmentsPerRevision: 8,
  maxAttachmentBytes: 2 * 1024 * 1024,
  maxSnapshotBytes: 256 * 1024,
  maxManifestBytes: 64 * 1024,
  maxPointerBytes: 64 * 1024,
  maxRevisionBytes: 8 * 1024 * 1024,
  maxPages: 50,
  maxStrokesPerPage: 2000,
  maxStrokes: 20000,
  maxPointsPerStroke: 10000,
  maxCoordinate: 1e6,
  maxStrokeWidth: 500,
  maxScale: 100,
  maxTitleLength: 200,
});

export const POC_LIMITATIONS = Object.freeze([
  'single-writer: 同一归档根同一时刻只允许一个写进程；锁只由持有 token 的写者释放，PoC 不回收陈旧锁',
  'stale-lock: 崩溃写者留下的 archive.lock 不会被自动回收（无法安全区分「刚创建还没写 JSON」的活锁），需调用方确认无写者后手动删除',
  'no-mobile-adaptation: 未验证 iPhone/iPad/Android 触摸、手写、文件权限、存储配额或后台中断',
  'synthetic-attachments-only: 附件必须由调用方以字节传入，PoC 不读相机、相册或任意文件路径',
  'no-sync: 不实现云备份、跨设备恢复或主存档接管，本机结果不等于云端副本',
  'no-cleanup: 不自动删除任何修订或崩溃残留的 .staging-* 目录；清理策略（O03）未定，PoC 只如实报告',
  'explicit-recovery: 回退只发生在调用方显式传 recover:true 时，结果 status 为 recovered 并带 issues，不改写指针',
]);

const POINTER_FILE = 'archive.json';
const MANIFEST_FILE = 'manifest.json';
const SNAPSHOT_FILE = 'snapshot.json';
const REVISIONS_DIR = 'revisions';
const LOCK_FILE = 'archive.lock';
const STAGING_PREFIX = '.staging-';
const POINTER_TMP_PREFIX = '.archive.json.';
const REVISION_DIR_PATTERN = /^r-(\d{8})$/;
const ATTACHMENT_REL_PATTERN = /^attachments\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.(png|jpg)$/;

// 只做文件头嗅探，不解码图片；目的是不让「伪 PNG 签名」或错配的字节混进归档。
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MEDIA_SIGNATURES = Object.freeze({
  'image/png': (bytes) => bytes.byteLength >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE),
  'image/jpeg': (bytes) => bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
});

// ---------- 基础工具 ----------

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function toIso(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new ArchiveError(ERROR_CODES.INVALID_INPUT, 'now() must return a valid Date');
  }
  return date.toISOString();
}

function revisionDirName(revision) {
  return `r-${String(revision).padStart(8, '0')}`;
}

function revisionsDir(root) {
  return path.join(root, REVISIONS_DIR);
}

function isInside(base, candidate) {
  const rel = path.relative(base, candidate);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

async function safeLstat(target) {
  try {
    return await fsp.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// 归档布局里的每一级目录都必须是真实目录：只检查末端文件挡不住「父目录是指向归档外部的符号链接」。
// 返回 null 表示不存在，由调用方决定是 not_found 还是 corrupt_archive。
async function lstatRealDirectory(target) {
  const stat = await safeLstat(target);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(ERROR_CODES.UNSAFE_PATH, 'archive layout requires a real directory (no symlinks)', { path: target });
  }
  return stat;
}

async function writeFileSynced(filePath, data) {
  const handle = await fsp.open(filePath, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDir(dir) {
  let handle = null;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES', 'EBADF', 'ENOSYS'].includes(error.code)) {
      throw error;
    }
  } finally {
    if (handle) await handle.close();
  }
}

function toBuffer(bytes, { label }) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  throw new ArchiveError(
    ERROR_CODES.INVALID_INPUT,
    `${label} must be a Buffer/Uint8Array; this PoC never reads file paths`,
  );
}

function fail(code, message, details) {
  throw new ArchiveError(code, message, details);
}

// ---------- 输入校验（调用方草稿） ----------

function normalizePoint(raw, context) {
  if (!isPlainObject(raw)) fail(ERROR_CODES.INVALID_INPUT, 'stroke point must be an object', context);
  const { x, y } = raw;
  for (const value of [x, y]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > LIMITS.maxCoordinate) {
      fail(ERROR_CODES.INVALID_INPUT, 'stroke point must hold finite coordinates within maxCoordinate', { ...context, x, y });
    }
  }
  return { x, y };
}

function normalizeTransform(raw, context) {
  if (raw === undefined || raw === null) {
    return { rotationDegrees: 0, scale: 1, translateX: 0, translateY: 0 };
  }
  if (!isPlainObject(raw)) fail(ERROR_CODES.INVALID_INPUT, 'page transform must be an object', context);
  const { rotationDegrees = 0, scale = 1, translateX = 0, translateY = 0 } = raw;
  for (const [name, value] of Object.entries({ rotationDegrees, scale, translateX, translateY })) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(ERROR_CODES.INVALID_INPUT, `page transform.${name} must be a finite number`, context);
    }
    if (name !== 'rotationDegrees' && Math.abs(value) > LIMITS.maxCoordinate) {
      fail(ERROR_CODES.INVALID_INPUT, `page transform.${name} exceeds maxCoordinate`, context);
    }
  }
  if (scale <= 0 || scale > LIMITS.maxScale) {
    fail(ERROR_CODES.INVALID_INPUT, 'page transform.scale must be within (0, maxScale]', context);
  }
  return { rotationDegrees, scale, translateX, translateY };
}

function normalizeStroke(raw, context) {
  if (!isPlainObject(raw)) fail(ERROR_CODES.INVALID_INPUT, 'stroke must be an object', context);
  const { strokeId, tool = 'pen', color = '#111111', width = 2, points } = raw;
  if (typeof strokeId !== 'string' || !LIMITS.idPattern.test(strokeId)) {
    fail(ERROR_CODES.INVALID_INPUT, 'strokeId must match idPattern', { ...context, strokeId });
  }
  if (!LIMITS.allowedTools.includes(tool)) {
    fail(ERROR_CODES.INVALID_INPUT, 'stroke tool is not supported', { ...context, tool });
  }
  if (typeof color !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(color)) {
    fail(ERROR_CODES.INVALID_INPUT, 'stroke color must be #rrggbb', { ...context, color });
  }
  if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0 || width > LIMITS.maxStrokeWidth) {
    fail(ERROR_CODES.INVALID_INPUT, 'stroke width is out of range', { ...context, width });
  }
  if (!Array.isArray(points) || points.length === 0 || points.length > LIMITS.maxPointsPerStroke) {
    fail(ERROR_CODES.LIMIT_EXCEEDED, 'stroke points must be a non-empty array within maxPointsPerStroke', context);
  }
  return { strokeId, tool, color, width, points: points.map((point) => normalizePoint(point, context)) };
}

function normalizePages(rawPages) {
  if (!Array.isArray(rawPages) || rawPages.length === 0 || rawPages.length > LIMITS.maxPages) {
    fail(ERROR_CODES.INVALID_INPUT, 'pages must be a non-empty array within maxPages', {
      pages: Array.isArray(rawPages) ? rawPages.length : typeof rawPages,
    });
  }
  let strokeTotal = 0;
  return rawPages.map((rawPage, index) => {
    if (!isPlainObject(rawPage)) fail(ERROR_CODES.INVALID_INPUT, 'page must be an object', { index });
    const { pageId, imageRef = null, strokes } = rawPage;
    if (typeof pageId !== 'string' || !LIMITS.idPattern.test(pageId)) {
      fail(ERROR_CODES.INVALID_INPUT, 'pageId must match idPattern', { index, pageId });
    }
    if (imageRef !== null && (typeof imageRef !== 'string' || !LIMITS.idPattern.test(imageRef))) {
      fail(ERROR_CODES.INVALID_INPUT, 'page imageRef must be null or match idPattern', { index, imageRef });
    }
    if (!Array.isArray(strokes)) fail(ERROR_CODES.INVALID_INPUT, 'page strokes must be an array', { index });
    if (strokes.length > LIMITS.maxStrokesPerPage) {
      fail(ERROR_CODES.LIMIT_EXCEEDED, 'page strokes exceed maxStrokesPerPage', { index, strokes: strokes.length });
    }
    strokeTotal += strokes.length;
    if (strokeTotal > LIMITS.maxStrokes) {
      fail(ERROR_CODES.LIMIT_EXCEEDED, 'document strokes exceed maxStrokes', { strokes: strokeTotal });
    }
    return {
      pageId,
      index,
      imageRef,
      transform: normalizeTransform(rawPage.transform, { index }),
      strokes: strokes.map((stroke) => normalizeStroke(stroke, { index })),
    };
  });
}

function normalizeAttachments(rawAttachments) {
  if (!Array.isArray(rawAttachments)) {
    fail(ERROR_CODES.INVALID_INPUT, 'attachments must be an array (possibly empty)');
  }
  if (rawAttachments.length > LIMITS.maxAttachmentsPerRevision) {
    fail(ERROR_CODES.LIMIT_EXCEEDED, 'too many attachments for one revision', {
      attachments: rawAttachments.length,
      max: LIMITS.maxAttachmentsPerRevision,
    });
  }
  const seen = new Set();
  return rawAttachments.map((raw) => {
    if (!isPlainObject(raw)) fail(ERROR_CODES.INVALID_INPUT, 'attachment must be an object');
    const { attachmentId, kind = 'problem-image', mediaType, bytes } = raw;
    if (typeof attachmentId !== 'string' || !LIMITS.idPattern.test(attachmentId)) {
      fail(ERROR_CODES.INVALID_INPUT, 'attachmentId must match idPattern', { attachmentId });
    }
    if (seen.has(attachmentId)) fail(ERROR_CODES.INVALID_INPUT, 'duplicate attachmentId', { attachmentId });
    seen.add(attachmentId);
    if (kind !== 'problem-image') {
      fail(ERROR_CODES.INVALID_INPUT, 'only synthetic problem-image attachments are supported in this PoC', { kind });
    }
    const extension = LIMITS.mediaTypes[mediaType];
    if (!extension) fail(ERROR_CODES.INVALID_INPUT, 'unsupported attachment mediaType', { mediaType });
    const buffer = toBuffer(bytes, { label: `attachment ${attachmentId} bytes` });
    if (buffer.byteLength === 0) fail(ERROR_CODES.INVALID_INPUT, 'attachment bytes must not be empty', { attachmentId });
    if (buffer.byteLength > LIMITS.maxAttachmentBytes) {
      fail(ERROR_CODES.LIMIT_EXCEEDED, 'attachment exceeds maxAttachmentBytes', {
        attachmentId,
        bytes: buffer.byteLength,
        max: LIMITS.maxAttachmentBytes,
      });
    }
    if (!MEDIA_SIGNATURES[mediaType](buffer)) {
      fail(ERROR_CODES.INVALID_INPUT, 'attachment bytes do not match the declared mediaType', { attachmentId, mediaType });
    }
    return { attachmentId, kind, mediaType, fileName: `${attachmentId}${extension}`, bytes: buffer };
  });
}

function normalizeDraft(draft) {
  if (!isPlainObject(draft)) fail(ERROR_CODES.INVALID_INPUT, 'draft must be an object');
  const { boardId, title = null } = draft;
  if (typeof boardId !== 'string' || !LIMITS.boardIdPattern.test(boardId)) {
    fail(ERROR_CODES.INVALID_INPUT, 'boardId must match boardIdPattern', { boardId });
  }
  if (title !== null && (typeof title !== 'string' || title.length > LIMITS.maxTitleLength)) {
    fail(ERROR_CODES.INVALID_INPUT, 'title must be null or a short string', { title });
  }
  const pages = normalizePages(draft.pages);
  const attachments = normalizeAttachments(draft.attachments ?? []);
  const byId = new Map(attachments.map((attachment) => [attachment.attachmentId, attachment]));
  for (const page of pages) {
    if (page.imageRef !== null && !byId.has(page.imageRef)) {
      fail(ERROR_CODES.MISSING_ATTACHMENT, 'page references an attachment that was not provided', {
        pageId: page.pageId,
        imageRef: page.imageRef,
      });
    }
  }
  return { boardId, title, pages, attachments };
}

// 读盘后的快照结构校验（与写入侧共用同一批约束）。
function validateSnapshotShape(snapshot, { boardId, revision }) {
  if (!isPlainObject(snapshot)) fail(ERROR_CODES.CORRUPT_ARCHIVE, 'snapshot.json must be an object');
  if (snapshot.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    fail(ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION, 'snapshot schemaVersion is not supported', {
      schemaVersion: snapshot.schemaVersion,
      supported: SUPPORTED_SCHEMA_VERSION,
    });
  }
  if (snapshot.boardId !== boardId) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'snapshot boardId does not match the archive pointer', {
      expected: boardId,
      received: snapshot.boardId,
    });
  }
  if (snapshot.revision !== revision) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'snapshot revision does not match its directory', {
      expected: revision,
      received: snapshot.revision,
    });
  }
  if (typeof snapshot.createdAt !== 'string' || Number.isNaN(Date.parse(snapshot.createdAt))) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'snapshot createdAt must be an ISO timestamp');
  }
  const pages = normalizePages(snapshot.pages);
  if (!Array.isArray(snapshot.attachments)) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'snapshot attachments must be an array');
  }
  const refs = new Map();
  for (const raw of snapshot.attachments) {
    if (!isPlainObject(raw)) fail(ERROR_CODES.CORRUPT_ARCHIVE, 'snapshot attachment must be an object');
    const { attachmentId, kind, mediaType, fileName } = raw;
    if (typeof attachmentId !== 'string' || !LIMITS.idPattern.test(attachmentId)) {
      fail(ERROR_CODES.CORRUPT_ARCHIVE, 'snapshot attachmentId must match idPattern', { attachmentId });
    }
    if (refs.has(attachmentId)) fail(ERROR_CODES.CORRUPT_ARCHIVE, 'duplicate snapshot attachmentId', { attachmentId });
    if (kind !== 'problem-image' || !LIMITS.mediaTypes[mediaType]) {
      fail(ERROR_CODES.CORRUPT_ARCHIVE, 'snapshot attachment kind/mediaType is unsupported', { attachmentId, kind, mediaType });
    }
    if (fileName !== `${attachmentId}${LIMITS.mediaTypes[mediaType]}`) {
      fail(ERROR_CODES.CORRUPT_ARCHIVE, 'snapshot attachment fileName is inconsistent', { attachmentId, fileName });
    }
    refs.set(attachmentId, raw);
  }
  for (const page of pages) {
    if (page.imageRef !== null && !refs.has(page.imageRef)) {
      fail(ERROR_CODES.MISSING_ATTACHMENT, 'page references an attachment that is not in this revision', {
        pageId: page.pageId,
        imageRef: page.imageRef,
      });
    }
  }
  return { pages, attachments: snapshot.attachments, title: snapshot.title ?? null };
}

// ---------- 归档根与路径限制 ----------

export async function assertArchiveRoot(root, { create = false } = {}) {
  if (typeof root !== 'string' || root.trim() === '') {
    fail(ERROR_CODES.INVALID_INPUT, 'root must be a non-empty absolute path');
  }
  if (!path.isAbsolute(root)) fail(ERROR_CODES.INVALID_INPUT, 'root must be absolute', { root });
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) {
    fail(ERROR_CODES.UNSAFE_PATH, 'refusing to archive directly at the filesystem root', { root: resolved });
  }
  const home = path.resolve(os.homedir());
  if (resolved === home) fail(ERROR_CODES.UNSAFE_PATH, 'refusing to archive directly at the home directory', { root: resolved });
  if (resolved.split(path.sep).filter(Boolean).length < 2) {
    fail(ERROR_CODES.UNSAFE_PATH, 'archive root must be at least two levels deep', { root: resolved });
  }
  const stat = await safeLstat(resolved);
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
    fail(ERROR_CODES.UNSAFE_PATH, 'archive root must be a real directory (not a symlink or file)', { root: resolved });
  }
  if (!stat) {
    if (!create) fail(ERROR_CODES.NOT_FOUND, 'archive root does not exist', { root: resolved });
    await fsp.mkdir(resolved, { recursive: true, mode: 0o700 });
    const created = await safeLstat(resolved);
    if (!created || created.isSymbolicLink() || !created.isDirectory()) {
      fail(ERROR_CODES.UNSAFE_PATH, 'archive root could not be created as a real directory', { root: resolved });
    }
  }
  return resolved;
}

// ---------- 单写者锁 ----------

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// 读取锁文件内容。状态分三种：absence（不存在）、unreadable（读不到/不是对象/不是 JSON）、parsed。
async function readLockState(lockPath) {
  let raw = null;
  try {
    raw = await fsp.readFile(lockPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'absent' };
    return { status: 'unreadable', reason: error.code };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'unreadable', reason: 'invalid-json' };
  }
  if (!isPlainObject(parsed)) return { status: 'unreadable', reason: 'not-an-object' };
  return { status: 'parsed', holder: parsed };
}

// 单写者锁。两块安全性质：
// 1) 只创建（O_EXCL），从不删除别人的锁：内容不可读/不可解析一律 fail closed 报 archive_busy，
//    因为「刚创建还没写入 JSON 的活锁」与「崩溃写者的陈旧锁」在文件内容上无法安全区分。
// 2) 释放前核实锁文件里仍是自己写入的 token，避免把别人的锁删掉。
// 代价：崩溃写者遗留的锁需要调用方确认无写者后手动删除，PoC 不做自动回收。
async function acquireLock(root) {
  const lockPath = path.join(root, LOCK_FILE);
  const token = randomUUID();
  try {
    const handle = await fsp.open(lockPath, 'wx', 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString(), task: 'video-whiteboard-poc' }),
      );
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const state = await readLockState(lockPath);
    const holder = state.status === 'parsed' ? state.holder : null;
    const reason = state.status === 'unreadable'
      ? 'unreadable-lock'
      : (isProcessAlive(holder.pid) ? 'live-writer' : 'stale-lock');
    fail(ERROR_CODES.ARCHIVE_BUSY, reason === 'stale-lock'
      ? 'archive is locked by a writer that is no longer running; this PoC never removes another writer lock'
      : 'archive is locked by another writer or by an unreadable lock file', { lockPath, reason, holder });
  }
  return {
    lockPath,
    token,
    release: async () => {
      const state = await readLockState(lockPath);
      if (state.status !== 'parsed' || state.holder.token !== token) return false;
      await fsp.rm(lockPath, { force: true });
      return true;
    },
  };
}

// ---------- 指针与修订发现 ----------

async function readPointer(root, { required = false } = {}) {
  const pointerPath = path.join(root, POINTER_FILE);
  const stat = await safeLstat(pointerPath);
  if (!stat) {
    if (required) fail(ERROR_CODES.NOT_FOUND, 'archive pointer is missing', { root });
    return { status: 'absent', pointer: null, pointerPath };
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(ERROR_CODES.UNSAFE_PATH, 'archive pointer must be a regular file', { pointerPath });
  }
  if (stat.size > LIMITS.maxPointerBytes) {
    fail(ERROR_CODES.LIMIT_EXCEEDED, 'archive pointer exceeds maxPointerBytes', { pointerPath, bytes: stat.size });
  }
  let pointer = null;
  try {
    pointer = JSON.parse(await fsp.readFile(pointerPath, 'utf8'));
  } catch {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'archive pointer is not valid JSON', { pointerPath });
  }
  if (!isPlainObject(pointer)) fail(ERROR_CODES.CORRUPT_ARCHIVE, 'archive pointer must be an object', { pointerPath });
  if (pointer.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    fail(ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION, 'archive pointer schemaVersion is not supported', {
      schemaVersion: pointer.schemaVersion,
      supported: SUPPORTED_SCHEMA_VERSION,
    });
  }
  if (typeof pointer.boardId !== 'string' || !LIMITS.boardIdPattern.test(pointer.boardId)) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'archive pointer boardId is invalid', { boardId: pointer.boardId });
  }
  if (!Number.isInteger(pointer.currentRevision) || pointer.currentRevision < 1) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'archive pointer currentRevision must be a positive integer', {
      currentRevision: pointer.currentRevision,
    });
  }
  const { previousRevision = null } = pointer;
  if (previousRevision !== null) {
    if (!Number.isInteger(previousRevision) || previousRevision < 1) {
      fail(ERROR_CODES.CORRUPT_ARCHIVE, 'archive pointer previousRevision must be null or a positive integer', {
        previousRevision,
      });
    }
    if (previousRevision >= pointer.currentRevision) {
      fail(ERROR_CODES.CORRUPT_ARCHIVE, 'archive pointer previousRevision must be older than currentRevision', {
        currentRevision: pointer.currentRevision,
        previousRevision,
      });
    }
  }
  return { status: 'ok', pointer: { ...pointer, previousRevision }, pointerPath };
}

async function listRevisionEntries(root) {
  const dir = revisionsDir(root);
  const dirStat = await lstatRealDirectory(dir);
  if (!dirStat) return { revisions: [], staging: [] };
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return { revisions: [], staging: [] };
    throw error;
  }
  const revisions = [];
  const staging = [];
  for (const name of names) {
    if (name.startsWith(STAGING_PREFIX)) {
      staging.push(name);
      continue;
    }
    const match = REVISION_DIR_PATTERN.exec(name);
    if (match) revisions.push({ name, revision: Number(match[1]) });
  }
  revisions.sort((a, b) => a.revision - b.revision);
  return { revisions, staging };
}


// ---------- 修订校验 ----------

async function readVerifiedEntry(absPath, expected, { maxBytes, describe }) {
  const stat = await safeLstat(absPath);
  if (!stat) fail(ERROR_CODES.MISSING_ATTACHMENT, `${describe} is missing`, { path: expected.path, revision: expected.revision });
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(ERROR_CODES.UNSAFE_PATH, `${describe} must be a regular file (no symlinks)`, { path: expected.path });
  }
  if (stat.size > maxBytes) {
    fail(ERROR_CODES.LIMIT_EXCEEDED, `${describe} exceeds the per-file byte budget`, { path: expected.path, bytes: stat.size, maxBytes });
  }
  const bytes = await fsp.readFile(absPath);
  if (bytes.byteLength !== stat.size) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, `${describe} changed while reading`, { path: expected.path });
  }
  const actualSha256 = sha256hex(bytes);
  if (bytes.byteLength !== expected.bytes || actualSha256 !== expected.sha256) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, `${describe} failed the integrity check`, {
      path: expected.path,
      revision: expected.revision,
      expectedBytes: expected.bytes,
      actualBytes: bytes.byteLength,
      expectedSha256: expected.sha256,
      actualSha256,
    });
  }
  return bytes;
}

function assertManifestFileEntry(entry, { revision }) {
  if (!isPlainObject(entry)) fail(ERROR_CODES.CORRUPT_ARCHIVE, 'manifest file entry must be an object', { revision });
  const { path: rel, bytes, sha256 } = entry;
  if (typeof rel !== 'string') fail(ERROR_CODES.CORRUPT_ARCHIVE, 'manifest file path must be a string', { revision });
  const isSnapshot = rel === SNAPSHOT_FILE;
  const attachmentMatch = ATTACHMENT_REL_PATTERN.exec(rel);
  if (!isSnapshot && !attachmentMatch) {
    fail(ERROR_CODES.UNSAFE_PATH, 'manifest lists a path outside the allowed archive layout', { revision, path: rel });
  }
  if (!Number.isInteger(bytes) || bytes < 1) fail(ERROR_CODES.CORRUPT_ARCHIVE, 'manifest file bytes must be a positive integer', { revision, path: rel });
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'manifest file sha256 must be a hex digest', { revision, path: rel });
  }
  if (isSnapshot) return { kind: 'snapshot', path: rel, bytes, sha256, revision };
  const [, attachmentId] = attachmentMatch;
  const manual = entry.mediaType;
  if (typeof entry.attachmentId !== 'string' || entry.attachmentId !== attachmentId) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'manifest attachmentId must match its file name', { revision, path: rel, attachmentId: entry.attachmentId });
  }
  if (entry.kind !== 'problem-image' || !LIMITS.mediaTypes[manual]) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'manifest attachment kind/mediaType is unsupported', { revision, path: rel });
  }
  return { kind: 'attachment', path: rel, bytes, sha256, revision, attachmentId, mediaType: manual, entryKind: entry.kind };
}

async function validateRevision(root, revision, { expectedBoardId, includeAttachmentBytes = false }) {
  if (typeof expectedBoardId !== 'string') {
    throw new TypeError('validateRevision requires the boardId from the archive pointer');
  }
  const revisionsRoot = revisionsDir(root);
  const revisionsStat = await lstatRealDirectory(revisionsRoot);
  if (!revisionsStat) fail(ERROR_CODES.CORRUPT_ARCHIVE, 'revisions directory is missing', { revision, revisionsRoot });
  const revisionDir = path.join(revisionsRoot, revisionDirName(revision));
  if (!isInside(root, revisionDir)) fail(ERROR_CODES.UNSAFE_PATH, 'revision path escapes the archive root', { revision });
  const dirStat = await lstatRealDirectory(revisionDir);
  if (!dirStat) fail(ERROR_CODES.CORRUPT_ARCHIVE, 'revision directory is missing', { revision, revisionDir });
  const manifestPath = path.join(revisionDir, MANIFEST_FILE);
  const manifestStat = await safeLstat(manifestPath);
  if (!manifestStat || manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'revision manifest is missing or unsafe', { revision });
  }
  if (manifestStat.size > LIMITS.maxManifestBytes) {
    fail(ERROR_CODES.LIMIT_EXCEEDED, 'manifest exceeds maxManifestBytes', { revision, bytes: manifestStat.size });
  }
  let manifest = null;
  try {
    manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  } catch {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'manifest is not valid JSON', { revision });
  }
  if (!isPlainObject(manifest)) fail(ERROR_CODES.CORRUPT_ARCHIVE, 'manifest must be an object', { revision });
  if (manifest.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
    fail(ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION, 'manifest schemaVersion is not supported', {
      revision,
      schemaVersion: manifest.schemaVersion,
      supported: SUPPORTED_SCHEMA_VERSION,
    });
  }
  if (typeof manifest.boardId !== 'string' || !LIMITS.boardIdPattern.test(manifest.boardId)) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'manifest boardId is invalid', { revision, boardId: manifest.boardId });
  }
  // 修订必须属于指针声明的同一个白板，否则这不是本归档可读的修订。
  if (manifest.boardId !== expectedBoardId) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'revision boardId does not match the archive pointer', {
      revision,
      expected: expectedBoardId,
      received: manifest.boardId,
    });
  }
  if (manifest.revision !== revision) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'manifest revision does not match its directory', { revision, received: manifest.revision });
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0 ||
      manifest.files.length > 1 + LIMITS.maxAttachmentsPerRevision) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'manifest files must list snapshot plus attachments', { revision });
  }
  const entries = manifest.files.map((entry) => assertManifestFileEntry(entry, { revision }));
  const snapshotEntries = entries.filter((entry) => entry.kind === 'snapshot');
  if (snapshotEntries.length !== 1) fail(ERROR_CODES.CORRUPT_ARCHIVE, 'manifest must list exactly one snapshot.json', { revision });
  const attachmentEntries = entries.filter((entry) => entry.kind === 'attachment');
  // 附件目录本身也必须是真实目录，避免通过父目录符号链接读到归档外部。即使本修订没有附件，
  // 归档布局也要求 attachments/ 存在；符号链接或普通文件一律 fail closed。
  const attachmentsStat = await lstatRealDirectory(path.join(revisionDir, 'attachments'));
  if (!attachmentsStat) {
    if (attachmentEntries.length > 0) {
      fail(ERROR_CODES.MISSING_ATTACHMENT, 'revision attachments directory is missing', { revision });
    }
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'revision attachments directory is missing', { revision });
  }
  const uniquePaths = new Set(entries.map((entry) => entry.path));
  if (uniquePaths.size !== entries.length) fail(ERROR_CODES.CORRUPT_ARCHIVE, 'manifest lists duplicate paths', { revision });
  let totalBytes = 0;
  const buffers = new Map();
  for (const entry of entries) {
    totalBytes += entry.bytes;
    if (totalBytes > LIMITS.maxRevisionBytes) {
      fail(ERROR_CODES.LIMIT_EXCEEDED, 'revision exceeds maxRevisionBytes', { revision, totalBytes });
    }
    const absPath = path.join(revisionDir, entry.path);
    if (!isInside(revisionDir, absPath)) {
      fail(ERROR_CODES.UNSAFE_PATH, 'manifest path escapes the revision directory', { revision, path: entry.path });
    }
    const bytes = await readVerifiedEntry(absPath, entry, {
      maxBytes: entry.kind === 'snapshot' ? LIMITS.maxSnapshotBytes : LIMITS.maxAttachmentBytes,
      describe: entry.kind === 'snapshot' ? 'revision snapshot' : `attachment ${entry.attachmentId}`,
    });
    buffers.set(entry.path, bytes);
  }
  let snapshot = null;
  try {
    snapshot = JSON.parse(buffers.get(SNAPSHOT_FILE).toString('utf8'));
  } catch {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'snapshot.json is not valid JSON', { revision });
  }
  const shape = validateSnapshotShape(snapshot, { boardId: manifest.boardId, revision });
  const manifestAttachments = new Map(attachmentEntries.map((entry) => [entry.attachmentId, entry]));
  for (const attachment of shape.attachments) {
    const entry = manifestAttachments.get(attachment.attachmentId);
    if (!entry) {
      fail(ERROR_CODES.MISSING_ATTACHMENT, 'snapshot lists an attachment that the manifest does not contain', {
        revision,
        attachmentId: attachment.attachmentId,
      });
    }
    if (entry.mediaType !== attachment.mediaType || entry.entryKind !== attachment.kind ||
        !entry.path.endsWith(attachment.fileName.replace(attachment.attachmentId, ''))) {
      fail(ERROR_CODES.CORRUPT_ARCHIVE, 'manifest and snapshot disagree about an attachment', {
        revision,
        attachmentId: attachment.attachmentId,
      });
    }
    manifestAttachments.delete(attachment.attachmentId);
  }
  if (manifestAttachments.size > 0) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'manifest lists attachments that the snapshot does not reference', {
      revision,
      attachmentIds: [...manifestAttachments.keys()],
    });
  }
  const listed = new Set([MANIFEST_FILE, ...entries.map((entry) => entry.path)]);
  const onDisk = await fsp.readdir(revisionDir);
  const unexpectedFiles = onDisk.filter((name) => !listed.has(name));
  const result = {
    revision,
    revisionDir,
    boardId: manifest.boardId,
    title: shape.title,
    createdAt: manifest.createdAt ?? snapshot.createdAt,
    pages: shape.pages,
    attachments: shape.attachments.map((attachment) => {
      const entry = attachmentEntries.find((candidate) => candidate.attachmentId === attachment.attachmentId);
      return {
        attachmentId: attachment.attachmentId,
        kind: attachment.kind,
        mediaType: attachment.mediaType,
        fileName: attachment.fileName,
        sha256: entry.sha256,
        bytes: entry.bytes,
        data: includeAttachmentBytes ? Buffer.from(buffers.get(entry.path)) : undefined,
      };
    }),
    bytesOnDisk: totalBytes,
    unexpectedFiles,
  };
  return result;
}

// ---------- 公开 API ----------

export async function saveArchive(root, draft, options = {}) {
  const { faults = {}, now = () => new Date() } = options ?? {};
  if (!isPlainObject(faults)) fail(ERROR_CODES.INVALID_INPUT, 'faults must be an object');
  if (typeof now !== 'function') fail(ERROR_CODES.INVALID_INPUT, 'now must be a function returning a Date');
  // 先校验草稿与选项，非法输入不触碰磁盘。
  const normalized = normalizeDraft(draft);
  const resolvedRoot = await assertArchiveRoot(root, { create: true });
  const createdAt = toIso(now());
  const lock = await acquireLock(resolvedRoot);
  let stagingDir = null;
  let committedRevisionDir = null;
  let pointerCommitted = false;
  try {
    const pointerState = await readPointer(resolvedRoot, { required: false });
    if (pointerState.status === 'ok' && pointerState.pointer.boardId !== normalized.boardId) {
      fail(ERROR_CODES.INVALID_INPUT, 'archive root already holds a different boardId', {
        expected: pointerState.pointer.boardId,
        received: normalized.boardId,
      });
    }
    if (pointerState.status === 'ok') {
      // 推进指针前先确认指针当前指向的修订仍然完整可读。否则「当前修订损坏、上一修订完整」
      // 这种可恢复状态会被新指针换成 previousRevision=损坏修订，静默丢掉可用的回退点。
      await validateRevision(resolvedRoot, pointerState.pointer.currentRevision, {
        expectedBoardId: pointerState.pointer.boardId,
      });
    }
    const { revisions } = await listRevisionEntries(resolvedRoot);
    const highestExisting = revisions.reduce((max, entry) => Math.max(max, entry.revision), 0);
    const currentRevision = pointerState.status === 'ok' ? pointerState.pointer.currentRevision : 0;
    const nextRevision = Math.max(currentRevision, highestExisting, 0) + 1;
    committedRevisionDir = path.join(revisionsDir(resolvedRoot), revisionDirName(nextRevision));
    if (await safeLstat(committedRevisionDir)) {
      fail(ERROR_CODES.CORRUPT_ARCHIVE, 'target revision directory already exists', { revision: nextRevision });
    }
    stagingDir = path.join(revisionsDir(resolvedRoot), `${STAGING_PREFIX}${process.pid}-${randomUUID().slice(0, 8)}`);
    await fsp.mkdir(path.join(stagingDir, 'attachments'), { recursive: true, mode: 0o700 });
    await syncDir(revisionsDir(resolvedRoot));
    const manifestFiles = [];
    for (const attachment of normalized.attachments) {
      const rel = `attachments/${attachment.fileName}`;
      await writeFileSynced(path.join(stagingDir, rel), attachment.bytes);
      manifestFiles.push({
        path: rel,
        bytes: attachment.bytes.byteLength,
        sha256: sha256hex(attachment.bytes),
        attachmentId: attachment.attachmentId,
        kind: attachment.kind,
        mediaType: attachment.mediaType,
      });
    }
    const snapshot = {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      boardId: normalized.boardId,
      revision: nextRevision,
      title: normalized.title,
      createdAt,
      coordinateSpace: 'board-units',
      pages: normalized.pages,
      attachments: normalized.attachments.map((attachment) => ({
        attachmentId: attachment.attachmentId,
        kind: attachment.kind,
        mediaType: attachment.mediaType,
        fileName: attachment.fileName,
      })),
    };
    const snapshotBytes = Buffer.from(JSON.stringify(snapshot, null, 2));
    if (snapshotBytes.byteLength > LIMITS.maxSnapshotBytes) {
      fail(ERROR_CODES.LIMIT_EXCEEDED, 'snapshot exceeds maxSnapshotBytes', { bytes: snapshotBytes.byteLength });
    }
    await writeFileSynced(path.join(stagingDir, SNAPSHOT_FILE), snapshotBytes);
    manifestFiles.unshift({
      path: SNAPSHOT_FILE,
      bytes: snapshotBytes.byteLength,
      sha256: sha256hex(snapshotBytes),
      mediaType: 'application/json',
    });
    const manifestBytes = Buffer.from(JSON.stringify({
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      boardId: normalized.boardId,
      revision: nextRevision,
      createdAt,
      files: manifestFiles,
      limitations: POC_LIMITATIONS,
    }, null, 2));
    if (manifestBytes.byteLength > LIMITS.maxManifestBytes) {
      fail(ERROR_CODES.LIMIT_EXCEEDED, 'manifest exceeds maxManifestBytes', { bytes: manifestBytes.byteLength });
    }
    await writeFileSynced(path.join(stagingDir, MANIFEST_FILE), manifestBytes);
    await syncDir(path.join(stagingDir, 'attachments'));
    await syncDir(stagingDir);
    await faults.afterStagingWritten?.({ root: resolvedRoot, stagingDir, revision: nextRevision });
    await fsp.rename(stagingDir, committedRevisionDir);
    stagingDir = null;
    await syncDir(revisionsDir(resolvedRoot));
    await faults.afterRevisionRenamed?.({ root: resolvedRoot, revisionDir: committedRevisionDir, revision: nextRevision });
    // 提交指针前先复核刚写入的修订，校验失败则不移动指针。
    const verified = await validateRevision(resolvedRoot, nextRevision, { expectedBoardId: normalized.boardId });
    const pointer = {
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
      boardId: normalized.boardId,
      currentRevision: nextRevision,
      previousRevision: pointerState.status === 'ok' ? pointerState.pointer.currentRevision : null,
      updatedAt: createdAt,
    };
    const pointerBytes = Buffer.from(JSON.stringify(pointer, null, 2));
    const pointerTmp = path.join(resolvedRoot, `${POINTER_TMP_PREFIX}${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
    await writeFileSynced(pointerTmp, pointerBytes);
    await fsp.rename(pointerTmp, path.join(resolvedRoot, POINTER_FILE));
    pointerCommitted = true;
    await syncDir(resolvedRoot);
    await faults.afterPointerCommitted?.({ root: resolvedRoot, revision: nextRevision });
    // 提交后不做「让归档看起来更干净」的清理：历史修订与崩溃残留的 .staging-* 都留在磁盘上，
    // 由调用方显式处理（O03 数据清理策略未定，PoC 只如实报告）。
    return Object.freeze({
      status: 'saved',
      boardId: normalized.boardId,
      revision: nextRevision,
      revisionDir: committedRevisionDir,
      previousRevision: pointer.previousRevision,
      bytesWritten: verified.bytesOnDisk,
      attachments: verified.attachments.map(({ data, ...meta }) => meta),
      unexpectedFiles: verified.unexpectedFiles,
    });
  } catch (error) {
    if (!pointerCommitted) {
      if (stagingDir) await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      if (committedRevisionDir) await fsp.rm(committedRevisionDir, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  } finally {
    await lock.release().catch(() => {});
  }
}

export async function openArchive(root, options = {}) {
  // 读路径只读：不清理、不移动指针、不改写任何文件，残留的 .staging-* 通过 stagingDirs 如实报告。
  const { revision: requestedRevision = null, recover = false, includeAttachmentBytes = false } = options ?? {};
  if (requestedRevision !== null && (!Number.isInteger(requestedRevision) || requestedRevision < 1)) {
    fail(ERROR_CODES.INVALID_INPUT, 'revision must be null or a positive integer', { revision: requestedRevision });
  }
  if (typeof recover !== 'boolean' || typeof includeAttachmentBytes !== 'boolean') {
    fail(ERROR_CODES.INVALID_INPUT, 'recover and includeAttachmentBytes must be booleans');
  }
  const resolvedRoot = await assertArchiveRoot(root, { create: false });
  const pointerState = await readPointer(resolvedRoot, { required: true });
  const pointer = pointerState.pointer;
  const { revisions: onDisk, staging } = await listRevisionEntries(resolvedRoot);
  // 指针是修订可见性的唯一依据：只有 currentRevision 与显式记录的 previousRevision 可读。
  const referenced = [pointer.currentRevision, pointer.previousRevision].filter((revision) => revision !== null);
  const unreferencedRevisions = onDisk
    .map((entry) => entry.revision)
    .filter((revision) => !referenced.includes(revision));
  // 显式读取某一已确认修订（典型用途：读取上一完整版本）。只读，不改变任何状态。
  if (requestedRevision !== null) {
    if (!referenced.includes(requestedRevision)) {
      fail(ERROR_CODES.NOT_FOUND, 'the archive pointer does not reference the requested revision', {
        revision: requestedRevision,
        currentRevision: pointer.currentRevision,
        previousRevision: pointer.previousRevision,
      });
    }
    const explicit = await validateRevision(resolvedRoot, requestedRevision, {
      expectedBoardId: pointer.boardId,
      includeAttachmentBytes,
    });
    return Object.freeze({
      status: 'ok',
      root: resolvedRoot,
      boardId: explicit.boardId,
      revision: explicit.revision,
      revisionDir: explicit.revisionDir,
      pointerRevision: pointer.currentRevision,
      previousRevision: pointer.previousRevision,
      isCurrentRevision: explicit.revision === pointer.currentRevision,
      requestedRevision,
      title: explicit.title,
      createdAt: explicit.createdAt,
      pages: explicit.pages,
      attachments: explicit.attachments,
      unexpectedFiles: explicit.unexpectedFiles,
      unreferencedRevisions,
      stagingDirs: staging,
      issues: [],
      limitations: POC_LIMITATIONS,
    });
  }
  const issues = [];
  let loaded = null;
  for (const revision of referenced) {
    try {
      loaded = await validateRevision(resolvedRoot, revision, {
        expectedBoardId: pointer.boardId,
        includeAttachmentBytes,
      });
      break;
    } catch (error) {
      if (!(error instanceof ArchiveError)) throw error;
      if (!recover) throw error;
      if (error.code === ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION) throw error;
      if (![ERROR_CODES.CORRUPT_ARCHIVE, ERROR_CODES.MISSING_ATTACHMENT].includes(error.code)) throw error;
      issues.push({ revision, code: error.code, message: error.message, details: error.details });
    }
  }
  if (!loaded) {
    fail(ERROR_CODES.CORRUPT_ARCHIVE, 'no complete revision is available in this archive', {
      pointerRevision: pointer.currentRevision,
      issues,
    });
  }
  return Object.freeze({
    status: issues.length > 0 ? 'recovered' : 'ok',
    root: resolvedRoot,
    boardId: loaded.boardId,
    revision: loaded.revision,
    revisionDir: loaded.revisionDir,
    pointerRevision: pointer.currentRevision,
    previousRevision: pointer.previousRevision,
    isCurrentRevision: loaded.revision === pointer.currentRevision,
    title: loaded.title,
    createdAt: loaded.createdAt,
    pages: loaded.pages,
    attachments: loaded.attachments,
    unexpectedFiles: loaded.unexpectedFiles,
    unreferencedRevisions,
    stagingDirs: staging,
    issues,
    limitations: POC_LIMITATIONS,
  });
}
