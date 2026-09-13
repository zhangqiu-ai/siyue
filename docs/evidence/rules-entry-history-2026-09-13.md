# 规则入口历史快照 · 2026-09-13

本文件完整保留本次规则精简前的 README.md 与 START_HERE.md 原文。它是历史快照，不是现行规则、当前排期或新验收证据；其中日期、运行结果、限制及旧阶段描述按原样保留。代码块中的相对路径以仓库根目录为基准。当前入口见 [README](../../README.md)、[START_HERE](../../START_HERE.md)；原运行证据见 [M1 验证](m1-validation.md)、[移动 AI 与设置](mobile-ai-settings.md)、[设置改版](settings-redesign.md)。

## README.md 原文

````markdown
# 思玥 · Siyue

当前开发版本：**0.0.1（未发布）**。功能归属见 [版本计划](planning/releases/0.0.1.md)，流程见 [版本规则](planning/releases/README.md)，实际发布变化见 [CHANGELOG](CHANGELOG.md)。

开发流程入口：[OpenSpec 规格与变更规则](openspec/README.md)。新功能先写规格，简单修改可说明豁免；验收后同步现行规格。

AI-first 个人成长应用 / An AI-first personal growth app.

> 立项基线 v0.1 · 2026-09-05；验证更新于 2026-09-06。当前已实现 M1 本地 Mock 目标闭环：macOS Electron 与 iOS 模拟器闭环、重启持久化及 iOS/Android JavaScript 打包通过；iPhone 16 Pro Max（iOS 26.6.1 / 23G83）已恢复USB连接，两条核心UI路径分别有通过证据：草稿闭环142.692秒、改名/完成/归档重启125.001秒；首轮整套为1通过1失败，不能写同次2/2。 应用与Runner签名验证通过，iPhone故障/后台及Android真机仍待验收；Android SDK 与专用模拟器已就绪，独立 UI 宿主已构建、安装并核验插桩目标；主应用重试构建、APK 签名校验与安装已通过；Android 模拟器两条独立 UI 用例分别通过（各 1 项、0 失败，336.319 秒与 325.679 秒），覆盖草稿闭环及真实断网下手动改名、完成、归档与重启保留。

iOS与Android独立QA应用均复用正常原生客户端工厂，真实SQLite提交后丢响应/回执暂不可读、终止进程后对账分别通过（iOS 43.191秒、Android 12.053秒，各1项0失败）；恢复execute=0，同commandId/issuedAt/对象ID/完整快照hash不变，pending只在原回执验证后清除。每个平台两条正常用户UI用例与一条QA用例分别执行，不是同次3/3；不代表正常用户UI错误交互、真机、物理断电、生成取消/后台中断或升级通过，也不自动恢复表单。

思玥帮助用户把目标转化为行动，在语言练习、项目推进和个人资产记录中积累真实证据，再由 AI 辅助理解、规划与复盘。个人成长操作系统是长期愿景，不意味着第一版覆盖全部生活领域。

## 已确认的产品约束

| 项目 | 约束 |
|---|---|
| 品牌 | 中文「思玥」，英文「Siyue」；工程标识建议 `siyue` |
| 界面语言 | 中文、英文必须同时支持；这是交付要求，不代表现有界面已完成国际化 |
| 定位 | AI-first 个人成长；语言学习、目标与项目管理、个人资产管理是长期核心域 |
| 平台 | iPhone 与 iPad 必须同时适配（iPad 为未来主力，手机持续保障），同时支持 Android；桌面采用 Electron + React，不采用 Tauri |
| 发展路线 | 初期个人开源项目，后续逐步商业化 |

## 文档入口

1. [PROJECT_CHARTER.md](PROJECT_CHARTER.md)：为什么立项、范围、负责人职责与交付标准。
2. [PRODUCT.md](PRODUCT.md)：首版用户场景、功能范围与非目标。
3. [ARCHITECTURE.md](ARCHITECTURE.md)：客户端、业务、AI、数据与可选云服务的边界。
4. [docs/ai-foundation.md](docs/ai-foundation.md)：模型、工具、审批、记忆、语音与运行状态。
5. [docs/domain-model.md](docs/domain-model.md)：领域对象和数据约束。
6. [docs/data-sync.md](docs/data-sync.md)：本地优先、写入权威、冲突、账号切换。
7. [docs/privacy-security.md](docs/privacy-security.md)：敏感数据、权限、密钥与删除。
8. [docs/roadmap.md](docs/roadmap.md)、[docs/backlog.md](docs/backlog.md)：里程碑与工作包。
9. [docs/decisions.md](docs/decisions.md)、[docs/acceptance.md](docs/acceptance.md)：决策状态与验收。
10. [START_HERE.md](START_HERE.md)、[AGENTS.md](AGENTS.md)：开发启动与 AI 编程协作规则。
11. [docs/BOOTSTRAP.md](docs/BOOTSTRAP.md)：本轮工程初始化、固定版本、运行命令和未验证项。
12. [docs/product-philosophy.md](docs/product-philosophy.md)：2026-09-06 产品哲学、家庭自用方向、AI 原则、成长资产与记忆；区分已确认原则与待决方案，不自动扩大 M1。

