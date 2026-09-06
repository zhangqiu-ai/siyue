# 本机 Xcode 探测管道的可选绕行工具

**默认不启用。** 仅在本机复现 `CreateBuildDescription` 阶段 clang 的 `-v -E -dM ... -c /dev/null` 管道阻塞时，按下述命令临时使用。它不修改 Xcode、SDK、应用工程、系统设置或依赖源码。

2026-09-06 在 macOS 26.6.2（25G83）、Xcode **26.6（17F113）** 上观察到：同一探测独立运行成功，SwiftBuild 内的探测却卡在 stderr 写入；串行重试仍复现。临时版本缓冲真实编译器输出，并在写完 stdout 后关闭它，再写 stderr，实际让构建跨过探测并进入 Pods 编译。仅合并写入但不关闭 stdout 的版本未奏效。此现象支持流读取顺序相关的诊断，但尚未定位或证明上游具体缺陷，不代表所有 Xcode 都需要此工具。

`clang` / `clang++` 是指向 `wrapper.py` 的符号链接。只有包含 `-v -E -dM` 且末尾为 `-c /dev/null` 的探测会被缓冲；每个流的字节、参数和退出码保持一致，但跨流时序改变。其他编译调用直接执行真实同名驱动。工具通过绝对路径 `/usr/bin/xcrun --find` 解析当前所选 Xcode 的驱动，遵循 `DEVELOPER_DIR`，并拒绝递归到自身。运行需要 `/usr/bin/python3`。

## 验证与单次构建

在仓库根目录运行：

```sh
/usr/bin/python3 scripts/xcode-probe/verify.py
```

验证覆盖 clang / clang++ 各四种语言的 8 组探测，比较原工具与 wrapper 的 stdout、stderr 和退出码；验证器故意先读 stdout 到 EOF 再读 stderr。同时检查非探测 `--version` 直通、xcodebuild 查询直通及 shim 参数规则。此命令不启动应用构建。

对本次构建显式传入工具路径（可将以下 `build` 参数替换为实际测试命令）：

```sh
SIYUE_PROBE_BIN="$PWD/scripts/xcode-probe"
/usr/bin/xcodebuild build \
  -workspace apps/mobile/ios/Siyue.xcworkspace \
  -scheme Siyue -configuration Release \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  CC="$SIYUE_PROBE_BIN/clang" CXX="$SIYUE_PROBE_BIN/clang++"
```

取消这些命令级参数即可停用。不要把它设置为全局 CC/CXX，不要替换 SDK 内的编译器。

## Expo JSI 的嵌套构建

已装 `expo-modules-jsi` 57.0.8 的 `apple/scripts/build-xcframework.sh` 使用 `env -i` 启动嵌套 xcodebuild，丢弃父构建的 CC/CXX，但保留 PATH。本目录的 `xcodebuild` shim 仅为显式 `build`、`test`、`archive` 等构建动作补充 CC/CXX；已有显式 CC/CXX 保留，`-version`、`-list`、`-create-xcframework` 等操作直通。需要显式写出构建动作；无动作的隐式 build 不注入。

若嵌套构建也复现阻塞，可先在没有其他本任务构建运行时预构建所需模拟器 slice，再运行主构建。以下从已安装的 mobile → expo → expo-modules-core 依赖链解析 **实际使用** 的 JSI 包，避免 pnpm 多个 peer 变体的 glob 歧义：

```sh
SIYUE_PROBE_BIN="$PWD/scripts/xcode-probe"
SIYUE_JSI_SCRIPT="$(node <<'JS'
const { createRequire } = require('node:module');
const path = require('node:path');
const mobile = createRequire(path.resolve('apps/mobile/package.json'));
const expo = createRequire(mobile.resolve('expo/package.json'));
const core = createRequire(expo.resolve('expo-modules-core/package.json'));
console.log(path.join(path.dirname(core.resolve('expo-modules-jsi/package.json')), 'apple/scripts/build-xcframework.sh'));
JS
)"
SIYUE_RN_ROOT="$(node -e 'const {createRequire}=require("node:module");const p=require("node:path");const r=createRequire(p.resolve("apps/mobile/package.json"));console.log(p.dirname(r.resolve("react-native/package.json")))')"
env -i HOME="$HOME" PATH="$SIYUE_PROBE_BIN:$PATH" \
  PODS_ROOT="$PWD/apps/mobile/ios/Pods" REACT_NATIVE_PATH="$SIYUE_RN_ROOT" \
  DEVELOPER_DIR="${DEVELOPER_DIR:-$(/usr/bin/xcode-select -p)}" \
  PLATFORM_NAME=iphonesimulator /bin/bash "$SIYUE_JSI_SCRIPT"
```

这里必须设置 `REACT_NATIVE_PATH`，不能只设置 `RN_ROOT`：依赖脚本会根据前者重新计算 `RN_ROOT`，且其缓存 hash 包含该路径。使用与主 Xcode 构建相同的 React Native 真实包目录，才能避免同一目录的不同路径别名造成缓存失效。

临时同等 shim 已使本机 Expo JSI 模拟器 slice 在约 31 秒内退出 0；完整应用及真机验收须单独记录。预构建会生成该依赖本来的缓存/产物，未改其脚本。这里不自动清缓存、不停止进程，也不隐藏真实编译错误。

当前诊断证据保存在仓库本机 `artifacts/m1/`：`clang-probe-diagnosis.md`、`buffered-probe-sample.txt`、`clang-wrapper-eof-equivalence.json`、`ios-simulator-eof.log`、`ios-jsi-simulator.log`。这些是本次执行记录，不是跨环境保证。
