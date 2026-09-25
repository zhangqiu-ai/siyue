## ADDED Requirements

### Requirement: Independent database and controlled migrations

服务 MUST 使用独立 Siyue 数据库和最小 DML 运行角色；迁移 SHALL 校验库、角色与环境，取得 advisory lock，记录版本和 checksum。API 不自动迁移。

#### Scenario: Repeated migration and runtime DDL
- **WHEN** 相同迁移重跑或运行角色尝试修改 schema
- **THEN** 迁移不重复应用，运行角色 DDL 被拒绝；历史 checksum 不符时迁移失败

### Requirement: Fail closed readiness

服务 SHALL 区分存活和就绪，数据库故障、schema 不兼容或必需配置缺失 MUST 阻止就绪或启动，错误不泄露秘密。

#### Scenario: Database unavailable
- **WHEN** 数据库连接失败
- **THEN** 就绪失败且身份请求不能返回成功会话

### Requirement: Independently verified session

服务 MUST 验证独立 ES256 签名、issuer、audience、kid、token_use 和时间，并核查数据库主体、会话与 credential_version。既有 session 响应 SHALL 保持严格原对象。

#### Scenario: Invalid or revoked identity
- **WHEN** 使用其他产品凭据、错误算法、过期或已撤销会话
- **THEN** 拒绝访问，不接受客户端自报身份或家庭角色

### Requirement: Atomic refresh and bounded recovery

刷新 MUST 建立唯一后继并保留绝对期限；60 秒内同 rotationId SHALL 仅恢复同一加密响应，且会话有效、后继未消费。不同 rotationId 重放 MUST 提交对应设备链撤销。

#### Scenario: Response lost
- **WHEN** 刷新已提交但响应丢失后同请求及时重试
- **THEN** 恢复原响应，不创建新后继或延长恢复窗口

#### Scenario: Replay or recovery expiry
- **WHEN** 旧凭据用不同请求重放，或同请求超过恢复期限
- **THEN** 分别报告重放或恢复过期，不创建后继，不删除本地白板

### Requirement: Logout and action bound reauthentication

退出 SHALL 接受本设备 access 或 refresh 证明，不接受任意自报 sessionId。reauth MUST 绑定主体、会话、动作、凭据版本和五分钟期限，消费与受保护动作同事务。

#### Scenario: Reused or mismatched proof
- **WHEN** grant 已消费、过期、动作不符或会话已撤销
- **THEN** 拒绝受保护操作，不因前端确认而跳过校验

### Requirement: Private device session management

服务 MUST 仅列出当前已验证主体的有效设备会话，并以有界分页返回平台、用户设置的设备标签、登录时间、最近活动、过期时间与当前设备标记。响应 SHALL 不包含 access/refresh token 或完整 IP。当前设备可自行撤销；撤销其他设备 MUST 消费绑定 `revoke-session` 的新鲜授权；撤销全部设备 MUST 消费绑定 `revoke-all-sessions` 的新鲜授权。服务 MUST 记录最小安全审计且保持不同主体设备不受影响。

#### Scenario: List only the caller's bounded device sessions
- **WHEN** 已验证用户请求设备列表并使用游标继续读取
- **THEN** 仅返回该主体有效会话，页大小不超过 25，跨主体游标被拒绝，响应不含秘密凭据或完整 IP

#### Scenario: Revoke one of the caller's devices
- **WHEN** 用户撤销当前会话或使用 `revoke-session` 授权撤销本人另一设备
- **THEN** 目标会话及其 refresh/re-auth 凭据一并失效；其它主体会话保持有效，重复撤销不重复产生审计事件

#### Scenario: Revoke all sessions
- **WHEN** 用户以 `revoke-all-sessions` 授权撤销全部设备
- **THEN** 本主体所有会话及凭据同一事务失效，错误动作或已消费授权不能通过

### Requirement: Private usable login method summary

服务 MUST 为已验证主体提供只读登录方式摘要，仅包含当前可用的已验证邮箱＋密码组合，以及 active 且保有服务端 provider 凭据的 Apple 身份。每种方式 SHALL 有稳定但不含凭据的方式 ID；邮箱只返回脱敏展示值。响应 MUST 不包含完整邮箱、外部主体标识、provider namespace/client ID、Apple 凭据或家庭授权。停用方式、缺失 provider 凭据的身份和不可用主体不得作为可用方式返回。

#### Scenario: List only usable methods of the caller
- **WHEN** Apple-only、邮箱-only 或两种方式并存的主体请求登录方式列表
- **THEN** 只返回该主体当前可用的方式；跨主体、已撤权、无密码的资料邮箱及失效会话不能获得其他人的方式或秘密

### Requirement: Safe removal of an email login method

