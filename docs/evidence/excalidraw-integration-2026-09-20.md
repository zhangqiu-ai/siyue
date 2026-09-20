# Excalidraw 编辑层接入证据 · 2026-09-20

> 后续 C13 已取消旧开发白板的保留/转换要求。下文转换实现及测试为历史证据，当前入口不再提供此功能；后续验证见文末。

状态：编辑层已实际接入；本机存档与自动化通过，真实输入及完整平台矩阵仍为部分验收。适用分支 `codex/video-whiteboard`、基线 `ae193af` 加本地未提交工作；不表示远端 PR 已合并。原有工作区修改保留，无提交、推送、合并或发布。

## 实际接入与版本

- `packages/whiteboard`：共享真实编辑器与版本化本机桥接协议，不是独立示例网页。
- 移动正式侧栏“白板” / 深链 `siyue:///whiteboard`，Expo DOM 内运行 Excalidraw；Electron 首页“白板”进入同一编辑器。
- `@excalidraw/excalidraw 0.18.1`；Expo 57.0.20、React / React DOM 19.2.3、React Native 0.86.3 保持现有主版本；DOM 容器为 SDK 57 的 `@expo/dom-webview 57.0.1`。
- 新增原生文件/图片适配：expo-file-system 57.0.7、expo-image-picker 57.0.19、expo-image-manipulator 57.0.19；@expo/metro-runtime 57.0.16、react-native-web 0.21.2。
- Excalidraw 自身声明支持 React 19，但其旧 Radix tabs 1.0.2 仅声明 React 18 peer；定向覆盖该一个传递依赖为 1.1.21，未忽略 peer 约束。`pnpm peers check` 通过，没有使用忽略 peerDependencies 的安装参数。

## 兼容性复现与修复

1. Metro 默认无法解析 Excalidraw CSS 条件导出；精确 resolver 指向由上游 CSS 生成的本地产物，字体 URL 内联为 data 字节，同时复制全部动态字体到 public/excalidraw/fonts。
2. Expo 57 DOM 分块 export 报 `Asset not found: _expo/static/js/web/__common-…js`；设置 `EXPO_NO_BUNDLE_SPLITTING=1` 后同一 export 成功。仍使用官方 DOM Component，不采用远程官网或公共 CDN。
3. 原生 Expo DOM WKUIDelegate 没有网页 confirm 实现；删除页使用宿主内可访问确认提示。
4. Android Gradle 原先未把 workspace 编辑器列为输入，修改共享 JS 后仍显示 UP-TO-DATE；`with-whiteboard-inputs.cjs` 配置插件加入 src/dist/generated 输入后重新打包，避免安装旧编辑器。
5. `expo prebuild --no-install` 在本环境重新生成了忽略的 ios/android 工程；既有自定义原生源仍在 `apps/mobile/modules`、既有 QA 源/脚本保留。没有清除应用数据。重建独立 XCTest runner 不改产品 target。

## 保存语义与兼容

权威存档为原生 SQLite，不使用 DOM localStorage / IndexedDB 保存作品。场景元素、页面 ID 和图片字节作为完整 v2 记录写入；白名单应用状态只含背景色、scrollX/Y、zoom。图片只在首次落盘增量跨桥，DOM onChange 不逐次跨桥传图。600ms 合并，2s 定时保存；切页/返回/正常桌面退出等待提交。后台仅尽力保存，进程强杀不保证未确认内容。

旧 `siyue.whiteboard.trial.v1` 保留不改，只有用户点击“转换旧白板副本”才生成 v2；坏数据不转换为空白。旧绘图屏幕为隔离回归文件，不再从正式入口并列展示。

## 运行命令

```sh
corepack pnpm install
corepack pnpm build:packages
node scripts/prepare-whiteboard-assets.mjs
corepack pnpm --filter @siyue/mobile ios
corepack pnpm --filter @siyue/mobile android
# 桌面独立本地构建
corepack pnpm --filter @siyue/desktop build
corepack pnpm --filter @siyue/desktop exec electron .
```

开发启动命令可用 Metro；离线验收必须使用 Release 内嵌 DOM 资源安装包，详见最终原生结果。

## 执行结果与证据

所有测试使用隔离数据和合成题图。以下按最后适用运行记录，不把重复运行次数叠加为覆盖数。

