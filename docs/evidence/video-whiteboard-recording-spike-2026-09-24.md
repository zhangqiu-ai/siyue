# 视频白板录像合成实验（任务 2.5 / V13 的合成媒体部分）

日期：2026-09-24。变更：add-family-video-whiteboard。工作包：SY-022。目标版本：0.0.1。

状态：**部分完成**。本实验只在 macOS 上用合成媒体验证一件事：能否把「白板主画面 + 多路参与者小画面 + 本地与远端两路声音」写成**一个本地文件**，并由另一段程序从成品读回可核对的视频轨、音频轨、持续时间/时间戳与关键帧画面。全程无供应商、无 RTC、无外部副作用。

第 2 轮（同日晚间）已定位「写入停在原地」的根因并修复写入驱动：改用 AVFoundation 文档要求的 `requestMediaDataWhenReady`，另加**有界**整 writer 重建。根因、修复与复跑记录见第 5.2 条更正、第 8 节与第 9 节。

tasks 2.5 与 V13 **保持未完成**。本实验不能证明 RTC 真实流、Expo/Android/Electron 采集路径、系统后台中断，也不能替代五设备验收。

## 1. 授权与边界

- 隔离要求：只新增 scripts/video-whiteboard-recording-spike/ 与本文件；未修改产品代码、package.json、现有测试或其他文档；仓库工作区其他改动均为本轮之前已存在。
- 只用合成数据：帧与音频都在实验进程内生成；不打开摄像头/麦克风、不做屏幕录制、不联网、不上传、不读取任何真实家庭数据。
- 输出隔离在 /tmp（/tmp/siyue-video-whiteboard-spike）；仓库内不保存媒体产物。
- 现场 ffmpeg/ffprobe 不在 PATH，未安装；实验使用 macOS 原生 AVFoundation + CoreGraphics/ImageIO。
- 环境：macOS 26.6.2（arm64）、Xcode 27.0、Apple Swift 6.4（swiftlang-6.4.0.34.1）、macOS SDK 27.0。

## 2. 方法

生成器与验证器共用确定性规格（Sources/Spec.swift），验证器使用**解析式期望值**而不是回放生成缓冲区。三种模式：

| 模式 | 内容 | 对应 C10 |
| --- | --- | --- |
| whiteboard | 白板主画面（网格、合成题图、3 秒内逐渐画出的笔迹、按时间滑动 40px 指针）+ 3 路参与者小画面（各自不同色相）+ 本地与远端混音 | 有白板时「白板为主画面、参与者视频为小画面」 |
| grid | 无白板形态：2x2 四路参与者画面 + 同一套混音 | 无白板时「记录多人视频及声音」 |
| negative | 阴性对照：同样 6 秒、同样 180 帧，但只有单一灰色画面且**没有音轨**，用于证明验证程序会拒绝不合格成品 | 反例 |

音频时间线（两条互相独立、可分别读回的音源，48 kHz 立体声）：

| 时间段 | 本地总线 | 远端总线 |
| --- | --- | --- |
| 0–2 s | 440 Hz 正弦 | 静音 |
| 2–4 s | 静音 | 1200 Hz + 1800 Hz |
| 4–6 s | 440 Hz | 1200 Hz + 1800 Hz |

验证维度：轨数量与编解码格式、视频/音频时长与起始时间、视频呈现顺序时间戳（帧数、1/30 s 间隔、断点）、解码后帧数、音频采样数与峰值、按窗口 Goertzel 判定三条音调是否按时间线出现、以及关键帧画面中白板/题图/笔迹进度/指针位置/每路小画面颜色与亮度调制是否符合设计。视频 H.264（avc1）、音频 AAC（48 kHz 立体声）、封装为单个 .mov。

## 3. 命令与本机结果

```bash
./scripts/video-whiteboard-recording-spike/run-spike.sh
# 等价于
xcrun swiftc -O -swift-version 5 -o /tmp/vwspike-build/video-whiteboard-spike \
  $(find scripts/video-whiteboard-recording-spike/Sources -name '*.swift' | sort)
/tmp/vwspike-build/video-whiteboard-spike all --output-dir /tmp/siyue-video-whiteboard-spike
```