服务 MUST 仅允许当前主体使用匹配 `unlink-identity` 的一次性重新验证授权移除其已验证邮箱＋密码方式。移除后仍须保留至少一种有效登录方式；拒绝时不得消费授权或删除数据。成功移除、会话及未完成挑战失效、安全通知入队与最小审计 MUST 在同一事务完成。Apple 方式移除须另行实现 provider 撤销，不得由邮箱解绑接口代行。

#### Scenario: Remove email while Apple remains usable
- **WHEN** 当前主体持有有效授权并移除自己的邮箱登录方式，且 Apple 身份及其 provider 凭据仍可用
- **THEN** 邮箱与适用的密码凭据移除、旧会话失效、被移除邮箱收到待发送安全通知；重复或跨主体请求不产生第二次移除

#### Scenario: Refuse last method or roll back failed removal
- **WHEN** 邮箱是最后可用方式、授权不匹配，或事务写入失败
- **THEN** 原登录方式与最近一次完整状态保留；最后方式拒绝可审计，失败事务不消费授权或发通知

### Requirement: Recoverable account deletion

账号注销受理 MUST 要求当前有效成人会话、绑定 `delete-account` 的一次性再次验证、显式确认与服务端核对的家庭／儿童依赖处理；客户端自报主体或角色不得赋权。涉及多个家庭时 MUST 逐个家庭提交独立处置选择，服务端在同一受理事务内核对每个当前受影响家庭恰有一项选择。转交接收人 MUST 是该家庭当前有效成人成员，且已由本人明确接受管理及适用的监护责任；受理时 MUST 核对接受记录仍覆盖当前家庭与儿童范围。唯一管理者选择结束管理且仍有其他成员时，家庭 MUST 冻结待处理、受其授权的儿童设备 MUST 立即失效、共同作品 MUST 保留待核对；冻结期间旧家庭权限 MUST NOT 继续赋予设备或共享资源访问。缺项、重复、多余家庭或失效资格／接受记录 MUST 拒绝，不能自动为某个家庭选择转交或结束管理。成功受理 MUST 在一个事务中使本人登录及受影响儿童设备授权失效、建立持久删除作业，并只返回用于查询该作业最小进度的受限回执。受理状态不得冒充数据清理或 Apple 外部授权撤销已完成。删除防复活记录 MUST 独立于可回滚的主库备份；恢复旧备份时须先重放记录再开放登录。未具备可完成的依赖处理和恢复防复活机制时，注销提交入口 MUST 保持关闭。

#### Scenario: Accepted but cleanup is unfinished
- **WHEN** 有效成人以匹配授权和明确确认请求注销，且家庭／儿童依赖已按可完成规则处理
- **THEN** 返回 202 与受限回执；旧 access、refresh 和派生儿童设备会话立即失效，回执查询只报告该作业的清理与外部撤销实际进度

#### Scenario: Unsafe dependency or restored backup
- **WHEN** 依赖处置尚未满足、再次验证错误，或旧备份恢复后仍有已注销主体的旧身份／会话
- **THEN** 不把请求报告为已删除；拒绝未授权提交，恢复后的登录在防复活记录重放前不得开放

#### Scenario: Restored family authority contradicts deletion
- **WHEN** 恢复后的主库仍使已注销主体持有有效家庭成员、owner、监护关系或儿童设备授权，且这些关联不属于与作业、删除中主体及冻结家庭匹配的待处理记录，即使围栏与账本相等
- **THEN** 启动恢复拒绝开放登录和外部查询，等待对家庭状态的独立核对

#### Scenario: Recorded frozen family remains pending after restart
- **WHEN** 已受理注销对应的家庭保持冻结，且待处理记录与作业、删除中主体及该家庭匹配，儿童设备授权已撤销
- **THEN** 其他账号可使用服务，注销者会话与冻结家庭访问继续失效；删除作业和共同作品核对保持待处理，不报告服务端数据已删

#### Scenario: Closed history still links to the deleting adult
- **WHEN** 受理后的家庭邀请、监护记录、儿童设备授权、配对、已结束房间、家庭待处理记录或已解散家庭仍保留指向注销者的关联
- **THEN** 清理作业保持待处理、回执不得声称服务端数据已删；在明确的删除或有界脱敏规则实施前保留相关记录供核对，不连带清除其他成员的数据

#### Scenario: Deletion state drifts during a running process
- **WHEN** 服务运行中发现删除作业对应主体重新变为 active，或删除中主体仍持有有效家庭权限，而主库围栏与账本仍相等
- **THEN** 就绪状态与外部 API 均停止放行；状态修复并重新核对后恢复服务

#### Scenario: Different choices for multiple families
- **WHEN** 成人注销前对两个受影响家庭分别选择转交给对应家庭合格成人与结束本人管理
- **THEN** 受理时逐家庭核对当前依赖和接收资格；任一家庭缺项、重复、额外列入或接收资格失效时整体拒绝，不撤销会话、不创建删除作业

