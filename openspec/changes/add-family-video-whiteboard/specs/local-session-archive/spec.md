## ADDED Requirements

### Requirement: VWA-01 Designated local editable archive
系统 SHALL 由发起活动的家长指定主存档设备自动保存题图、可编辑笔迹及页面；该行为独立于录像，其他参与者只有获另存权限时才能永久保存副本。

#### Scenario: Session ends without recording
- **WHEN** 本次通话未录制并正常结束
- **THEN** 已成功写入的白板仍能在主存档设备找到并编辑，显示本机保存结果，不宣称云端备份或所有成员均有副本。

#### Scenario: Save a separate copy
- **WHEN** 非主存档成员申请另存
- **THEN** 依 O03 确认的授权人和规则检查权限，只有获授权范围可导出或永久保留；参与/编辑权限不自动替代另存授权。

### Requirement: VWA-02 Honest archive failures and recoverability
系统 MUST 区分主存档确认、设备临时状态及未同步内容；写入失败不得显示保存成功，也不得静默改换永久存档设备。

#### Scenario: Primary archive device disconnects or runs out of space
- **WHEN** 主设备不可达或写入失败
- **THEN** 明确显示存档中断和未确认范围，保护最近完整原件；继续编辑、受控恢复与授权接管依 O03 定案，不以继续通话暗示新内容必然保存。

#### Scenario: Crash, damaged file or future schema
- **WHEN** 写入中断或打开损坏/不支持版本的作品
- **THEN** 不覆盖唯一原件，保留最近完整版本并提示恢复或版本不兼容；恢复结果经过附件与结构校验。

### Requirement: VWA-03 Manual local recording with persistent notice
系统 SHALL 默认关闭录像，仅由获相应授权的家长主动开启本地录制，并在有效录制期间持续向所有参与者显示录制者及状态；采集范围、同意与中途加入规则依 O02 冻结，未确认不得开始真实采集。

#### Scenario: Start or join a recorded session
- **WHEN** 家长请求录制或新参与者加入正在录制的房间
- **THEN** 按已批准的告知/同意流程处理，录制状态持续可见；不能以一次弹窗替代持续提示。

#### Scenario: Recording stops or fails
- **WHEN** 家长停止录制、空间不足、系统中断或文件写入失败
- **THEN** 更新录制状态与可恢复文件结果，不继续显示正在录制；通话与白板不因录像失败被无解释终止。

### Requirement: VWA-04 Explicit data lifetime and local control
系统 MUST 将本地归档、临时协作缓存、实时服务留存、录像、另存及未来云备份分开说明；用户可按权限查看、导出和删除本机作品/录像，不自动上传云库、相册或 AI。

#### Scenario: Reopen on a different device
- **WHEN** 用户在没有副本的设备上查找旧作品
- **THEN** 不伪装为已同步或已丢失，说明须由持有完整副本的获授权设备提供，或通过受控导入恢复。

#### Scenario: Delete local data or revoke permission
- **WHEN** 用户删除本机作品或撤销成员访问
- **THEN** 按经 O03 确认的生命周期清理关联附件和缓存、拒绝后续未授权访问；明确已导出离线副本和服务端留存边界，不承诺远程瞬时彻底删除。
