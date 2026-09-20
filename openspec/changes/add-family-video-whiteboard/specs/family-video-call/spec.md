## ADDED Requirements

### Requirement: VWC-01 Five-device room capacity
系统 SHALL 将单房间并发参与上限设为五台设备，包含发起设备；同账号的不同设备分别计数，重连不得重复占位。

#### Scenario: Five devices and a sixth join
- **WHEN** 已有五台设备加入且第六台申请加入
- **THEN** 系统明确提示房间已满，不移除已加入设备。

#### Scenario: Concurrent joins and reconnect
- **WHEN** 多设备同时竞争最后名额或原设备断线重连
- **THEN** 服务端分配结果不超过五台，重连绑定原授权会话且不重复占位；过期名额按经验证的规则释放。

### Requirement: VWC-02 Authorized participants and separate permissions
系统 MUST 校验加入房间的身份与本次授权，将加入、编辑、录制和永久另存分开；家庭成员身份不自动授权全部操作。仅家长 SHALL 能发起房间并邀请已有家庭成员，儿童可接受邀请；系统 MUST NOT 提供公开房间码。逐人管理细则与另存授权仍依 design O01/O03。

#### Scenario: Unauthorized join or stale permission
- **WHEN** 未获邀设备加入或撤权后的旧请求到达
- **THEN** 系统拒绝访问或写入，不暴露题图、白板或房间媒体。

#### Scenario: Parent invites a child in the family
- **WHEN** 家长发起房间并邀请已有家庭成员中的儿童
- **THEN** 儿童可接受邀请加入；儿童主动发起和未获邀的加入均被拒绝。

### Requirement: VWC-03 Video and shared board coexist
系统 SHALL 在拍题讲解和直接白板练习中保持可达的音视频交互及参与者状态，不能要求结束通话才能使用白板。

#### Scenario: Capture a question during a call
- **WHEN** 参与者在通话内拍题、取消或完成拍摄
- **THEN** 相机争用、音频和视频状态如实显示，操作结束可返回白板通话，不创建无题目的空记录；按真机能力明确短暂停顿，不伪装持续视频。

### Requirement: VWC-04 Independent interruption and recovery states
系统 SHALL 区分媒体中断、白板失联、主存档中断及录像失败；单项失败不得伪装整场成功，也不得无解释地结束其他仍可用的能力。

#### Scenario: Participant connection interrupted
- **WHEN** 某设备失联或应用进入后台
- **THEN** 其状态对其他参与者可见，恢复时重新校验身份与房间状态，不承诺未经验证的后台摄像或录制。

#### Scenario: Initiator leaves without ending the room
- **WHEN** 发起者选择离开且尚有其他参与者
- **THEN** 系统 SHALL 保持房间继续，区分个人离开与家长明确结束全场的动作，不将离开自动解释为结束。

#### Scenario: Parent explicitly ends the room
- **WHEN** 获有效房间授权的家长明确结束全场
- **THEN** 系统 SHALL 结束该房间并拒绝旧邀请和旧连接重新加入；儿童不能结束全场。

### Requirement: VWC-05 Bilingual and cross-device delivery
系统 SHALL 为房间与录制状态提供中文/英文、无障碍名称，并分别验收 iPhone/iPad 与 Android 的核心路径；Electron 按 O05 冻结的矩阵提供证据，不据未运行结果宣称支持。

#### Scenario: Phone and tablet layout changes
- **WHEN** 手机/平板切换语言、横竖屏、窄窗口或适用大字号
- **THEN** 加入/离开、麦克风、白板及录制状态仍可操作与辨认，不能以单一手机截图代替全部验收。