#### Scenario: Valid transfer and freeze in one request
- **WHEN** 接收人已作为有效成人成员明确接受当前责任范围，另一家庭仍有成员且唯一管理者选择结束管理
- **THEN** 一个事务内分别完成转交与冻结、撤销相应儿童设备授权、记录冻结家庭待处理事项并创建一项注销作业；任一步失败整体回滚

#### Scenario: A non-owner adult ends only their own access
- **WHEN** 非 owner 成人对仍活跃的家庭选择结束本人访问，且本人监护的每名儿童都有另一名当前有效监护人
- **THEN** 注销事务撤销本人的家庭成员、监护同意及关系、儿童设备与未结授权；家庭及其他成员的合法数据和权限保持有效，不创建冻结待处理记录
- **WHEN** 任一儿童将失去最后一名有效监护人，或其他监护人在并发处置中失效
- **THEN** 拒绝整次受理，不撤销本人会话或留下半次家庭退出

#### Scenario: Sole manager ends access while other members remain
- **WHEN** 唯一管理者在注销时对仍有其他成员的家庭选择结束管理
- **THEN** 受理事务冻结该家庭并撤销受其授权的儿童设备；其他成员及共同作品保留待核对，旧家庭权限不得继续使用，清理进度不得宣称这些待处理事项已完成

#### Scenario: Sole owner ends a truly empty family
- **WHEN** 唯一 owner 选择结束管理，家庭从未有其他成员且没有邀请、监护、设备、房间或其他共享资源记录
- **THEN** 注销事务删除该家庭、本人的成员记录及其创建幂等记录，不保留指向注销者的 owner 关联，也不创建冻结待处理记录
- **WHEN** 家庭有历史成员或任何共享关联，即使当前无人使用
- **THEN** 不将其当作空家庭自动删除；受理整体拒绝并保留原记录待核对

#### Scenario: Frozen family cannot regain a room seat
- **WHEN** 家庭已冻结，或旧备份留下该家庭的开放房间记录
- **THEN** 内部房间创建与席位认领均拒绝，不凭旧房间状态恢复共享访问

### Requirement: Recipient accepted family management transfer

转交接收人 MUST 以自己的有效成人会话查看该家庭当前责任范围，并分别明确接受管理和适用监护责任。服务端 MUST 只为该家庭当前有效成人成员记录有期限的接受，绑定原 owner、双方成员版本、家庭版本及当前儿童范围摘要；请求不得自报接收人、原 owner 或儿童身份。同状态重复提交 MUST 返回原接受记录；责任范围变化后原记录 MUST 失效并要求重新接受。注销转交受理 MUST 在同一事务内重新核对资格、范围和期限，消耗接受记录，转移 owner 及适用监护关系，撤销原管理者授权的儿童设备；失败 MUST 整体回滚。接收人接受记录本身 MUST NOT 触发转交或账号注销。

#### Scenario: Recipient confirms before deletion
- **WHEN** 当前家庭成人成员预览版本和儿童范围后明确接受两项责任
- **THEN** 服务端只记录该成员本人有期限的接受，同状态重复提交返回原记录，家庭 owner 与儿童监护关系仍保持原状

#### Scenario: Scope changes before transfer
- **WHEN** 家庭、双方成员或儿童范围在接受后改变，记录过期，或接收人失去资格
- **THEN** 注销转交拒绝且不消费接受记录；旧 owner、儿童授权和删除作业保持原状

### Requirement: Trusted family membership foundation

家庭 SHALL 由有效成人会话明确创建，而非注册账号时自动创建。创建与 owner 成员关系及幂等回执 MUST 在同一数据库事务提交；相同主体的同一请求键不得产生第二个家庭。家庭查询 MUST 只返回当前主体有效加入的家庭，并从数据库装配可信成员版本和权限快照；客户端提交的角色、主体类型或快照不得赋权。家庭成员身份本身不自动授权个人记录、房间、图片、另存或录像。

#### Scenario: Adult creates and reads a family
- **WHEN** 有效成人会话明确创建家庭，并以相同请求键重试
- **THEN** 仅创建一个 active 家庭及 owner 成员关系，查询返回当前主体的最小家庭摘要和版本

#### Scenario: Foreign or forged family access
- **WHEN** 其他主体查询该家庭，或请求自报 owner、成人身份、家庭策略快照
- **THEN** 不泄露该家庭的存在或记录，拒绝自报权限；被撤销的会话不能继续读取

### Requirement: Controlled one-time family invitation

仅有效家庭 owner/admin 可按当前成员与家庭版本发起最长 24 小时的一次性成员邀请。服务端 MUST 生成不可猜测令牌，只保存摘要及为同请求恢复所需的短期加密响应；令牌不得成为公开房间码。邀请有目标邮箱时，接受者 MUST 在自己的有效成人会话中已验证该登录邮箱。接受前 SHALL 重新检查邀请者的角色与版本、家庭状态、令牌期限和接受者身份；加入成员、消费邀请与最小审计 MUST 同事务提交。同一请求键重试不得重复创建邀请或成员。

