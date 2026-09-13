# 账号与同步候选资料核对 · 2026-09-08

状态：官方资料研究，非选型批准、PoC 或上线验收。上下文：0.0.1 邮箱 OTP、中国大陆与海外使用、受管理儿童身份已由维护者明确。本轮未安装依赖、注册服务、发送邮件、部署或读取个人数据。

## 已核实的产品能力

| 候选 | 官方事实 | 对本项目的意义 |
|---|---|---|
| Supabase Auth | 邮箱 OTP 可用；`signInWithOtp` 默认发 Magic Link，需模板包含 `{{ .Token }}` 才发送验证码；`verifyOtp` 校验后取得会话；默认允许自动注册，可通过 `shouldCreateUser` 控制 | 邮件请求成功不等于登录成功。注册/登录与儿童身份建立必须由产品规则明确，不能照抄默认行为。[官方 OTP 文档](https://supabase.com/docs/guides/auth/auth-email-passwordless) |
| Supabase 邮件 | 默认 SMTP 仅供受限测试，未配置自定义 SMTP 时限制收件人为项目团队地址 | 生产邮件链路需要单独选择 SMTP、验证发件身份和投递；不能用维护者收件成功代表普通成员可登录。[官方 SMTP 文档](https://supabase.com/docs/guides/auth/auth-smtp) |
| Supabase 托管地域 | 每项目一个主地域；官方列表包含新加坡、东京、首尔等，本次列表没有中国大陆地域 | 地域选择决定主要数据位置，不能证明大陆可达或符合数据要求。[官方地域列表](https://supabase.com/docs/guides/platform/regions) |
| Supabase 自托管 | 提供 Docker 自托管路径 | 存在部署控制选项，但需要另验升级、备份、恢复、邮件及安全运维；“可自托管”不等于当前项目已具备运维能力。[官方 Docker 文档](https://supabase.com/docs/guides/self-hosting/docker) |
| PowerSync Auth | 支持验证 Supabase JWT；客户端 connector 通过 `fetchCredentials()` 提供凭证，也支持自定义鉴权 | 同步认证可复用身份会话，家庭与儿童授权仍需思玥服务端实现。[官方 Supabase 集成](https://docs.powersync.com/configuration/auth/supabase-auth)、[自定义认证](https://docs.powersync.com/configuration/auth/custom) |
| PowerSync RN/Expo | 官方有 React Native/Expo SDK；原生数据库适配器不适用于 Expo Go，文档另有 JS 适配方案；`uploadData()` 由应用实现，将客户端写入送往业务后端 | 必须用当前 Expo/RN 原生构建验证。PowerSync 不替代命令处理器的审批、权限、版本及回执事务。[官方 SDK 文档](https://docs.powersync.com/client-sdks/reference/react-native-and-expo) |
| PowerSync 托管地域 | 官方列 US、EU、JP、AU、BR；JP 对应 `ap-northeast-1`。本次列表未列中国大陆或新加坡 | 不应假设 Supabase 新加坡与 PowerSync 同地域；东京可作为共同托管地域的测试候选，尚非部署决定。[实例文档](https://docs.powersync.com/configuration/powersync-service/cloud-instances)、[地域映射](https://docs.powersync.com/configuration/source-db/private-endpoints) |
| PowerSync 自托管 | 提供 Docker 服务及 Open Edition/Enterprise 自托管路径；自托管不提供同等 Cloud Dashboard | 运维界面、授权条款及所需功能需单独核查，不能将客户端 SDK 的开源许可推导为所有服务端版本同许可。[官方自托管文档](https://docs.powersync.com/intro/self-hosting) |

## 候选结构与推断

可进入 PoC 的候选：邮箱 OTP 身份服务 → 思玥业务 API/事务数据库；客户端经 PowerSync 接收授权投影，经业务 API 上传命令。身份、数据库、同步与邮件的地域和服务方分别登记。托管组合与自托管组合都保留；本报告不锁供应商，不自动引入双地域双写。

受管理儿童身份属于思玥领域设计：监护人登录身份、儿童记录主体和当前操作身份需可区分。不能让儿童复用监护人完整会话权限，也不能把家庭管理员自动当作监护人。上述厂商资料没有证明思玥所需监护授权已经实现。

## 必须补充的验证

- **网络与邮件**：中国大陆和目标海外网络分别测 DNS/TLS、OTP 投递与延迟、验证码校验、会话刷新、同步长连接和断线恢复。覆盖实际邮箱类型、垃圾箱、重发、限流、过期与错误验证码；本机网络成功不能代替双地域结果。
- **权限**：伪造空间/儿童主体、过期会话、监护变更、成员撤权、长连接已有订阅和迟到请求；下发规则及业务写入两侧都过滤。不得仅凭旧 JWT 中角色认定当前权限。
- **离线**：获知撤权前已离线设备无法保证即时远程清缓存；明确离线授权期限或联网访问策略，再验证锁定、受控清理与本人未提交输入恢复。不能承诺收回导出副本。
- **存储与同步**：当前 Expo/RN、iPhone/iPad/Android 和 Electron 的驱动兼容；旧 SQLite 迁移、单一队列、重复投递、丢回执、拒绝/冲突、删除标记和全量恢复。云下发不得再次上传。
- **运维与决策**：预算、地域、邮件服务、凭证轮换、备份恢复、删除期限、服务退出与数据导出；具体成本和许可尚未完成比较。中国大陆可达性、目标市场合规与儿童使用要求均未验证，不由本报告作保证。

下一步：按确认的地域及离线策略形成限界 PoC，再以实际结果更新 ADR-004。当前证据仅证明候选有相应公开接口和部署路径。