通过的一次运行：退出码 0，**71/71 检查通过、0 失败**；阴性对照 7/7 必需失败全部出现，且另外出现 9 项内容失败（共 16 项）。交叉检查：把 whiteboard 成品按 grid 期望验证时退出码为 1，说明验证程序不是无条件通过。

主代理在最终代码状态另以 `SPIKE_OUTPUT_DIR=/tmp/siyue-video-whiteboard-spike-qa ./scripts/video-whiteboard-recording-spike/run-spike.sh` 独立复跑，退出码 0、**71/71**、阴性对照通过；输出与报告位于该独立临时目录，命令日志 `/tmp/siyue-video-whiteboard-spike-qa.log`。这是一次成功样本，不抵消下文已复现的间歇超时。

关键实测值（完整列表见输出目录 report.json）：

| 检查 | 期望 | 实测 |
| --- | --- | --- |
| 容器时长 | 6.00 s ±0.15 | 6.000 s |
| 视频轨 / 音频轨 | 各 1 条 | 1 / 1 |
| 视频格式 | 1280x720 avc1 | 1280x720 avc1 |
| 音频格式 | 48000 Hz、2 声道、aac | 48000 Hz、2 声道、aac |
| 视频帧数（编码帧 / 解码帧） | 180 | 180 / 180 |
| 视频帧间隔中位数 | 0.03333 s ±0.004 | 0.03333 s |
| 视频首帧时间 | 0.0000 s ±0.050 | 0.0000 s |
| 视频与音频轨时长差 | ≤ 0.10 s | 0.000 s（两轨起始时间同为 0.0000 s） |
| 音频采样数 | 288000 | 288000；峰值 0.972（未削顶） |
| 0.25–1.75 s | 仅 440 Hz | 440 Hz 0.500、1200 Hz 0.000、1800 Hz 0.000 |
| 2.25–3.75 s | 仅 1200/1800 Hz | 440 Hz 0.000、1200 Hz 0.280、1800 Hz 0.280 |
| 4.25–5.75 s | 三者同时存在 | 440 Hz 0.498、1200 Hz 0.278、1800 Hz 0.278 |
| 4.05–4.40 s（远端总线回来之后） | 两者都在 | 440 Hz 0.498、1200 Hz 0.277、1800 Hz 0.278 |
| 两路音源单独读回 | 各自只含自己的音调，另一段静音 | 本地总线 440 Hz 0.500、远端 0.000；远端总线 1200/1800 Hz 0.280、440 Hz 0.000；静段峰值 0.00000 |
| 白板区域保持白色比例 | ≥ 0.60 | 1.000 |
| 笔迹进度（0.5 s 起点 / 0.5 s 末端 / 3.5 s 末端） | 起点已画、末端未画、3.5 s 已到末端 | 0.190 / 0.000 / 0.180 |
| 指针位置（0.5 s / 3.0 s） | 按设计位置出现深色方块 | x=106.7、深色占比 1.000；x=340.0、深色占比 1.000 |
| 相邻帧差异 | > 0.0005 | 0.00180（whiteboard）、0.00639（grid） |
| 每路小画面颜色 | 与「基色 × 亮度」相差 ≤ 0.12 | 最大偏差 0.035–0.050 |
| 小画面可区分 | 最近色相模板等于自身 | 分类 [local, remote-1, remote-2]，边界 0.5783 / 0.4559 / 0.4462 |
| 每路小画面亮度随时间变化 | 实测跨度 ≥ 期望的 50% | 本地 0.424/0.450、远端 0.357/0.374 等 |

产物（全部在 /tmp，仓库不保存媒体）示例：whiteboard-call.mov 287055 字节（sha256 9f997ea9…517b）、multi-video-call.mov 131901 字节、negative-control-solid.mov 13497 字节、audio/local-bus.wav 与 audio/remote-bus.wav 各 1156096 字节、frames/ 下 6 张白板/网格关键帧与 3 张阴性对照关键帧。注意：同一模式两次运行的 .mov **字节数完全相同但 sha256 不同**（容器内带时间元数据），可复现性以检查项为准，不以容器字节哈希为准。

## 4. 主代理独立交叉核验（本轮补充）

维护者侧的主代理在本机对同一成品做了三项**独立于实验代码**的核验，结论与第 3 节一致：

