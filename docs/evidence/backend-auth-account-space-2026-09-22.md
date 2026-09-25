# SA-05 空间映射与客户端生命周期基础

2026-09-22，`feature/dev` 当前未提交工作，基线 `fee1f4b`。实现原方案7.2、18章和CLI-03/04的必要基础，活动变更 `add-shared-api-independent-auth`。**正式移动／桌面空间入口与白板命名空间尚未接入，6.4整体未完成。**

## 本批实现

- `accountSpaceBindingSchema` 明确版本、环境、稳定subject、随机namespace和spaceId，不含邮箱、路径或访问令牌。
- `createAccountSpaceCatalog` 使用专用 SQLite 数据库；查询不创建关联，显式创建按环境与subject唯一且可重复。不同账号／环境分配独立namespace；原业务数据库与owner不修改。写失败事务回滚，损坏条目、未版本化非空库和未来格式拒绝覆盖。
- `createAccountWorkspace` 从宿主提供的可信会话状态取得subject，界面不能传入其他subject或文件路径。首次无映射继续使用原本机空间；显式创建独立账号空间后持久恢复。换号先失效旧客户端生命周期再打开对应空间。资源关闭失败保持不可用并保留待关闭资源，重试成功后才打开替代资源。
- `createLocalClient` 新增可选生命周期信号；现有未接线调用保持原行为。失效后拒绝新操作，丢弃迟到读取／回执，中止生成请求并阻止排队确认继续应用。已提交写入和回执保留在原空间，不假称可回滚已经提交的数据。
- 桌面原有 IPC 增加等待结束后的归属与销毁复查，避免已销毁dispatcher仍返回原上下文数据。此项已进入正式主进程；空间协调器仍仅用于本批测试宿主。

协调器当前只处理成人个人空间；儿童受限设备及家庭授权仍属于SA-08，不把个人映射当作家庭访问权限。新建独立账号空间也不替代原本机空间的显式关联／恢复入口，该能力继续跟踪6.4d。没有云同步、上传或数据迁移。

## 已执行验证

| 检查 | 实际证据 |
| --- | --- |
| adapters单测 | `corepack pnpm --filter @siyue/adapters test`：72/72；`/tmp/siyue-account-space-unit.log`。包括映射重复创建、环境隔离、持久重开、写失败回滚、损坏／未来原件保留、关闭失败恢复、生成迟到、排队确认、已提交旧回执保留。 |
| 桌面主进程 | `corepack pnpm --filter @siyue/desktop test`：23/23；`/tmp/siyue-account-space-desktop-unit.log`。新增销毁后迟到读取不得返回的回归。 |
| Playwright真实基础接线 | `tests/e2e/account-space.spec.mjs` 使用临时 PostgreSQL、真实HTTP登录／退出、生产认证协调器、真实文件SQLite空间与映射表。A创建→B创建→重启恢复B→退出回本机→再次登录A；验证独立记录、旧客户端失效和迟到读取丢弃。 |
| 原有应用回归 | 与 `desktop-auth.spec.mjs` 及 `desktop.spec.mjs --grep 'manual create, rename'` 一起执行，组合4/4通过，`/tmp/siyue-account-space-regression.log`。不是移动原生或白板换号验收。 |

准确组合命令：

```sh
corepack pnpm --filter @siyue/contracts build
corepack pnpm --filter @siyue/adapters build
corepack pnpm exec playwright test tests/e2e/account-space.spec.mjs tests/e2e/desktop-auth.spec.mjs tests/e2e/desktop.spec.mjs --grep 'real account sessions|real Electron main|manual create, rename'
```

构建／类型：contracts、adapters构建通过；mobile/desktop类型检查通过，日志 `/tmp/siyue-account-space-{build,mobile-type,desktop-type}.log`。本批未新增依赖。

最初回归发现已取消的简化AbortSignal对象没有addEventListener，已恢复“先检查取消再订阅”的兼容行为；全部旧测试随后通过。集成测试初次把Date对象传给要求ISO字符串的领域时钟，严格合同拒绝写入；修正测试工厂时钟后通过，未放宽产品合同。

## 接入限制与下一步

