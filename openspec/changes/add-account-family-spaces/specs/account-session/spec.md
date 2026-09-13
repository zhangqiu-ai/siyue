## Purpose

定义思玥账号和个人空间的生命周期，使用户能在已授权设备上恢复自己的内容，同时保证账号切换、退出、恢复与删除不会泄露另一账号的数据或静默覆盖本机记录。

## ADDED Requirements

### Requirement: Verified identity
系统 MUST 支持注册、登录、账号恢复及会话失效恢复；云端从验证后的会话确定身份，不信任客户端声明的 actor 或成员权限。成人账号采用邮箱验证码；首次有效验证创建账号，再次验证恢复原账号，不要求儿童拥有独立邮箱。

#### Scenario: Forged identity
- **WHEN** 请求带伪造 actor、失效令牌或他人空间 ID
- **THEN** 服务端拒绝越权读取和执行，不在响应中泄露他人数据或账号是否存在。

#### Scenario: Recovery
- **WHEN** 用户完成所选身份方案的有效恢复验证
- **THEN** 恢复同一账号及其原空间关联，旧会话按恢复策略撤销，不创建重复身份或空间。

### Requirement: Account isolation and local adoption
系统 SHALL 按账号隔离数据库/缓存、上传队列、检索、AI 请求和待执行审批；首次连接云账号必须展示本机内容归属和上传范围，用户确认后才迁移。

#### Scenario: Late response after switching
- **WHEN** 从 A 退出并登录 B 后 A 的请求返回
- **THEN** 该响应不更新 B 的视图、数据库或队列，A 的内容不向 B 或其模型服务发送。

#### Scenario: Existing local content
- **WHEN** 未归属本机内容与既有云端个人空间同时存在
- **THEN** 展示冲突/导入预览，允许取消且保留原数据；重复确认不重复导入，不直接替换 spaceId。

### Requirement: Account deletion
系统 MUST 区分退出、断开同步和删除账号；删除要求重新验证与后果确认，覆盖会话撤销、个人数据、共享关系和备份删除重放，显示真实处理状态。

#### Scenario: Sole family owner
- **WHEN** 家庭唯一所有者请求删除账号
- **THEN** 先处理所有权转移或明确解散流程；不得留下无主家庭，也不能静默删除其他成员私人数据。

#### Scenario: Incomplete deletion
- **WHEN** 删除请求结果未知或清理尚未完成
- **THEN** 通过稳定请求 ID 查询进度，不宣称已彻底删除；保留必要最小删除标记阻止旧端恢复。

### Requirement: Email verification safety
系统 MUST 将验证码绑定邮箱、验证目的和挑战，有效期与尝试上限明确；仅存储安全校验材料，重发、过期、重放及暴力尝试不得产生越权会话。日志与错误不得包含验证码或访问令牌。

#### Scenario: Replayed or expired code
- **WHEN** 验证码已使用、过期、绑定其他邮箱或超出尝试限制
- **THEN** 不签发会话，显示可恢复的通用错误；重发不绕过服务端限流。

### Requirement: Managed child identity
系统 SHALL 支持监护人创建受管理儿童身份，并让儿童在自己设备取得独立受限会话；监护人与儿童是不同主体，家庭管理角色不自动建立监护权。

#### Scenario: Child enters own device
- **WHEN** 已绑定监护关系的监护人通过儿童设备显示一次性配对码、监护人核对儿童与设备并明确确认的流程授权儿童设备
- **THEN** 设备仅取得对应儿童身份的授权，不取得监护人令牌、私人空间或其他儿童内容；未完成授权不能进入。

#### Scenario: Revoked child device
- **WHEN** 有权监护人撤销指定儿童设备
- **THEN** 服务端拒绝该设备继续刷新或同步，其他合法设备不被误改身份；离线数据按统一撤权边界处理。

### Requirement: Guardian pairing authorization
系统 MUST 由创建受管理儿童身份者建立明确监护关系，允许其配对、恢复及撤销儿童设备，不自动赋予读取儿童全部私人内容的权限。配对码不得包含儿童个人信息或单独换取会话；服务端校验挑战、设备、监护关系、有效期、限流与撤销状态。新增/变更监护关系及儿童身份删除流程另行确认后实施。

#### Scenario: Pairing replay and expiry
- **WHEN** 配对码过期、撤销、被重复或并发提交，或未绑定监护关系的账号尝试确认
- **THEN** 过期、撤销和越权请求拒绝；合法重复仅返回同一绑定结果，不多发设备授权，不取得监护人会话。

#### Scenario: Pairing does not grant private content access
- **WHEN** 监护人完成儿童设备配对后请求读取儿童未共享私人内容
- **THEN** 系统仍按对象授权检查，不因配对或监护身份自动放行。