1. 直接查看 frames/whiteboard-pip-t02.50s.png：可见白板主体与三个不同颜色的视频小画面，与「白板主画面 + 多路小画面」的布局一致。
2. afinfo whiteboard-call.mov 独立报告：音频轨为 2 ch / 48000 Hz AAC、1024 frames/packet、284 packets，estimated duration **6.058667 s**，即 290816 个解码帧。
3. afconvert -f AIFF -d BEI16@48000 解码后，用独立 Python/aifc DFT 检查：0.5 s 段 [440=8186, 1200=0, 1800=0]、2.5 s 段 [0, 4582, 4583]、4.5 s 段 [8163, 4552, 4556]，即「前段只有本地音、中段只有远端双音、后段三音源同时存在」。

**关于 6.058667 s 与 6.000 s 的差别必须如实说明**：6.000 s / 288000 samples 来自容器时间线（本实验的 AVAsset 检查读到视频轨与音频轨时长均为 6.000 s，AVAssetReader 解出 288000 个 PCM 采样）。afinfo 的 estimated duration 是从音频包推算的原始解码长度：284 packets × 1024 frames = 290816 frames，比时间线多 **2816 samples（约 58.7 ms）**，属于 AAC 编码器 priming/包对齐的填充。两者不是同一口径，不能写成「完全零差」；该差异远小于 0.1 s 的时长容忍与 ±2% 的采样数容忍，也不改变三条音调的时间线结论（独立 DFT 的分析窗口远大于 59 ms）。afinfo 只列音频轨，因此其 Num Tracks 为 1 不代表文件只有一条轨。

这些核验仍然只是**同一台 macOS 上的合成文件**，不构成真实 RTC、真实设备或真实网络证据。

## 5. 过程中真实出现的失败与修复

以下都是实际运行证据，不是设计说明。

1. **首个具体失败：写入器无限等待。** 当天 15:38 起连续两次运行都停在生成阶段，whiteboard-call.mov 只有 5309 字节（仅容器头）、进程 CPU 约 0.5%，而音频 WAV 已写成功。把无限轮询改成有界等待后得到确切错误：
   ```
   error: io failure: timed out after 10 s waiting for video input at frame 39: status=1 error=nil
   ```
   即 AVAssetWriterInput.isReadyForMoreMediaData 长时间不返回 true，而 writer.status 仍为 writing、error 为 nil。
2. **该停顿不是由 B 帧重排引起的（对上一版的更正）。** 先用 AVVideoAllowFrameReorderingKey=true 做对照，在第 39 帧稳定复现一次；但把该项设为 false 之后，停顿仍然出现：帧号 41、46、53、53、88 各不相同，既出现在 whiteboard 也出现在 grid，既出现在单文件 generate 也出现在一次进程内连写三个文件的 all。加入有界等待后的 19 次运行中有 5 次停顿（约 26%）；连同修复前 2 次无界等待和 1 次帧重排对照，本实验共观察到 8 次同类停顿（帧号 39/41/46/53/53/88，另 2 次因无界轮询未取到帧号）。当前可说的结论只是：**在本环境里 H.264 编码器会间歇性地不给就绪信号**，机制未定性；关闭帧重排能改变首次停顿的位置，但不是根因。

   **【第 2 轮更正】上面「机制未定性 / 编码器不给就绪信号」的归因已被推翻。** 停顿不是编码器故障，而是本实验自己的写入驱动造成的两轨互锁：单线程锁步等待视频输入就绪时，同一线程不向音频输入送数据，而 AVAssetWriter 的 ideal interleaving 需要音频数据才能继续落盘，于是视频永不就绪。停顿现场的 `sample` 报告与逐次就绪日志见第 8.1 节，修复见第 8.4 节，复测见第 9 节。第 5.2 条中「关闭帧重排不是根因」的对照结论在第 2 轮仍然成立（帧重排只改变首次停顿的位置，与互锁无关）。