当前Playwright是“真实服务＋存储＋协调器”的测试宿主，不是正式设置页面选择空间。正式应用的原本机空间仍保持原样；不得据此宣称账号内容在所有界面已隔离。接下来必须完成：

1. 两端宿主创建／关闭资源，受限IPC与当前空间信息，显式创建／选择入口。
2. 待处理命令键、表单／检索／AI缓存随空间隔离；切换前保留输入与未确认结果。不能只重建React组件来掩盖旧请求。
3. Excalidraw正式存档与照片原件目录隔离；落盘失败留原编辑上下文，旧DOM请求不能写新空间。
4. 原本机空间显式关联及恢复；iPhone/iPad/Android/Electron UI及原生验收。

本地测试仅合成内容与临时数据库，无根`.env`读取，无云操作，无提交推送。原方案三份文件未改；整体工作包保持in_progress。独立审查代理遇到429，没有可用审查结果，不能标记独立审查通过。

## 桌面接入增量（进行中）

本节更新上面的“尚未接入”快照：桌面主进程已接线空间协调器、按namespace打开业务与白板SQLite、按revision约束IPC。Renderer保留同空间表单，旧空间在关闭期间保持挂载但隐藏，允许白板向原文件完成最后保存；待处理命令键按账号namespace隔离。设置账号页增加显式创建账号空间入口。移动端、原本机空间显式关联尚未接入，6.4b/c不能勾选完成。

当前验证：桌面类型检查、构建通过；桌面主进程23/23；Playwright组合5/5（中英文账号错误/重置/登录/重启/退出2项、原有业务编辑重启2项、新增workspace-renderer空间重开保留未保存文本及拒绝旧revision1项）。日志 `/tmp/siyue-workspace-{account-check,main-tests,build}.log`。spec:check 6/6、release:check、diff检查通过。

失败与修复：首次用了旧renderer构建，重建后原业务2/2通过；同空间按revision重挂载会丢失认证表单错误，改为同namespace保留页面、仅重新绑定客户端和白板；未保存编辑缓冲按namespace保留在进程内，不承诺强杀恢复。退出测试改为等待数据库实际撤销，避免以显示登录表单替代远端撤销证据。Node回归导入新增TS模块失败，改为显式扩展名并启用noEmit类型检查的对应选项，23项恢复通过。

这些结果尚不证明正式UI的A/B多账号创建隔离、换号时白板保存失败、跨账号未保存表单恢复以及所有缓存隔离；下一批必须补充真实Electron多账号路径和白板回归。独立审查代理本轮仍429，无独立审查结果。未读取根env或操作云端。

### 真实桌面换号与白板失败验收增量

新增持久Playwright脚本 `desktop-account-space.spec.mjs`：通过实际设置登录和显式创建空间，验证原本机业务记录不被收编、A/B记录隔离、B冷启动恢复、退出回原本机、重新登录A恢复记录。两账号各自经Excalidraw工具栏绘制笔迹，B首次无A笔迹，重启B恢复B元素ID，重登A恢复A元素ID。最终1/1通过，日志 `/tmp/siyue-account-space-ui-boards.log`。全部账户与内容为临时PostgreSQL的合成数据，非云端验收。

`workspace-renderer.spec.mjs` 新增两条：未落盘笔迹在空间重开前完成flush（通过）；通过真实SQLite触发器注入写入失败，验证协调器拒绝替换、原磁盘内容逐字不变，解除故障后通过界面重试，原DOM笔迹落盘（1/1通过，`/tmp/siyue-workspace-flush-failure.log`）。原文本保留和旧revision拒绝仍通过。原 `excalidraw.spec.mjs` 五项全部通过，包括图片完整字节、失败原件保护、退出flush、工具和暗色窄窗；该五项是本机原空间回归，尚不代表跨账号图片隔离。

测试最初错误地把主进程已切换视为界面已提交，并立即点击旧设置对话框；新增明确workspace revision测试契约，等待实际渲染修订完成。白板返回也等待设置入口恢复后才做只读存档检查，避免检查会话提前替换尚在退出的编辑会话。未通过强制点击或延长超时掩盖问题。当前缺口仍包括跨账号图片、移动空间接线、既有本地空间关联、账号安全/Apple/家庭后续工作包。

