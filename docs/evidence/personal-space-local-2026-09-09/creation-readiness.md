# 个人空间创建闭环接入核查 · 2026-09-09

Target release: 0.0.1。对应已批准变更 add-account-family-spaces 的任务5.3；本轮仅读取代码与真实Figma上下文，不宣称功能实施完成。

## 已核实设计与实现

已按figma-design-to-code技能调用get_design_context，文件5OKY7OMJ2jQy2XAaGbNDGC，节点221:1813（chat-input）。返回截图已查看：对话中包含“练习计划草稿”卡，标注“3项任务 · 可以先修改，再确认保存”，查看入口连接后续流程；Sage变量背景#F7F8F2、操作#476B53。实际确认/编辑目标节点仍需沿当前Figma连线读取，不能按旧JSON索引猜测或把生成的React/Tailwind直接粘到Expo。

`apps/mobile/src/client.ts`使用createNativeClient；`native-client.ts`固定MockAgentExecutor，与真实聊天的配置、传输和供应商能力尚未接通。当前propose可证明本地机制，不能作为真实模型完成证据。真实聊天文本也不能直接成为正式计划写入。

## 可复用业务路径

- `LocalClient.propose(goal, signal)`：校验GoalDraft输出，生成有版本、有效期的ActionDraft。
- `editDraft(id, version, payload)`：取得新草稿版本；参数变化须重新确认。
- `confirmDraft(id, version)`：内部批准→正式事务执行→运行状态更新；UI成功必须结合回执与snapshot。
- `discardDraft(id, version)`：拒绝后不正式写入；生成中取消用AbortController。
- `saveManual(payload)`：直接正式写入，只能在用户明确确认后调用，不可冒充“保存草稿”。
- 未知结果保留同一草稿/commandId，通过receipt及snapshot对账。运行状态更新失败不等于正式事务失败，不应让用户重复创建。

不存在manualDraft/revise/approve/execute公开客户端接口。若手工草稿也要求持久化，应通过适配器暴露已有领域createDraft(source:ui)，先补规格与测试；不允许页面直接写数据库。

## 必须先解决的接入缺口

1. 真实模型生成执行器：复用当前已配置供应商与安全凭据入口，明确结构化草稿能力、取消、超时、预算和错误；不自动切换供应商，不把Mock标为真实AI。实际外发仍遵循用户已配置的用途与授权。
2. 计划关联：当前plan.create把所有任务挂在第一个项目；没有项目时任务成为独立记录。个人空间goalProgress只通过项目关联汇总，不能把这类任务按标题或创建时间猜测归属。接入前须对照领域约束和设计明确方案，再补相应规格/回归。
3. 草稿编辑/预览与确认分离，保留输入，重启正式查询可见；需要沿Figma真实连线取回编辑/确认页，不只复用聊天截图。
4. 所有失败路径明确“本机写入结果未知/已保存但刷新失败/未执行”，保留重试身份。

## 现有测试的边界

独立只读审查确认领域/适配器测试源码包含拒绝、过期、参数变化、重复提交、跨空间、丢回执与恢复等用例；本轮未重跑，不将这些源码视为新UI通过。后续定向运行并补移动实际操作。现有79项移动测试不覆盖新创建页面、真实模型或完整跨设备闭环。

本轮没有改业务代码、调用真实AI、购买服务、部署、提交或推送；5.3保持未完成。下一步先解决上述技术接线与关联边界，并补实施规格，再写页面。

## 已确认项目关联与生成基础模块

维护者随后明确选择沿用目标→项目→任务，草稿显示一个可改名项目。已同步decisions、space-experience差量与design；不修改schema/历史独立任务。新模块 `apps/mobile/src/space/compatible-plan.ts` 复用现有SSE transport，只返回校验过的GoalDraft，不访问正式写入接口。读取同一捕获的配置会话、用户取消信号和active状态，凭据前后/流结束检查失效；严格JSON与单项目校验，失败无自动重试、无供应商回退。

