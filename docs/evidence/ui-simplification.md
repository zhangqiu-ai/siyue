# 2026-09-06 · 当前 UI 精简

按维护者确认的 DESIGN.md 实施，限现有移动与桌面 UI，不改领域、存储、AI 请求及审批流程。

## 修改

- 移动 `chat-screen.tsx`：删除装饰图形、重复分类与描述，快捷建议用短标签但发送原始完整提示；重新生成使用带无障碍标签的图标。
- `conversation-list.tsx` 与 shell layout：新建对话使用轻量撰写图标，侧栏品牌旁放置同一操作；设置使用齿轮。去口号、重复会话标题和逐项“继续/查看”提示，保留选中状态；重启清空说明留在设置。图标触控区域至少 44×44。
- 设置与 AI 配置：去重复分组标题和说明，保留费用、数据发送、密钥与清空记录等信息；返回与关闭图标化。
- 桌面 `App.tsx`/`styles.css`：去口号、编号与重复品牌；刷新图标化，灰阶配色。保留目标工作台与所有业务操作，不把历史 QA fixture 当产品页面修改。

## 验证

工作目录 `/Users/feature/code/siyue`。

- `corepack pnpm --filter @siyue/mobile typecheck`：通过。
- `corepack pnpm --filter @siyue/mobile test`：38/38 通过；日志 `/tmp/siyue-ui-simplification-tests.log`。
- `corepack pnpm --filter @siyue/desktop typecheck`：通过。
- `corepack pnpm --filter @siyue/desktop build`：Vite 构建通过。
- `git diff --check`：通过。
- iPhone 17 Pro / iOS 26.5 模拟器 UUID `7328BC59-6853-445B-A888-E99496AB2048`：冷启动、侧栏设置图标进入、返回、明暗切换、供应商选择及填充均实际检查。AX 树保留新建对话/设置/关闭/返回的名称。未保存密钥或发送供应商请求；结束恢复明色主页。
- 六张移动截图逐图查看，未见裁切；对比见 [本机截图页](../../artifacts/ui-simplification/comparison.html)。截图为实际 simctl 原图，产物目录受 Git 忽略。
- 桌面 Playwright Chromium 1440×1000 截图查看通过，无横向溢出；浏览器无 Electron IPC 桥，显示本机空间不可用，不能据此宣称 Electron 业务通过。

未运行 Android 原生、真机、完整聊天生成/重试 UI 或完整桌面业务回归。未新增依赖、提交、推送、部署。工作包状态不因视觉修改升级完成。