### 跨账号图片验收增量

`desktop-account-space.spec.mjs` 已扩展真实Electron选图流程：仅将原生文件选择结果替换为仓库合成题图，图片读取、压缩、Excalidraw插入、保存和恢复仍执行产品实现。A保存图片＋笔迹，断言完整JPEG dataURL与文件引用存在；B首次为空且无A图片文件，写入B笔迹后重启恢复；重新登录A时按元素ID/type/fileId和完整files对象逐项相等检查。1/1通过，日志 `/tmp/siyue-account-space-images.log`。此证据是桌面原生选图适配及账号隔离，不是相机或移动原生验收。

移动端接入现状核查：`src/client.ts`缓存单一客户端；`native-client.ts`持有业务与pending两份SQLite连接但未暴露资源关闭；`whiteboard/native-service.ts`使用全局kv-store及whiteboard-originals目录。因此后续必须把这三者一起接入协调器并保持旧本机路径，不能只改页面账号标签。移动端仍未接入，原件未迁移。子代理本轮因429终止，无可用独立审查结果。

### 移动资源生命周期接入准备

`apps/mobile/src/native-client.ts` 增加 `createNativeClientResource`，返回绑定同一空间的client与close；现有createNativeClient调用保留原本机数据库默认路径。资源接收宿主spaceId和lifetimeSignal，关闭先取消后等待已开始调用结束，再关闭待处理命令与业务SQLite。重复/并发close幂等，退休客户端拒绝新调用。空间元数据与数据库内spaceId不一致时拒绝打开并保留原件；桌面工厂也增加同一检查。

新增 `apps/mobile/tests/native-client-resource.test.mjs` 使用真实文件SQLite，仅替换Expo原生桥接层：双空间隔离、账号spaceId保持、同库错误spaceId拒绝且正确重开原件、并发关闭、取消后迟到写入拒绝、文件名与身份校验。3/3通过；移动全套Node回归133/133通过，类型检查通过，日志 `/tmp/siyue-mobile-resource-{test,regression,type}.log`。未声称Expo SQLite原生关闭行为已验收；移动协调器、导航保存握手、白板和拍照目录尚待接线。未新增依赖，未移动旧数据。

### 移动空间宿主与编辑器保存握手

新增 `account/workspace-service.ts`：可信认证驱动catalog与空间协调器，按namespace分配业务/pending数据库、白板KV键和相机原件目录，保留原本机路径；旧生命周期只允许已加载编辑器向原命名空间完成save，不允许旧load/pick。资源关闭先收齐编辑器保存确认，失败不打开新空间。`workspace-editors.ts` 为每次保存请求分配独立token，合并同时请求，忽略旧token，失败/超时/卸载均不当成功，允许重试。

白板native-service增加可选宿主namespace和取消信号，系统选图/相机返回及图片处理后复查生命周期；路径仅由受校验UUID生成，DOM不能指定路径。原本机调用保持原路径。此宿主尚未接入正式Provider、导航与白板screen，因此不能称移动账号隔离已启用。

新增宿主测试用生产宿主和真实文件SQLite，仅以测试替代Expo平台桥：验证本机→A显式创建、隔离白板键、保存确认失败→不可用、成功重试→B独立空间、旧客户端/白板失效、退出回原本机。与资源测试组合4/4；握手独立2项覆盖并发、失败重试、旧token、卸载和超时。日志 `/tmp/siyue-mobile-workspace-host.log`，全套测试见 `/tmp/siyue-mobile-workspace-all.log`。这些不是原生平台/相机/DOM桥接证据。正式接线和原生回归仍需继续，不勾选6.4b/c。

### 正式移动导航与账号接线增量

正式root启用WorkspaceProvider；业务getClient使用已配置宿主，配置失败不回退到未隔离的旧客户端。认证不可配置时仍提供原本机空间。Provider在切换中隐藏并禁用旧导航树的交互/无障碍读取，同时保持旧白板挂载供flush；确认新空间后按namespace重建导航和聊天缓存。白板screen注册保存token回执，同空间revision变化也重新绑定DOM会话。账号页面增加显式创建账号空间。创建表单、任务名称编辑和草稿输入以namespace+表单ID保存在进程内；不宣称强杀可恢复未保存输入，完整表单换号验收尚待执行。

