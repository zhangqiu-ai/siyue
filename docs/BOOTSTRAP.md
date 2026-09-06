# M1 工程运行与验证记录

日期：2026-09-06。开发分支：`feature/dev`。当前交付为本地 Mock 目标闭环，尚未达到 M1 全平台验收。

## 当前实现

- 移动：Expo + React Native 界面，通过 `expo-sqlite` 独占事务调用共享命令服务。
- 桌面：Electron + React；数据库和可信身份留在主进程，Renderer 经受限 IPC 操作。
- 共享：Domain / Contracts / AI / Adapters；运行时 schema、草稿、参数与版本绑定审批、命令回执、幂等和空间权限。
- 存储：受限单设备 SQLite 快照实现，正式对象、活动、审批和回执一致提交；未知版本或损坏数据拒绝打开，不覆盖原始数据。
- AI：确定性本机 Mock，不联网、不调用付费模型；Node + Fastify 提供独立的 loopback Mock 开发服务，移动与桌面本地闭环无需先启动它。

这里的移动端 **Hermes** 是 React Native 的 JavaScript 引擎；`.hbc` 是其字节码。没有引入 Hermes Agent 框架。AI SDK 7 的结构化输出及工具审批契约通过离线测试替身验证，不代表真实供应商已接入。

## 依赖与可复现安装

版本声明以各 `package.json` 为准，完整解析以 `pnpm-lock.yaml` 为准。首轮实际 shell 为 Node `22.22.3`，通过 `corepack pnpm` 使用项目声明的 pnpm `11.25.0`；本机 PATH 中直接 `pnpm` 是 `11.19.0`，建议复现时使用 Corepack 命令。

| 组件 | 验证使用版本 |
|---|---:|
| TypeScript | 6.0.3 |
| Expo / Router | 57.0.20 / 57.0.19 |
| React / React Native | 19.2.3 / 0.86.3 |
| Electron / Vite | 44.2.0 / 8.2.2 |
| AI SDK / Fastify / Zod | 7.0.92 / 5.12.3 / 4.5.4 |
| 桌面验证 Playwright | 1.62.1 |

在仓库根目录执行：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

不需要修改全局 pnpm 或 Node。pnpm 11 的 esbuild 安装脚本已在 `allowBuilds` 明确允许；测试和构建遇到过期依赖会报错，先显式安装，不自动修改依赖树。Electron 44 在首次运行时下载自己的二进制，锁文件安装成功不等于该下载已完成。

## 开发入口

```sh
corepack pnpm dev:mobile
corepack pnpm dev:server

# 桌面开发分别在两个终端执行：
corepack pnpm dev:desktop:renderer
corepack pnpm dev:desktop:electron
```

这些入口先构建共享包。修改 `packages/*` 源码后重新执行 `corepack pnpm build:packages`，应用热更新以编译产物为输入。共享包统一导出 ESM 编译结果；避免 Metro 把源 TypeScript 中的 `.js` 相对导入当成缺失文件。

服务端仅监听 `127.0.0.1`，默认端口 8787。`/health`、`/v1/ai/capabilities` 和 `/v1/ai/mock-plan` 是受限开发接口，明确没有生产鉴权，不应向公网暴露。

## 验证入口与边界

```sh
corepack pnpm peers check
corepack pnpm --filter @siyue/mobile exec expo install --check
corepack pnpm bundle:mobile
corepack pnpm test:storage-poc
corepack pnpm test:desktop-smoke
```

- `build`：编译共享包、服务端与桌面 Renderer，不生成移动原生安装包或桌面发行安装包。
- `bundle:mobile`：输出 iOS/Android JavaScript 与移动端 Hermes 字节码；不能替代模拟器、真机或原生构建。
- `test:storage-poc`：11 个隔离 Node SQLite 原型测试，全部使用临时合成数据。
- `test:desktop-smoke`：启动真实 Electron，验证草稿编辑与重启恢复、确认保存、任务完成与重启、拒绝、手动创建及受限 IPC。输出 `artifacts/m1/desktop-smoke.json` 与截图；数据库位于独立临时目录，不操作个人常用数据库。

桌面实际运行时：macOS arm64，Electron `44.2.0`、Node `24.20.0`、Chromium `152.0.7977.76`、SQLite `3.53.4`。shell Node 的 SQLite `3.51.3` 测试与 Electron 测试分别记录。

## 已发现并修复的工程问题