新增10项可执行测试，合成fetch覆盖合法草稿、仅发送明确目标、非法JSON/围栏/额外批准字段、零/多项目、后台启动、凭据读取中配置取消、响应后取消、空输入。最初缺少模块时测试失败；首次实现发现Node strip-only不支持参数属性，改为显式属性后移动全套89/89通过。类型检查通过；没有真实网络AI调用。日志 [全套测试](plan-generation-tests.log)。

**尚未完成**：把生成模块绑定到真实AISettings上下文、移除正式路径默认Mock、预算/错误本地化接线、草稿界面与确认、手工创建及真实设备闭环。单个模块通过测试不代表用户可使用生成计划。现有财务用量未记账，2048输出token限制不等于月预算。后续扩充流中/最后一帧取消与组件卸载竞态验证。

### 凭据等待取消修复

新增悬挂凭据读取用例，修复前100ms内仍等待而失败；修复后取消立即结束生成，晚到凭据错误被消费且不发起请求。`corepack pnpm --filter @siyue/mobile test` 90/90通过，`corepack pnpm --filter @siyue/mobile typecheck`通过。仅生成模块及测试变化，未接入页面、未调用真实供应商，5.3仍未完成。

### 请求级模型与客户端接线

新增propose-plan与use-plan-generation：使用AISettings安全凭据和Expo fetch，配置会话覆盖整个生成及草稿保存阶段。LocalClient支持请求级provider，移动native默认不再使用Mock；只有native恢复测试显式enableMock。桌面renderer明确拒绝请求级函数，不通过IPC传递或静默忽略。既有数据、schema和正式审批链不变。

验证（仓库根目录）：适配器新增两项用例先失败、实现后`corepack pnpm --filter @siyue/adapters test`42/42通过；同包build通过；移动test94/94、desktop test14/14通过，两应用typecheck通过。移动新增合成SSE→真实临时SQLite整合验证：确认前无正式目标/任务，确认后项目与任务关联正确；草稿落盘期间会话取消，草稿/run取消且无正式目标/任务。测试未访问真实供应商、未使用应用个人数据库。

剩余：hook尚未挂入生成页面，错误本地化、手工草稿、Figma编辑/确认界面对应实现及模拟器/真机验收未完成；不将模块测试当成用户可用闭环。5.3c仍保持未完成。

### 草稿编辑与确认页初步实施

读取Figma实际节点220:1196的design context和截图，沿用Sage输入行、卡片、主按钮、目标图标；新增plan-draft路由和个人空间待确认草稿入口。新增目标/项目/任务编辑、保存草稿修改后单独确认、拒绝、过期只读、原commandId回执及正式对象核实、未知结果查询。中英文资源同时补齐。编辑冲突允许读取最新草稿并保留输入，采用最新版本或重应用输入需显式操作；approved无回执时展示再次审阅确认入口。

draft-state辅助模块新增7项测试，涵盖状态/过期/深拷贝/输入校验/回执身份与实体版本；移动全套101/101通过，typecheck通过。iPhone模拟器iOS26.5通过siyue://plan-draft?id=qa-missing-draft只读验证缺失草稿状态，截图发现返回按钮居中后修复并实际复核左对齐，[截图](draft-ui/missing-draft.png)。未修改个人数据库，未调用真实模型。该截图不证明有数据编辑、冲突、确认、键盘或iPad矩阵通过。

Figma变体读取调用300秒超时；不能认定额度耗尽。随后对已知单页发起复用输入实例添加项目字段操作，结果仍需核实，不宣称Figma矩阵已更新。生成输入页和手工草稿尚未接通，UI仍待进一步原生交互验收。

### 手工草稿与错误提示准备

新增LocalClient.createManualDraft(payload, request)，复用领域createDraft(source ui)，单项目、原commandId/issuedAt、30分钟有效期；确认前无正式对象。成功和丢响应恢复路径均验证来源/空间/执行身份/完整command，拒绝误用AI草稿身份。未知时不创建替代ID。桌面方法暂明确unsupported，不增加IPC权限。输入页面尚未调用该接口。