类型及136项Node测试通过；正式Android离线导出到 `/tmp/siyue-space-mobile-export`（本次未启动Metro，EXPO_NO_DOTENV=1）；独立QA Android Release构建通过，包标识经aapt2核实为app.siyue.mobile.accountqa再安装。QA root同样采用生产WorkspaceProvider，测试认证环境明确为test。`android.mjs --workspace` 2/2通过：中文明色、英文暗色，真实登录→点击创建空间→冷启动恢复→退出→重启不恢复登录。使用真实Android SecureStore、Expo SQLite与本机隔离PostgreSQL；该项尚未验证业务或白板内容跨账号。结果 `artifacts/account-ui-android-1790014443022/result.json`，日志 `/tmp/siyue-mobile-space-android-{build,qa}.log`。

截图存于界面证据目录android-workspace-zh.png / android-workspace-en.png。已查看中文截图，QA浅色状态栏白色图标仍是历史测试宿主问题；产品root已有随主题StatusBar，未将QA截图算完整视觉验收。该Android构建没有覆盖后来草稿页面key隔离的小修正（QA入口不导入该页面）；其类型检查通过，但完整产品原生路线仍待后续运行。iPhone/iPad空间接入、移动白板换号/图片/写入失败、表单恢复、原空间关联继续未验收。临时测试服务已结束，不连接云端，不读取根.env。

### 空间身份可见性与 iOS 原生验收

两端账号页面新增“当前空间”说明，明确原本机空间与仅本机账号空间；未暗示云同步。Android和XCTest加入创建后及冷启动后的空间身份断言，避免只看到“已登录”就算映射成功。

- Android独立Release与 `android.mjs --workspace`：2/2，`artifacts/account-ui-android-1790033159004/result.json`，中英/明暗。QA宿主增加与产品一致的StatusBar主题控制，中文截图确认浅底图标可见。
- iPhone XCTest：2/2，`artifacts/account-ui-native/space-iphone-02.xcresult`。首次space-iphone-01两项被系统Save Password弹窗阻挡；测试根据无障碍树显式选择Not Now后重跑通过，未关闭产品密码自动填充。
- iPad XCTest：2/2，`artifacts/account-ui-native/space-ipad-01.xcresult`，包括横屏恢复。使用42C82E31-F592-4C74-99BF-3579F5DD674F隔离模拟器。
- 桌面Playwright账号UI与双账号图片组合3/3；加强空间文字断言后单项再次1/1。日志 `/tmp/siyue-space-desktop-{ui-3,identity}.log`。

截图位于界面证据目录 iphone-workspace-zh/en.png、ipad-workspace-zh/en-landscape.png、android-workspace-zh/en.png。已查看中文iPhone、中文Android和英文iPad横屏图。这里只验收账号页面和空间创建恢复，非完整业务/白板原生验收。

代码审查补充修复：移动configuredClient同步捕获调用时的资源，避免Promise续体重新选取空间；代理对非方法属性返回原值，避免把不存在的then当方法导致Promise错误吸收。新增测试直接覆盖切换发生在Promise续体之前，验证拿到旧资源且操作被取消；环境在同一宿主固定，禁止重配为另一环境。类型检查与137项Node测试通过，`/tmp/siyue-space-capture-tests.log`。iPad构建包含资源捕获和then修复；环境固定的最后一道校验仅跑了Node回归，未重新构建。iPhone与Android上述账号测试构建早于捕获修复，不将其当作业务调用路径的验收证据。

测试服务已关闭，未连接云端。活动工作包仍未完成：移动业务/白板内容换号、照片原件、存储失败、表单恢复、既有空间关联与其他SA工作包继续执行。

### Android 原生笔迹与账号恢复验收

`artifacts/account-ui-android-1790034389627/result.json` 确认 `status=passed`、两语言场景及 `whiteboardRecovery=true`。持久脚本 `apps/mobile/e2e/account-auth/android.mjs --whiteboard` 通过原生触摸在正式 Excalidraw 白板书写，保存后比较 namespace、元素 ID、完整元素与文件摘要，覆盖 A/B 独立初始空白、各自冷启动、退出回原本机空白以及重新登录 A 恢复 A。QA 元数据入口只读；没有用注入场景替代书写。截图归档为界面证据目录 android-account-board-zh/en.png。

