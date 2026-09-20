# 家庭视频白板 · 隔离存储 PoC（任务 2.4）

这是 `add-family-video-whiteboard` 任务 2.4 的最小技术验证，不是产品功能、不是移动端实现，也不接入应用。
它只用合成数据验证一件事：可编辑白板快照与合成题图附件能否在本地文件系统上以「完整修订 + 指针」的方式原子提交、校验、重开并保留上一完整版本。

## 边界

- 只写入调用方给定的归档根目录，测试全部使用 `os.tmpdir()` 下的独立目录。
- 不使用生产数据、不读取相机/相册/任意文件路径；题图必须以字节传入。
- 不安装依赖、不接云同步、不接数据库、不接应用 UI。
- 不做自动清理、不做修订数量保留策略（O03 未定），崩溃残留的 `.staging-*` 和所有历史修订都留在磁盘。
- 不做 iPhone/iPad/Android 触摸、手写、文件权限、存储配额或后台中断适配，本 PoC 不冒充移动验收。
- 跨进程 Playwright runner 集成测试由主代理维护，见仓库中的 `tests/e2e/video-whiteboard-archive.spec.mjs`；本目录只提供稳定 API 和 `node:test` 行为测试。

## 运行

```bash
node --test experiments/video-whiteboard/local-archive.test.mjs
```

环境要求只有 Node.js（当前验证使用 Node v22.22.3）。测试包含真实子进程退出、跨进程重开和真实文件系统 rename/fsync 路径。

## 导出 API

```js
import {
  assertArchiveRoot,
  openArchive,
  saveArchive,
  ERROR_CODES,
  LIMITS,
  POC_LIMITATIONS,
} from './local-archive.mjs';
```

### `saveArchive(root, draft, options?)`

在 `root` 下写入一个新的完整修订，成功后原子覆盖 `archive.json` 指针。

```js
const saved = await saveArchive(root, draft, {
  now: () => new Date(),
  faults: { afterRevisionRenamed: () => process.exit(71) },
});
```

返回：

```js
{
  status: 'saved',
  boardId: 'board-1',
  revision: 2,
  revisionDir: '/…/revisions/r-00000002',
  previousRevision: 1,
  bytesWritten: 12345,
  attachments: [{ attachmentId: 'img-1', kind: 'problem-image', mediaType: 'image/png',
                  fileName: 'img-1.png', sha256: '…', bytes: 1234 }],
  unexpectedFiles: []
}
```

`draft.boardId` 必须是稳定的字符串，后续保存必须使用同一个 `boardId`。提交前如果 pointer 已存在，会先校验 pointer 当前指向的修订；当前 manifest/snapshot 损坏或 schema 不可读时直接失败，不推进 pointer，也不丢掉 `previousRevision` 提供的可恢复引用。

### `openArchive(root, options?)`

只读打开归档，不自动清理、不移动指针、不改写任何文件。

```js
const archive = await openArchive(root, {
  revision: null,                 // null=current，正数=显式读取 current 或 previous
  recover: false,                 // true 时才允许回退到上一完整修订
  includeAttachmentBytes: true,   // true 时 attachments[].data 是 Buffer
});
```

默认只校验 pointer 显式引用的 `currentRevision` 和 `previousRevision`。显式 `revision` 只能读取这两个已确认修订；其他磁盘上的修订通过 `unreferencedRevisions` 如实报告，但不能被冒充为当前版本。

返回：

```js
{
  status: 'ok' | 'recovered',
  root, boardId, revision, revisionDir,
  pointerRevision, previousRevision, isCurrentRevision,
  requestedRevision: 2,            // 仅显式 revision 读取时有
  title, createdAt, pages, attachments,
  unexpectedFiles, unreferencedRevisions, stagingDirs, issues, limitations
}
```

`attachments[]` 形如：

```js
{
  attachmentId: 'img-1',
  kind: 'problem-image',
  mediaType: 'image/png',
  fileName: 'img-1.png',
  sha256: '…',
  bytes: 1234,
  data: Buffer // 仅在 includeAttachmentBytes:true 时存在
}
```

`recover:true` 只对损坏/缺失的完整修订做显式回退，返回 `status:'recovered'` 和 `issues`。未来 schema、路径不安全、非法输入等不会被静默当成旧版本；恢复也不会改写 pointer。

### `assertArchiveRoot(root, { create })`

校验归档根：必须是绝对路径，至少两层深，不能是文件系统根、`$HOME`、文件或符号链接目录。`create:true` 才会在新路径创建目录。

## 草稿与快照样例

草稿结构：

```js
const draft = {
  boardId: 'board-1',
  title: '合成题图练习',
  pages: [
    {
      pageId: 'page-1',
      imageRef: 'img-1',
      transform: { rotationDegrees: 0, scale: 1, translateX: 0, translateY: 0 },
      strokes: [
        { strokeId: 's-1', tool: 'pen', color: '#111111', width: 2,
          points: [{ x: 10, y: 20 }, { x: 30, y: 40 }] },
      ],
    },
  ],
  attachments: [
    {
      attachmentId: 'img-1',
      kind: 'problem-image',
      mediaType: 'image/png',
      bytes: onePixelPng(), // Buffer/Uint8Array，真实可解码的 1x1 PNG/JPEG
    },
  ],
};
```

写入后的 `snapshot.json` 结构：

