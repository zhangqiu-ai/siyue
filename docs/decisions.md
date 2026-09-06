# 决策登记册

状态说明：Confirmed = 用户明确约束；Baseline = 本轮推荐实施基线；Validate = 需工程证据；Owner decision = 维护者决定后生效；Deferred = 暂不实现。

| ID | 决策 | 状态 | 冻结前需要什么 |
|---|---|---|---|
| D-001 | 中文思玥、英文 Siyue | Confirmed | 名字确认不代表商标或域名已获权 |
| D-002 | iOS 优先、支持 Android；桌面 Electron + React | Confirmed | 各端真实验收；不再评选 Tauri |
| D-003 | 初期个人开源、后续商业化 | Confirmed | 具体许可、公开内容和服务边界待定 |
| ADR-001 | React Native + Expo；纯 TS 共享业务 | Baseline / Validate | Expo 57 安装、双平台 JS 打包、iOS 模拟器两条独立 UI 用例与 iPhone 开发签名构建通过；Android 环境/独立宿主已就绪，主应用重试构建/校验/安装通过，Android 模拟器两条独立 UI 用例分别通过（各1项0失败），包括真实断网下手动改名/完成/归档与重启；移动真机及正常用户UI错误交互、取消/升级故障未验收 |
| ADR-002 | 模块化单体、少量 workspace 包 | Baseline | 已有 `apps/*` + `packages/{domain,contracts,ai,adapters}`；共享命令与平台事务端口已测试 |
| ADR-003 | AI SDK Core + 薄 Agent 层；Hermes 可选 | Baseline / Validate | 维护者选择本地 Mock；AI SDK 7 离线契约、审批/失败/取消已测试，真实 Provider 未配置 |
| ADR-004 | SQLite + 可选 PostgreSQL；同步候选 PowerSync | Validate | RN/Electron、离线冲突、账号切换、许可、退出方案 |
| ADR-005 | 本机正式写入与同步服务端裁决分开 | Baseline / Validate | 幂等、重复投递、断点对账、审批版本测试 |
| ADR-006 | 小型结构化记忆优先，图谱和向量后置 | Baseline | 来源、纠正、删除与复盘覆盖测试 |
| ADR-007 | 手机前台交互；可靠后台任务可选服务端 | Baseline | 不宣称手机常驻；授权数据范围 |
| D-004 | 开源许可证 | Owner decision | Apache-2.0 为候选，不自动附 LICENSE |
| D-005 | 仓库新建/关联、初始可见性、是否移植旧代码 | Owner decision | 不自动公开或修改原项目 |
| D-006 | 云平台、模型供应商、费用上限、正式域名与包标识 | Owner decision / Validate | 凭据、费用、持有权、地区可用性验证 |
| D-007 | 首发地区、账号主体、分发与订阅路径 | Owner decision | 目标市场与平台审核，不沿用其他产品结果 |
| D-008 | 第三方插件、自动交易、全本地模型、完整团队功能 | Deferred | 新用户故事、安全审查和专项预算 |

## 变更规则

修改 Confirmed 约束必须取得用户明确指令。Baseline 可以在有证据的情况下调整，并记录原因与替代影响。Validate 不能在 README 中写成“已支持”。所有决定记录日期、提出人角色、证据、状态和影响；禁止以助手的个人推荐冒充用户已拍板。

本次未向旧仓库提交代码，也不把旧仓库的 AGENTS 或产品规则自动升级为本项目规则。

## 2026-09-06 · 设计技能与规范选择

提出人及确认人：维护者；依据：本次对话的三项明确批注。

- Confirmed：本项目禁止使用 `ui-ux-pro-max`，不卸载本机技能，不影响其他项目。
- Confirmed：引入已安装的 `huashu-design` 作为设计探索、HTML 交互原型及设计评审的方法；项目执行规则见根目录 `AGENTS.md`。不新增应用依赖，HTML 原型不替代原生实现。
- Owner decision：`design-md` 技能、设计规范文件格式、具体视觉体系及组件库尚待维护者选择。研究候选不代表采用，不创建已定稿的 `DESIGN.md`。

影响：仅更新设计工作方式与选择状态；不改变技术栈、产品范围或工作包验收状态。

## 2026-09-06 · M1 实施证据

提出人：编程代理；维护者确认本阶段先完成本地 Mock。TypeScript 按 Expo 实际兼容检查由 7.0.2 调整至 6.0.3；共享包统一编译 ESM，Node 与 Metro 消费同一产物。锁文件、依赖检查、构建及 macOS Electron 目标闭环有执行证据，见 [M1 验证记录](evidence/m1-validation.md)。