首次测试暴露 UIAutomator 单引号属性解析问题，修复后可以读取 JSON 标签。新隔离服务令旧会话失效时，还复现成人 reauth-required 被空间错误遮罩挡住登录的问题：协调器现在关闭失效账号空间并开放原本机空间以重新登录，成功认证后恢复原绑定；儿童仍拒绝访问。对应共享协调器单测及桌面真实会话撤销回归已补充。此前执行记录为 adapters 73/73、mobile 137/137、桌面该项 1/1；临时日志当前已不可用，不把这些计数作为本次重新执行结果。

QA Gradle 原先未将共享包列为输入，可能复用旧 JS；已补充 src/dist 输入并重新构建后运行上述原生验收。该修正仅针对独立 QA 构建。创建表单成功后清空进程内输入与请求身份，完整原生表单路径仍待验收。

边界：本次原生白板只含笔迹，无图片文件；原本机空间为空，不能据此证明非空访客内容保留。移动图片、后台返回、写入失败、iOS 白板、真机手写笔/相机，以及原空间显式关联仍未验收。根 env 未读取，云服务未操作，整个 SA 工作包仍未完成。

### 前台返回保留编辑空间（2026-09-22）

复现：原 AccountAuthProvider 每次 active 都 bootstrap，认证 generation 从 2 变 3，进而退休编辑空间。新增 Playwright 回归先以旧策略运行，明确在 generation 不变断言失败。现新增 `foreground-auth.ts` 并接入 Provider：authenticated/offline-available 调用 session 校验及待撤销处理；anonymous 仅处理待撤销队列；认证进行中不重启，错误恢复仍保留 bootstrap。真正会话撤销仍关闭原空间，不放宽账号权限。

当前实际执行（仓库根目录）：
- `corepack pnpm exec playwright test tests/e2e/auth-client.spec.mjs --workers=1`：13/13，通过真实本机 HTTP 与临时 PostgreSQL 验证。新增场景覆盖有效会话、令牌续期、离线→恢复、服务端撤销；断言 generation、workspace revision、client 引用在正常恢复中不变，撤销后旧资源替换。此场景的工作区资源为受控测试对象，不是原生 SQLite/DOM。
- `corepack pnpm --filter @siyue/mobile typecheck`：通过。
- `corepack pnpm --filter @siyue/mobile test`：138/138；新单测覆盖进行中状态、匿名待撤销及错误恢复分支。
- 独立只读审查确认原 bootstrap→generation→空间退休链路，主代理复核并执行上述回归。

本轮未重新构建原生应用；ADB 当前没有连接设备。相册返回、系统 AppState 事件及原生白板连续编辑仍需原生验收，不能用上述控制器测试宣称已通过。冷启动认证与空间初始化时序仍是独立待验收项。未读取根 env 或操作云端。

### 冷启动身份恢复竞态（2026-09-22）

新增回归先复现：认证处于 bootstrapping 时，空间已变 ready 并打开原本机库，未等待账号身份。共享协调器现在将 bootstrapping 纳入选择键并保持 loading，不分配业务资源；身份解析完成的订阅事件直接继续选择。等待不占用认证 promise、不要求手动重试，也不改动存档或 catalog。匿名恢复后仍正常打开原本机空间。

验证：adapters 单测 74/74，构建通过；移动类型检查及 138/138 单测通过。`corepack pnpm exec playwright test tests/e2e/account-space.spec.mjs tests/e2e/auth-client.spec.mjs --workers=1` 14/14。新增真实 HTTP＋临时 PostgreSQL＋文件 SQLite 冷启动断言：先启动空间宿主，确认没有库被打开；恢复 B 身份后仅打开 account，B 原记录仍在，之后退出及重登 A 保持隔离。模拟器与安装包未在本轮重新运行，不能将此结果作为完整原生冷启动验收。

