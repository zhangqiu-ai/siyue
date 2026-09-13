# 自动化优先的界面验证

2026-09-13 维护者要求：Playwright 能验证通过的场景，开发期间暂不重复 Computer Use；无法覆盖的场景再使用 Computer Use。本规则决定验证工具，不降低产品验收条件。

## 选择顺序

1. 查受影响场景是否有 Playwright 测试；有则运行，无则判断现有运行目标是否支持，支持时补可重复的测试。断言须验证实际结果，不能只验证页面打开或按钮被点击。
2. 同一代码/构建、平台与场景通过后停止，不为重复确认再逐步操作模拟器、读取截图或调用 Computer Use。测试失败先查断言、日志和失败 trace，修复后重跑受影响项；失败不等于工具无法覆盖。
3. Playwright 不支持的原生能力优先使用适用的 XCTest/UIAutomator/命令行测试；这些也无需模型逐步点击。仅未覆盖的视觉判断、原生交互或定位诊断使用 Computer Use，开始前说明具体缺口，完成该缺口后停止。
4. 没有测到的设备、语言、状态仍为未验证。桌面通过不能代替移动原生验收，浏览器手机尺寸也不等于 iPhone/iPad 原生。发布前双语、双设备和真机要求保留。

## 可直接运行

仓库根目录，复用锁定的 Playwright 依赖，无新增依赖或浏览器下载：

```sh
# 构建当前共享包和桌面 renderer，执行真实 Electron E2E
corepack pnpm test:e2e
# 按名称选取受影响用例，仍先构建
corepack pnpm test:e2e --grep 'draft edits'
# 仅列出测试，不启动应用
corepack pnpm exec playwright test --list
# 当前构建已确认未变化时，可直接执行选定用例
corepack pnpm exec playwright test --grep 'invalid plan'
```

配置在 [playwright.config.mjs](../playwright.config.mjs)，用例在 [desktop.spec.mjs](../tests/e2e/desktop.spec.mjs)。单 worker、无自动重试；失败返回非零退出码。每次运行使用独立 artifacts/e2e 子目录，每项使用独立 userData/SQLite，重启保留本项数据；不读用户数据库、不清库、不用真实模型，不启动模拟器。保留本地结果 JSON；失败截图与 trace 用于按需定位，不将完整截图逐步输入模型。artifacts 不进入 Git，清理由维护者按需处理。

## 当前覆盖与缺口

| 场景 | 验证工具与范围 |
|---|---|
| 手动创建单项目草稿、重启续看、拒绝零正式写入、确认后关联，以及改名、任务完成、归档、重启保留 ID/状态 | Playwright E2E，中英覆盖，真实 Electron/IPC/SQLite |
| 草稿修改前禁止确认、保存修改、重启、拒绝不创建正式记录 | 新 Playwright E2E，中英各一项，确定性本地 Mock |
| 空项目、旧多项目草稿保留且禁止误确认 | Playwright E2E，中英覆盖；旧格式仅写入每项隔离测试库 |
| 超量任务拒绝、输入保留、修正后单次写入 | 新 Playwright E2E，中英各一项，真实命令校验 |
| 切换英文、Escape 关闭与焦点返回、重启保留语言 | 新 Playwright E2E，一项 |
| 草稿确认闭环、丢回执对账、IPC/CSP 安全 | 既有 [desktop-smoke.mjs](../scripts/desktop-smoke.mjs)，构建后 `corepack pnpm test:desktop-smoke`；本次未重跑，不计入新增七项 |
| 移动当前页面、键盘、安全区、权限、原生存储及设备切换 | 本套 Playwright 未覆盖；按下述原生入口选择自动化，剩余缺口再 Computer Use |

Playwright 支持浏览器和实验性 Electron 自动化，移动浏览器仿真不能验证 React Native 原生界面。当前 mobile 直接使用 Expo SQLite、SecureStore、Expo UI，未提供 React Native Web 运行目标；不为测试复制业务实现或把 HTML 原型当正式 App。

原生已有 [iOS UI 测试](../apps/mobile/e2e/README.md)、[隔离恢复 QA](../apps/mobile/e2e/native-recovery/README.md)、[Android UI 测试](../apps/mobile/e2e/android/README.md)。旧 SiyueUITests 的“行动”底部标签定位与当前 Drawer 不同，只能按其历史/QA 宿主范围解释；执行前核对入口、构建和专用设备。缺少当前页面自动化时不声称可直接替代 Computer Use，也不沿用旧设备 ID 盲跑。

## 证据要求

记录测试命令、结果、构建/代码状态及覆盖平台。Playwright 行为断言通过只证明对应行为；视觉观感、原生权限和未覆盖维度单列，必要时一次性检查代表证据，不重复全程截图。新缺陷优先沉淀为自动化断言，减少下次交互操作。

官方资料（2026-09-13 查阅）：[Electron](https://playwright.dev/docs/api/class-electron)、[设备仿真](https://playwright.dev/docs/emulation)、[Android 浏览器/WebView 范围](https://playwright.dev/docs/api/class-android)。