| 验证 | 结果与证据 |
|---|---|
| 版本化存档协议 | 5/5，`/tmp/siyue-excalidraw-protocol-gc.log`：加载门禁、迟到/重复请求、会话失效、损坏/未来格式、写失败保原件、缺图拒绝、删除页后无引用图片回收。 |
| 原有移动单元测试 | 129/129，`/tmp/siyue-excalidraw-mobile-unit.log`。 |
| 桌面单元测试 | 17/17，`/tmp/siyue-excalidraw-desktop-unit-final.log`，含退出前保存握手的失败、重试、调用者校验。 |
| Electron Playwright | 5/5，`/tmp/siyue-excalidraw-contrast-e2e.log`：真实画笔、矩形、橡皮、选中移动、撤销重做、分页和删除；完整图片及 SQLite trigger 写失败；正常退出保存；英文暗色窄窗与旧数据转换按钮对比度。最后图片回收改动复测同样 5/5，`/tmp/siyue-excalidraw-final-e2e.log`（2.7 分钟）。 |
| 原有桌面 E2E | 15 项通过，`/tmp/siyue-excalidraw-regression.log`；该历史混合运行另一个新用例因测试标题定位失败，后续已修复并在 5/5 中通过。 |
| 原有白板模型/存档 E2E | 5/5，`/tmp/siyue-excalidraw-prior-regression.log`，旧记录解析与恢复保持可用。 |
| iPhone/iPad 中文亮色 | 每台 2 项 XCTest 通过，`/tmp/siyue-excalidraw-{iphone,ipad}-verified.log`：原生拖画、保存、终止重开、系统相册取消/导入、显式旧数据副本转换。这里的旧旋转检查不足，横屏单列复测。 |
| iPhone/iPad 英文暗色 | 每台 1 项原生测试通过，`/tmp/siyue-excalidraw-{iphone,ipad}-english-retest.log`；旧 iPad 检查没有测量实际横向尺寸，因此不据此宣称横屏通过。 |
| Android 断网 Release | `artifacts/excalidraw-android-1789908341465/result.json`：passed、offline=true、systemDialogs=0；原生画笔、撤销/重做、分页、系统相册取消/导入、完整图片字节、SQLite 笔迹、force-stop 冷启。 |

存储独立核查见 `artifacts/excalidraw-native/iphone-storage.json`、`ipad-storage.json`：活动页包含有效尺寸的 freedraw 与 image，存档含图片 dataURL；旧 v1 字节保持不变。测试运行会继续增加合成笔迹及修订，JSON 只证明对应运行的快照。

测试中发现并修复：相册导入未结束时旧“已保存”状态会误导验收，改为处理图片/保存中并等待原生按钮恢复；旧笔迹转换宽高为零，改为按点边界计算并核对落盘；暗色转换按钮对比度不足，修正并增加计算对比度断言。删除页时仅回收无引用图片，保留已删除元素引用以支持该页撤销。

Android 系统曾出现 System UI/Pixel Launcher ANR，重启专用模拟器保留数据后最终相册用例无需处理系统弹窗。测试最多识别两次这两类系统 ANR 并留证，不忽略 Siyue 应用 ANR。

实际截图在 `artifacts/excalidraw-native/`：`iphone-whiteboard.png`、`ipad-whiteboard.png`、`iphone-english-dark.png`、`ipad-english-dark.png`。这些是已安装 Release 应用的模拟器截图，不是真机手指/Pencil 验收。

## 修改范围

新增共享编辑器/协议与测试 `packages/whiteboard/`；移动宿主 `apps/mobile/src/screens/whiteboard-screen.tsx`、DOM/原生适配 `apps/mobile/src/whiteboard/`、Metro/配置插件、正式路由和原生回归；桌面 renderer/受限 preload/SQLite IPC/关闭握手；本地资源准备脚本、依赖与锁文件；对应 OpenSpec/决策/任务/验收记录。旧试用模型、存档、隔离绘图屏幕与测试保留。工作区还包含此前视频白板规划/试用修改，不将其都冒充本轮新写。

## 尚未验收边界

真实 iPhone 手指、iPad Pencil/手掌误触、真实相机、真实设备后台极限和 Android 真机尚无本轮证据。单机本地保存不代表五设备共享、主存档授权、RTC 或连续录像通过。DOM 表面与视频/音频合成录制有待独立验证。

## 最终静态/流程检查

共享编辑器、mobile、desktop 三包类型检查通过（`/tmp/siyue-excalidraw-typecheck-final.log`）；`pnpm peers check` 无冲突；`spec:check` 5/5、`release:check`、`git diff --check` 通过。原生拍照和真实输入尚未完成，因此 SY-023 / AT-026 保持 in_progress / partial，变更不归档。

## 最终安装包与原生复测（21:14 本地时间）