独立审查补充：冷启动首次 refreshing 也须等待，已按认证 generation 区分“首次恢复”与“已建立身份的正常续期”；前者继续 loading，后者保持资源。`start()` 明确保留立即返回语义，桌面可随后启动认证，避免循环等待。补充后重新执行 adapters 74/74、移动类型与 138/138、Playwright 上述 14/14。另执行 `corepack pnpm exec playwright test tests/e2e/desktop-account-space.spec.mjs --workers=1`：真实 Electron 1/1，通过窗口启动、A/B 图片与笔迹恢复、退出及撤销后登录恢复，未出现启动死锁。认证 vault/API 已有超时；没有以无限等待作为恢复保证，原生超时交互仍需验收。

### Android 后台返回及修复后原生复验（2026-09-22）

重新构建独立 `app.siyue.mobile.accountqa` Release，包含 foreground-auth 与冷启动 pending 修复。构建使用 EXPO_NO_DOTENV=1、JDK17、QA Gradle init script，54 秒成功，aapt2 验证独立包标识后安装到 Siyue_API_36 / emulator-5554；不覆盖正式应用。未启动 Metro，服务仅使用回环 HTTP 与临时 PostgreSQL、合成账号。

`SIYUE_QA_ANDROID=emulator-5554 node apps/mobile/e2e/account-auth/android.mjs --whiteboard` 2/2 通过，结果 `artifacts/account-ui-android-1790083121628/result.json`。每种语言在正式白板触摸书写第一笔，HOME 后启动原 Activity 返回白板再画第二笔，保存后断言两笔存在；冷启动比较 namespace、元素及文件摘要，退出回原空间，再登录 A 恢复 A 内容。中英/明暗均通过。截图 `backend-auth-account-ui-2026-09-22/android-board-resume-zh.png` 和 `android-board-resume-en.png`，中文截图已目视核对两笔与已保存状态。

独立审查指出：两笔恢复不能排除无损编辑器重挂载，因此本结果仅证明前后台内容保留、继续编辑和账号隔离；不能宣称撤销历史/当前工具内存状态保持。相册、相机、图片文件、iOS 与真机仍需独立验收。脚本语法、spec:check 6/6、release:check、diff 检查通过。隔离测试服务完成后已发送正常终止信号，不操作云端。

### Android 系统相册图片隔离（2026-09-22）

持久原生脚本新增 `--images`，将仓库 exercise.png 放入模拟器 Pictures/SiyueQA 并触发媒体扫描；查询该指定文件的媒体时间，结合系统时区定位唯一照片标签。第一轮失败是选择器不展示文件名（artifacts/account-ui-android-1790083445063/failure.png），已据系统 UI 与指定媒体记录修正定位，没有按照片列表首项猜测，也没有替换产品相册 API。当前脚本要求系统选择器英语，应用仍覆盖中英。

执行 `SIYUE_QA_ANDROID=emulator-5554 node apps/mobile/e2e/account-auth/android.mjs --images`：2/2 通过，结果 `artifacts/account-ui-android-1790083693754/result.json`。复用上一节已核实的独立 Release 包；测试服务为全新临时 PostgreSQL。A 经真实系统相册选入一张合成题图、批注两笔并经历 HOME 返回；保存检查 image 元素存在、files 摘要非空。冷启动逐项比较空间 namespace、完整元素摘要及 files 摘要；B 新空间无 A 图片、files 保持空；重新登录 A 恢复原元素与全部文件记录摘要。

图片经过生产 ImageManipulator 重编码为 JPEG，比较的是该落盘记录，不与源 PNG 字节假定相等。load 使用生产 validateBoard 校验图片引用，初次保存截图已目视确认题目与批注正常显示：`backend-auth-account-ui-2026-09-22/android-account-image-zh.png`。摘要相等证明字节未改变，不独立证明任意损坏 JPEG 均能被校验器发现；本轮也没有重新打开后的单独渲染截图。

相机原件、取消、授权拒绝、大图、iOS 与真机仍待验收；6.4c 不整体勾选。语法、spec 6/6、release 与 diff 检查通过。完成后正常关闭隔离服务，未读取根 env、未使用真实家庭图片、未连接云端。

### 已有白板的相册取消（2026-09-22）