3. 184 个存储样本 vs 180 帧。直读（passthrough）拿到 184 个样本且读取顺序不是呈现顺序（前 8 个 PTS 为 0.0000、0.0000、0.1333、0.0667、0.0333、0.1000、0.2667、0.2000），其中 4 个是零字节/零时长样本、1 个时间戳无效。修复：验证器按呈现顺序（排序后的 PTS）判定连续性与间隔，并新增「解码后帧数」检查；那 4 个空样本是封装器补位，作为日志备注而不作为断言（关闭帧重排后仍存在）。
4. 关键帧 PNG 证据为空。frames 目录被创建但没有任何 PNG，原因是写 PNG 的错误被 try? 吞掉。修复：显式捕获首个错误并输出「写出文件数 + 首个错误」，随后 6 张白板/网格关键帧与 3 张阴性对照关键帧全部写出。
5. 阴性对照最初不成立（0/7）。对照文件缩到 10 帧后小于 4096 字节的产物下限，验证器在 artifact_present 处提前返回，只产生 1 项失败。修复：对照改为与真实成品相同的 6 秒/180 帧，失败只能来自内容（无音轨、纯色画面、无运动），随后 7/7 必需失败与 9 项额外内容失败全部出现。

## 6. 未覆盖与不可据此外推

- 未接任何 RTC/白板供应商 SDK，未做信令、房间、邀请、录制同意与中途加入；本实验不证明任何供应商能产出同样成品。
- 未在 Expo、iOS/iPadOS、Android、Electron 上运行；未用摄像头/麦克风/手写笔；各平台采集路径完全未验证。
- 未执行系统后台挂起、音频会话中断、进程被杀、断网重连、空间不足或断电；原先设计的「写入器分段」模式已按最小化要求删除，未运行。
- 未做五设备、未做真实网络与真实 RTC 抖动/缓冲/漂移；音画对齐只核对了容器起始时间与合成时间线。第 4 节的独立核验同样只是同一台机器上的合成文件。
- 白板表面是 Core Graphics 矢量绘制，不是 Excalidraw DOM 表面，也不是屏幕录制；因此本实验不能回答「DOM 表面能否被连续捕获并与 RTC 画面、音频同步」。
- 生成器与验证器共用 Spec.swift：本实验证明的是「封装链路保留了设计的视频/音频内容」，不能当成独立内容来源的验证；第 4 节的独立解码/DFT 只独立于实验代码，不独立于这台机器。
- 第 5.2 条的间歇停顿说明**逐帧轮询就绪**的写法在重复运行下不可靠（第 8 节已把驱动换成 `requestMediaDataWhenReady`）；换成新驱动后在真实采集负载下的行为仍未验证。

## 7. 产物与下一步

实验代码与用法见 scripts/video-whiteboard-recording-spike/README.md。按最小化要求，本轮只保留 whiteboard / grid / negative 三种模式，并删除 9 项与其他检查重复的检查记录（5 个不同检查名）：Sources 共 1896 行 Swift（第 2 轮写入驱动与中止守卫改动后为 2341 行），检查项 80 → 71。剩余体量集中在生成器、71 项检查与 report.json 结构；继续削减将减少覆盖（例如去掉阴性对照或 grid 模式）而不是去掉开销，因此本轮不再压缩。

下一步仍需（保持未完成状态）：

1. 真实设备与真实 RTC 供应商接入后的 C10 录制验证（含同意流程、中途加入、后台中断、空间不足与文件恢复），不属于本实验。
2. 把写入驱动从逐帧轮询改为 requestMediaDataWhenReady（或写入失败后重建一整个 writer 重试一次），并在重复运行中复测第 5.2 条的间歇停顿；当前实现只能靠重跑通过。
   **第 2 轮已完成（原条目保留作历史）**：写入驱动改为 `requestMediaDataWhenReady`，停顿改为有界监控 + 一次整 writer 重建，并在 40 次复跑中复测第 5.2 条的场景（第 8、9 节）。新驱动下未再观察到停顿，但该结论只覆盖本机、本合成负载。
3. 真实 RTC 抖动下的音画同步与漂移测量方法尚未定义。

## 8. 第 2 轮：间歇停顿的根因与修复（同日续）

第 5.2 条的间歇停顿在第 2 轮被定位为**本实验自己的写入驱动与 AVAssetWriter 多轨 interleaving 互锁**，不是编码器故障；修复方式是把驱动换成 AVFoundation 文档要求的 `requestMediaDataWhenReady`，并保留有界的停顿监控与整 writer 重建。

### 8.1 现场证据（不是推断）