- iOS Release 构建成功：`/tmp/siyue-excalidraw-ios-final-build.log`；安装到 `Siyue Whiteboard Trial QA iPhone`（9285E00A-C506-45B6-A73E-EF94BFCE5469）和 `Siyue Whiteboard Trial QA iPad`（1E1F92B8-B29F-49E0-B137-22A997493073）。旧 `Siyue Plan QA Isolated` 未覆盖。
- 最后两项本地修复（转换按钮暗色对比度、无引用图片回收）后的 XCTest：iPhone、iPad 各 1 项通过，见 `/tmp/siyue-excalidraw-{iphone,ipad}-gc-stable.log` 和对应 `-result`。涵盖真实 DOM 画笔、确认保存、终止再开；iPad 增加实际 WebView width > height 横屏断言。
- iPad 最初实际横屏断言失败，系统主屏幕也不旋转，控制中心为空；专用模拟器保留数据重启、恢复挂起测试服务后，严格断言通过。没有修改产品以绕过该断言。XCTest 的 `app.screenshot()` 横屏附件含 EXIF 方向 8 和黑边，不能当稳定成品截图；原生自动化通过后，用 Device Hub 补充核对完整系统画面并用 simctl 截取最终屏幕。这是截图/原生渲染缺口补充，未替代 Playwright 或 XCTest。
- Android 最终顺序 Release 构建成功：`/tmp/siyue-excalidraw-android-final-sequential-build.log`（3m9s）。前一次与 iOS 同时重打包耗时较长，主动终止 Android bundler 后顺序重建；被终止记录不是成功证据。
- Android 最新 APK 安装升级保留数据；`/tmp/siyue-excalidraw-android-final-native-test.log` 和 `artifacts/excalidraw-android-final/result.json` 通过，offline=true、systemDialogs=0，活动页修订 21：书写、撤销/重做、新页、系统相册取消与导入、完整图片字节、force-stop 冷启一致。
- `artifacts/excalidraw-native/final-build-and-storage.json` 记录 APK SHA256、两个包各 234 个本地字体、iOS 内嵌 DOM HTML，以及最终 SQLite 核查：iPhone 修订 15 / 6 个图片文件，iPad 修订 14 / 4 个图片文件，所有图片元素均有数据字节。两台 QA 的语言/主题偏好已恢复，仅偏好键恢复，不改作品。
- iOS 证明 Release 脱离 Metro 加载本地 DOM；Android 证明无默认网络仍能原生编辑/存档/重开；Electron E2E 禁止 HTTP(S) 外联。未把 iOS 的本地构建证据夸大为整机飞行模式测试。上游字体代码包含 CDN 后备 URL，宿主 CSP 拒绝，已打包本地主字体；拒绝日志不等于已发出成功的外网请求。

最终截图（本地绝对路径可由 Codex 打开）：

- [iPhone 中文亮色](../../artifacts/excalidraw-native/iphone-whiteboard-final.png)
- [iPad 中文竖屏](../../artifacts/excalidraw-native/ipad-whiteboard-final.png)
- [iPad 中文横屏](../../artifacts/excalidraw-native/ipad-landscape-final.png)
- [iPhone 英文暗色](../../artifacts/excalidraw-native/iphone-english-dark-final.png)
- [iPad 英文暗色竖屏](../../artifacts/excalidraw-native/ipad-english-dark-final.png)

当前 Device Hub 的专用 QA iPad 停在新白板横屏，可直接继续操作。应用侧栏“白板”同样进入，不依赖视频通话；工具栏由 Excalidraw 提供，顶部“＋”创建空白页，“选图”使用系统相册。该入口只有本机作品权限，不伪造多人主存档授权。

再次打开已安装版本：

```sh
xcrun simctl launch 1E1F92B8-B29F-49E0-B137-22A997493073 app.siyue.mobile
xcrun simctl openurl 1E1F92B8-B29F-49E0-B137-22A997493073 'siyue:///whiteboard'
# iOS 系统可能显示“Open in Siyue”确认；这不是应用保存确认。
```

剩余矩阵：真实相机/授权拒绝、各种 EXIF 方向与极端大图、真实 iPhone 手指、Pencil/手掌误触、原生软键盘遮挡、真实设备后台与强杀时未确认修订、Android 真机/完整双语主题尺寸矩阵仍需执行。桌面文字输入已落盘恢复，但不能替代原生软键盘验收。五设备同步、正式权限与连续合成录像未由本轮完成，DOM 画布如何进入白板主画面＋视频缩略图＋双向声音的录像链路仍为独立风险。

## C13 后续清理：取消旧开发白板转换

维护者确认自研白板内容仅为开发遗留产物，不再需要保留/迁移。删除正式编辑器的转换按钮、提示文案和转换函数，移除桥接 `legacy` 操作、`hasLegacy` 探测及原生 v1 读取适配。现有 Excalidraw v2 作品与图片不删除、不重置；未执行全库清理。未接入路由的旧试用源/历史测试不作为当前产品入口。

- 协议 6/6：`/tmp/siyue-no-legacy-unit.log`，新增旧键永不读取、旧转换操作被拒绝。
- Electron Playwright 5/5：`/tmp/siyue-no-legacy-e2e.log`（52.8 秒），显式放置旧开发记录仍不出现转换入口；完整编辑、图片与失败恢复/重开回归通过。
- 三包类型检查通过：`/tmp/siyue-no-legacy-types.log`；spec:check 5/5、release:check 和 diff 检查通过。
- C13 已记入 decisions/proposal，活动规格与任务取消旧转换要求；前文兼容和转换截图为历史证据。
- iOS Release 更新成功（`/tmp/siyue-no-legacy-ios-build.log`），已安装到原专用 QA iPhone/iPad。iPad XCTest 1/1 通过（40.698 秒，`/tmp/siyue-no-legacy-ipad-test.log`）：残留旧记录时无转换入口、书写保存、终止冷启及实际横屏。当前截图：[去掉转换栏的 iPad](../../artifacts/excalidraw-native/ipad-without-legacy.png)。Android 源码已同步，本轮未重打 Android APK；本轮未提交或推送。
