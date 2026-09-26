# SA-06 Apple 登录实施证据

2026-09-22，feature/dev 工作区。仅本地实现，不提交、部署或启用 Apple 登录；原始三份设计文档不改。

## 当前实现

- contracts/auth-apple：严格 login/ios start、complete 与 start response；未知身份字段拒绝，JWT 16KiB、code 2048字符、姓名组件有界。主代理把 nonce/state 收紧为固定43位，匹配后续32字节随机数生成；不接受 link/reauth 伪实现。
- server/identities/apple/identity：使用已有 jose 6.2.12；固定 Apple 公钥来源与 RS256，拒绝令牌自带 jku/x5u/jwk；验证 issuer、精确单个 audience、subject、iat/exp、nonce 摘要。返回身份三元信息，不返回或信任邮箱。取钥失败与无效身份证明分开。
- 配置基线：取钥5秒、冷却30秒、缓存10分钟；时钟容差60秒、token age 10分钟。一次性事务5分钟的期限、state 校验与消费必须由后续持久流程执行，不能用本函数替代。
- 对外 provider 仍 disabled，start/complete 未注册。没有创建 Apple 账号、没有兑换真实授权码、没有安装移动 SDK。

## 实际验证

仓库根目录：

- `corepack pnpm --filter @siyue/contracts test`：27/27，包括新增5项；contracts build 通过。
- `corepack pnpm --filter @siyue/server build`：通过；全包 test 28/28，包括新增验签5项。小幅类型表达式调整后重新 build 与定向5/5。
- `corepack pnpm exec playwright test tests/e2e/auth-client.spec.mjs --workers=1`：14/14，使用本机 HTTP、临时 PostgreSQL，新增断言 Apple 不可用、未接线接口404且未创建主体，原邮箱/会话回归继续通过。
- 验签测试使用本地生成的 RSA/EC 密钥与合成 JWT，覆盖签名篡改、错误 issuer/audience/nonce、缺失字段、未来/过期/非整数时间、算法拒绝、令牌引导密钥地址及服务不可用。不是 Apple 真实登录验收。

## 来源核对

