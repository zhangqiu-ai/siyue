# Sage iPad 运行检查 · 2026-09-09

范围：既有个人空间空状态、设置、主题与语言切换、横竖屏。未新增业务功能或修改业务数据。

环境：`Siyue UI Audit iPad`，UUID `9F1E3F2F-B074-498C-A87C-8F46A0E2BF5D`，iOS 26.5；当前未提交工作区。`xcrun simctl list devices booted` 确认设备已启动。Metro PID 1335 在 localhost:8081 监听，`lsof -a -p 1335 -d cwd -Fn` 确认目录为本仓库 `apps/mobile`。

实际操作：通过 Simulator 的 Rotate 按钮由倒置竖屏切至横屏，再切至正向竖屏；从个人空间侧栏进入设置，切换英文暗色→英文明色→中文明色，旋转后选择状态保持。检查后恢复英文暗色并返回个人空间。未操作另一台 iPhone 上的用户输入。

| 项目 | 状态与证据 |
| --- | --- |
| 设置宽度、分组、返回导航 | pass（所测范围）：横屏内容居中收窄，竖屏同级对齐；无侧栏按钮与返回混排 |
| 主题和语言入口 | pass：AX checked 状态与可见选中项一致，中文与英文标签正常；操作立即更新 |
| 旋转 | pass（空状态/设置）：页面保持，未出现可见裁切与重叠；不代表编辑输入旋转保护已验证 |
| Sage 色彩 | pass（所测范围）：明色奶油卡片、深绿选中按钮；暗色深绿背景、浅绿选中按钮；截图已查看 |
| 版本一致性 | 未通过版本工件核实：设置显示 0.1.0，但根 package.json 与 apps/mobile/app.json 为 0.0.1。设置读取 Constants.expoConfig.version；随后核实安装包 Info.plist 与 EXConstants.bundle/app.config 都是 0.1.0，本地生成的原生 Info.plist 也未同步版本，不将本次热更新 UI 证据作为 0.0.1 新安装包验收 |
| 原生方向配置 | 配置已核实：现有工程及安装包 UISupportedInterfaceOrientations~ipad 均明确四方向。Expo config-plugins 57.0.9 的 setOrientation 仅更新通用键、保留 iPad 专用键；独立只读调用已确认。无需改 app.json 的 portrait；新构建工件及完整交互矩阵仍须验证 |
| 完整矩阵 | not_run：窄窗口/分屏、辅助大字、屏幕/外接键盘编辑、有数据详情、Android、真机 |

截图通过 `xcrun simctl io <UUID> screenshot <path>` 获取；Simulator 窗口截图同时人工查看。原始设备帧缓冲可能保留旋转方向，不将其误认成应用倒置缺陷。底部灰条是开发环境的 “Open debugger to view warnings” 提示，本轮未隐去，警告内容未诊断。

- [英文暗色横屏设置](ipad-settings-dark-landscape.png)
- [中文明色横屏设置](ipad-settings-light-zh-landscape.png)
- [中文明色竖屏设置](ipad-settings-light-zh-portrait.png)

本轮未修改应用代码，不重复已通过的 79 项移动测试；不据局部视觉检查勾选完整 UI 验收。

## 版本差异修复与新包复测

已将被 Git 忽略的 `apps/mobile/ios/Siyue/Info.plist` 中唯一的 CFBundleShortVersionString 从 0.1.0 同步为已确认的 0.0.1；原文件备份 `/tmp/siyue-native-info-before-sage-version.plist`。没有改版本计划、依赖、方向或签名策略，也未运行清洁 prebuild。

构建命令（仓库根目录）：
```sh
/usr/bin/xcodebuild build -workspace apps/mobile/ios/Siyue.xcworkspace -scheme Siyue -configuration Debug -destination 'platform=iOS Simulator,id=9F1E3F2F-B074-498C-A87C-8F46A0E2BF5D' -derivedDataPath /tmp/siyue-ios-debug-derived CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_ENTITLEMENTS=/Users/feature/code/siyue/scripts/ios-simulator.entitlements CC=/Users/feature/code/siyue/scripts/xcode-probe/clang CXX=/Users/feature/code/siyue/scripts/xcode-probe/clang++
```
结果：退出0，BUILD SUCCEEDED；[完整日志](native-version-build.log)。产物 Info.plist 与 EXConstants.bundle/app.config 的版本均断言为 0.0.1，iPad 专用方向键仍为四方向。