#### Scenario: Targeted invite accepted once
- **WHEN** owner 使用当前版本发起目标邮箱邀请，该邮箱所属成人持令牌接受并重试同一请求
- **THEN** 该主体只成为一次 `member`，没有管理员、监护、记录或房间权限，重试不重复写入

#### Scenario: Changed authority or competing claimant
- **WHEN** 邀请过期、邀请者被撤权或版本变化、目标邮箱不匹配，或另一主体抢先消费令牌
- **THEN** 拒绝加入且不暴露目标家庭内容；过期令牌的可恢复密文按清理策略销毁

### Requirement: Explicit guardianship and restricted child-device pairing

受监护儿童主体 MUST 由当前有权成人明确创建，并在同一事务记录该成人的监护同意、儿童家庭成员关系及独立监护关系；家庭 owner/admin 角色本身不得自动成为其他儿童的监护权。配对申请 SHALL 由儿童设备匿名发起并严格限流，分别签发供家长识别的 requestToken 与仅留在发起设备的 pollSecret；服务端只保存各自的 keyed digest，状态查询不得返回成人或家庭资料。家长在批准前 SHALL 以有效成人会话、requestToken 和拟授权儿童读取服务器保存的设备描述；只有实际监护人可预览，预览不得返回 pollSecret、成人凭据或无关家庭资料，也不得消费再次验证授权。批准 MUST 要求当前监护关系版本、有效成人会话、动作绑定的 `approve-child-device` 再次验证及 requestToken。领取 MUST 使用 pollSecret 一次消费，在同一事务内建立最长 30 天的设备授权与 child 会话，不得复制家长凭据或默认授予房间、白板和记录权限。同请求恢复不得重新签发会话，原刷新凭据轮换、撤权、监护同意撤回、监护关系或家长凭据版本变化后不得恢复旧凭据。儿童会话的每次验证和刷新 MUST 检查当前设备授权、监护关系、同意及家庭状态；家长撤销授权后下一次请求立即失效。

#### Scenario: Guardian approves one child device
- **WHEN** 有权成人创建儿童并记录明确同意，儿童设备发起配对，实际监护人以当前关系版本和一次性再次验证批准，发起设备持 pollSecret 领取
- **THEN** 只产生一条有期限的设备授权及一条受限 child 会话；并发领取与短期同请求重试不产生第二条会话，状态与领取响应不含成人凭据

#### Scenario: Reject foreign guardian and stale approval
- **WHEN** 普通家庭管理员但非实际监护人尝试批准，或批准后监护关系、同意、家长凭据或家庭状态变化
- **THEN** 不产生可用的 child 授权；错误秘密、过期申请及旧授权版本不泄露家庭资料

#### Scenario: Revoke an active child device
- **WHEN** 实际监护人撤销儿童设备授权，或原刷新凭据已轮换却再次请求恢复配对领取结果
- **THEN** 旧 child access 与 refresh 在下一次请求被拒，旧配对响应不重新交付可失效的刷新凭据，其他设备授权不被连带修改

### Requirement: Verified email registration and password authentication

邮箱注册 MUST 先验证邮箱控制权，再原子创建主体、邮箱、密码及会话；登录 SHALL 使用邮箱与密码，未知邮箱和错误密码返回相同拒绝。密码 MUST 按 15–128 Unicode 码点校验，不 trim 或截断，使用有界 Argon2id。

#### Scenario: Unverified or already registered email
- **WHEN** 验证码错误、过期或邮箱已注册
- **THEN** 未验证请求不创建账号；公开 request 不枚举邮箱，验证控制权后冲突不覆盖原密码

### Requirement: Purpose bound challenges and durable mail outbox

验证码 MUST 绑定挑战、用途、请求秘密与服务端期限，存 HMAC；错误次数和邮箱/IP/全局预算 SHALL 原子累计。邮件只通过短期加密 Outbox 发送，受理、发送和送达 MUST 区分，副作用接口 MUST 执行幂等校验。

#### Scenario: Retry, cross purpose or exhausted attempts
- **WHEN** 同幂等请求重试、不同载荷复用 key、跨用途验证码或错误次数耗尽
- **THEN** 分别恢复同一次操作、拒绝冲突、拒绝跨用或拒绝继续尝试；新挑战不清除邮箱/IP错误累计

#### Scenario: Mail outcome uncertain
- **WHEN** SMTP 提交结果未知或发送进程在提交后退出
- **THEN** 不自动重复发送未知结果；显示可恢复状态，用户可按重发限制申请新挑战，过期／终结清除加密载荷

