## ADDED Requirements

### Requirement: VWB-01 Photo questions and direct handwriting
系统 SHALL 在首版同时提供拍照/选图后的题图讲解及空白页直接书写练习；后者不得作为仅观看模式或后续版本替代。

#### Scenario: Annotate a paper assignment
- **WHEN** 用户确认题图并放入白板
- **THEN** 获授权参与者可共同标注并继续书写，不依赖 OCR 或 AI 才能使用。

#### Scenario: Practice directly on a blank page
- **WHEN** 用户新建空白页
- **THEN** 手机触摸及平板适用手写输入均可完成练习，移动/缩放和书写行为可区分；实际手写笔与误触表现须真机记录。

### Requirement: VWB-02 Editable objects and stable coordinates
系统 MUST 分开保留题图、页面、对象和可编辑笔迹，使用稳定文档坐标，不能仅保留截图宣称可继续编辑。

#### Scenario: Different aspect ratios and reopening
- **WHEN** 不同设备缩放、旋转屏幕或重新打开已保存作品
- **THEN** 批注与题目位置一致，图片和笔迹可恢复，页面结构不丢失。

### Requirement: VWB-03 Permission-aware concurrent editing
系统 SHALL 允许五台获编辑授权的参与设备共同书写；主存档位置不赋予独占编辑权。撤销、擦除、翻页与跟随按 O04 批准的规则实施。

#### Scenario: Concurrent edits and destructive actions
- **WHEN** 多名成员同时画线或某成员请求清空/删除
- **THEN** 系统保留可对账的操作身份、顺序与权限检查；未获相应权限的破坏性操作被拒绝。

### Requirement: VWB-04 Late join and synchronization recovery
系统 SHALL 区分实时操作、资源传输和持久化确认；迟到/重复操作不得重复执行，重连恢复必须在现行权限下完成。

#### Scenario: A member joins after drawing starts
- **WHEN** 新成员获授权进入已有题图和笔迹的房间
- **THEN** 能恢复完整当前内容而非只看到新笔迹，未加载题图有明确状态与重试入口。

#### Scenario: Offline edit and stale authorization
- **WHEN** 设备恢复网络并提交临时操作
- **THEN** 重新检查授权和版本，未确认内容与冲突明确显示，不静默覆盖其他人的作品或把未上传内容标为已保存。

### Requirement: VWB-05 No implicit AI use
系统 MUST 将家庭协作传输、保存及 AI 外发区分；本切片不得因加入房间或打开白板就自动旁听、识别题图、生成画像或发送给外部模型。

#### Scenario: Board use with no AI authorization
- **WHEN** 成员拍题、共同书写或结束通话
- **THEN** 核心白板流程无需 AI 运行，原始题图及影音不因该操作自动进入 AI 服务或记忆。


### Requirement: VWB-06 Standalone local whiteboard trial
系统 SHALL 提供不依赖通话、账号服务或网络的“白板测试”入口，允许空白书写、内置题图批注、整笔擦除、颜色与粗细选择、撤销重做和多页切换，并将页面与独立笔迹显式保存到本机试用存储。此入口 MUST 明确为本地试用，不宣称多人同步、录像或相册导入已实现。

#### Scenario: Draw and reopen without a call
- **WHEN** 用户未进入通话而打开白板测试，书写、保存、退出并重开
- **THEN** 页面及可编辑笔迹保持一致；工具、状态与错误具有中文和英文，手机和平板均保留可操作画布。

#### Scenario: Undo or erase a stroke
- **WHEN** 用户使用整笔橡皮擦过笔迹，或撤销/重做本次操作
- **THEN** 对应整笔被移除或恢复，操作不会错误影响其他页面；尺寸变化使用统一文档坐标，不把图形拉伸错位。

#### Scenario: Local read or write fails
- **WHEN** 本机保存失败或已保存文档损坏/版本不支持
- **THEN** 不显示保存成功，不覆盖无法读取的原件；保留当前有效输入、提供重试，离开未保存编辑需明确确认。

### Requirement: VWB-07 成熟编辑器与本机图片页面
系统 SHALL 使用 Excalidraw 提供自由书写、擦除、选择移动、文字、基础图形、颜色粗细、撤销重做及平移缩放；画布占据宿主主要可用区。原生负责拍照/选图权限与文件，DOM 内处理连续输入。页面拥有独立场景和编辑历史；只暴露版本化、带请求身份、范围校验的桥接能力。

#### Scenario: 拍题与空白练习不依赖视频通话
- **WHEN** 用户打开本机白板并选择拍照、系统照片或空白页
- **THEN** 可以在可编辑画布中批注或书写，拒绝授权、取消和读取失败不清空已有作品

#### Scenario: 切页隔离
- **WHEN** 页面存在未保存修改、迟到请求或撤销历史，用户切换或删除页
- **THEN** 系统先处理待保存内容，迟到回调不能写入新页，撤销不能修改另一页

#### Scenario: 本地离线资源
- **WHEN** 用户在无外网且无 Metro 的本地构建中打开白板
- **THEN** 编辑器、样式、字体与图片可从本机加载，不访问公共白板网站或公共协作服务
