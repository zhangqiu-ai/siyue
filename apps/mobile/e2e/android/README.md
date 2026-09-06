# Android 原生 UI 验收宿主

独立 `com.android.application` 测试宿主包为 `app.siyue.uihost`，插桩包为 `app.siyue.uihost.test`，自动生成的 instrumentation `targetPackage` 指向宿主，**不指向思玥**。UIAutomator 跨进程操作已经安装的 `app.siyue.mobile`。用例执行 `am force-stop app.siyue.mobile` 时测试宿主继续存活，并核对原进程确实消失后才重新启动应用。

当前两个独立用例分别覆盖：

- `goalDraftConfirmationPersistenceRejectionAndManualCreation`：目标输入 → Mock 草稿不增正式目标 → 编辑目标/项目/任务且未保存时禁止确认 → 保存草稿 → force-stop/重启后显式继续 → 确认正式目标/项目/任务 → 完成任务 → 再次 force-stop/重启后同 ID、完成状态和数量保留 → 拒绝另一份草稿不增正式记录 → 手动创建目标和任务。
- `manualRenameCompletionArchiveAndRelaunch`：手动创建唯一目标和任务 → 分别改名且保留原 ID、旧名消失 → 完成任务 → 归档任务和目标 → force-stop/重启后新名、同 ID、归档状态及目标数量保留。全页检查归档对象的改名、保存、取消、归档和任务完成按钮均不存在，避免屏外按钮漏检。

每次生成唯一 `Android-<随机值>-…` 合成标题，保留数据，不运行 `pm clear`、卸载思玥或重置模拟器。从系统页首扫描到系统页尾，按标题和记录类型收集稳定 `record.id` 并去重；完整页面必须恰好存在一个匹配 ID，才允许用该 ID 定位任务按钮。屏外同名不同 ID 也会失败，不点击全局第一个按钮。页首/页尾、各类计数和空态分别使用 `siyue-page-start` / `siyue-page-end`、`siyue-count-<kind>`、`siyue-goals-empty` 固定资源标识，不能由同名用户记录替代。主滚动区限定思玥的 `siyue-main-scroll`，从页首到页尾做有界扫描以处理既有测试记录；记录过多超过扫描界限会失败，不把没找到当零记录。输入使用可访问接口 `setText` 完整替换，并核对精确值；仅在检测到输入法窗口时使用返回键收起键盘。

这是本地 Mock 路径；宿主没有网络权限，不调用真实模型或云服务。测试自身不切换设备网络。若验收实际离线，执行者须在专用模拟器运行前关闭 Wi-Fi 和移动数据，独立核验并保存网络状态证据，再执行指定用例；没有该证据的普通运行不能写作断网实测通过。请在专用模拟器执行；真机另行记录。

每次 `@Before` 固定 force-stop `app.siyue.mobile`，等待并核验其 PID 为空，再启动应用；这一步保留数据库，避免继承上次失败留下的编辑器与滚动位置，也适用于应用尚未运行的首次测试。启动后等待主滚动区、返回系统页首，再核验本机空间可用。用例中途每次持久化重启仍先断言应用进程确实存在，随后核验进程终止与宿主存活，不能用隐藏页面代替重启。

## 版本与定位依据

2026-09-06 查阅官方资料并检查实际源码：