ADR-004 保持 Validate：当前 `expo-sqlite` 与裸 `node:sqlite` 是可替换的单设备验证实现，空间内对象/活动/回执按 JSON 快照原子提交；不据此采用 PowerSync 或承诺生产同步。iOS 原生工具已可用，模拟器两条独立 UI 用例分别通过；Android SDK/专用模拟器与独立 UI 宿主已就绪，主应用重试构建与安装通过，Android 模拟器 UI 已验证草稿恢复、确认创建、任务完成和跨 force-stop 重启持久化；Android第二条独立用例另验证真实断网下手动改名同ID、完成归档、重启保留与归档只读，网络已恢复；移动真机、正常用户UI错误交互、取消/升级故障与生产同步仍未验收。没有引入 Hermes Agent；移动构建日志中的 Hermes 仅指 React Native JavaScript 引擎。

### 2026-09-06 恢复与设备验证补充

移动手工命令增加独立 SQLite 待提交日志，桌面日志改用 localStorage；日志仅保留命令标识/时间，未知结果先对账，坏记录拒绝覆盖。运行事件增加明确版本、运行归属与授权续读接口。真实 Electron 全进程重启丢响应测试通过。现场已具备完整 Xcode 26.6，iOS 模拟器两条独立 UI 用例分别通过，包含改名/归档用例的 iPhone 开发签名 build-for-testing 与签名检查通过；设备当前 unavailable，真机未安装或运行。Android SDK 安装与专用模拟器启动完成，独立 UI 宿主构建和两份 APK 安装通过，instrumentation target 已核验为 app.siyue.uihost；主应用重试构建、APK 签名校验与安装通过；Android 模拟器 UI 经测试宿主定位和启动修复后通过（1 项、0 失败，336.319 秒）；两轮失败日志保留，未清库或修改业务命令语义，移动真机和 M1 全平台仍未完成；这不改变单设备 Mock 或生产同步未采用的边界。


### 2026-09-06 Android 离线手动路径补充

`manualRenameCompletionArchiveAndRelaunch` 在关闭 Wi-Fi/移动数据、无默认网络且探测返回 Network unreachable 时通过，1项0失败、325.679秒；与此前336.319秒目标闭环为两次独立执行。核验改名同ID、旧名全页不存在、完成后归档、force-stop重启同ID/名称/状态/数量及归档只读。网络设置恢复原值1/1，恢复后默认网络104。应用APK未变，仅更新独立测试宿主；不据此提升M1真机、正常用户UI错误交互、取消/升级故障或同步完成状态。证据见 [M1 验证记录](evidence/m1-validation.md)。

### 2026-09-06 iOS / Android 独立 QA 丢回执恢复

iOS与Android独立QA应用均复用正常原生客户端工厂，真实SQLite提交后丢响应/回执暂不可读、终止进程后对账分别通过（iOS 43.191秒、Android 12.053秒，各1项0失败）；恢复execute=0，同commandId/issuedAt/对象ID/完整快照hash不变，pending只在原回执验证后清除。每个平台两条正常用户UI用例与一条QA用例分别执行，不是同次3/3；不代表正常用户UI错误交互、真机、物理断电、生成取消/后台中断或升级通过，也不自动恢复表单。 正常默认数据库与命令语义保留，QA为显式独立入口及包名。构建、JSON、截图和准确复现命令见 [M1 验证记录](evidence/m1-validation.md)。工作包与跨阶段AT状态不提升。

iOS QA日志为 `ios-native-recovery-compile-fix.log`（43.191秒、1项0失败），首轮Swift `isEmpty()` 编译错误修复史及六份JSON/PNG/辅助功能树TXT附件见上述验证记录；QA与正常target共享Pods生成文件，需串行构建。正常iOS Release重建及模拟器安装/启动也已通过；bundle标记检查与正常界面截图符合预期，仅属正常启动检查，非source map证据或完整UI重跑。本轮无新增真机签名。


## 2026-09-06 · Headspace 参考确认与 Spectr 安装

提出人及确认人：维护者；依据：选择 Headspace 风格的批注，以及随后附 Spectr 安装页截图要求先安装 skill 与 design.md。

- Confirmed：Headspace 的温暖成长陪伴方向作为思玥设计探索基准，根目录 `DESIGN.md` 为读取入口。覆盖前述“具体视觉体系尚待选择”的状态；页面、最终变量、中文字体和组件库仍待确认。
- 已执行：Spectr 上游 skill（提交 `33c9393854cb6708a1bf4c0e8140d2b97b1e334d`）安装至 `/Users/feature/GitHub/skills/spectr`，以独立符号链接供 Codex 发现。上游 SKILL.md 未改写。
- 已执行：Headspace 通用与 Expo 参考、README 和上游 LICENSE 固定到提交 `5d3aeca239caef3ea4080034eb22ab87cc77fa24`，保存于 `docs/design/references/headspace/`，来源及 SHA-256 见 SOURCE.json。属于第三方风格参考，不是 Headspace 官方发布规范。
- 验证边界：检查了文件存在、符号链接、参考文件 hash 与文档差异；未运行 Spectr 录屏生成（本轮无录屏输入，PATH 未发现 ffmpeg），未核验 Claude 登录或调用模型，未增加应用依赖。不代表 Expo 示例兼容、原型完成或 UI 验收。