### Requirement: Password recovery revokes authority

找回密码 MUST 验证仅属于已启用登录邮箱的控制权，原子更新密码及 credential_version，撤销旧会话、refresh 和敏感授权；SHALL 不自动登录或删除本地业务数据。

#### Scenario: Concurrent reset and credential reuse
- **WHEN** 重置成功或同挑战被并发确认
- **THEN** 仅一个重置事务生效，旧 access、refresh 与 reauth 均失效；用户需用新密码登录

#### Scenario: Authenticated password change fails during storage
- **WHEN** 当前会话使用 change-password 再次验证授权修改密码，但后续存储失败
- **THEN** 授权消费、密码和版本变更、旧会话撤销均回滚；成功时整体提交并要求重新登录

#### Scenario: Retry a committed password change after the session is revoked
- **WHEN** 客户端未收到改密成功响应，并在幂等缓存期限内用原会话、相同 key 和相同请求体重试
- **THEN** 服务返回该操作的相同终态，不重复改密、增加凭据版本、撤销会话或发送安全通知；相同 key 配不同请求体返回冲突

#### Scenario: Authenticated password change client recovery
- **WHEN** 已登录用户再次验证当前密码并提交符合策略的新密码
- **THEN** 客户端将改密绑定到 change-password reauth grant；服务器确认后清除本机当前恢复凭据并要求重新登录
- **AND** 若响应结果未知，客户端在内存保留原 grant、访问令牌、请求体和幂等 key，界面锁定输入并允许同一进程内重试
- **AND** 重新打开账号面板时仍可恢复该重试入口；重启后不从持久存储恢复密码或 grant，用户通过新密码登录以核对结果

### Requirement: Durable client refresh and account generation

客户端 SHALL 仅在内存持有 access，安全恢复包 MUST 绑定环境、API 地址、主体和会话；刷新前先保存 pendingRotationId，后继保存确认后才能发布已登录状态。同代多个请求 MUST 合并刷新，账号代际变化 SHALL 中止旧请求并拒绝迟到结果。

#### Scenario: Refresh response lost or storage fails
- **WHEN** 刷新请求失去响应、进程重启或后继无法保存
- **THEN** 保留同 rotationId 的恢复证明，不另开轮换链，不把未保存凭据显示为已登录

#### Scenario: Account changes while request remains in flight
- **WHEN** 旧账号响应在退出或新账号登录后到达
- **THEN** 不更新当前身份和账号缓存，不把旧会话权限授予新界面

### Requirement: Platform vault and offline logout

移动 SHALL 使用解锁后仅本设备 SecureStore；桌面 MUST 在主进程以可用的系统加密存储恢复包，拒绝 basic_text 和明文回退。离线退出 SHALL 先持久化不再恢复登录的标记和受限撤销队列，再宣称本机退出；不得删除本地白板或自动改写本地空间归属。

#### Scenario: Vault unavailable or corrupted
- **WHEN** 安全存储无法读取、写入或格式不兼容
- **THEN** 返回明确不可用状态，保留原件，不当作空记录覆盖

#### Scenario: Restart after offline logout
- **WHEN** 未联网退出后应用重新启动
- **THEN** 保持本机退出，只以队列凭据撤销原设备，不能用它恢复登录

### Requirement: Restricted account host boundary

认证网络请求 MUST 由固定受信环境配置选择目标，禁止重定向泄露凭据或任意 URL 代理。Electron renderer 与白板 DOM SHALL 不取得 access／refresh，只能调用校验来源、参数和代际的白名单账号操作。

#### Scenario: Frame or untrusted origin calls authentication IPC
- **WHEN** 非正式主 frame 或错误来源请求账号操作
- **THEN** 拒绝执行和读取身份，不返回凭据

### Requirement: Email entry preserves user intent

移动与桌面 SHALL 从设置进入中英账号表单，复用当前主题，显示真实认证、恢复、不可用与退出状态。密码和验证码 MUST 只在表单内存中保留，账号变化或页面销毁后清除。找回成功 SHALL 明确要求新密码登录，不将重置成功等同已登录。未启用或尚无可用配置的登录方式不得显示为可用。

#### Scenario: Password reset response is unknown
- **WHEN** 重置提交后连接中断或响应不可用
- **THEN** 保留该次幂等键和参数供显式重试，暂时锁定该意图的输入，不生成另一份密码修改；关闭不宣称撤销服务端操作

#### Scenario: Registration policy is unavailable
- **WHEN** 缺少可阅读的正式用户协议或隐私政策及版本
- **THEN** 不伪造同意版本或开放正式注册；仍可实现和验证已有账号登录、找回与会话恢复
### Requirement: Explicit local account workspace selection
The host SHALL derive workspace ownership from its verified authentication state and persist an environment/subject/space mapping. Reading a missing mapping MUST NOT adopt guest content or rewrite its owner. Explicit creation SHALL allocate an independent namespace and preserve the same mapping across restart. A corrupt or future catalog MUST fail closed without replacement.

