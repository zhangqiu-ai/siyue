## Purpose

定义账号内和家庭共享内容的持久化与跨设备同步，使用户可分辨本地保存与云端确认，在断网、冲突、重复投递、撤权和旧客户端恢复时保护内容及权限边界。

## ADDED Requirements

### Requirement: Durable content and scoped sync
系统 SHALL 持久保存范围内的对话、目标、项目、任务与同步状态；仅向已授权服务器同步该账号/空间的允许数据，令牌和 BYOK 不进入同步队列。

#### Scenario: Second device resumes
- **WHEN** A 保存且服务端确认后，同账号在 B 登录
- **THEN** B 取得同一允许记录、稳定 ID 和状态，可继续操作；流式中断回复标识未完成，不自动重发模型请求。

### Requirement: Authoritative commands
系统 MUST 区分本地已保存、等待同步、已同步、冲突与被拒绝；服务端在事务内校验身份、权限、版本、审批和 commandId，原子提交数据、事件及回执。

#### Scenario: Lost receipt and retry
- **WHEN** 写入后响应丢失，同一命令重投
- **THEN** 返回原回执且只产生一次副作用；同 ID 不同参数拒绝；云端下发不会重新进入上传队列。

#### Scenario: Approval changed
- **WHEN** 审批过期、被拒绝或撤销，或参数/对象版本改变
- **THEN** 不执行新正式写入，要求重新预览确认并保留可恢复输入。

### Requirement: Conflicts and deletion
系统 SHALL 用版本和明确冲突策略处理并发，不采用全表静默最后写入覆盖；删除标记、游标失效和全量重建不得复活旧记录。

#### Scenario: Concurrent text edits
- **WHEN** 两设备离线修改同一字段后重连
- **THEN** 显示双方内容和冲突解决入口，保留用户输入，不静默覆盖。

#### Scenario: Old device replays deletion
- **WHEN** 旧设备、过期游标或备份恢复重新投递已删除记录
- **THEN** 拒绝复活并安全重建允许数据，恢复仅经显式授权的新操作。

### Requirement: Safe migration
系统 MUST 对协议与存储使用独立 schemaVersion；首次账号绑定、升级和恢复先校验版本与归属，失败不覆盖唯一原始数据。

#### Scenario: Unsupported schema
- **WHEN** 客户端遇到未来版本、损坏数据或迁移失败
- **THEN** 停止不安全写入并显示恢复路径，保留原文件与待提交记录，不通过降级强行读取或清库解决。

### Requirement: Bounded offline collaboration
系统 SHALL 允许家庭成员在有效离线授权内查看和编辑已授权内容；授权 MUST 绑定身份、设备、资源范围、权限版本及期限；有效期为最后一次成功服务端核验后 24 小时，到期锁定，重连先验证权限再提交，离线操作不延长期限。

#### Scenario: Edit while offline then reconnect
- **WHEN** 成员在有效期限内离线编辑后重连
- **THEN** 若权限仍有效则按原件版本裁决并同步；若权限已撤销则拒绝，不丢失可恢复的本人输入且不恢复共享权限。

#### Scenario: Lease expiry or untrusted time
- **WHEN** 授权到期，或重启/时钟回拨导致无法可靠证明授权仍有效
- **THEN** 锁定共享正文与编辑并要求联网验证，不以修改设备时间续期，不静默清除待提交输入。

#### Scenario: Twenty four hour boundary
- **WHEN** 距最后一次成功服务端核验已满 24 小时，设备仍离线且存在待提交编辑
- **THEN** 锁定家庭共享正文及编辑，要求成功联网核验后续期；不因本地操作、重启或调时续期，保留受控的本人待提交输入。
