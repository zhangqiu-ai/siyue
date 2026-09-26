# 2026-09-25 应用界面重构阶段验证

范围：按 `docs/design/prototype/siyue-prototype.html` 的账号、侧栏、对话、空间、计划与白板方向补齐移动端实现。工作区原有大量未提交改动；本记录只覆盖本轮实际核实的路径，不代表发布或真机验收。

## 实际运行

- iOS Debug 应用使用 Xcode 的 `Siyue` scheme 构建，安装在隔离的 `Siyue UI Audit Compact`（iOS 26.5）和 `Siyue UI Audit iPad`（iPadOS 26.5）模拟器。连接本地 Metro 后，正式 Expo Router 入口成功打包并显示；原生包最初因白板文案从 Excalidraw 入口导入而在 `nanoid/crypto` 处打包失败，改用独立 `@siyue/whiteboard/strings` 导出后重新打包成功。
- iPad 英文、暗色模式：常驻 300pt 侧栏、对话空态与未连接卡、空间空态、新建计划和单页草稿均在真实应用中显示。用隔离本机数据库完成手动计划：选择示例目标、添加任务、等待“Draft · autosaved”、确认后出现“1 goal · 1 project · 1 tasks”，进入目标详情可见同一任务和 `0/1 done`。这是本机数据路径，不涉及 AI 服务或账号服务器。
- 紧凑 iPhone 中文、暗色模式：对话首页显示正常；在 `accessibility-extra-large` 字号下，未连接卡原先横排挤压文字，改为竖排后说明和按钮可见。大字号首页的建议仍需滚动查看，未做完整 S/M/L 矩阵验收。
- iPad 白板库显示三种新建起点；选择空白白板后，DOM 编辑器出现全屏顶部名称和自动保存状态、右侧页面与插入按钮、底部绘图工具。返回库后出现“New board, 1 page”。这是空白存档的进入/返回检查，未进行图片、绘图持久化或多设备验收。
- iPad 正式应用中的账号入口也已打开，显示英文登录页、数据不自动上传提示及邮箱登录/注册入口；真实账号服务、凭据和登录结果不在此次正式入口视觉检查中。
- iPad 与原型同状态的对照见 [原型截图](redesign-app-ui-2026-09-25/prototype-ipad-chat-en-dark.png)、[iPad 对话](redesign-app-ui-2026-09-25/ios-ipad-chat-en-dark.png)。其他模拟器截图：[空间空态](redesign-app-ui-2026-09-25/ios-ipad-space-empty-en-dark.png)、[计划入口](redesign-app-ui-2026-09-25/ios-ipad-plan-create-en-dark.png)、[草稿](redesign-app-ui-2026-09-25/ios-ipad-plan-draft-en-dark.png)、[白板编辑器](redesign-app-ui-2026-09-25/ios-ipad-whiteboard-editor-en-dark.png)、[账号入口](redesign-app-ui-2026-09-25/ios-ipad-account-entry-en-dark.png)、[紧凑 iPhone](redesign-app-ui-2026-09-25/ios-compact-chat-zh-dark.png)、[大字号](redesign-app-ui-2026-09-25/ios-compact-chat-zh-large.png)。截图是视觉检查，不能代替自动化断言。

## 可重复检查

- `./node_modules/.bin/tsc --noEmit -p apps/mobile/tsconfig.json`：通过。
- `./node_modules/.bin/tsc -p packages/adapters/tsconfig.json` 与 `./node_modules/.bin/tsc -p packages/whiteboard/tsconfig.json`：通过。
- `node --experimental-strip-types --test apps/mobile/tests/*.test.mjs`：218/218 通过。
- 在 `packages/adapters` 运行 `./node_modules/.bin/tsx --test src/*.test.ts`：281/281 通过，其中包含行内任务关联、失败重试和丢失回执对账。
- `./node_modules/.bin/playwright test --config packages/whiteboard/playwright.config.mjs`：12/12 通过，覆盖编辑器界面。其余受影响的 Playwright 用例与更新中的 iOS XCTest 尚未声称通过。
- `git diff --check`：通过。

## 尚未验收的差距

- 移动正式入口依赖 `expo-sqlite` 原生事务，Expo Web 会报 `withExclusiveTransactionAsync is not supported on web`；因此无法用 Web Playwright 假装验证移动端。需要 iOS XCTest 与 Android 原生自动化覆盖完整流程。
- 家庭空间的创建、同步冲突处理和真实成员列表依赖尚未接入的空间能力；界面只展示当前可用空间。视频通话入口在 `add-family-video-whiteboard` 接口就绪前隐藏。
- 对话与计划 AI 的真实服务响应、iPhone/iPad 全部中英明暗及大字号矩阵、Android、真机与桌面端未通过本轮完整验收。账号独立 QA 构建和 XCTest 结果另行补记。