不改变业务范围、工程技术栈、全项目许可证或工作包完成状态。

### 2026-09-06：移动 UI 通用控件采用 Expo UI

- 状态：Confirmed（维护者明确选择 Expo UI）；正式页面视觉仍待原型确认。
- 角色与依据：维护者在通用控件选型中选择系统原生体验；执行代理核对 SDK 57 文档、本地类型并完成 iOS 模拟器交互验证。
- 实施：直接依赖 `@expo/ui@57.0.16`，保留 Expo Router，增加统一主题变量和开发组件预览入口。未引入 HeroUI 或新聊天库。
- 影响：iOS 与 Android 控件外观遵循各自平台；Headspace 方向的品牌页面需要组合与定制。现有目标确认、保存链路不迁移。
- 来源：https://docs.expo.dev/versions/v57.0.0/sdk/ui/ 。本次验证不代表 Android 或真机验收。

### 2026-09-06：采用 assistant-ui Expo 应用骨架

- 状态：Confirmed；维护者对“assistant-ui 完整 Expo 示例 + 底部导航 + Headspace 暖色”明确回复“是的，就是这个意思”。
- 实施范围：移动端 Stack / Drawer / NativeTabs（对话、行动），assistant-ui 聊天、会话列表、发送/停止/重新生成；原目标界面迁入行动路由，业务命令与 SQLite 不变。
- 来源：官方 `examples/with-expo`，固定快照与 MIT 许可保留在 `apps/mobile/src/chat/UPSTREAM.md` 及 `UPSTREAM-LICENSE`。根据 SDK57 使用 expo-router 的导航导出，未照搬上游独立 react-navigation 依赖。
- 运行边界：本地异步 Mock 文本流，不调用真实供应商；聊天会话仅内存，不等同于持久历史。未批准新供应商、云同步或自动写入。正式行动仍需已有明确确认流程。
- 工程修正：Metro 会解析 core 导出的可选 `assistant-cloud` 模块，因此安装 0.1.43 满足打包解析，但不创建云客户端。手势库发现 2.32.0/3.2.1 双版本，按 Expo57 兼容集将 workspace override 统一到 2.32.0；不调整 Expo SDK。
- NativeTabs 使用 SDK57 的实验性 API，未来升级需回归导航、键盘和安全区。框架落地不表示完整视觉稿、真机或生产 AI 验收完成。

## 2026-09-06：产品哲学与家庭自用方向

提出与确认：维护者在当日产品讨论中明确表达；助手负责整理。证据为维护者关于自用优先、家庭多成员、AI 不替代人与人互动、成长经历沉淀及低负担记忆的表述，摘录与上下文见 [产品哲学](product-philosophy.md)。这是产品方向归档，不是已验证的市场结论或新的实施任务授权。

| ID | 决策或待决事项 | 状态 | 影响与生效边界 |
|---|---|---|---|
| D-009 | AI 增加高质量的人际互动，不替代家庭成员 | Confirmed | 后续功能、交互与评价指标均应遵循；具体交互规则另做规格 |
| D-010 | 先让本人和家庭真正用得上、确实有用，再商业化 | Confirmed | 补充 D-003；不以更快收费牺牲家庭成长价值，不取消长期商业方向 |
| D-011 | 个人成长保留为主线；家庭共同成长是重要场景，不限两人 | Confirmed | 修正原 PRD 的永久成年人边界解释；不自动批准未成年人公开上线或多人通话范围 |
| D-012 | 共同经历应沉淀为可长期回看、延续使用的成长资产 | Confirmed | 与财务资产域区分；数据结构、分享与保存策略未冻结 |
| D-013 | AI 记忆应低负担、可自动形成且透明可管理，不要求逐条“记住”指令 | Confirmed / Validate | 确认体验目标；实现与授权方式待验证，现有审批和候选状态规则不被绕过 |
| D-014 | 家庭视频白板原型、儿童使用边界、iPad 适配及排期 | Owner decision / Validate | 场景重要性已获维护者强调；需独立规格、预算与验收，当前 M1 不变 |
| D-015 | 默认不录制完整视频、资产与记忆权限模型、最终品牌口号及收费方式 | Owner decision / Validate | 仅保留讨论候选；不得视为维护者已批准的实现或商业承诺 |

本次不修改 `START_HERE.md`、路线图、backlog、验收状态或应用代码；SY-001 / SY-002 与隔离准备 SY-003 的执行顺序不变。若下一步决定优先做家庭原型，应明确它替换或延后哪一项既有工作，再同步相关规划。
