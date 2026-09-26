# 视频白板录像合成实验（任务 2.5 / V13 的合成媒体部分）

这是 add-family-video-whiteboard 任务 2.5 的无供应商、无外部副作用实验，只回答一个问题：
用 macOS 原生 AVFoundation/CoreGraphics，能否把「白板主画面 + 多个参与者小画面 + 本地与远端两路声音」
合成为**一个本地文件**，并让另一段程序从成品里读回可核对的视频轨、音频轨、持续时间/时间戳与关键帧画面。

它不是产品功能，不接 RTC，不开摄像头/麦克风，不联网，不上传，不读任何家庭数据。

## 运行

```bash
./scripts/video-whiteboard-recording-spike/run-spike.sh
```

等价于：

```bash
xcrun swiftc -O -swift-version 5 -o /tmp/vwspike-build/video-whiteboard-spike \
  $(find scripts/video-whiteboard-recording-spike/Sources -name '*.swift' | sort)
/tmp/vwspike-build/video-whiteboard-spike all --output-dir /tmp/siyue-video-whiteboard-spike
```

子命令：all（默认，生成 + 验证 + 阴性对照）、generate --mode whiteboard、verify --mode whiteboard --input FILE。

### 写入驱动与停顿处理

媒体数据通过 `requestMediaDataWhenReady(on:using:)` 送进 AVAssetWriter：视频与音频各一个块、各一条串行队列，块内只在本输入 `isReadyForMoreMediaData` 为真时追加，送完后调用 `markAsFinished`。这是 AVFoundation 对非实时源要求的机制；旧版「单线程逐帧轮询就绪」会与多轨 ideal interleaving 互锁（等待视频时就没人给音频供数），2026-09-24 第 2 轮已复现、定性并替换，现场证据见证据文档第 8 节。

停顿处理是有界且可见的：最近一次成功追加超过 10 s 没有进展即判定停顿。中止顺序固定为「置停止标志 → 最多等 2 s 让两个供数块退出 AVAssetWriter 调用 → 确认没有块在飞行 → `cancelWriting` 删除半成品」，因为 AVFoundation 文档禁止 `cancelWriting`/`finishWriting` 与 append 并发。若 2 s 内仍有块在飞行（例如真的卡在 writer 调用里），本实验**拒绝**取消或完成该文件：记录 `outcome=refused`、以非零码退出、不重试、不删除也不重建同一个 URL，半成品原样留在输出目录。`finishWriting` 同样有界（20 s，超时记为 `outcome=finish_timeout` 并同样终止该文件）。正常路径下每个文件最多 2 次尝试：`SPIKE_MAX_WRITE_ATTEMPTS` 只在 1...2 之间取值，`1` 表示关闭重建，更大或非法值收敛为默认 2。每次尝试都重写全部 180 帧与 288000 采样，不跳帧、不放宽任何检查；尝试记录写在 stderr 与 report.json 的 `writes[].attempts`，`environment.mediaSupplyMechanism` 记录当前机制。

测试专用、默认关闭的开关：`SPIKE_FORCE_STALL_ATTEMPT=N` 让第 N 次尝试在写完约 20 帧后按停顿中止；`SPIKE_HOLD_AUDIO_BLOCK_SECONDS=N` 让音频供数块第一次被调用时停留在块内 N 秒（从观察者看与「卡在 writer 调用里」不可区分），两者一起用来实际执行 `refused` 路径。
测试专用、默认关闭的开关：`SPIKE_FORCE_STALL_ATTEMPT=N` 让第 N 次尝试在写完约 20 帧后按停顿中止，用来验证重建路径确实被执行。

## 场景

| 模式 | 内容 |
| --- | --- |
| whiteboard | C10 有白板形态：白板主画面（网格、合成题图、逐渐画出的笔迹、滑动指针）+ 3 路参与者小画面 + 本地/远端混音 |
| grid | C10 无白板形态：2x2 四路参与者画面 + 同一套本地/远端混音 |
| negative | 阴性对照：同样 6 秒、同样帧数，但只有单一灰色画面且没有音轨，用于证明验证程序真的会拒绝不合格成品 |

音频时间线：0-2 s 只有本地 440 Hz，2-4 s 只有远端 1200 Hz + 1800 Hz，4-6 s 两者同时存在。

## 输出（全部在临时目录内）

- whiteboard-call.mov、multi-video-call.mov：H.264 视频 + AAC 音频的单文件封装。
- audio/local-bus.wav、audio/remote-bus.wav：两路互相独立的音源，单独读回验证。
- frames/*.png：用于核对的关键帧画面。
- report.json：环境（含写入机制）、产物哈希、每个文件的写入尝试记录、全部检查项与限制。

## 验证方式

MediaVerifier 独立读回成品，检查：容器轨数量与编解码格式、视频/音频时长与起始时间、视频存储与呈现时间戳
（帧数、1/30 s 间隔、首末时间、是否有断点）、解码后帧数、音频采样数与峰值、分窗 Goertzel 判定三条音调是否按要求出现，
以及解码关键帧中白板、题图、笔迹进度、指针位置和每路小画面的颜色/亮度变化是否符合确定性设计。

## 明确不能证明的事情

- 没有 RTC 真实流、没有供应商 SDK、没有信令、没有五设备房间、没有录制同意流程、没有任何上传。
- 只覆盖 macOS/AVFoundation 的封装与编解码行为；不覆盖 Expo、iOS/iPadOS、Android、Electron 的采集路径。
- 没有执行系统后台挂起、音频会话中断、进程被杀、断网重连等场景。
- 白板表面是 Core Graphics 矢量绘制，不是 Excalidraw DOM 表面，也不是屏幕录制。
- 音画对齐只核对了容器起始时间与合成时间线，不代表真实 RTC 抖动、缓冲与漂移可控。
- 生成器与验证器共用 Spec.swift，因此证明的是「封装链路保留了设计内容」，不是「某供应商 SDK 能产出同样成品」。

结论与命令、环境、实际结果统一记录在 [证据文档](../../docs/evidence/video-whiteboard-recording-spike-2026-09-24.md)。