1. 初次安装被 esbuild 未批准脚本阻断，已设置特定允许项，未全面开放安装脚本。
2. 自动解析的 Worklets / Reanimated / Metro peers 与 Expo SDK 不匹配，按 Expo 包内 `bundledNativeModules.json` 对齐，`peers check` 通过。
3. 原始 TypeScript 7 声明未通过 Expo 兼容检查，调整为 Expo 建议的 `6.0.3`，兼容检查和实际构建通过。
4. 共享包仅导出 TypeScript 源文件会影响服务端发行启动；源文件 NodeNext `.js` 导入又导致 Metro 解析失败。现统一编译 ESM，并让依赖按构建顺序执行。
5. 桌面 Vite 产物需要相对资源路径；已配置 `base: './'` 并用真实 `file://` 窗口验证。
6. 手工写入丢响应后生成新命令可能重复创建；已增加稳定命令标识及先对账后重试的测试。

## 尚未验证或尚未完成

- 初次检查只有 Command Line Tools；2026-09-06 重新检查已有完整 Xcode 26.6、iOS 26.5 模拟器及已连接的 iPhone。iOS 模拟器原生构建与完整 UI 闭环已通过，iPhone 16 Pro Max（iOS 26.6.1 / 23G83）已恢复USB连接，两条核心UI路径分别有通过证据：草稿闭环142.692秒、改名/完成/归档重启125.001秒；首轮整套为1通过1失败，不能写同次2/2。 故障与后台场景仍未验收，结果见验证报告；Android 已完成 prebuild、JDK/命令行工具与 Gradle 启动验证；SDK 平台和模拟器组件已安装，专用 Siyue_API_36 / emulator-5554 已启动；独立 UI 宿主构建和两份 APK 安装通过，instrumentation target 已核验为 app.siyue.uihost，原生应用重试构建、APK 签名校验与安装通过；Android 模拟器两条独立 UI 用例分别通过（各1项0失败，336.319/325.679秒），第二条验证真实断网下手动改名/完成/归档与重启保留；iPhone现已恢复连接并通过两条核心路径，Android真机、iPhone故障/后台与M1全平台验收未完成。
- SQLite 适配是可替换的单设备验证实现，整空间 JSON 快照尚未验证大数据性能、断电恢复、数据库加密或生产同步。PowerSync 仍未采用。
- Windows、桌面签名、自动更新及桌面发行包未验证；只验证 macOS 上实际 Electron 应用。
- 没有真实模型、远程 AI 鉴权、平台密钥、账号登录或同步；个人密钥安全存储与生产授权仍属于后续工作。
- M1 的完整状态与剩余项见 [backlog.md](backlog.md)，测试证据见 [evidence/m1-validation.md](evidence/m1-validation.md)。

## iOS 原生验证准备（2026-09-06）

现场重新检测已具备 Xcode `26.6`（`17F113`）、iOS `26.5` SDK 与模拟器运行时。已连接的 iPhone 16 Pro Max 使用 iOS `26.6.1`，已配对并开启开发者模式。生成工程、安装 Pods、设备可见均不能单独证明原生测试通过。

已执行 `corepack pnpm --filter @siyue/mobile exec expo prebuild --platform ios --no-install`，仅生成被 Git 忽略的 `apps/mobile/ios`，未改应用清单。安装 CocoaPods `1.17.0` 后，从 `apps/mobile/ios` 执行：

```sh
LANG=en_US.UTF-8 SSL_CERT_FILE=/opt/homebrew/etc/ca-certificates/cert.pem pod install
```

本机 Homebrew OpenSSL 默认 `cert.pem` 未生成，首次 Pods 安装证书校验失败；显式使用 Homebrew 已生成的 CA 证书集后成功，未关闭 TLS 校验。此路径为本机环境修复，不要求其他机器照抄。CocoaPods 安装已完成，但 Homebrew 的 OpenSSL postinstall 仍报告失败，单独记录，不能视为整个工具链环境无异常。

项目当前 pnpm 在设置 `CI=1` 时会报 `enableGlobalVirtualStore` 与已安装布局不一致；保持与安装时相同的环境运行，本轮未降低 `verifyDepsBeforeRun` 检查。iOS 界面测试准备及准确命令见 [mobile/e2e](../apps/mobile/e2e/README.md)，构建和测试结果继续登记到验证报告。

本机 Xcode 的 clang 宏探测在输出管道阻塞；已用[默认关闭的命令级绕行工具](../scripts/xcode-probe/README.md)推进编译。8 组探测的 stdout、stderr、退出码等价验证通过。Expo JSI 嵌套构建需单独预构建，且 `REACT_NATIVE_PATH` 必须与应用构建解析到的真实路径相同，才能命中缓存。已验证模拟器和 iPhone slice 构建及缓存命中；随后模拟器应用构建与两条独立 UI 用例分别通过（每次 1 项、0 失败），包含改名/归档用例的 iPhone arm64 开发签名 build-for-testing 也已通过，应用与测试 Runner 的 codesign 验证通过；当时设备unavailable；后续USB连接恢复后两条iPhone核心UI路径分别通过，故障/后台仍未验收。准确通过命令与历次失败定位记录见验证报告。