- **`sample` 报告**（停顿中的进程，1 ms × 3 s）：主线程 100% 位于 `MediaWriter.waitUntilReady` → `+[NSThread sleepForTimeInterval:]`；`com.apple.coremedia.mediaprocessor.videocompression`、`com.apple.coremedia.mediaprocessor.audiocompression`、`com.apple.coremedia.formatwriter.qtmovie` 三条 CoreMedia 线程全部停在 `FigSemaphoreWaitRelative` / `_pthread_cond_wait`，即**没有任何编码线程在工作**。就绪判定的调用栈是 `-[AVAssetWriterInput isReadyForMoreMediaData]` → `-[AVAssetWriterInputWritingHelper isReadyForMoreMediaData]` → `-[AVFigAssetWriterTrack isAboveHighWaterLevel]`，说明等待发生在「轨道高于高水位」的落盘侧，而不是编码侧。
- **逐次就绪日志**（同一驱动的临时插桩，等待超过阈值时打印）：

  ```
  [diag] video not ready 0.05s at frame 169: self.ready=false audio.ready=true writer.status=1 writer.error=nil
  [diag] video not ready 0.10s at frame 169: self.ready=false audio.ready=true writer.status=1 writer.error=nil
  ...（0.20 / 0.40 / 0.80 / 1.60 / 3.20 / 6.40 s 同上）
  error: io failure: timed out after 10 s waiting for video input at frame 169: status=1 error=nil
  ```

  即整个 10 s 内**视频始终不可就绪，而音频始终可写**：音频输入一直在等客户端送数据。这里的关键不是「谁先谁后」，而是同一线程既等视频、又不送音频。

### 8.2 文档依据（本机 macOS SDK 27.0 头文件）

- 多个输入时 AVAssetWriter 会按 ideal interleaving 写出数据，每个输入按该模式通报 `readyForMoreMediaData`；该值会异步变化，**所有输入都可能同时临时为 NO**（`AVAssetWriterInput.h` 第 147、149、155 行）。
- 同一头文件给出非实时源的正确机制：`requestMediaDataWhenReadyOnQueue:usingBlock:`，一个输入一个块，块内只在 `readyForMoreMediaData` 为 YES 时追加，数据送完或输入不就绪就退出（第 183–215 行）。
- `markAsFinished`：监控就绪的客户端送完后必须调用，否则其它输入可能为完成 interleaving 而**永久等待**（第 270 行）。
- `appendSampleBuffer:`：调用 `finishWritingWithCompletionHandler:` 之前必须确保所有 append 已返回（第 271 行）；`cancelWriting` 不得与 append 并发，并会删除已创建的文件（第 241–247 行）。修复按这三条约束排序：先停止供数并等待供应块退出，再 finish 或 cancel。

### 8.3 根因

旧驱动把「等待视频就绪」和「向音频输入送数据」串在同一个线程里：等待视频期间音频轨道无人供数。当 interleaving 需要音频数据才能继续落盘、因而把视频轨道标为高于高水位时，视频永不就绪，形成互锁直到 10 s 上限。这解释了此前全部现象：停顿帧号随机（取决于分块边界）、whiteboard 与 grid 都出现、关闭帧重排只改变首次停顿位置、停顿期间进程 CPU 极低（编码线程空闲）。

### 8.4 修复

- `Sources/MediaWriter.swift`：视频与音频各用一个 `requestMediaDataWhenReady(on:using:)` 块加各自串行队列（`com.siyue.video-whiteboard-spike.supply.video` / `.audio`），块内只在本输入就绪时追加，送完后在块内调用 `markAsFinished`。
- 观察线程只做有界监控：跟踪最近一次成功追加时间，静默超过 `stallTimeoutSeconds`（10 s）即判定停顿 → 置停止标志 → 等待供应块退出 → `cancelWriting`（删除半成品）→ 抛出带现场值的 `MediaWriterStall`（含 writerStatus / writerError / videoReady / audioReady / 各轨进度 / 块调用次数）。
- 有界重建：同一文件最多 `maxAttempts` 次（默认 2 = 首次 + 一次整 writer 重建，可用 `SPIKE_MAX_WRITE_ATTEMPTS` 覆盖）。每次尝试都重新写全部 180 帧与 288000 采样，**不跳帧、不放宽任何检查**。
- 可见性：每次尝试都写入 stderr 与 `report.json` 的 `writes[].attempts`（`outcome` / `framesAppended` / `audioSampleFramesAppended` / `seconds` / `note`），`environment.mediaSupplyMechanism` 记录所用机制。重试不会把停顿变成无声的通过：尝试全部停顿则进程以非零码退出并打印停顿现场。
- 测试专用开关（默认关闭，不改变任何断言）：`SPIKE_FORCE_STALL_ATTEMPT=N` 让第 N 次尝试在写完约 20 帧后按停顿中止，用于实际执行重建路径。