新增planErrorKey和中英文消息，区分配置、取消、结构错误、截断、超时与限流；不展示未知错误/凭据细节，不把限流一概解释为当日额度耗尽，不声称部分模型输出已保存。补修草稿页采用最新applied版本后必须重新核对回执，不能仅凭状态宣称成功。

验证：适配器新增用例先红后绿；`corepack pnpm --filter @siyue/adapters test`47/47、mobile test102/102、desktop test14/14通过；adapter build、mobile/desktop typecheck通过；spec:check 4/4与release:check通过。均使用合成数据，无真实模型调用或个人数据库修改。

Figma单页写入调用也在300秒超时，落盘结果未知，未重放写入。浏览器现场曾显示“Some changes won't be synced until Figma is able to reconnect.”，随后该连接警告消失；不等于修改已同步。只读design context核实仍在等待，完整Figma项目字段矩阵未完成。

### 创建入口与原生手工闭环

新增plan-create路由，个人空间可进入AI/手工创建。AI动作调用真实设置hook，只发送目标；手工输入目标/项目后创建草稿并跳转。未知手工结果锁定输入并复用本次request；请求只在本页内存中保留，跨进程恢复依赖空间草稿列表，不宣称持久化请求身份。过期重试已修复：先按原ID核实既有草稿，不把approval_expired当作此前未保存的证据。最新适配器48/48、移动102/102及移动typecheck通过。

为原生验证创建全新iPhone 17 Pro模拟器“Siyue Plan QA Isolated”，iOS26.5，UUID FDAA3980-E363-4891-8020-4994DD8AD466，安装已有0.0.1 Debug工件并连接当前Metro8081。空数据库，不读取或更改原iPhone/iPad个人空间。通过实际UI输入QA English practice / QA Work communication，创建草稿，添加Practice a short introduction，保存草稿修改后再明确确认。只读SQLite核查：确认前`goals|projects|tasks|drafts|status|version=0|0|0|1|draft|2`；确认后`goals|projects|tasks|receipts|draftStatus=1|1|1|1|applied`。终止并重新启动应用，空间仍显示目标0/1；点击完成后界面1/1，数据库`1|1|1|2|done|applied`（计划及任务更新各一份回执）。[重启后完成截图](draft-ui/manual-restart-completed.png)。成功页返回按钮已定向到我的空间，避免深链进入后回到错误页面。

这仅证明iPhone中文明色手工正常路径。AI供应商实际调用、取消/冲突等完整原生失败路径、iPad/英文/大字号/Android/Electron创建闭环仍未验收。新增输入页沿用已读取的Sage草稿/对话输入组件方向，Figma新增字段及创建页完整对应仍待复核；此次只读design context也300秒超时，当前无继续运行的Figma调用，不宣称设计同步成功。

### 2026-09-10 原生恢复路径与 Figma 项目字段

隔离iPhone辅助大字号accessibility-extra-large：创建输入可录入QA English goal，缺少模型配置时出现受控提示且输入保留；返回选择继续编辑后仍保留；进入AI设置再返回也保留。修复AI设置返回按钮无障碍名称硬编码为“设置”，改为通用“返回/Back”，现场AX复核。测试后该隔离设备字号恢复large。该检查不覆盖软件键盘、大字号所有滚动位置或所有异常。

创建全新隔离iPad Pro 11-inch M5，iOS26.5，UUID42C82E31-F592-4C74-99BF-3579F5DD674F，空数据安装已有Debug工件，通过设置切英文/暗色。创建页横竖屏均实际查看；横屏手工输入QA iPad review/QA project并创建草稿，确认拒绝后编辑/确认入口消失，字段只读；只读SQL结果`goals|projects|tasks|receipts|status=0|0|0|0|rejected`。补充已拒绝/取消/过期状态标题，现场AX复核Draft rejected。[横屏草稿](draft-ui/ipad-en-dark-landscape-draft.png)、[拒绝后](draft-ui/ipad-en-dark-rejected.png)。不改变原iPad用户环境。本轮iPad未测试确认正式保存、重启与任务完成。