`xcrun simctl install <iPad UUID> /tmp/siyue-ios-debug-derived/Build/Products/Debug-iphonesimulator/Siyue.app` 退出0；`simctl launch` 返回 PID70662。仅更新验收 iPad，没有卸载/清库，没有更新用户 iPhone。

首次启动显示开发服务器连接失败。现场 curl 和 lsof 确认8081无监听后，执行 `corepack pnpm --filter @siyue/mobile exec expo start --localhost --port 8081`，会话86489；点 Reload 后正常进入。设置实际显示0.0.1，英文暗色选择保留；再次点 Rotate 后横屏设置居中收窄、未见裁切，AX 状态不变。新包画面已人工查看：[0.0.1 横屏设置](ipad-native-001-settings.png)。此前关于版本成因未确认的记录是历史状态，现在版本差异已解决；仍不代表完整新版本功能/真机/发布验收。当前版本无先前开发警告条，但未独立诊断旧警告成因。

## 辅助大字号缺陷与修正

使用 `xcrun simctl ui <iPad UUID> content_size accessibility-extra-large`（AX3，运行时 fontScale=2.643）复现设置页标题、主题/语言按钮文字严重裁切，见 [失败截图](ipad-ax3-settings-before.png)。默认档原为 large。该问题不能由文字对比度测试发现。

范围为既有设置页局部布局修复，OpenSpec简化路径，归属0.0.1及当前主题验收，不改变文案、权限或导航。`settings-screen.tsx` 在大字号纵排时禁止子项沿纵轴收缩、关闭纵排折行，分段控件伸展到卡片可用宽度；普通字号横排保留原有收缩。保留系统字体缩放、原行高和按钮最小热区。

验证过程：取消收缩后标题首先恢复；临时 onTextLayout/onLayout 测量实际字行约63.432pt、文本盒63.5pt，说明字体/行高缩放正常。控件宽度修正后热更新曾仍保留旧测量；重新挂载设置页并移除全部诊断代码后按钮文字完整。再次从large切AX3，未复现初始裁切。截图均人工查看：[英文暗色修正后](ipad-ax3-settings-after.png)、[中文明色竖屏](ipad-ax3-settings-zh-light.png)。后者保留滚动位置，顶部AI行部分已滚出视口，不计其完整首屏验证。

实际点选明色与中文，AX checked状态与可见选中一致。完成后恢复英文、暗色及large字号。底部分组在竖屏可继续呈现，但本轮未完成滚动到底部、窄窗口、长服务名与全部键盘/VoiceOver矩阵；个人空间大字号尚待后续核实。

`corepack pnpm --filter @siyue/mobile typecheck` 通过；`corepack pnpm --filter @siyue/mobile test` 79/79通过，日志 [大字修复后的移动测试](ax3-mobile-tests.log)。这79项不包含原生文字布局断言，视觉回归依据上述失败/修复截图及实际操作。`git diff --check`通过。未重建原生包，布局JS通过Metro加载；未进行真机或发布。

## 个人空间辅助字号顶栏修复

AX3（fontScale2.643）英文暗色个人空间空状态正文正常换行，但顶栏My space被裁切。[修复前](ipad-ax3-space-header-before.png)。本地expo-router57.0.19的HeaderTitle保留字体缩放，getDefaultHeaderHeight对iPad内容区固定50pt，Header外层固定高度；项目此前仅指定背景。独立只读审查确认这些结构证据。

修改 `apps/mobile/app/(shell)/_layout.tsx`：个人空间共用顶栏仅在fontScale>1.4时采用安全区top + ceil(24×fontScale) +16 的高度，其余恢复平台默认。不改变侧栏/返回/编辑导航语义，不关闭字号缩放。JS Header原有onLayout将正文推下，不需要正文补固定占位。

实际复核：AX3竖屏与横屏的标题均完整，正文无重叠，[修复后](ipad-ax3-space-header-after.png)。恢复large后顶栏回到常规高度，空状态正常。本轮仅检查英文暗色空状态；有数据详情/编辑、中文明色与iPhone顶栏矩阵仍待补齐，不泛化为所有标题通过。属于0.0.1既有导航局部缺陷修复，OpenSpec简化路径。

移动typecheck通过，移动79项测试通过，[本轮日志](header-mobile-tests.log)，git diff --check通过。测试不包含原生布局断言，修复证明来自实际失败与复测画面。没有真实AI请求、业务数据修改、提交或发布。