#### Scenario: A and B use the same device
- **WHEN** A creates an account workspace, then B signs in and explicitly creates another
- **THEN** A and B use different namespaces, guest content remains in its original namespace, and signing back into A restores only A's binding.

### Requirement: Retired workspace clients cannot cross account boundaries
The host MUST invalidate the previous workspace lifetime before activating a new selection. New commands on a retired client and late results MUST be rejected. Already committed writes remain in their original space and MUST NOT be replayed into the new space. A failed resource close MUST prevent opening a replacement until recovery succeeds.

#### Scenario: An old read completes after an account switch
- **WHEN** A's pending read returns after B becomes the current identity
- **THEN** the old result is cancelled and never returned as B's snapshot.

#### Scenario: A queued approval loses its workspace lifetime
- **WHEN** a workspace is retired before its queued approval applies
- **THEN** that client cannot continue applying the approval or issue another write, while any existing original-space receipt remains preserved.

#### Scenario: An adult session expires before local startup
- **WHEN** the saved adult session requires reauthentication
- **THEN** its private account workspace stays closed while the original unowned local workspace and login recovery remain accessible; successful reauthentication restores the existing account binding, and this fallback grants no child access.

#### Scenario: A mobile editor resumes with the same valid account
- **WHEN** a running mobile app returns to the foreground with an authenticated or offline-available account
- **THEN** it validates the existing session without changing the account generation or retiring the current workspace; token renewal and network recovery retain that workspace, while confirmed revocation still closes its lifetime. Anonymous resume only retries pending revocations and preserves the original local workspace.

#### Scenario: Workspace startup races credential restoration
- **WHEN** the workspace host starts while authentication is still bootstrapping or performing its first refresh for that generation
- **THEN** it remains loading without opening an unowned workspace; after restoration resolves it opens the selected account or anonymous local workspace, and does not require another manual retry.

### Requirement: Apple identity proof is verified independently of profile data
The server MUST verify Apple identity signatures with fixed-origin keys and an explicit RS256 allowlist. It MUST bind issuer, configured client audience, expiration, issued-at and the flow nonce digest. Email and client profile data MUST NOT establish or merge a subject. The provider MUST remain unavailable until transaction storage, code exchange and session issuance are wired and configured.

#### Scenario: A token supplies another key URL or app audience
- **WHEN** an identity token supplies jku/x5u/embedded jwk or a different audience
- **THEN** verification rejects it without fetching a token-selected URL or creating a subject.

#### Scenario: Apple keys cannot be retrieved
- **WHEN** key retrieval fails
- **THEN** the verifier reports provider unavailability rather than treating network failure as proof that an account is invalid.

### Requirement: Apple authorization code exchange is bounded and not retried
The server MUST use the fixed Apple token endpoint and a server-signed ES256 client secret. Native requests SHALL omit redirect_uri when none was used during authorization. The returned identity token MUST be verified again and match the already verified subject, configured client and flow nonce. External exchange MUST occur outside a long database transaction.

#### Scenario: A response stalls or is lost after sending an authorization code
- **WHEN** the exchange deadline expires or the response cannot be validated
- **THEN** the adapter rejects the result, aborts its transport and does not retry the code; the flow owner must require new authorization unless a verified result was already durably recorded.

#### Scenario: Exchange returns another identity
- **WHEN** the response identity differs from the flow's verified subject or nonce
- **THEN** no successful exchange result is returned for session issuance.

### Requirement: Apple login transactions fence concurrent exchange attempts
Login flows MUST durably store only digests of transactionSecret, state and nonce, with a five-minute lifetime. A short row-lock transaction MUST grant a single exchange lease; expired or abandoned leases MUST become terminal rather than authorize another exchange. Verified provider credentials MUST be encrypted with flow/client-bound associated data, and changed completion payloads MUST NOT recover an earlier result.

#### Scenario: Concurrent completes claim the same flow
- **WHEN** concurrent requests present the same valid flow proof and completion fingerprint
- **THEN** exactly one obtains exchange permission and the others receive in-progress; verified recovery requires the original subject and fingerprint.

#### Scenario: An exchange completes after its lease expired
- **WHEN** a late worker attempts to persist a verified response
- **THEN** the stale lease cannot update the flow, and the terminal failure remains committed even when the caller receives an error.

### Requirement: Verified Apple identities resolve to one independent subject
A trusted server-side verified Apple identity MUST resolve by provider, configured namespace and verified subject, never by display name or email. Concurrent first logins MUST create only one adult subject. Provider refresh credentials MUST be encrypted separately and committed in the caller's account/session transaction. Existing display names MUST survive later Apple profile input; unavailable subjects or identities MUST NOT be reactivated by login.

