# 独立白板本机试用 · 2026-09-20

## 范围与运行入口

维护者要求先直接操作白板，无需真实视频通话。当前工作树基于 `codex/video-whiteboard`，未提交。已有 Debug app 加载本次 Metro 源码；不是已发布构建。通过侧栏“白板测试”或 `siyue:///whiteboard` 打开。此页是待维护者评审的可操作本机原型，不将其当作正式协作 UI 的 Figma/完整产品验收。

新增文件：`apps/mobile/src/screens/whiteboard-screen.tsx`、`src/whiteboard/model.ts`、`src/whiteboard/storage.ts`（后两者相对 apps/mobile）、`app/whiteboard.tsx` 及自制示例题图；入口与中英资源在既有文件接入。没有新增依赖、服务调用、相册/相机权限或正式家庭数据写入。

支持空白页/自制分数题图、四色三档画笔、整笔橡皮、撤销重做、多页、显式保存后退出重开。文档固定 1000×1400，按可用区等比显示。试用最多 10 页、400 笔、每笔 600 点、共 20000 点；超限提示并保留此前内容。撤销历史只在当前页面会话内保留（最多 30 步）。

保存使用既有 Expo SQLite KV 独立键 `siyue.whiteboard.trial.v1`，不读写正式家庭/目标记录。读取损坏或未来 schema 时锁住编辑，不允许空文档覆盖原件；保存失败保留内存文档并提示重试；未保存退出有确认。试用数据属于此安装设备，不具备家庭账号空间隔离语义；正式账号共享接线前需单独迁移设计。

暂未接入自由选题图/拍照、缩放/平移、Apple Pencil 压感、多人同步、指定设备自动存档、RTC 或录像。试用 KV 与前一轮 Node 文件存档 PoC 是不同适配器，不能用两者的独立测试声称正式存档链已接通。

## 自动化与覆盖边界

- `corepack pnpm --filter @siyue/mobile typecheck`：通过。
- `node --experimental-strip-types --test apps/mobile/tests/whiteboard-model.test.mjs`：8 项通过；损坏/未来版本、数据边界、不可变操作、擦除命中线段、序列化往返。
- `corepack pnpm --filter @siyue/mobile test`：129 项通过（主代理实际执行复核）。
- `corepack pnpm exec playwright test tests/e2e/whiteboard-trial-storage.spec.mjs`：3 项通过。使用生产 model/storage 与隔离真实 Node SQLite 验证写入、关闭重开后编辑、损坏/未来数据保旧、query_only 写失败及重试。属于 Playwright runner 集成，不能冒充 React Native UI E2E 或 Expo 原生故障测试。

React Native 当前没有浏览器运行目标，Playwright 无法对原生 PanResponder/Expo SQLite 页面做浏览器交互。对应原生手势与进程重启用 XCTest 独立 runner。主用户模拟器只打开页面供其试用，自动化只操作专用 QA 设备。


## 原生执行与修正记录

环境：Xcode 27.0 (27A266a)、iOS 26.5 (23F77)，已有 Siyue Debug 原生壳加当前 Metro 源码。独立 runner 由 `scripts/prepare-whiteboard-ui-tests.rb` 生成，不重建/更改产品 native target。复现命令见 `apps/mobile/e2e/whiteboard-trial/README.md`。

- iPhone 17 Pro 专用设备 `9285E00A-C506-45B6-A73E-EF94BFCE5469`，首轮 1 项通过 / 0 失败，40.371 秒。
- iPad Pro 13-inch (M5) 专用设备 `1E1F92B8-B29F-49E0-B137-22A997493073`，首轮 1 项通过 / 0 失败，42.316 秒。
- 覆盖实际 PanResponder 拖画 → 撤销 → 重做 → 命中整笔擦除 → 撤销擦除 → Expo SQLite 保存 → app terminate/launch → 重开同笔数/页数 → 题图页继续绘制/保存。
- 首轮截图审查发现 Image 固有尺寸覆盖 absoluteFill 布局，题图被裁切；已显式设置图片宽高为画布的 100%。这是截图发现的真实显示缺陷，首轮功能断言不能代替该视觉验收。复跑结果另列。
- Reanimated Babel 将普通颜色对象 `.value` 误判为 shared value 并报警，属性改名为 `inkColor`，未屏蔽全局日志。
- 自动化独立子任务后续遇到模型服务 429，由主代理接管原生 runner、执行与最终复核；没有把失败的委派当作审查通过。

首轮日志保留在 `artifacts/whiteboard-trial-2026-09-20/{iphone,ipad}-initial.log`。测试产物为本机忽略文件，原始 `.xcresult` 位于 `/tmp/siyue-whiteboard-{iphone,ipad}.xcresult`。


### 最终复跑与画面复核

修正图片布局并增加跨重启页码定位后，以同一 XCTest 用例在两个 destination 执行：**2 项通过，0 失败**；iPhone 29.102 秒、iPad 30.931 秒，`TEST EXECUTE SUCCEEDED`。最终日志 `artifacts/whiteboard-trial-2026-09-20/final-native.log`，结果 `/tmp/siyue-whiteboard-final.xcresult`；两张 keepAlways 截图与设备映射位于 `artifacts/whiteboard-trial-2026-09-20/final/manifest.json`。主代理逐图查看，题图完整显示、比例正确、笔迹可见、按钮未被遮挡，未再做重复手动操作。

主用户设备 `Siyue Plan QA Isolated` 的白板已打开供试用，后续自动化未在该设备绘制或清库。Metro 8081 保留运行。

最终类型检查、`spec:check`（5 项）、`release:check`、`git diff --check` 均通过。AT-026 仍为 partial，SY-023 仍为 in_progress，等待维护者试用及剩余矩阵；OpenSpec 6.1/6.2 仅本次限定试用与记录任务已完成。

未验证：英文实际交互、深色/大字号/横屏/窄窗口完整矩阵、Android、真机、Apple Pencil、原生磁盘满/进程被杀/后台中断。已执行模拟器中文竖屏的输入与保存路径；以上缺口不计为通过，也不提升正式协作或版本发布状态。
