## 1. 基础

- [x] 1.1 theme.ts 新增 errorSurface、warn、warnSurface、apple、onApple 明暗配对，更新对比度测试
- [x] 1.2 实现共享组件（Button、TextField、PasswordField、OtpField、PasswordRules、Banner、ListGroup/ListRow、ChoiceCard、Checkbox、StepHeader、BottomSheet、Toast、ResultView、ProgressRing）并补组件级测试
- [x] 1.3 重组 expo-router 路由与侧栏（app-navigation：侧栏结构、空间切换跟随全应用、账号与设置入口），iPad 常驻侧栏与窄窗口抽屉
- [ ] 1.4 中英文资源集中整理，删除旧界面遗留文案

## 2. 账号（account-experience）

- [x] 2.1 登录入口、邮箱登录、三步注册、两步找回
- [x] 2.2 账号首页、登录方式、修改密码、登录设备（按需身份验证）
- [x] 2.3 家庭责任、数据空间
- [x] 2.4 三步注销与注销进度
- [ ] 2.5 更新账号原生 UI 自动化与相关 Playwright 脚本

## 3. 对话（chat-experience）

- [x] 3.1 新对话首页、未连接 AI 连接卡、正文排版回复、停止与重新生成、复制
- [x] 3.2 发送失败保留原文与重新发送；错误文案分类
- [x] 3.3 契约与本机存储：按空间持久保存对话与消息，修改 AI 配置不清空
- [x] 3.4 对话内计划草稿卡（提出计划工具，只创建草稿）

## 4. 空间（space-home）

- [x] 4.1 空间首页（今天、目标卡、草稿提示、新建按钮、空状态）
- [ ] 4.2 同步状态呈现与冲突就地处理；只读成员
- [x] 4.3 目标详情（日期、进度、理由、打勾、行内添加、已完成折叠、完成与归档）
- [ ] 4.4 家庭成员页

## 5. 计划创建（plan-creation）

- [x] 5.1 写下目标、生成中与停止
- [x] 5.2 单页草稿、自动保存、确认前等待保存完成
- [x] 5.3 GoalDraft.targetDate 与 schemaVersion，确认时写入 Goal.targetDate
- [x] 5.4 结果页、过期与结果未确认状态

## 6. 白板（whiteboard-workspace）

- [x] 6.1 白板存档协议升级为多块白板，迁移旧 local-whiteboard
- [x] 6.2 白板库与三种起点
- [x] 6.3 全屏编辑外壳：浮动栏、仅自动保存、页面缩略图、插入菜单、保留撤销历史
- [ ] 6.4 发起通话与通话中界面，接 add-family-video-whiteboard 接口；接口未就绪时隐藏入口

## 7. 桌面端跟进

- [ ] 7.1 桌面端按同一信息结构整理导航与账号、对话、目标页面（范围在实施前单独确认）

## 8. 验证与记录

- [ ] 8.1 类型检查、单元测试与既有 Playwright 规格通过
- [ ] 8.2 iPhone 与 iPad 模拟器按 S/M/L 验收矩阵截图核对（中英、明暗、大字号）
- [ ] 8.3 更新证据、版本计划状态与规格同步

阶段证据：[2026-09-25 移动端界面与本机计划验证](../../../docs/evidence/redesign-app-ui-2026-09-25.md)。勾选表示对应实现已接入；8.1～8.3 和未勾选项仍需独立验收，变更保持活动状态。