- 独立宿主固定 **AGP 9.1.1 / Gradle 9.3.1 / JDK 17 / compileSdk 36**，使用 Java，没有 Kotlin 插件。AGP 9.1.1 官方兼容表要求 Gradle 9.3.1、JDK 17 与 Build Tools 36.0.0。[官方兼容表](https://developer.android.com/build/releases/agp-9-1-0-release-notes)
- UIAutomator 固定 **2.3.0**，AndroidX Test Runner **1.7.0**、JUnit 扩展 **1.3.0**。采用官方 Java API，不引入 2.4 alpha DSL。[UIAutomator Java 指南](https://developer.android.com/training/testing/other-components/ui-automator-legacy)、[AndroidX Test 发布记录](https://developer.android.com/jetpack/androidx/releases/test)
- RN **0.86.3** 实际 `ReactAccessibilityDelegate.kt` 将 `react_test_id` 原样赋给 `AccessibilityNodeInfoCompat.viewIdResourceName`，因此使用 `By.res("siyue-…")`，不添加假想的 `app.siyue.mobile:id/` 前缀；全部查询额外限定 `By.pkg("app.siyue.mobile")`。[对应 RN 源码](https://github.com/facebook/react-native/blob/v0.86.3/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt)

**上述 AGP 选择只属于独立宿主，不改变或证明思玥 Android 应用的 AGP/依赖兼容性。宿主编译成功也不等于应用构建或运行成功。**

## 构建宿主

先完成 Android SDK 36、Build Tools 36.0.0、JDK 17 安装，以及主工程正常 Expo prebuild。`apps/mobile/android` 是可重建的忽略目录；这里借用其已生成的 Gradle 9.3.1 wrapper，`-p` 明确指向独立工程，不修改主应用 Gradle 文件。没有该 wrapper 时先恢复主项目 prebuild，不随意换 Gradle 版本。

从仓库根目录执行；`ANDROID_HOME` 设为本机实际 SDK 目录，`JAVA_HOME` 设为已安装 JDK 17。推荐与主应用构建串行执行以降低资源竞争；SDK 组件安装期间不要并行构建。不同 Gradle 项目可在 SDK 安装完成后独立构建，各自核对结果：

```sh
apps/mobile/android/gradlew \
  -p "$PWD/apps/mobile/e2e/android" \
  --no-daemon --max-workers=2 \
  :host:assembleDebug :host:assembleDebugAndroidTest
```

输出为 `host/build/outputs/apk/debug/host-debug.apk` 与 `host/build/outputs/apk/androidTest/debug/host-debug-androidTest.apk`。仅使用本地标准 debug 签名；没有发布、签名服务、生产部署或修改思玥签名的操作。

## 在指定模拟器执行

先由主流程构建思玥 **包含本地 JS bundle** 的 Android APK，并确认所用 APK 是本次实现。Debug/Metro 构建需要另行确保运行时依赖；单纯安装宿主不会构建或安装思玥。先执行 `adb devices -l` 核对专用模拟器，再设置明确的序列号及本次实际应用 APK 路径，禁止在多设备环境使用无 `-s` 的安装/运行命令。

以下命令中的 `SIYUE_ANDROID_SERIAL` 和 `SIYUE_APP_APK` 必须由执行者设置为已核实值；`adb install -r` 保留同签名应用数据，若签名冲突应停止检查，不能用卸载或清库绕过。

```sh
: "${SIYUE_ANDROID_SERIAL:?Set the verified dedicated emulator serial}"
: "${SIYUE_APP_APK:?Set the verified Siyue APK path}"
adb -s "$SIYUE_ANDROID_SERIAL" install -r "$SIYUE_APP_APK"
adb -s "$SIYUE_ANDROID_SERIAL" install -r apps/mobile/e2e/android/host/build/outputs/apk/debug/host-debug.apk
adb -s "$SIYUE_ANDROID_SERIAL" install -r apps/mobile/e2e/android/host/build/outputs/apk/androidTest/debug/host-debug-androidTest.apk
adb -s "$SIYUE_ANDROID_SERIAL" shell am instrument -w -r \
  -e class app.siyue.uihost.GoalFlowTest#goalDraftConfirmationPersistenceRejectionAndManualCreation \
  app.siyue.uihost.test/androidx.test.runner.AndroidJUnitRunner
```

独立执行新增手动编辑与归档用例（沿用上述已核实的设备及 APK 安装步骤，结果单独保存）：

```sh
adb -s "$SIYUE_ANDROID_SERIAL" shell am instrument -w -r \
  -e class app.siyue.uihost.GoalFlowTest#manualRenameCompletionArchiveAndRelaunch \
  app.siyue.uihost.test/androidx.test.runner.AndroidJUnitRunner
```

判定成功必须检查 instrumentation 输出确实执行此用例且为 `OK (1 test)`，无失败/跳过；不能只看 adb 命令退出码。失败时不要清库重跑，先读取 XML 可访问树、截图和失败断言。运行输出会报告唯一 `m1-<UUID>` 证据目录；成功阶段和失败均保存 XML/PNG。可读取测试宿主自己的证据：

```sh
adb -s "$SIYUE_ANDROID_SERIAL" pull \
  /sdcard/Android/data/app.siyue.uihost/files/ \
  artifacts/m1/android-ui-host/
```

该目录仅属于此测试宿主，不读取思玥私有数据库；截图可能包含模拟器上已有的测试记录。保留原始 instrumentation 完整输出与本轮唯一证据目录，分别记录应用 APK、宿主 APK、设备 API/架构、用例结果。iOS、Android 模拟器、Android 真机分别验收。

## 当前验证状态

**2026-09-06：Android 专用模拟器草稿确认闭环已通过，1 用例、0 失败，336.319 秒。** 实际日志 `artifacts/m1/android-ui-cold-start.log` 记录 `goalDraftConfirmationPersistenceRejectionAndManualCreation` 和 `OK (1 test)`。设备为 `Siyue_API_36 / emulator-5554`（Pixel 8、API 36、Google APIs ARM64 镜像）。通过范围是 Mock 草稿、明确确认、正式目标/项目/任务、任务完成、进程终止后持久化、拒绝与手动创建；Android 真机未运行，此次通过不包含改名/归档或主动断网验证。

**手动路径离线验收也已独立通过，1 用例、0 失败，325.679 秒。** `artifacts/m1/android-ui-offline-rename.log` 记录 `manualRenameCompletionArchiveAndRelaunch` 与 `OK (1 test)`，覆盖离线手动创建、目标/任务改名同 ID、任务完成、归档及 force-stop/重启后同 ID、新名、状态、数量和只读按钮验证。该次使用 29 秒构建的最新宿主（`artifacts/m1/android-uihost-rename-archive-build-20260906.log`，61 tasks、5 executed），测试 APK 安装日志 `artifacts/m1/android-host-rename-install.log` 返回 `Success`，思玥应用 APK 沿用此前版本。这是两个用例分别运行通过，不是同一次运行 2/2；手动路径断网证据不能推广到 Mock 全流程、丢回执场景或 Android 真机。

执行者在专用 `emulator-5554` 上关闭 Wi-Fi 与移动数据；`artifacts/m1/android-offline-connectivity-before.log`、`artifacts/m1/android-offline-connectivity-during.log`、`artifacts/m1/android-offline-connectivity-after.log` 均记录 `Active default network: none`，`artifacts/m1/android-offline-probe.log` 记录 `connect: Network is unreachable`。测试自身未更改网络。测试后已恢复 Wi-Fi 和移动数据，复查 `wifi_on=1`、`mobile_data=1`；`artifacts/m1/android-offline-connectivity-restored.log` 记录默认网络恢复为 `104`。

离线用例原始证据目录为 `m1-6115a5ea-5be8-4860-bf28-cbf1fd6f2464`，已取回至 `artifacts/m1/android-offline-rename-passed/`，包含 `manual-renamed-and-completed`、`manual-renamed-and-archived`、`archived-records-retained-after-relaunch` 三组 XML/PNG。XML 可核对本轮任务先完成再归档，以及重启前后目标/任务同 ID、已归档状态；完整页旧名消失、唯一性和按钮缺失以实际用例断言为证据。

两次通过运行均使用应用原生构建重试成功的 APK（`artifacts/m1/android-app-build-retry.log`：`BUILD SUCCESSFUL in 10m 56s`），包含本地 JS bundle，使用本地 debug 签名；应用已安装。独立宿主初次构建通过（`artifacts/m1/android-uihost-build.log`：`BUILD SUCCESSFUL in 4m 22s`，61 tasks），随后定位修复重编译。草稿确认用例通过时使用 `artifacts/m1/android-uihost-cold-start-fix-20260906-0210.log` 对应的宿主与测试 APK（`BUILD SUCCESSFUL in 27s`，61 tasks、4 executed），均已重新安装后运行。`pm list instrumentation` 已核验 `target=app.siyue.uihost`，Java 语法、Manifest XML 与 diff 检查也已执行。

复现使用上方指定模拟器的安装与 instrumentation 命令。草稿确认用例原始证据目录为 `m1-f4bda402-8b07-45a4-96d4-a4ff413038af`，已取回至 `artifacts/m1/android-ui-passed/`，保留 `confirmed-and-completed`、`relaunch-preserved-records`、`manual-saved-rejected-absent` 三组 XML/PNG。前两组 XML 中的目标、项目、任务 ID 一致，任务状态均为“已完成”；完整页唯一性、数量和拒绝不新增等断言以完整 instrumentation 用例通过为证据，单张截图不替代这些断言。

## 失败与修复历史

首轮 `artifacts/m1/android-ui-test.log` 记录 1 用例、1 失败、29.049 秒：草稿已生成，测试查询却将所有文本限制为 `android.widget.TextView`，漏掉 RN `accessibilityRole=header` 暴露的 `android.view.View`。失败 XML 和截图保存在 `artifacts/m1/android-ui-host/m1-0c530ee3-6a31-4c8c-a449-3e5132dfaece/`。此轮没有通过完整闭环。

已仅修复宿主的只读文本查询，不限制原生类；按钮、输入、系统锚点和全页记录唯一性约束均保留。宿主重编译通过：`artifacts/m1/android-uihost-heading-fix-1788633290008.log` 为 `BUILD SUCCESSFUL in 25s`（61 tasks，4 executed）。随后安装并复测仍失败：`artifacts/m1/android-ui-heading-fix.log` 记录 1 用例、1 失败、25.675 秒；应用恢复了上轮底部位置，初始化等待的本机空间提示在屏外。证据位于 `artifacts/m1/android-ui-host/files/m1-958f20b4-50e2-4a04-8ac5-ac7dffc81748/`。

初始化随后增加保留数据库的冷启动，并在等待本机空间前回到系统页首；安装最新宿主后才得到上述实际通过结果。前两次失败不计作通过，原始数据和失败证据均保留。本轮定位与初始化修复未修改 iOS XCTest 或思玥应用代码；模拟器通过不能替代真机验收。