`android.mjs --images` 增加 cancelImage：关闭并重新打开已有作品，进入真实系统相册（确认 Albums 可见），按系统返回取消，等待原白板与“已保存到本机”，再比较取消前后 namespace、元素与 files 全量摘要。A 含合成题图＋两笔，B 含两笔；无场景注入。运行 2/2 通过，`artifacts/account-ui-android-1790084023506/result.json` 的 whiteboardImageCancel=true，并继续通过冷启动、退出和重新登录 A。复用前述独立 Release 包，本次未修改产品代码。

中英截图归档 `backend-auth-account-ui-2026-09-22/android-image-cancel-zh.png` / `android-image-cancel-en.png`；中文已目视确认重新打开后题图与批注仍完整显示。独立只读审查核实产品取消逻辑返回原保存状态，本次原生运行验证了这条路径。未添加多余“取消成功”提示；没有把未复现的 picker 挂起或退休时错误提示推测当作已确认缺陷。

脚本语法、spec 6/6、release 与 diff 检查通过。临时服务完成后正常关闭。相机权限拒绝/原件、iOS 白板、真机与剩余 SA 工作包仍未完成，工作包勾选未提升。

### Electron 登录时工作区 revision 的重新读取（2026-09-23）

认证 Playwright 首次扩展到 Electron 真实主进程时，发现登录后工作区 revision 变化使原本机 LocalClient 失效；本地空间仍然 ready，但目标/行动读取收到 `cancelled` 后页面一直显示“本机空间暂不可用”。测试用独立 userData 和临时 PostgreSQL 重复复现。修复桌面计划页在 workspace revision 变化后退休旧 client，并在新 revision 稳定、在途读取结束后重新取快照；保留同一 local/account scope 的编辑器，不做账号数据迁移。

验证：`corepack pnpm --filter @siyue/desktop typecheck`、桌面原生单测与 renderer build 通过。认证＋账号空间相关 Playwright 28/28 通过，包含 Electron 主进程真实登录、加密恢复、进程重启、退出、双账号空间隔离及完整 auth/UI/HTTP 回归。失败修复前已验证 workspace bridge ready 而页面仍报错；修复后 Electron 登录、重启和退出的入口断言均通过。此验证使用本地 Electron 与隔离 PostgreSQL，不是 Linux/Windows 系统密钥库验收。

### iOS 模拟器账号白板隔离（2026-09-24）

独立 `app.siyue.mobile.accountqa` 的 XCTest 通过真实账号界面与白板画笔，在 A 的账号空间绘制并保存一笔；冷启动后元素及文件摘要一致。退出后本地空间不含 A 的元素，B 新账号空间为空，重新登录 A 恢复原元素与摘要。隔离 QA 服务使用回环合成账号与临时 PostgreSQL。`xcodebuild build-for-testing` 通过；iPhone 17 Pro（iOS 26.5）单测试执行两次均为 **1/1**，第二次结果由 `xcrun xcresulttool get test-results summary` 独立核实为 Passed，证据见 `artifacts/account-ui-native/ios-whiteboard-isolation-1790233853.xcresult`。持久用例和执行前置见 [原生 QA 说明](../../apps/mobile/e2e/account-auth/README.md)。这只验收该模拟器上的触摸笔迹与本机账号空间隔离；真机、图片/相机、手写笔、共享房间及生产服务仍待验收。

### iPad 原生账号白板隔离（2026-09-24）

同一独立 `app.siyue.mobile.accountqa` XCTest 在专用 iPad 模拟器 `Siyue Whiteboard Trial QA iPad`（iPad Pro 13-inch (M5)、iOS 26.5、arm64、`1E1F92B8-B29F-49E0-B137-22A997493073`）上执行。复用 `/tmp/siyue-account-ios` 的 `build-for-testing` 产物，执行前卸载隔离 QA 包，回环合成 fixture 与临时 PostgreSQL，不读取根 env、不连接云端、不接触正式应用数据。