#### Scenario: Separate flows resolve the same new identity concurrently
- **WHEN** valid flows have the same Apple namespace and verified subject
- **THEN** they resolve to one subject, without orphan subjects or duplicate identities.

#### Scenario: Account completion rolls back
- **WHEN** a later step in the encompassing account/session transaction fails
- **THEN** new identity, subject and provider credential writes all roll back.

### Requirement: Apple login completion is atomic and recoverable without reissuance
The verified flow, resolved identity, provider credential and Siyue session MUST commit atomically. Completion MUST clear the flow's provider payload and retain only an encrypted session response for at most 60 seconds from completion. Recovery MUST require the original flow proof and completion fingerprint and MUST NOT return revoked, expired or consumed refresh credentials. A completed flow MUST never issue a replacement session.

#### Scenario: Session issuance fails after identity writes
- **WHEN** a later step in the login transaction fails
- **THEN** identity and session writes roll back together, and a retry uses the already persisted provider result without exchanging the code again.

#### Scenario: Concurrent completed-response retries
- **WHEN** multiple requests retry the same completed flow within its response window
- **THEN** they receive the same existing session tokens, without another signature or session row.

#### Scenario: Recovery after response expiry or refresh consumption
- **WHEN** the 60-second response window expires or its refresh token has been consumed or revoked
- **THEN** recovery is rejected and the flow cannot issue another session; a new authorized flow may locate the existing identity.

### Requirement: Client-address budgets trust only configured proxies
The runtime MUST ignore forwarded client addresses by default. Explicit bounded CIDR configuration MAY enable trusted proxies; wildcard or hop-count trust MUST NOT be accepted. Address traversal MUST stop at the first untrusted hop, and an invalid resulting IP MUST be rejected before admission budgets or business writes.

#### Scenario: An untrusted client spoofs forwarded addresses
- **WHEN** requests from an untrusted socket vary X-Forwarded-For
- **THEN** they consume the same socket-address budget and cannot reset it by changing the header.

#### Scenario: A trusted proxy supplies a chain with an untrusted intermediate hop
- **WHEN** attacker-controlled prefixes vary before that hop
- **THEN** the budget remains bound to the first untrusted hop rather than the injected prefixes.

### Requirement: Apple clients preserve authorization and retry semantics
Clients MUST use the strict native login contracts and retain the same completion input and idempotency key when retrying the same operation. A server request to restart Apple authorization MUST remain distinct from invalidating an existing Siyue session. In-progress responses MUST be represented as busy, and the transport MUST NOT automatically initiate another authorization or change the completion key.

#### Scenario: Server rejects an Apple authorization proof
- **WHEN** completion returns the stable Apple restart error
- **THEN** the client reports that new Apple authorization is required, without interpreting it as revocation of another Siyue session.

### Requirement: Client deletion submission recovery
客户端注销提交 MUST 绑定当前成人会话及本人影响预检；每个受影响家庭恰有一项处置。密码及 Apple 再次验证 SHALL 使用 `delete-account`，响应未知时仅允许显式重试原 bearer、grant、请求体与幂等键，不自动创建新请求。受理回执 MUST 先写入独立的平台受保护存储，再清除当前认证恢复记录；回执不得进入公开认证状态或桌面 renderer。账号代际变化 MUST 拒绝旧请求迟到结果。此接线不解除正式提交入口的服务端门槛。

#### Scenario: Lost response and protected storage recovery
- **WHEN** 提交响应丢失，或成功回执的受保护写入失败
- **THEN** 前者显式重试相同请求，后者重用内存中的成功回执而不重复提交；回执持久化成功前不报告本地注销完成

#### Scenario: Progress after local sign-out
- **WHEN** 已保存回执的客户端重启后查询进度
- **THEN** 使用绑定环境与端点的受保护回执查询，仅公开作业编号、到期时间及最小进度；另一笔未到期回执不得被新提交静默覆盖

#### Scenario: Apple deletion retry
- **WHEN** Apple 再次验证已签发动作 grant，而注销提交结果未知
- **THEN** 显式重试沿用原提交，不重复原生授权、不重新取得 grant；账号切换或取消后迟到结果不得发起注销

### Requirement: Account deletion flow state
注销页面流程 SHALL 展示本人影响并要求逐个受影响家庭明确选择；未选择不得进入最终确认。未知提交结果 MUST 锁定原选择，只可显式重试控制器持有的原请求。账号代际改变 MUST 清除旧表单及拒绝迟到结果；本次注销成功后的匿名状态 SHALL 进入回执进度。页面状态 MUST NOT 保存密码、bearer、reauth grant 或 receipt secret。

#### Scenario: A family is still unselected
- **WHEN** 多家庭影响清单中只有部分家庭已选择处置
- **THEN** 继续操作不进入最终确认，也不为未选家庭填默认值