## 当前工程状态

2026-09-06 移动基础补充：已增加 OpenAI 兼容个人密钥设置、连接测试及流式普通聊天；目标草稿仍使用原有 Mock。真实供应商与本轮真机尚未验收，详情见 [移动 AI 与设置验证](docs/evidence/mobile-ai-settings.md)。

已实现移动与桌面目标草稿、确认保存、正式记录编辑和任务完成，复用 Domain / Contracts / AI / Adapters。`pnpm-lock.yaml` 已生成，共享业务、SQLite 及 IPC 测试已执行，桌面通过真实 Electron 闭环验证。iPhone 17 Pro 模拟器（iOS 26.5 / 23F77）已通过草稿编辑保存、重启后显式继续与确认、目标/项目/任务保存、任务完成与重启保留、拒绝不增记录及手动创建的 UI 测试；另一条独立用例验证手动目标/任务改名 ID 不变、任务完成后归档、重启后同 ID、归档状态与数量保留。两条 UI 用例分别执行通过，每次均为 1 项、0 失败，耗时分别为 167.126 秒与 151.684 秒。Android 环境与独立 UI 宿主已就绪，主应用重试构建、APK 签名校验及安装通过；Android 模拟器 UI 闭环通过（1 项、0 失败，336.319 秒），覆盖草稿编辑保存、重启显式继续、确认目标/项目/任务、任务完成后重启同 ID/状态保留、拒绝不增记录及手动创建；第二条 Android 独立用例在关闭 Wi-Fi/移动数据、确认无默认网络后通过（1 项、0 失败，325.679 秒），验证手动目标/任务改名同 ID、完成后归档、重启同 ID/名称/状态/数量保留及归档只读；网络设置已恢复。两次分别运行，不是同次 2/2；正常用户UI其余错误交互、升级故障、iPhone故障/后台及Android真机仍未验收；iPhone 16 Pro Max（iOS 26.6.1 / 23G83）已恢复USB连接，两条核心UI路径分别有通过证据：草稿闭环142.692秒、改名/完成/归档重启125.001秒；首轮整套为1通过1失败，不能写同次2/2。 CI 运行、生产同步、真实模型及发布流水线仍未验证或未实现。工作包与分层验收状态见 `planning/` 和 [本轮验证记录](docs/evidence/m1-validation.md)。远端仓库为 `zhangqiu-ai/siyue`。

项目已在 GitHub 建立公开仓库 `zhangqiu-ai/siyue`。初始化阶段不注册域名、不购买外部服务，也不宣称尚未运行的构建或测试已经通过。

## 开源状态

开源是已确认的发展路线，具体许可证尚待维护者决定。此文档包不附有效 `LICENSE`，不宣称代码已获某一开源许可证授权。见 [docs/open-source-commercial.md](docs/open-source-commercial.md)。

外部技术事实和检索范围见 [docs/sources.md](docs/sources.md)。


2026-09-06：维护者要求移除初始化示例。移动正式导航现为对话主页，设置从侧栏进入（无底部栏），目标与行动示例及原生组件预览入口已移除；旧目标 UI 仅保留为隔离 QA fixture，数据库与业务代码未删除。历史目标 UI 验收属于旧界面，不能证明当前正式移动入口可用。正式目标页面需后续重新设计。 详见 [设置改版验收](docs/evidence/settings-redesign.md)。
````

## START_HERE.md 原文

````markdown
# 从这里开始：首个开发切片

当前开发版本：**0.0.1（未发布）**。功能归属见 [版本计划](planning/releases/0.0.1.md)，流程见 [版本规则](planning/releases/README.md)，实际发布变化见 [CHANGELOG](CHANGELOG.md)。

**2026-09-07 设备约束：iPhone 与 iPad 必须同时适配。当前重视手机，iPad 是未来主力；新页面和布局修改同时纳入两类设备，不将平板适配后置。具体矩阵见 [UI 设计与验收](docs/design/ui-acceptance.md)。本条是要求，不代表已有 iPad 验收。**