```sh
xcrun simctl uninstall 1E1F92B8-B29F-49E0-B137-22A997493073 app.siyue.mobile.accountqa
xcrun simctl install 1E1F92B8-B29F-49E0-B137-22A997493073 /tmp/siyue-account-ios/Build/Products/Release-iphonesimulator/SiyueAccountQA.app
xcrun simctl install 1E1F92B8-B29F-49E0-B137-22A997493073 /tmp/siyue-account-ios/Build/Products/Release-iphonesimulator/AccountAuthUITests-Runner.app
xcodebuild test-without-building -workspace apps/mobile/ios/Siyue.xcworkspace -scheme AccountAuthUITests -configuration Release -destination "platform=iOS Simulator,id=1E1F92B8-B29F-49E0-B137-22A997493073" -derivedDataPath /tmp/siyue-account-ios -resultBundlePath artifacts/account-ui-native/ios-ipad-whiteboard-isolation-<ts>.xcresult -parallel-testing-enabled NO -collect-test-diagnostics never CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- -only-testing:AccountAuthUITests/AccountWhiteboardIsolationUITests/testAccountSpaceWhiteboardIsolationAcrossAccounts
```

iPad 上共 6 次执行，前 4 次都只在测试前置断言失败、未触发任何账号或白板断言：`ios-ipad-whiteboard-isolation-1790234305.xcresult` 与 `-1790234519.xcresult` 为原始 `Native keyboard must be available for real typing`（后者额外把该 iPad 的模拟器硬件键盘偏好设为 false，该偏好随后已还原），`-1790234791.xcresult` 仅点开输入助手栏 `Keyboard` 菜单，`-1790235067.xcresult` 已点选 `Show Keyboard` 但 15 秒内仍未出现软键盘。失败可访问树显示邮箱输入框为 `Keyboard Focused, Focused`，屏幕没有软键盘：iPadOS 在宿主机硬件键盘接入时只提供输入助手栏的 `Keyboard` 菜单。据此只修正测试对软键盘可见性的假设：先请求系统 `Show Keyboard` 条目，平台仍隐藏软键盘时才以输入框可点、`typeText` 后完整 value 与随后真实登录结果作为输入证据；iPhone 仍要求软键盘可见。账号空间、白板元素与摘要断言未改动。

第 5 次执行通过：`ios-ipad-whiteboard-isolation-1790235356.xcresult`，1 个测试、0 失败、0 跳过，139.714 秒，`xcrun xcresulttool get test-results summary` 为 `Passed`。检查结果（取自用例附件）：A 账号空间命名空间 `5c0f90a3-…` 绘制前 0 个元素、绘制后 1 个 `freedraw`，元素摘要 `4f53cda1…`→`ad034856…`；冷启动与重新登录 A 后元素集合、元素摘要、文件摘要一致；退出登录后范围 `local` 且不含该元素；B 命名空间 `06e9a1a7-…` 且元素为空；重新登录 A 恢复原元素与摘要。登录附件为 `software keyboard visible: true; idiom pad: true`。该用例只含笔迹、没有图片，`fileDigest` 全程为 `44136fa3…`（空 files 对象）。

同一 build 的第 6 次执行用于排除环境依赖：把此前仅用于诊断的模拟器硬件键盘偏好还原为默认后重跑，`ios-ipad-whiteboard-isolation-1790235587.xcresult` 仍 1 个测试、0 失败（141.126 秒），附件 `software keyboard visible: true; idiom pad: true`。流程不依赖模拟器偏好改动。

同一 build 的 iPhone 17 Pro（`FFFF2B61-63F7-4797-A7DF-53BE95CE3BF8`）回归覆盖新的键盘分支：`ios-iphone-whiteboard-isolation-1790235780.xcresult`，1 个测试、0 失败，129.314 秒，附件 `software keyboard visible: true; idiom pad: false`；A 命名空间 `11f0ed21-…` 绘制前 0 个元素、绘制后 1 个 `freedraw`（摘要 `4f53cda1…`→`a0cd9e5d…`），B 命名空间 `9b9f3aba-…` 且为空。

边界：这些结果只验收两台模拟器与合成 fixture 下的触摸笔迹与本机账号空间隔离，且只覆盖笔迹、无图片文件。真机、Apple Pencil 压感、相机、图片、非空访客白板、共享房间、跨账号图片隔离、强杀恢复与生产服务仍未验收；6.4c 不整体勾选。