### 8.5 本轮未证明

- 新驱动在本机 40 次复跑中 0 次停顿（第 9 节），但重建路径只由故障注入触发过；真实采集负载、真实设备、其它 macOS 版本未验证。
- 独立供数后音频可以明显领先视频（故障注入运行中实测 audioChunks=162/180 时 videoFrames=20/180）。本实验只检查成品内容，不评价这种交错布局对体积与寻道的影响。
- 第 8.2 节引用的是本机 SDK 头文件（macOS SDK 27.0）；SDK 27 已把 `readyForMoreMediaData`、`requestMediaDataWhenReady`、`appendSampleBuffer:` 标记为在 macOS 27 起改用新的 async receiver API。本实验仍用旧机制，因为它在本机（macOS 26.6.2）可用且新 API 的运行期可用性无法在本机验证。

### 8.6 QA 复核后的修订（同日晚间）

复核指出三处不安全或不明确的实现，均已修复，并且各用一次故障注入实际执行过：

1. **未确认供数块退出就调用 `cancelWriting`/`finishWriting`。** 原 `waitForSuppliersToStop(timeout:)` 无返回值，2 s 超时后照样取消或完成写入，违反 `AVAssetWriterInput.h`「不得与 append 并发」的约束。现在该函数返回 `Bool`，中止路径统一收敛到 `abandonAttempt(...)`（置停止标志 → 有界等待 → 确认没有块在飞行 → 才 `cancelWriting`），完成写入前用同一守卫；等待超时抛 `MediaWriterTearDownRefused`（现场含 `activeSupplyBlocks=[...]`），**不取消、不完成**。
2. **上述终止性失败曾被当作可重试失败。** 复核指出 `write()` 的 catch 会把它记成一般失败并进入下一次尝试，而 `writeOnce` 开头会删除同一 URL，等于与仍活着的旧回调竞态。现在引入 `TerminalWriteFailure` 标记协议，`refused` 与新增的 `finish_timeout` 都实现它：catch 记录尝试后立即 `throw`，不再重建同一 URL，半成品原样保留。
3. **`finishWriting` 等待无上限、开关语义未定义。** 现在该等待有 20 s 预算，超时抛 `MediaWriterFinishTimedOut`（同样终止该文件，因为完成回调可能随后仍写入同一 URL）。`SPIKE_MAX_WRITE_ATTEMPTS` 明确收敛到 1...2：`1` 关闭重建，更大或非法值取默认 2。

对应的现场记录（第 9 节修订行）：`refused` 运行里 `write()` 只记录第 1 次尝试后即以退出码 2 结束，日志中没有第 2 次尝试，输出目录只留下 0 字节半成品；`activeSupplyBlocks=[audio,video]` 证明拒绝理由就是「确有块在飞行」。

本轮仍未被运行验证的部分：`finish_timeout` 没有注入开关，只经过代码复核；验证阶段的 `blockOnAsync`（`AsyncBridge.swift`，仅用于读取成品属性）仍是无上限等待，它不涉及写入侧 append 并发约束，本实验未给它设预算。

## 9. 第 2 轮验证记录（命令、环境、结果）

环境：macOS 26.6.2（25G83、arm64、Apple M5、10 核）、Xcode 27.0 / macOS SDK 27.0、Apple Swift 6.4（swiftlang-6.4.0.34.1）。运行时机负载偏高（`uptime` 在同一时段观察到 load average 6.13 / 6.35 / 14.01，更早一轮为 4.66 / 11.18 / 24.53）。全部媒体写在 /tmp，仓库不保存产物。