```json
{
  "schemaVersion": 1,
  "boardId": "board-1",
  "revision": 2,
  "title": "重开后再编辑",
  "createdAt": "2026-09-20T03:00:00.000Z",
  "coordinateSpace": "board-units",
  "pages": [
    {
      "pageId": "page-1",
      "index": 0,
      "imageRef": "img-1",
      "transform": { "rotationDegrees": 0, "scale": 1, "translateX": 0, "translateY": 0 },
      "strokes": [{ "strokeId": "s-1", "tool": "pen", "color": "#111111", "width": 2,
                    "points": [{ "x": 10, "y": 20 }, { "x": 30, "y": 40 }] }]
    },
    {
      "pageId": "page-2",
      "index": 1,
      "imageRef": "img-2",
      "transform": { "rotationDegrees": 90, "scale": 1.5, "translateX": 4, "translateY": -6 },
      "strokes": [{ "strokeId": "s-2", "tool": "highlighter", "color": "#ffcc00", "width": 8,
                    "points": [{ "x": 5, "y": 5 }] }]
    }
  ],
  "attachments": [
    { "attachmentId": "img-1", "kind": "problem-image", "mediaType": "image/png", "fileName": "img-1.png" },
    { "attachmentId": "img-2", "kind": "problem-image", "mediaType": "image/jpeg", "fileName": "img-2.jpg" }
  ]
}
```

## 磁盘布局与原子提交

```text
<root>/
  archive.json                 # pointer: schemaVersion, boardId, currentRevision, previousRevision, updatedAt
  archive.lock                 # 写者锁：{ pid, token, startedAt, task }
  revisions/
    r-00000001/
      manifest.json            # 文件清单：path、bytes、sha256；附件还带 attachmentId/kind/mediaType
      snapshot.json
      attachments/
        img-1.png
    .staging-…/                 # 崩溃残留时保留，只报告、不自动删除
```

提交顺序：输入校验 → 获取 O_EXCL 写锁 → 校验已有 pointer 与其当前修订 → 写暂存目录和附件 → 逐文件 `fsync` → `rename` 暂存目录为 `revisions/r-XXXXXXXX` → 复核新修订 → 写临时 pointer 并 `rename` 覆盖 `archive.json` → 释放锁。pointer 的 rename 是提交点；在它之前失败会保留旧 pointer 和旧完整修订。

`pointer.previousRevision` 只是显式记录的上一完整修订，不是修订窗口，也不触发任何清理。`fsync` 目录在平台不支持时会使用 Node 支持的降级路径；本 PoC 不宣称覆盖断电、磁盘耗尽、网络文件系统或跨设备 rename。

## 错误码

| 错误码 | 含义 |
| --- | --- |
| `invalid_input` | 草稿、options 或附件字节不符合约束 |
| `unsupported_schema_version` | pointer、manifest 或 snapshot 来自未来 schema，拒绝读写 |
| `corrupt_archive` | JSON 损坏、哈希不符、修订不完整、boardId/revision 不一致 |
| `missing_attachment` | 快照引用或 manifest 记录的附件缺失 |
| `archive_busy` | 已有活锁、未知/损坏锁或陈旧锁；PoC 一律失败关闭，不删除他人锁 |
| `unsafe_path` | 路径逃逸、根/家目录、文件或符号链接父目录等不安全布局 |
| `limit_exceeded` | 超出字节数、附件数、页数、笔迹数等资源上限 |
| `not_found` | 归档、pointer 或 pointer 未引用的修订不存在 |

## 已知限制

- **单写者**：同一归档根同一时刻只允许一个写进程。锁只由持有正确 token 的写者释放；未知/损坏锁和陈旧锁都不自动回收。
- **崩溃锁恢复**：写进程崩溃后 `archive.lock` 会保留，调用方必须确认没有写者后手动删除；PoC 不能安全区分「刚创建还没写 JSON 的活锁」与陈旧锁。
- **无清理策略**：历史修订、未引用修订和 `.staging-*` 都保留；O03 数据清理策略未定，PoC 只如实报告。
- **明确恢复**：只有 `recover:true` 才允许从当前损坏修订回退到上一完整修订，且结果必须带 `status:'recovered'` 与 `issues`；未来 schema 不做静默回退。
- **合成题图**：附件会校验文件签名与内容哈希/完整性；测试夹具使用真实可解码的 1x1 PNG/JPEG，但本实现不提供图片解码校验，也不负责图片编辑器/渲染器兼容。
- **未验证移动与云端**：iPhone/iPad/Android、后台中断、配额、云备份和跨设备恢复都不在本 PoC 范围。

## 测试覆盖

`local-archive.test.mjs` 使用 `node:test`，覆盖：

- 重开后编辑再保存，旧修订不被覆盖；
- 失败保旧：暂存失败、rename 后指针失败；
- 真实子进程崩溃：暂存中断、pointer 提交前中断、崩溃锁 fail-closed；
- 附件损坏/缺失、快照引用不完整附件、manifest 多出附件；
- pointer/manifest/snapshot 未来 schema；
- 当前修订损坏或未来 schema 时 `saveArchive` 拒绝推进 pointer；
- `openArchive` 与恢复路径核对 `pointer.boardId`；
- 路径逃逸、根/家目录、文件、末端附件符号链接、`revisions/`/`attachments/` 父目录符号链接；
- 非法输入、资源上限、真实 1x1 PNG/JPEG、跨进程重开。

最终运行结果见 [验证证据](../../docs/evidence/video-whiteboard-local-2026-09-20.md)。