开发流程入口：[OpenSpec 规格与变更规则](openspec/README.md)。新功能先写规格，简单修改可说明豁免；验收后同步现行规格。

当前已有本地 Mock 目标闭环、锁文件和共享业务测试；macOS Electron 真实闭环、iOS 模拟器闭环及 iOS/Android JavaScript 打包已验证。模拟器已覆盖草稿编辑保存、重启显式继续与确认、正式记录与任务完成的重启保留、拒绝不增记录和手动创建；另一条独立用例覆盖手动目标/任务改名 ID 不变、任务完成后归档、重启同 ID/状态/数量保留。两条 iOS UI 用例分别执行通过，每次 1 项、0 失败。iPhone 16 Pro Max（iOS 26.6.1 / 23G83）已恢复USB连接，两条核心UI路径分别有通过证据：草稿闭环142.692秒、改名/完成/归档重启125.001秒；首轮整套为1通过1失败，不能写同次2/2。 应用与Runner签名验证通过，iPhone故障/后台及Android真机仍待验收；Android SDK 与专用模拟器已就绪，独立 UI 宿主已构建、安装并核验插桩目标；主应用重试构建、APK 签名校验与安装已通过；Android 模拟器两条独立 UI 用例分别通过（各 1 项、0 失败，336.319 秒与 325.679 秒），覆盖草稿闭环及真实断网下手动改名、完成、归档与重启保留；不能将模拟器结果作为真机或全平台完成依据。先读 `docs/BOOTSTRAP.md` 与 `docs/evidence/m1-validation.md`，继续已有实现，不再重复初始化。

iOS与Android独立QA应用均复用正常原生客户端工厂，真实SQLite提交后丢响应/回执暂不可读、终止进程后对账分别通过（iOS 43.191秒、Android 12.053秒，各1项0失败）；恢复execute=0，同commandId/issuedAt/对象ID/完整快照hash不变，pending只在原回执验证后清除。每个平台两条正常用户UI用例与一条QA用例分别执行，不是同次3/3；不代表正常用户UI错误交互、真机、物理断电、生成取消/后台中断或升级通过，也不自动恢复表单。

## 首次切片任务（历史启动范围）

```text
请按当前 Siyue 仓库的 AGENTS.md 和立项文档开始 M1，不要实现全部路线图。

先检查 git status、现有文件和本机可用工具。保留已有内容，不改动其他仓库，不公开代码，不部署服务。

本轮处理 SY-001 与 SY-002；再在隔离验证目录中准备 SY-003。使用 React Native + Expo 建移动入口（iOS 优先、支持 Android），使用 Electron + React 建桌面入口。采用 TypeScript workspace，但不要创建大量空包。

先定义 PersonalSpace、Goal、Project、Task、ActionDraft、CommandReceipt 的最小模型、校验和确定性命令契约。通过 Mock Provider 验证草稿与确认的边界。移动和桌面使用同一领域测试，不在共享业务层导入平台 API。

记录依赖版本和实际可执行命令。对本机无法执行的 iOS/Android/Windows 测试明确写未运行；不要说全部平台已支持。数据库驱动与生产同步须按 SY-003 的 PoC 结果定，不把未经测试的 PowerSync/SQLite 组合锁死到全部业务。

提交前说明文件差异、真实测试结果、未决事项。达到本轮验收后停止，不自动做资产、支付、插件市场或生产部署。
```

## 后续切片顺序

2026-09-06 维护者调整当前优先级：先完成 SY-021（移动基础对话、个人 OpenAI 兼容密钥、基础设置），再继续 SY-009 的剩余业务验收。SY-021 已完成基础代码和合成检查，真实供应商及真机验证仍待完成；见 [验证记录](docs/evidence/mobile-ai-settings.md)。

通过 SY-003 选择存储适配；实现 SY-004 与 SY-005 的事务和安全边界；随后 SY-006/007/008/009 完成 AI 草稿到正式目标。每一阶段都保留手动编辑与取消路径。

## 远端仓库

远端仓库为 `zhangqiu-ai/siyue`，当前为公开仓库。初始化代码进入 `main`，后续日常开发从 `feature/dev` 分支开始。本次没有 GitHub Issue 编号；SY-xxx 是规划 ID。


2026-09-06：维护者要求移除初始化示例。移动正式导航现为对话主页，设置从侧栏进入（无底部栏），目标与行动示例及原生组件预览入口已移除；旧目标 UI 仅保留为隔离 QA fixture，数据库与业务代码未删除。历史目标 UI 验收属于旧界面，不能证明当前正式移动入口可用。正式目标页面需后续重新设计。 详见 [设置改版验收](docs/evidence/settings-redesign.md)。
````