依据：[Expo 本地构建](https://docs.expo.dev/guides/local-app-overview/)、[CocoaPods 安装](https://guides.cocoapods.org/using/getting-started.html)。

## 依据

- [Expo SDK 兼容表](https://docs.expo.dev/versions/latest/)、[Expo Router 安装](https://docs.expo.dev/router/installation/)、[Expo monorepo](https://docs.expo.dev/guides/monorepos/)。包内兼容表及 `expo install --check` 为本次版本对齐的实际依据。
- [pnpm 11 变更](https://github.com/pnpm/pnpm.io/blob/main/blog/releases/11.0.md)、[构建与依赖检查设置](https://pnpm.io/settings/build)。
- [Electron 安全](https://www.electronjs.org/docs/latest/tutorial/security)、[Playwright Electron](https://playwright.dev/docs/api/class-electron)。
- [存储研究及原生工具检查](evidence/m1-storage-research.md)、[SQLite 原型结果](../experiments/storage/results.md)。


## Android 原生验证准备（2026-09-06）

用户已明确授权接受本次 Android SDK / ARM64 模拟器所需许可并继续安装。仅接受指定组件要求的 `android-sdk-arm-dbt-license` 与 `android-sdk-license`；未批量接受无关 Google TV 等许可。SDK 安装命令已退出 0；这不能作为应用构建通过证据。

已执行：

```sh
HOMEBREW_NO_AUTO_UPDATE=1 brew install openjdk@17
HOMEBREW_NO_AUTO_UPDATE=1 brew install --cask android-commandlinetools
corepack pnpm --filter @siyue/mobile exec expo prebuild --platform android --no-install
```

JDK 实测为 Homebrew OpenJDK `17.0.19+0`，命令行工具 `sdkmanager --version` 为 `20.0`。JDK 安装命令因 glib post-install 警告退出 1，但 JDK 自身能运行，实际 `./gradlew --version` 退出 0：Gradle `9.3.1`、JVM `17.0.19`、macOS aarch64。未添加系统 Java 符号链接或修改全局 shell 配置。证据：本机 `artifacts/m1/android-jdk-install.log`、`android-commandlinetools-install.log`、`android-gradle-version.log`。

Android prebuild 仅生成被忽略的原生目录，报告 package.json 无变更。出现 `userInterfaceStyle` 需要 expo-system-ui 的提示，该主题能力尚未验收，不能因 prebuild 通过宣称 Android 应用可用。

本机后续命令使用：

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

sdkmanager --install \
  'platform-tools' 'platforms;android-36' 'build-tools;36.0.0' \
  'ndk;27.1.12297006' 'cmake;3.30.5' \
  'emulator' 'system-images;android-36;google_apis;arm64-v8a'
```

compile/target SDK 36、Build Tools 36.0.0、NDK 27.1.12297006 来自已安装 RN 0.86.3 的版本声明；CMake 3.30.5 与 RN 的源码构建配置对齐。JDK 17 参考 [Expo Android 环境](https://docs.expo.dev/workflow/android-studio-emulator/) 和 [AGP 兼容表](https://developer.android.com/build/releases/agp-8-12-0-release-notes)。原命令重试的 Release 构建已通过，确认了本次 Gradle/AGP/应用组合的构建结果，不代表原生 UI 已通过。SDK 包安装与许可流程依据 [sdkmanager 文档](https://developer.android.com/tools/sdkmanager) 和 [Google SDK 许可](https://developer.android.com/studio/terms)。


安装后 `sdkmanager --list_installed` 核实：平台 API 36 revision 2、Google APIs ARM64 镜像 revision 7、Emulator 37.1.11、Platform Tools 37.0.1、Build Tools 36.0.0、NDK 27.1.12297006、CMake 3.30.5；见 `artifacts/m1/android-sdk-installed.log`。`emulator -accel-check` 退出 0，确认 Hypervisor.Framework 可用。

已创建专用 `Siyue_API_36`（Pixel 8）AVD，不覆盖既有设备、不清数据。第一次在 platform-tools 安装前提前启动失败；组件安装结束后重新启动，使用 `-no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader`，保留独立日志 `android-emulator-ready.log`；已确认 `emulator-5554` 启动完成，日志记录 `Boot completed in 67730 ms`。当前应用原生构建命令（从 `apps/mobile/android` 执行）为：

```sh
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
ANDROID_HOME=/opt/homebrew/share/android-commandlinetools \
./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a \
  -Pandroid.cmakeVersion=3.30.5 --no-daemon --max-workers=4
```

此处 Release 用于内嵌 JS、独立于 Metro 的本机测试；生成模板使用本地 debug 签名，不是生产发布包。首轮 `artifacts/m1/android-app-build.log` 因下载 appcompat 1.7.1 AAR 时 TLS 握手中断而失败（18 分 30 秒、121 tasks）；未修改依赖或禁用 TLS，沿用原命令重试的 `android-app-build-retry.log` 退出 0，`BUILD SUCCESSFUL in 10m 56s`，495 tasks（380 executed、115 up-to-date）。独立 UI 验收宿主见 [Android e2e](../apps/mobile/e2e/android/README.md)。宿主构建已通过（`android-uihost-build.log`：`BUILD SUCCESSFUL in 4m 22s`，61 tasks），宿主与测试 APK 均以 `adb install -r` 安装成功，`pm list instrumentation` 已核验 target 为 `app.siyue.uihost`。思玥 APK 已独立核验：包名 `app.siyue.mobile`、版本 `0.1.0` / code `1`、minSdk `24` / targetSdk `36`，ARM64，包含 `assets/index.android.bundle`；`apksigner verify` 退出 0，SHA-256 记录于 `android-app-apk-sha256.log`，应用安装日志 `android-app-install.log` 返回 `Success`。

Android UI 首次执行日志为 `artifacts/m1/android-ui-test.log`：1 项、失败 1 项、29.049 秒，失败位于草稿标题定位（当时 `GoalFlowTest.java:80`）。随后 `android-ui-heading-fix.log` 第二轮执行 1 项失败（25.675 秒），原因是在 `@Before` 继承上次页面底部位置。仅修测试宿主：文本查询不限定 TextView 类，启动后等待主滚动区、回页首再检查本机空间，`@Before` 对固定思玥包 force-stop 并核验 PID 消失；原有中途 force-stop/重启断言保留，未清空数据。

最终宿主构建 `android-uihost-cold-start-fix-20260906-0210.log` 27 秒通过并安装，测试 APK hash 见 `android-tested-host-sha256.log`。`android-ui-cold-start.log` 最终退出 0，`Time: 336.319`、`OK (1 test)`，1 项、0 失败；通过草稿编辑保存、force-stop后显式继续与确认、正式目标/项目/任务、任务完成后重启同ID/状态/数量保留、拒绝不增记录与手动创建。三阶段截图和 XML 位于 `artifacts/m1/android-ui-passed/`，准确复现命令与失败史见 [M1 验证记录](evidence/m1-validation.md)。第二条Android独立用例 `manualRenameCompletionArchiveAndRelaunch` 已在真实断网下通过（325.679秒、1项0失败），验证手动改名同ID/旧名全页不存在、完成后归档、force-stop重启同ID/名称/状态/数量保留和归档只读。对应宿主构建29秒通过，应用APK沿用未变；日志 `android-ui-offline-rename.log`、host hash `android-offline-rename-host-sha256.log`、三阶段截图/XML `android-offline-rename-passed/`。Wi-Fi/移动数据从1/1关闭为0/0，before/during/after均无默认网络，探测返回Network unreachable；之后恢复1/1且默认网络104，准确操作与恢复命令见验证记录。两条Android用例分别执行，不能写同次2/2；移动真机、正常用户UI错误交互、取消/升级故障及 M1 全平台仍未完成，工作包不提升。

### 2026-09-06 iOS / Android 独立 QA 丢回执恢复

iOS与Android独立QA应用均复用正常原生客户端工厂，真实SQLite提交后丢响应/回执暂不可读、终止进程后对账分别通过（iOS 43.191秒、Android 12.053秒，各1项0失败）；恢复execute=0，同commandId/issuedAt/对象ID/完整快照hash不变，pending只在原回执验证后清除。每个平台两条正常用户UI用例与一条QA用例分别执行，不是同次3/3；不代表正常用户UI错误交互、真机、物理断电、生成取消/后台中断或升级通过，也不自动恢复表单。 正常默认数据库与命令语义保留，QA为显式独立入口及包名。构建、JSON、截图和准确复现命令见 [M1 验证记录](evidence/m1-validation.md)。工作包与跨阶段AT状态不提升。

iOS QA日志为 `ios-native-recovery-compile-fix.log`（43.191秒、1项0失败），首轮Swift `isEmpty()` 编译错误修复史及六份JSON/PNG/辅助功能树TXT附件见上述验证记录；QA与正常target共享Pods生成文件，需串行构建。正常iOS Release重建及模拟器安装/启动也已通过；bundle标记检查与正常界面截图符合预期，仅属正常启动检查，非source map证据或完整UI重跑。本轮无新增真机签名。