## iPhone 有数据编辑的大字号修正

设备 `Siyue M1 QA`（7328BC59-6853-445B-A888-E99496AB2048，iOS26.5），中文明色，原字号large。通过现有合成目标进入详情：进度1/1，现有任务名UITest-E63FE8BBc。没有改名或勾选任务；打开编辑后保存禁用，输入等于已保存值。

AX3时旧布局的编辑标题与左右按钮争夺横向空间，保存右侧裁切，[失败截图](iphone-ax3-edit-before.png)。本地Header代码只估算固定左右占位，增加高度不能解决横向拥挤。修正个人空间：仅大字号编辑模式把编辑标题移到正文开头，导航栏留取消/保存；普通字号仍居中标题，标题语义与语言资源保留。

iPhone未接收本轮Fast Refresh，首次观察仍为旧布局。退出未修改的编辑后，经Dev Menu→Reload重连，已有目标查询保持；重新进入编辑，[当前代码修正后](iphone-ax3-edit-after.png)取消/保存完整、正文标题和输入无重叠。AX显示保存仍禁用，任务内容未变。退出编辑并恢复large。未重新安装iPhone原生包；这属于当前JS的模拟器交互验收。没有触发真实保存、AI或同步。

独立审查还指出设置页AI服务名位于横排内，不能随纵排value统一禁用收缩。因此添加仅服务名使用的横排收缩样式（minWidth0/flexShrink1），大字号允许多行，trailing按可用宽度伸展。其他纵排文字保持不压缩；长服务名原生压力场景尚未实测，不标为视觉通过。

移动typecheck、79项测试通过，日志 [编辑布局修复测试](edit-layout-mobile-tests.log)，git diff --check通过。大字号屏幕键盘、英文编辑、iPad有数据编辑、长服务名/窄窗口仍待补齐。简化修复归属0.0.1，不扩大整体版本验收。

## 屏幕键盘组合检查与新增待修项

在iPhone中文明色编辑页，Simulator菜单子项的AX索引不稳定，初次点击未显示键盘，不能算通过。关闭菜单后用Simulator `Cmd+Shift+K` 实际显示屏幕键盘，AX列出q/w/e等键及return，窗口截图已在任务中查看。普通字号下输入和顶栏操作均完整。没有选择Paste/AutoFill或使用听写，没有修改任务文本。

设置为AX3并保持编辑聚焦，取消/保存与输入可达，但“任务名称”字段标题出现局部裁切：**fail，运行中字号变化的文字测量待修**。退出未修改编辑再重入后，标题、输入、屏幕键盘完整并存，已实际查看；仅稳定进入路径可记通过，不覆盖运行中字号变化。

尝试仅按fontScale重建字段标题用于定位，未充分验证焦点与键盘保留，已撤回该临时改动，未将试验代码交付。随后恢复large字号并退出未修改编辑。当前未新增应用代码；不重复此前79项测试。本轮结果是补充真实键盘证据并登记失败，不提升整体UI验收状态。

## 动态字号字段标题修复（更新上节待修状态）

相同条件再次复现，已保留 [键盘打开时失败截图](iphone-dynamic-type-keyboard-before.png)。显式lineHeight30实验在重入后的同条件large→AX3仍失败，因此撤回，未作为修复交付。

临时onLayout诊断发现：AX3标题盒高度55.6667pt；切回fontScale1后，标题盒高度仍55.6667pt，而卡片高度已从241降到163.6667pt。可确认该节点动态尺寸未及时刷新；不据此声称已定位RN全局缓存根因。临时诊断已移除。

最小修复仅给“任务名称”的静态Text加fontScale key，触发字体档位改变时重测量；TextInput、编辑state、父容器均不重建，不增加固定高度、不禁用字号缩放。稳定进入后先确认屏幕键盘可见，再AX3→large→AX3往返，标题均完整，键盘持续可见、光标与同一输入值保留。最后large恢复后取消未修改编辑；保存未触发。见 [修复后键盘与标题](iphone-dynamic-type-keyboard-after.png)，截图已实际查看。

本缺陷在所测iPhone中文明色/屏幕键盘路径由fail更新为pass；不替代其他设备或英文矩阵。typecheck和移动79项测试通过，[日志](dynamic-type-mobile-tests.log)。原生布局依据实际失败/修复操作，79项测试本身不证明视觉正确。简化修复归属0.0.1；无提交、推送或发布。