#### Scenario: Unknown submission and incomplete progress
- **WHEN** 提交结果未知，之后用户显式重试并得到尚未完成的进度
- **THEN** 原家庭选择保持锁定，客户端不发起另一笔注销，不将任何未完成清理维度显示为全部完成

### Requirement: Recipient client binds acceptance to displayed responsibility
接收人客户端 MUST 先读取本人当前成人会话对应的家庭责任预览，接受请求的家庭、三个版本及儿童范围摘要 MUST 与预览完全一致。刷新预览与接受 SHALL 互斥；换号、退出或销毁控制器 MUST 清除预览。提交 SHALL 单次派发，未知结果不得自动重发；成功回执 MUST 匹配相同家庭、接收人、原管理者、版本及范围，且接受本身不得视为所有权已转移。

#### Scenario: Responsibility is being refreshed
- **WHEN** 新责任预览正在读取而旧预览曾经存在
- **THEN** 客户端拒绝并发接受或另一次预览；只有新预览成功后才允许明确接受

#### Scenario: Acceptance scope is forged or replaced
- **WHEN** 请求或回执与已展示责任范围不一致，或请求夹带主体、角色等字段
- **THEN** 客户端拒绝该请求或回执，不报告接受成功，也不改变家庭所有权

### Requirement: Reviewed frozen families and classified deletion history
冻结家庭 SHALL 由指定运营人员通过独立受控入口复核，普通成员 MUST NOT 自行解冻。恢复前 MUST 核实当前有效成人明确接受管理及适用监护责任、共同作品核对结果和版本；旧儿童授权 MUST 保持撤销。历史清理 SHALL 删除本人失效凭据与临时材料，保留其他成员原件，仅在安全可分离时移除本人历史身份关联；不可分离共同作品 MUST 留待核对且不得报告全部删除。

#### Scenario: Ordinary member tries to restore a frozen family
- **WHEN** 未经指定运营身份的调用试图完成复核或恢复家庭
- **THEN** 操作被拒绝，家庭与儿童设备状态不变

#### Scenario: Deletion history includes inseparable shared works
- **WHEN** 清理无法安全区分本人贡献与其他成员作品
- **THEN** 保留作品并保持待核对进度，不自动删除或重新分配归属

### Requirement: Formal deletion submission is recovery protected
正式 DELETE 入口 MUST 校验严格请求、唯一 bearer 和幂等键，使用独立防复活账本受理；环境未配置账本时不得启用。返回 202 仅表示已受理，进度 MUST 单独查询。

#### Scenario: A submitted deletion response is lost
- **WHEN** 客户端用原 bearer、请求与幂等键重试已受理注销
- **THEN** 服务端核对独立账本后返回原回执，不再受理另一笔注销

### Requirement: Family handover and frozen review are reachable in account UI
移动与桌面账号页面 SHALL 提供逐家庭处置、当前候选成人及本人接受状态、两项明确责任确认与冻结责任确认入口。只有管理和适用监护均已接受的当前有效成人可选为转交接收人。预览与接受 MUST 绑定会话代际及服务器当前范围；普通成员接受冻结责任不构成解冻授权。正式注销页面 SHALL 提供再次验证、明确提交、原请求重试及冷启动回执恢复，中英文状态一致。

#### Scenario: Recipient has not accepted responsibility
- **WHEN** 管理者查看转交候选人，而接收人尚未明确接受责任
- **THEN** 页面展示待接受状态并禁用选择；接收人须在本人账号勾选两项责任后才能提交接受

#### Scenario: Accepted deletion survives application restart
- **WHEN** 本机已保存受保护回执，应用结束后重新启动
- **THEN** 用户可在未登录状态查看同一作业进度，无需重新提交注销或输入密码

### Requirement: Public registration with published consent versions

The client SHALL offer email registration using the configured public API and SHALL display the current published terms and privacy policy before confirmation. The server MUST reject unavailable or mismatched policy versions rather than record placeholder consent. Passwords and challenge proofs MUST remain out of logs and durable UI drafts.

#### Scenario: Verified email creates a recoverable account
- **WHEN** an adult requests a code, receives the real email, explicitly agrees to the displayed policies and confirms a valid code with a password
- **THEN** the server creates one account and session, and the client securely restores that same account after restart.

#### Scenario: Policy unavailable or updated
- **WHEN** no published policy is configured or the confirmation cites an outdated version
- **THEN** registration refuses without creating an account or recording fictional consent, and the user can review the current documents before retrying.

#### Scenario: Shared mail provider with separate product data
- **WHEN** Siyue temporarily uses the maintainer-authorized QiuGe Helper Resend sender
- **THEN** Siyue keeps its own queue and encrypted payloads and uses product-specific mail text; provider acceptance is distinct from verified inbox receipt.
