## Purpose

定义个人与家庭空间的共享边界，使家人能在明确权限下协作，同时维持各自私人内容的独立性，并可验证邀请、成员变更、撤权与家庭生命周期的安全结果。

## ADDED Requirements

### Requirement: Private personal space
系统 MUST 区分个人空间与家庭空间；加入家庭不自动共享私人对话、目标、个人资料或模型密钥。共享采用同一内容授权访问，后续修改同步给获授权成员；成员角色与对象权限分别校验，按已确认的角色规则执行。

#### Scenario: Family member reads private content
- **WHEN** 家庭成员通过猜测 ID 或修改请求访问他人的私人内容
- **THEN** 服务端拒绝，列表、搜索、事件流和同步游标均不泄露其正文或元数据。

### Requirement: Invitation lifecycle
系统 SHALL 支持创建家庭、邀请、接受、撤销与过期；邀请绑定目标身份、家庭、授予角色和有效期，接受验证身份并幂等处理。

#### Scenario: Replay or revoked invitation
- **WHEN** 邀请被重复接受、撤销后接受、过期后接受或被其他身份使用
- **THEN** 合法重复返回同一结果，其余拒绝，不重复建立成员或扩大角色。

### Requirement: Controlled sharing
系统 MUST 提供可预览、明确确认和撤销的内容共享；共享 MUST 通过显式授权关系解析到同一原件，保留 ID 与归属，不复制记录或绕过普通跨空间业务引用限制；不得默认共享关联的全部对话或资料。

#### Scenario: Share selected content
- **WHEN** 用户选择个人记录共享到家庭
- **THEN** 展示接收空间、所选内容及可见/可编辑范围；确认后生成可追溯结果，未选择的关联资料和密钥不外泄。

#### Scenario: AI use is separate
- **WHEN** 成员可读取家庭共享内容但未获得将其发送外部 AI 的授权
- **THEN** 系统不将该内容自动加入模型上下文，外发入口说明接收方与范围并按授权规则处理。

### Requirement: Membership revocation
系统 MUST 在每次服务端读写和同步时验证当前成员资格；退出、移除和权限变更使未执行的旧授权失效。离线缓存不声称可即时远程销毁。

#### Scenario: Revocation races with queued edit
- **WHEN** 成员离线编辑后被移除，重连提交旧命令
- **THEN** 服务端按当前权限拒绝；客户端锁定共享内容，给出可恢复的本人未提交输入处理路径，不上传为成功或重新授予权限。

#### Scenario: Offline device has cached content
- **WHEN** 撤权时某设备仍离线
- **THEN** 服务端立即阻止后续访问；设备获知撤权或离线授权到期后锁定并清理受控缓存，不承诺收回已导出、截图或下载副本。

### Requirement: Family lifecycle
系统 SHALL 支持退出、移除成员、所有权转移及解散；儿童身份和监护权限必须单独定义，家庭管理员身份不得自动等同于监护权。

#### Scenario: Last owner leaves
- **WHEN** 唯一所有者退出或被移除
- **THEN** 必须先完成有效转移或明确解散，不允许无主家庭；并发转移和退出由服务端原子裁决。

### Requirement: Single shared record
系统 MUST 让有权成员协作于同一原件；写入以实际成员身份校验与记录，撤销共享只撤销访问，不删除原件。

#### Scenario: Member edits shared content
- **WHEN** 有编辑权限的成员修改共享记录并获服务端接受
- **THEN** 原件和其他有权设备获得同一 ID 的新版本，记录真实编辑者；无重复家庭副本，未授权成员不能读取变化。

#### Scenario: Revoke grant
- **WHEN** 有权者撤销某家庭的共享授权
- **THEN** 原件仍归原空间，家庭入口和同步投影失效，不能通过保存旧 ID 继续访问。

### Requirement: Family and object permissions
系统 MUST 区分家庭管理权与对象权限：仅家庭所有者可转移所有权或解散；所有者和管理员可邀请及移除普通成员，但不得移除或改权所有者。普通成员按对象授权查看或编辑；仅原件所有者可授予/撤销共享或删除原件，编辑权不包含再次共享权。儿童身份不得因家庭角色获得管理权限。

#### Scenario: Manager cannot manage another owners record
- **WHEN** 管理员或编辑成员请求再次共享、撤销共享或删除不属于自己的原件
- **THEN** 服务端拒绝，即使其有家庭管理权或对象编辑权；原件及既有合法共享保持不变。

#### Scenario: Protected owner and child restrictions
- **WHEN** 管理员尝试移除或修改所有者权限，或儿童会话请求邀请成人、转移所有权或变更监护关系
- **THEN** 拒绝请求，不扩大角色或监护权限。

### Requirement: Shared conversation continuity
系统 SHALL 在共享整个会话的确认页明确包含后续消息，并在共享中的会话持续显示共享状态；后续消息沿用当前有效共享范围，其他未选会话保持私有。

#### Scenario: New messages in shared conversation
- **WHEN** 原件所有者确认共享整个会话后新增消息
- **THEN** 当前有权成员可同步同一会话的新消息；持续共享提示可见，未选择的其他会话不被加入。

#### Scenario: Messages after revocation
- **WHEN** 原件所有者撤销共享后新增消息，旧成员使用旧会话 ID 请求读取或同步
- **THEN** 服务端拒绝旧授权访问，不向其发送后续消息；已离线下载的内容遵循既定撤权边界。