- [Apple 验证说明](https://developer.apple.com/documentation/signinwithapple/verifying-a-user)：要求 nonce、issuer、client audience 和有效期检查。网页工具仅返回 JS 页面，改读官方同路径 `.md`。
- [授权码交换](https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens)：原生初始授权没有 redirect_uri 时不虚构添加；实际交换仍待实现。
- [Apple 当前公钥](https://appleid.apple.com/auth/keys)：本日只读获取的三项均为 RSA/RS256/sig。验证说明的算法措辞存在不一致，按原设计及实际公开 JWK 固定 RS256，不混用思玥 ES256。

未读取私钥、根 env 或任何真实家庭数据。未连接账号授权/交换接口，仅读取官方公开文档和公开密钥。

## 后续未完成

持久流程与并发租约、授权码交换、身份唯一性、加密第三方 refresh、原子会话完成及60秒恢复缓存，移动 SDK 与真实配置、取消与失败、隐藏邮箱、首次/再次登录、真实签名/真机；后续绑定/撤销/通知另按 SA-07 接线。SA-06 整体未完成。

## 授权码交换适配器增量

新增 `apps/server/src/identities/apple/exchange.ts`，复用已有 jose 和身份验证器。固定 Apple token URL，ES256 client-secret 5分钟，原生请求不传 redirect_uri；再次验签返回 id_token 并对齐 subject/client/nonce，只向未来服务端持久层返回 Apple refresh，不返回其 access。当前尚未接路由、数据库或客户端，provider 仍 disabled。

默认10秒 deadline覆盖响应读取及验证，32KiB流式上限（不信 Content-Length），拒绝重定向、错误类型/缺失凭据、异常身份；任何失败不自动重发授权码。错误文本固定，不包含供应商正文或凭据。结果未知要求重新授权，后续 flow 服务必须持久表达该状态，不能仅靠本适配器内存去重。

实际验证：server build 通过；`corepack pnpm --filter @siyue/server test` 34/34（新增6项）；定向6/6。`corepack pnpm exec playwright test tests/e2e/apple-exchange.spec.mjs --workers=1` 1/1，通过真正本机HTTP流验证超时后连接关闭、调用次数为1。该测试把传输注入回环假供应商，使用合成私钥/凭据，未请求真实Apple授权接口。其余单测覆盖client-secret验签与请求形状、subject/nonce不符、400/401/429/500、无效/超大/重定向响应、忽略abort与悬挂body、配置/输入拒绝。

独立子任务审查了原设计的流程边界和应测清单；交换实现由主代理完成与验证，不将该审查称为成品独立审计。仍缺持久事务、一次性并发、授权码结果恢复、第三方refresh加密、公开路由及真实原生验收。

## 一次性流程仓储增量

新增0003只追加 apple_login_flows，不修改既有迁移。状态结构、hash长度、字段上限、租约不超过流程期限均有数据库约束；沿用owner/migrator/app权限。新增 flow-storage：start/inspect/claim/recordVerified/fail/cleanup，5分钟流程、30秒唯一租约；requestHash和预验签subject绑定重复请求，AEAD保护验证结果与Apple refresh。过期租约永不重新授权交换，错误返回前先提交终态；迟到lease不能写入。verified可恢复是上游结果恢复，不是登录会话恢复。

实际执行：server build通过；`node --test apps/server/tests/integration/*.test.mjs` 52/52，包括新增6项真实PG用例：秘密仅摘要、错误证明/不同client拒绝、10并发仅1认领、错误lease、加密持久恢复、请求变更冲突、租约/总期限过期、错误身份、显式失败、损坏密文不回写、约束及清理。旧数据库测试最初固定预期只有2条迁移而失败，更新为实际迁移清单长度，保留旧身份升级/邮箱唯一性断言；补充测试SQL一处引号错误已修正，最终全套通过。

并发测试覆盖数据库认领，尚未把认领与真实Apple交换、账号创建、会话签发串为公开流程。后续必须在外部调用前认领、在数据库事务外交换，并将verified结果与身份唯一约束/会话原子完成接线。完整provider仍disabled，未操作生产数据库，未读取root env。

本批另运行 `corepack pnpm exec playwright test tests/e2e/auth-client.spec.mjs tests/e2e/apple-exchange.spec.mjs --workers=1`：15/15，覆盖既有认证与provider关闭状态、真实本机HTTP超时断连。spec 6/6、release及diff检查通过。

## 登录准备服务串联增量

`prepare-login.ts` 将严格请求校验、流程证明检查、身份验签、唯一租约、授权码交换及加密持久结果读回串联。证明不正确时不请求供应商公钥；请求摘要绑定幂等键和完整已校验输入。只有持久结果读回后才向服务端下一阶段返回凭据；失败前已提交的 verified 状态不被降级，未提交或未知交换不再次兑换。此返回值仅限服务端内部，不能作为 HTTP 响应。

本批实际执行：`corepack pnpm --filter @siyue/server test:integration`（含 build）59/59；之后新增落盘失败用例，`node --test apps/server/tests/integration/apple-prepare.test.mjs` 8/8。覆盖错误证明、身份拒绝、八个并发重复请求、重建服务恢复、输入/幂等键变更、交换未知、失败写入丢失、提交成功但确认丢失、验签期间到期、供应商验签暂不可用、交换途中到期及存储失败。使用真实隔离 PostgreSQL、本地 RSA 签名和合成交换结果；未请求真实 Apple 授权。

`corepack pnpm exec playwright test tests/e2e/auth-client.spec.mjs tests/e2e/apple-exchange.spec.mjs --workers=1`：15/15。公共 Apple provider 仍关闭，账号/会话原子完成、60秒登录结果缓存、公开限流路由及原生 SDK 尚未接通；本批不是完成登录验收。

## 独立身份与第三方凭据存储

新增0004迁移和 `identity-storage.ts`：事务内以Apple/provider namespace/verified subject唯一定位，首次并发创建通过advisory lock及数据库唯一键收敛到一个adult主体。已有主体及身份状态需active，不按姓名或已有邮箱自动合并，不覆盖既有名称。Apple refresh以独立表和identity/namespace AAD加密；整个方法由调用者事务包裹，后续会话失败需一并回滚。目前尚未连接公开登录完成服务，不把该adapter视为账号与会话原子完成。

独立代理编写8项真实PG测试，主代理审阅并补充第9项：已存在凭据被替换后，后续会话步骤失败，原密文及身份更新时间仍完整保留；成功提交才替换。全套首次运行读到代理中间测试版本，两项断言失败（同名主体计数漏算既有邮箱主体、误认为PG会拒绝事务外advisory lock）；修正测试后全套68/68。之后新增第9项定向运行9/9。不得把方法注释当事务运行时强制；正式接线必须使用现有transaction helper，此处通过跨连接不可见及回滚验证调用者边界。

本批同时按方案14.5将prepare请求摘要改为32字节服务端pepper HMAC-SHA256，并验证落库值。prepare定向8/8；server build及全套集成通过；Playwright auth-client/apple-exchange 15/15；spec 6/6、release、diff检查通过。未使用真实Apple密钥、授权码或生产库。

审查提出的60秒恢复建议已区分用途：当前verified是五分钟登录事务内的待完成上游材料，并非已完成登录的凭据响应缓存。最终会话完成仍必须新增独立completed状态及最多60秒响应缓存，之后不可再签发第二组会话。此项仍未实现，provider继续关闭。

## 原子登录完成与60秒会话恢复

新增0005和内部 `login-service.ts`。recover→prepare→事务complete复用同一严格输入/HMAC计算；flow行锁保护同一流程最多一个会话。身份/Apple凭据、思玥session/refresh及完成缓存一起提交，成功后删除flow内的provider材料；响应仅包含思玥凭据。会话写入start中的设备标签与ios平台。响应恢复须原proof/请求摘要，且主体、会话和原refresh仍有效；轮换消费或撤销后拒绝旧凭据恢复，不影响新refresh链。缓存损坏保留原件且不重新签发。

方案中的5分钟授权与完成后60秒恢复分开：在第299秒完成，仍可在其后60秒恢复原会话；不会重兑代码、延长缓存或生成新会话。cleanup清空过期响应并保留completed标记，24小时后删流程；运行宿主定时调用仍待公开服务接线。

实际验证：server build通过；全套真实PG集成79/79。随后再补缓存加密失败回滚，`node --test apps/server/tests/integration/apple-login.test.mjs`最终11/11。覆盖单会话并发、两条合法flow同主体、签发后失败回滚、提交确认丢失、60秒边界、原流程到期后的有限恢复、撤销/改凭据版本/封禁/refresh消费、损坏缓存、完成途中期限失效及缓存加密失败。回滚后重试不重复兑换。

新增持久化Playwright `apple-login.spec.mjs` 使用真实回环HTTP和隔离PG，供应商验签/交换明确使用合成适配器；并发HTTP请求拿到同一思玥会话，原refresh消费后拒绝恢复，provider secret不出响应。与auth-client/apple-exchange合计16/16。它是内部服务测试宿主，不是生产Apple路由，也不是苹果真实授权验收。

独立代理做了恢复判据/锁顺序静态审查；主代理补齐refresh摘要、adult类型、锁后期限、grant期限和设备上下文。部分建议针对审查时尚未写入的service，由最终顺序及测试验证消除。公共provider、真实配置、路由限流/审计/错误映射、原生SDK仍未完成；SA-06继续未勾选。

## HTTP路由、配置和清理接线

新增Apple routes/request-gate，runtime按显式依赖注册start/complete；index按受保护Apple配置组装真实验签与交换适配器。默认关闭；显式启用但文件/字段/权限/密钥错误拒绝启动。配置使用 `SIYUE_APPLE_CONFIG_FILE` 的严格JSON，复用既有服务端secret-file约定；与原方案散列环境变量表达相比，字段集中在私有文件，仍保持独立p8。具体字段和命令入口见server README/.env.example，不写入真实凭据。

持久IP/global/flow预算HMAC化，单进程4在途；start 8KiB、complete 64KiB解析上限及各字段更小上限，拒绝多余身份、Authorization、查询串和无效幂等键。稳定错误映射区分并发、重启授权、恢复已过期和服务不可用。成功审计在原子登录事务内，失败回滚后重试仍不二次交换；其余尝试/失败分类不含输入秘密。Apple安全事件按原方案建议90天，生产隐私政策仍未确认。API启动和30秒定时清理flow、限流和安全事件，不依赖邮件worker。

实际执行：server全套集成83/83，包括新增实际index进程启动/配置拒绝和真实PG跨实例持久限流、并发准入/flow预算/清理；Apple登录定向增加审计故障回滚（12项）。Playwright改用真实runtime路由，供应商仍为合成适配器，与auth-client/apple-exchange共16/16。六并发首次撞到4在途保护，原测试全200假设失败；修正为验证AUTH_BUSY并重试后取得同一会话，未放宽产品并发保护。后续补JWKS不可用503、无兑换、恢复后成功，以及配置私钥绝对路径校验，再运行相应定向测试。

本批构建曾因启动闭包的apple变量缺显式类型失败，补AppleRoutes类型后全套通过。默认关闭回归仍通过；显式配置后的provider无platform查询返回能力+ios范围，Android/desktop明确关闭。此处“启用”仅表示配置可服务，不是Apple官方验收已通过。

未完成：可信反代CIDR接线、客户端Apple错误映射/SDK/UI、真实Apple配置与授权、通知/绑定/撤销、注册条款和完整平台验收；禁止把本批视为可直接生产部署。独立审查指出的旧快照启动未接线问题已由进程测试核实；其余缺口按后续工作继续推进。根私有env未读取或加载，无生产访问。

## 可信代理与IP限流增量

配置/启动/runtime接通SIYUE_TRUSTED_PROXY_CIDRS，默认不信任转发头。严格CIDR上限16项，拒绝裸IP/别名/跳数/全网/前导零/zone/越界，沿用本地锁定Fastify 5.12.3信任链。最终request.ip非有效IP时400，不写限流桶或业务数据。独立代理读取本地Fastify/proxy-addr/forwarded源码并用回环HTTP确认链路，不使用在线版本推断。

主代理实际验证：server build通过；server test35/35（新增配置拒绝用例）；runtime真实进程集成6/6。新增 `tests/e2e/trusted-proxy.spec.mjs`：默认忽略伪造XFF、未匹配代理忽略XFF、可信代理区分客户端IP、多级链遇到不可信节点后忽略左侧注入，各以真实HTTP和PG预算证明10次准入上限；可信代理传非法IP在业务前拒绝。与Apple路由及auth-client回归合计19/19。首次4场景通过后补非法最终IP，再次全范围通过。

未运行Nginx、未访问云端，没有证明实际公网来源/TLS/覆盖XFF已部署；README写明必须由真实代理覆盖XFF为remote_addr。此接线也影响Fastify转发host/protocol，认证issuer/audience仍固定服务端配置。当前feature/dev，无提交/推送。

## 客户端严格API与错误语义

共享AuthApiClient新增startApple/completeApple，固定路径、严格现有Apple合同、必需幂等键、无Authorization，响应分别校验start与思玥SessionTokens；不自动重兑或替换请求。AUTH_APPLE_RESTART_REQUIRED映射独立apple_restart_required，AUTH_IN_PROGRESS映射busy，缺幂等键映射invalid_request。两端账号消息资源增加中英文重新授权提示，尚未增加Apple按钮或原生SDK调用。

实际执行：contracts/adapters build通过；adapters test76/76（新增2项固定请求、payload拒绝、稳定键和错误分类/无自动重试）；mobile/desktop typecheck通过。Playwright实际runtime Apple路由测试使用新typed client完成start、complete、相同请求恢复及错误state重新授权映射，与auth-client回归15/15。验签/交换仍合成，HTTP和PG为真实隔离环境，不是Apple原生授权验收。

尝试委派controller接线只读审查，路由模型返回429重试耗尽，没有得到审查产物，因此不声称完成独立审查。主代理读取当前controller，下一步仍需原生授权取消、账号代际围栏、安全存储及不确定complete的恢复接线；本批仅API层，不将SA-06客户端标为完成。

## Apple授权尝试与账号代际生命周期

新增共享apple-sign-in协调器并接auth-controller的loginApple/retryApple/canRetryApple。当前仅允许匿名账号入口，不能以Apple授权静默替换已登录账号；原生授权回调只接收nonce/state/signal，响应需匹配state和期限。取消或迟到SDK结果不调用complete。complete已发送后使用API自身有界期限，不因本地切换立即丢弃可用于补偿撤销的返回凭据；controller对迟到成功沿用compensate，只撤销该次会话。

可恢复网络/超时/服务不可用/处理中响应保留同一输入和幂等键供显式retryApple，不重新start/弹原生授权；该材料只在内存，成功、非重试错误、换号/退出/销毁时清除，定时最多保留6分钟且受flow恢复期限约束。不写SecureStore/文件。仍须说明：进程强杀或API自身期限后持续不可达，无法保证收到并撤销服务器已发会话，本批不声称解决全部未知结果；短期服务器缓存只保证其窗口内可恢复。

实际验证：adapters build通过；最终adapters82/82（新增6项：取消/state不符、同请求重试、迟到SDK拒绝、迟到会话撤销、其他账号操作清除尝试、已登录账号拒绝替换）。Playwright用真实runtime/PG、共享controller/typed client、内存vault和合成SDK/供应商，故意在服务器完成后丢HTTP响应，重试恢复同一会话且SDK只调用一次；与auth-client回归15/15，补定时材料清理后定向1/1。两端typecheck通过（最后定时清理改动不变更其接口）。无Apple原生SDK或真机证据。

本批再次尝试独立controller审查，指定路由模型429耗尽，未得到结果；测试与代码由主代理完成，不声称子代理审查通过。实际Expo SDK、按钮/UI状态、取消体验和真机测试继续下一步。

## Expo 原生客户端增量（2026-09-23）

在既有 Expo 57 / React Native 0.86.3 工程中添加精确版本 `expo-apple-authentication@57.0.2`；未升级 Expo、React 或 RN。账号页只有在服务端 Apple provider 启用、声明支持 iOS 且系统 `isAvailableAsync()` 返回可用时才展示 Apple 原生按钮。登录仍走既有 Apple coordinator 和 typed HTTP 客户端；取消不提交请求，state 不匹配或凭据不完整要求重新授权，同一不确定请求沿用原完成请求与幂等键。只将 identity token、authorization code、state 和 schema 校验后的可选姓名送入服务端，不传递 SDK user/email/realUserStatus。

新增平台分流的 iOS adapter 与原生 Apple 按钮；Android/其他平台返回不可用，不显示按钮。`app.json` 使用官方 config plugin 和 `usesAppleSignIn`；本机手工维护工程中配置了 Sign in with Apple entitlement 和 mixed localization，并运行 `pod install`。该仓库将 `apps/mobile/ios/` 整体加入 `.gitignore`，因此这些本机原生生成文件及 Pod lock 不属于版本控制差异；可复现声明保存在受跟踪的 Expo app config 和 lockfile，现有本地 iOS 工程通过 Podfile autolinking 载入模块。未运行 prebuild，以免覆盖项目已有自定义 QA 原生 target。

## 本批实际验证

- `corepack pnpm --filter @siyue/mobile test`：141/141，通过；其中新增 `apple-native.test.mjs` 3/3，验证原 nonce/state、字段白名单、取消分类、错误 state、平台不可用和迟到取消。
- `corepack pnpm --filter @siyue/mobile typecheck`：通过。
- `corepack pnpm spec:check`：6 项 OpenSpec 全部通过；`corepack pnpm release:check` 通过；`git diff --check` 通过。
- `pod install`：106 dependencies / 105 pods 完成，含 ExpoAppleAuthentication 57.0.2。
- 对 iPhone 17 Pro iOS Simulator 执行 `xcodebuild ... build`：AppleAuthentication Pod 成功编译，但整应用最终链接失败，报 `facebook::react::Sealable`、`BaseViewProps`、`DebugStringConvertible` 等新架构符号未定义，引用来自 RNScreens、Gesture Handler、Reanimated；未产出可安装 app。该失败发生在整应用链接阶段，当前没有基线前的同命令对照，因此不能仅凭本次日志断言是既存回归或 Apple SDK 引入。详见本机 `/tmp/siyue-apple-xcodebuild.log`。

本批未启动模拟器 App、未取得原生按钮截图，也未执行真实 Apple 授权。provider 仍默认关闭；没有 Apple Developer Team/签名配置及真实用户凭据，且模拟器不等于 iPhone/iPad 真机。未运行桌面浏览器 Playwright，因为新增行为依赖 iOS 原生 AuthenticationServices 系统界面；API/controller故障恢复既有 Playwright 证据仍见前述章节。需后续修复/核清 iOS 原生链接基线，再做模拟器账户页及真机认证验收。

### 新架构链接诊断（2026-09-23）

进一步检查最终链接行及安装产物：`RNGestureHandler`、`RNScreens`、`RNReanimated` 对 React renderer 新架构核心符号有未解析引用；当前 0.86.3 `React.framework` 与 `ReactNativeDependencies.framework` 的导出表均找不到 `Sealable` / `DebugStringConvertible` 定义。故定位为当前预编译 RN Core 符号集合与已编译新架构 Pods 不闭合；还不能判定是该上游预编译制品问题、项目预编译配置问题或此前构建环境差异。未通过禁用 Fabric/New Architecture 掩盖。

依照现有 Podfile 提供的开关，尝试 `RCT_USE_PREBUILT_RNCORE=0 RCT_USE_RN_DEP=0 pod install` 作源码构建对照；CocoaPods 拉取 DoubleConversion 的 GitHub 源码时代理返回 HTTP 503，尚未进入编译。随后使用本机已有 RN 0.86.3 debug tarball 成功恢复标准预编译 Pods（106 dependencies / 105 pods）；未改 tracked native project。后续应在源依赖网络可用时复跑源码构建，再对比相同 scheme 的完整链接。当前不据此修改 RN 版本或工程架构。

### 源码构建与模拟器启动复验（2026-09-23）

Expo SDK 57 官方 `expo-build-properties` 提供 `ios.buildReactNativeFromSource`。固定新增 `expo-build-properties@57.0.21` 并在受跟踪的 `apps/mobile/app.json` 启用该属性；不关闭新架构，也不升级 Expo/RN。配置解析确认选项生效。由于 `apps/mobile/ios/` 是忽略的手工维护工程、带项目自定义 QA targets，本次不运行 Prebuild；仅在本机忽略文件 `ios/Podfile.properties.json` 设置相同选项，再运行 `pod install`，源码安装 111 dependencies / 113 pods 成功。

相同 `Siyue` scheme、iOS Simulator 通用目标的完整 Xcode Debug 构建成功，源码编译并链接 RN Core 与 app；之前 `Sealable`、`BaseViewProps`、`DebugStringConvertible` 未解析问题消失。将 app 安装至 iPhone 17 Pro iOS 26.5 模拟器后，首屏曾显示缺少 Metro 的 Debug 提示；启动项目本地 Metro 并重载后，Siyue 首页正常显示。截图：`backend-auth-apple-2026-09-23-iphone17pro.png`。这验证源码构建和开发服务器下启动，不等同脱离 Metro 的 Release/离线构建，也未操作 Apple 登录页或真实 Apple 授权。

复验：移动端 141/141 单测、TypeScript、Expo public config 解析、OpenSpec 6/6、release:check、git diff --check 均通过。仍未配置 Apple Developer Team/签名及真实 Apple 服务端凭据；provider 默认关闭，原生按钮不会对用户开放，真机/iPad/Apple 授权仍待验收。官方构建属性说明：[Expo Build Properties](https://docs.expo.dev/versions/latest/sdk/build-properties/)。