Figma小范围读取恢复，先证实原项目字段缺失后再写入。12张指定草稿变体（4手机、8平板，中英明暗、平板横竖屏）均复用原Input组件205:19，正文高度318→394，任务和下方按钮自动下移。12个节点回查、12个正文截图及2个代表整屏截图已核查，主代理重新查看代表整屏，未见重叠。证据：[节点及截图记录](../../design/draft-project-fields-2026-09-10.json)。这是项目字段同步，不代表新创建页/错误/批准等其他Figma变体已同步或完整验收。

### 2026-09-10 任务行身份与输入保持

草稿任务行原来使用数组index作为React key，删除前项会复用不同任务的输入节点。现改为本次编辑期间稳定的行身份，加载/保存/采用最新时统一重建，增删时保持其他行身份。没有更改正式任务ID或数据结构。

隔离iPad英文暗色实测：手工新建QA task focus/QA project草稿，添加First、Second；聚焦Second时删除First，再直接输入“ continued”，AX显示同一输入控件52的值为Second continued、标签随顺序变为Task1。保存草稿后只读SQLite确认taskTitles=["Second continued"]，version=2，status=draft。未确认该草稿，未创建正式计划。移动typecheck及102项测试通过；快速连续增删/全部键盘与平台矩阵仍未覆盖。

### 2026-09-10：真实运行来源记录修正

原始 Siyue M1 QA iPhone 已配置 DeepSeek，通过界面输入合成目标 `English` 并触发一次生成；界面返回无效单项目草稿错误，未确认或创建正式计划。未保留原始响应，不能判断当次具体格式失败原因，也不能视为真实生成验收通过。检查发现旧运行记录固定标为 Mock；不推测或重写历史记录。

新请求级 proposer 必须携带执行元数据。移动端捕获一次凭据，以同一份凭据的公开 model ID 记录 modelVersion 并发出请求；该字段不代表供应商不可变模型版本。promptVersion 为 compatible-single-project-v2，明确项目与任务字段均为字符串数组。未知 usage 保存 null。取消等待凭据不启动运行，设置会话失效继续覆盖草稿持久化阶段。

contracts 8/8、domain 43/43、adapters 50/50 测试通过，含 SQLite 重开后真实元数据与正式确认边界。历史 Mock 缺省可读；新 compatible 记录不受旧严格客户端支持。SQL 结构/schemaVersion 未变，不宣称旧客户端读取兼容。真实供应商修复后重试尚未完成。

### 2026-09-10：真实生成与拒绝的原生证据

在原始 iPhone 模拟器 `7328BC59-6853-445B-A888-E99496AB2048`（Siyue M1 QA，iOS 26.5；旧 native 0.1.0 + 当前 Metro JS）通过屏幕键盘输入合成目标 `English`，执行一次真实生成。界面进入“确认你的计划”，出现目标 `English Language Learning Plan`、可编辑项目 `English Proficiency Builder` 与 24 项任务。截图：`draft-ui/real-provider-draft.png`。本次成功不证明前一次无效输出的具体原因；未记录原始供应商响应，不能把提示数组说明的修改直接认定为根因修复。

通过 `xcrun simctl get_app_container ... app.siyue.mobile data` 定位当前容器，用 sqlite3 只读查询 `Documents/SQLite/siyue-m1.db` 的 JSON 状态：新 run 为 `compatible / deepseek-v4-flash / compatible-single-project-v2 / awaiting_approval / usage:null`，新 draft `e68c1a5b-e0c4-41b6-8299-80b706199779` 为 draft、1 项目、24 任务，对应正式目标数量为 0。旧失败 run 保持 Mock 历史标记。

