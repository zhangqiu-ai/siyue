# Playwright 优先验证 · 2026-09-13

授权：维护者要求新增 Playwright E2E，能验证通过的暂不用 Computer Use，无法完成的再使用。范围：测试工具和开发流程维护，按 OpenSpec 简化流程；不改变产品行为、数据结构、权限或外部服务。Target release: 0.0.1，无新业务工作包。策略见 [测试指南](../testing.md)。

新增 playwright.config.mjs、tests/e2e/desktop-fixture.mjs、tests/e2e/desktop.spec.mjs 与根 test:e2e 入口。规则同步 AGENTS、工程指南、DESIGN、UI 验收、现行开发流程规格；版本与 BOOTSTRAP 引用本记录。使用已安装 Playwright 1.62.1，无依赖或锁文件变动。

## 执行

工作目录 /Users/feature/code/siyue；feature/dev；工作区含既有未提交更改。没有修改应用实现。Host Node v22.22.3；Electron 44.2.0（内嵌 Node 24.20.0、Chromium 152.0.7977.76），本机 macOS。

- `corepack pnpm test:e2e`：首轮 7/7，9.9 秒；独立审查后加强归档可见性与归档文案断言，最终完整回归 7/7，10.1 秒，0 失败。共享构建 4 项缓存命中，桌面 Vite 构建实际执行；不把缓存构建算重新验证共享实现。
- 完整回归原始结果位于 `artifacts/e2e/2026-09-13T03-37-14.479Z-19669/`，每项有 result.json、独立合成 SQLite 与 trace。本地工件不随 Git 分发。
- `corepack pnpm exec playwright test --list`：发现 7 项。
- `corepack pnpm spec:check`：4 项通过；`corepack pnpm release:check`、`git diff --check` 通过。
- 独立审查：实际页面操作经过正式 IPC 和 SQLite；初版归档“无按钮”可能在行消失时假通过，已补行可见和归档状态断言并全量重跑。关闭失败仍保留结果、截图不可用改文本附件。

测试涵盖中英手动创建/改名/完成/归档/重启，草稿编辑门槛/拒绝无正式写入，输入校验失败恢复，以及语言持久化/焦点返回。业务写入不 mock；计划生成使用应用现有确定性 Mock，无真实 AI 外发。浏览器请求拦截不代表进程级网络沙箱。

本轮 Computer Use 调用 0 次；未启动模拟器。未运行旧 desktop-smoke、原生测试或真机验收，未改写它们的历史状态。本次不会直接覆盖移动当前界面的键盘、安全区或权限；旧 iOS 正常 UI 测试定位含“行动”底部标签，与当前 Drawer 不同，需先适配再复用。完整移动自动化不是本次七项通过的结论。

未提交或推送。未量化 token 节省；已验证的是测试可重复执行而无需模型逐步操作。

补充验证：修正 worker 重载配置时的工件目录标识继承后，`corepack pnpm test:e2e --grep 'invalid plan'` 筛选 2 项均通过（2.2 秒），验证筛选命令和配置实际生效。随后规格 4 项、版本、diff、两份测试模块语法及 41 个本地链接检查通过。此补充不是第三次全量测试。