```bash
# 编译（退出码 0，无警告）
xcrun swiftc -O -swift-version 5 -o /tmp/vwspike-build/video-whiteboard-spike \
  $(find scripts/video-whiteboard-recording-spike/Sources -name '*.swift' | sort)
# 基线 / 复跑（每个输出目录独立）
/tmp/vwspike-build/video-whiteboard-spike generate --mode whiteboard --output-dir /tmp/siyue-video-whiteboard-spike-soakwb\$i
/tmp/vwspike-build/video-whiteboard-spike all --output-dir /tmp/siyue-video-whiteboard-spike-final\$i
# 最终单次（用户要求的入口）
SPIKE_OUTPUT_DIR=/tmp/siyue-video-whiteboard-spike-final-run ./scripts/video-whiteboard-recording-spike/run-spike.sh
# 重建路径与失败路径的故障注入
SPIKE_FORCE_STALL_ATTEMPT=1 /tmp/vwspike-build/video-whiteboard-spike all --output-dir /tmp/siyue-video-whiteboard-spike-forced
SPIKE_MAX_WRITE_ATTEMPTS=1 SPIKE_FORCE_STALL_ATTEMPT=1 /tmp/vwspike-build/video-whiteboard-spike generate --mode whiteboard --output-dir /tmp/siyue-video-whiteboard-spike-noretry
```

| 阶段 | 对象 | 次数 | 结果 |
| --- | --- | --- | --- |
| 基线（旧锁步驱动） | whiteboard generate | 20 | 16 通过 / **4 停顿**（帧 36、172、166、80）；失败耗时 15.0–15.6 s（10 s 上限 + 先前帧的逐步减速） |
| 新驱动 | whiteboard generate | 20 | 20 通过 / 0 停顿（0.57–0.77 s） |
| 新驱动 | grid generate | 10 | 10 通过 / 0 停顿（0.67–1.06 s） |
| 新驱动 | full `all`（71 项 + 阴性对照） | 10 | 10 通过；每次均 71 passed / 0 failed、阴性对照 passed、overall PASS（3.1–5.4 s） |
| 同日对照（旧锁步驱动） | whiteboard generate，紧接新驱动 40 次全通过之后 | 20 | 14 通过 / **6 停顿**（帧 44、97、106、107、108、123，约 30%） |
| 最终代码 | full `all` | 10 | 10 通过：71 passed / 0 failed、阴性对照 passed，全部日志中无 stalled 记录 |
| 最终代码 | whiteboard generate | 10 | 10 通过 / 0 停顿 |
| 最终单次入口 | `run-spike.sh` | 1 | 退出码 0；71 passed / 0 failed、阴性对照 passed、overall PASS；whiteboard-call.mov 287055 B、multi-video-call.mov 131901 B、negative-control-solid.mov 13497 B（与第 3 节同值） |
| 重建路径 | `SPIKE_FORCE_STALL_ATTEMPT=1` 的 `all` | 1 | 三个文件均记录 `stalled → completed`（第 1 次尝试在第 21 / 23 / 24 帧被中止），第 2 次尝试写满 180 帧；71 passed / 0 failed、阴性对照 passed |
| 失败路径 | 重试额度耗尽时的强制停顿 | 1 | 退出码 2；stderr 打印完整停顿现场；`cancelWriting` 删除半成品，输出目录内无残留 .mov |
| 修订后 full `all` | 71 项 + 阴性对照 | 1 | exit 0；71 passed / 0 failed、阴性对照 passed、overall PASS |
| 修订后 full `all` 复跑 | 71 项 + 阴性对照 | 10 | 10 次全部 71 passed / 0 failed、overall PASS，无 stalled / refused / finish_timeout |
| 修订后重建路径 | `SPIKE_FORCE_STALL_ATTEMPT=1`（generate whiteboard） | 1 | exit 0；第 1 次 `stalled`（`activeSupplyBlocks=[none]`）→ 第 2 次 `completed`，180 帧 |
| 修订后拒绝路径 | `SPIKE_FORCE_STALL_ATTEMPT=1 SPIKE_HOLD_AUDIO_BLOCK_SECONDS=5` | 1 | exit 2；第 1 次 `refused`（等待 2.0 s，`activeSupplyBlocks=[audio,video]`）；**无第 2 次尝试**；输出目录只留 0 字节半成品 |

限定在本机、本合成负载下的结论：旧驱动的停顿可复现（同日另一批 20 次里 6 次），换成 `requestMediaDataWhenReady` 后 40 次复跑 0 次停顿；71 项内容断言、关键帧证据与阴性对照全部保留且未放宽；停顿后的整 writer 重建路径与「重试耗尽即失败」路径都由故障注入实际执行过。

本实验不改变 tasks 2.5、V13、2.1/O06 或任何 4.x/5.x 的状态。