随后通过“拒绝这份草稿”及确认弹窗拒绝此合成草稿，界面显示“草稿已拒绝”。再次读取数据库：draft=rejected、run=cancelled、对应正式目标仍为 0。保留拒绝记录，不删除测试历史，不修改既有用户计划。已验证真实生成→本地草稿→明确拒绝边界；本次没有正式确认，也未证明真实供应商的确认后重启链路、iPad 真实请求或真机通过。

独立审查发现等待存储初始化时取消不能立即返回，已修复，并增加请求取消/设置会话失效、晚到存储结果、凭据单次快照与实际 HTTP/运行模型同源测试。补充完整 JSON 已消费但 DONE 未到时的取消测试，修正旧测试过度声明的名称。

本轮最终验证（仓库根目录）：`corepack pnpm --filter @siyue/mobile test` 107/107，通过日志 `/tmp/siyue-real-draft-tests.log`；移动 typecheck（独立修复审查）通过；`corepack pnpm spec:check` 4/4、`git diff --check` 通过。没有提交、推送、部署或真机测试。

### 2026-09-10：隔离 iPad 确认、重启与完成

设备 `42C82E31-F592-4C74-99BF-3579F5DD674F`（Siyue Plan QA iPad Isolated，iPad Pro 11 M5/iOS 26.5，native 0.0.1，英文/暗色/横屏）。通过界面确认此前的合成手工草稿 `QA task focus / QA project / Second continued`；出现 `Plan saved on this device`。执行 `xcrun simctl terminate <device> app.siyue.mobile`、`xcrun simctl launch <device> app.siyue.mobile`，再 `xcrun simctl openurl <device> siyue://space`，目标重新出现且进度 0/1。进入详情、点击复选框后左右两栏同步为 1/1；CUA 实际查看横屏截图，无详情菜单混入。

只读 sqlite3 检查该隔离容器 `Documents/SQLite/siyue-m1.db`：goals/projects/tasks/receipts 为 1/1/1/2，task=done，指定 draft=applied。截图 `draft-ui/ipad-restart-completed.png`（simctl 原始截图可能按设备原始方向保存，已另通过 CUA 查看直立横屏）。这证明该 iPad 的手工草稿→确认→重启查询→任务完成；不代表 iPad 真实供应商、全部主题/语言或真机完成。

独立静态审查发现 `plan-draft-screen` 读取成功后未清除旧 latest 冲突快照，会残留冲突卡并禁用确认。已在权威读取、编辑、拒绝成功与回执对账成功/同版本结果时清除；未清除失败路径的可恢复输入。该冲突路径的原生故障注入尚未运行，不能按本次普通确认路径认定修复验收完成。

本步静态验证：`corepack pnpm --filter @siyue/mobile typecheck` 通过；`corepack pnpm --filter @siyue/mobile test` 107/107 通过（`/tmp/siyue-ipad-confirm-tests.log`）；`git diff --check` 通过。测试不覆盖本次冲突卡原生交互，未因此声称该路径验收。

### 2026-09-10：完整 JSON 后异常结束的持久化边界

新增 `apps/mobile/tests/propose-plan.test.mjs` 三个集成场景，使用合成 SSE + 正式 LocalClient/领域服务 + 临时真实 SQLite，分别注入缺失 DONE、finish_reason=length、finish_reason=tool_calls。全部先发送完整有效单项目 JSON，再异常结束；断言每次仅一次请求、一个 compatible/failed run、usage=null，且 drafts/goals/projects/tasks 均为零。该测试验证传输结束语义贯通持久化边界，不是实际供应商异常或原生故障注入。

命令 `corepack pnpm --filter @siyue/mobile exec node --experimental-strip-types --test tests/propose-plan.test.mjs`：11/11 通过，日志 `/tmp/siyue-incomplete-plan-tests.log`。没有修改生产逻辑；这三条已有行为获得直接集成证据。
