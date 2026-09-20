# 视频白板本地开发交接与隔离存档验证

日期：2026-09-20。目标版本：0.0.1。工作包：SY-022。变更：`add-family-video-whiteboard`。

## 代码与授权边界

- 原工作区 `/Users/feature/code/siyue` 在 `feature/dev`，起点 `8baacbc`，开工时无未提交改动。
- `git fetch origin` 后确认 PR #1 为 OPEN / Draft，规划头 `ae193af9d3af5dfd78aaff5c3af7648ebde14394`，目标 `feature/dev`。
- 本地分支 `codex/video-whiteboard` 从该规划头创建并解除默认上游，避免误推到规划分支。本轮新增内容未提交、未推送、未合并。
- 从引用会话读回并登记 C10 的已确认录像成品；O02 其余同意/中途加入/多设备规则继续待决。维护者随后确认 C11 的家长发起、家庭内邀请、儿童接受邀请、发起者离开通话继续与家长明确结束规则。
- 本轮技术验证只使用合成数据、独立临时目录和本地进程，不采集摄像头/麦克风、不读取家庭文件、不调用外部服务。

## 实施与验证

存档实验位于 `experiments/video-whiteboard/`，属于任务 2.4 的 Node 文件系统验证，不是 RN/Expo 或 Electron 正式应用接线。其 schema 是实验格式，不是已冻结的生产跨端契约。

执行环境：macOS，Node v22.22.3，pnpm 11.25.0（仓库锁定版本）。

| 命令 | 结果与范围 |
|---|---|
| `corepack pnpm spec:check` | 5 项通过，0 失败；补齐原规划远端环境未运行的严格检查，并验证 C10 更新 |
| `corepack pnpm release:check` | 通过；不代表版本交付验收 |
| `git diff --check`；本轮 Markdown 相对路径及 JSON 解析检查 | 通过；仅涉及本轮文件 |

| `node --test experiments/video-whiteboard/local-archive.test.mjs` | 22/22 通过，0 失败；真实临时文件及子进程崩溃、版本、附件、路径和锁回归 |
| `corepack pnpm exec playwright test tests/e2e/video-whiteboard-archive.spec.mjs` | 2/2 通过；真实 Node 跨进程写入→编辑→重开、提交前崩溃保旧；不是浏览器或产品 UI 验收 |

主代理在子代理交付基础上复核并运行上述测试；审查已修正：未知/损坏锁不自动删除，释放核对持有者 token；保存前验证当前修订以保护旧恢复引用；读取与恢复均核对指针和作品 boardId；拒绝 revisions/attachments 父目录符号链接。中间开发态单测曾因删除清理 API 后遗留的 import 失败，已移除过时导入；上表为最终结果。

归档使用完整修订目录及原子替换指针，保存题图字节、可编辑独立笔迹和页面。默认读取损坏/未来版本会报错；仅显式请求可恢复到上一完整版本，并返回 `recovered` 与问题列表，不改写原件。未加入自动清理或保留数量策略。签名和哈希不等同完整图片解码校验。

任务 2.4 的隔离 Node 存储验证完成；SY-022 与 AT-025 的正式应用/跨端验收保持未完成。代码入口：[实验 README](../../experiments/video-whiteboard/README.md)。厂商文档初筛见 [官方资料初筛](video-whiteboard-provider-screening-2026-09-20.md)，2.1 仍需补 SDK/许可、导出、删除及退出路径实证。

崩溃后的锁保留且阻止继续写入，PoC 只支持在确认无写者后人工处理，不是已实现产品恢复流程。所有修订与崩溃残留保留，实际保留/清理策略待 O03；空间不足与断电尚未实测。

## 未覆盖边界

真实五设备通话、共同书写与相机争用、原生文件系统/真实空间不足/系统断电、iPhone/iPad/Android、真实 Electron 产品界面、录制合成及真实服务网络均未由本实验验证。权限和数据生命周期不得从本实验推导；O03 未决时不接正式主存档接管/另存/清理。

下一步需逐项确认 O01 剩余逐人管理细则、O02 同意与加入、O03 保存权限和接管、O04 工具与操作边界、O05 平台矩阵，以及 O06 服务、预算和临时留存。准备与隔离验证可继续；正式外部路径受对应待决项阻塞。
