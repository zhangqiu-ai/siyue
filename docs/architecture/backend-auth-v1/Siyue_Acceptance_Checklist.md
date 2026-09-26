# Siyue 后端与认证验收清单

**版本：1.0 ｜ 日期：2026-09-21**  
配套主规格：`Siyue_Backend_Auth_Design_v1.0.md`

所有用例初始为未执行。勾选必须附环境／代码 SHA／日期／实际结果；模拟、真服务、真机、生产结果分开记录。本文不是测试通过报告。

## 1. 基线与产品隔离（SA-01/02/10）

- [ ] ISO-01：确认当前 Siyue 工作分支保留最新视频白板改动，未从旧 main 覆盖重建。
- [ ] ISO-02：`/api/cloud/*` 仍由旧服务处理；`/api/siyue/v1/*` 只进入思玥，路径前缀不重复。
- [ ] ISO-03：未知思玥路径返回 404，不回退旧 qiuge 服务。
- [ ] ISO-04：qiuge access/refresh 不能用于思玥；思玥凭据不能用于 qiuge；同邮箱不改变此结果。
- [ ] ISO-05：staging 与 production 的 issuer／签名密钥／数据库分离，互相拒绝 Token。
- [ ] ISO-06：新服务停止／出错时，旧 health/ready 与获授权 smoke 仍正常。
- [ ] ISO-07：旧微信回调精确 location、access_log off、TLS 与其他 location 未改变。
- [ ] ISO-08：Nginx trailing-slash 代理行为经真实代理测试；bodyLimit 与错误码正确。

## 2. 数据库与迁移（SA-02）

- [ ] DB-01：siyue_app 不是 superuser、不能建库／建角色／改 schema，不获得迁移凭据。
- [ ] DB-02：不同库的 CONNECT／schema／表权限经实际角色查询验证，不仅是数据库名不同。
- [ ] DB-03：检查旧 qiuge 角色是否有高权限；记录共享 PG 的真实隔离限制，不未经授权修改旧角色。
- [ ] DB-04：空库一次迁移成功；第二次执行不重复修改；checksum 不符明确失败。
- [ ] DB-05：并发迁移只有一个执行者，API 不以管理员身份自动迁移。
- [ ] DB-06：同邮箱、同外部身份并发创建只出现一个主体，不产生孤儿 session 或外部身份。
- [ ] DB-07：PG 连接池／超时／哈希并发有界，不耗尽共享实例。
- [ ] DB-08：数据库断开时 ready 失败；身份接口 fail closed，不能伪造空权限成功。
- [ ] DB-09：备份加密且有异机副本；隔离恢复实际通过，不只确认备份文件存在。
- [ ] DB-10：恢复旧备份后先重放删除账本，已注销账号不会重新可登录。

## 3. 邮箱、密码与验证码（SA-04）

- [ ] MAIL-01：未验证邮箱不能创建可用账号；验证码成功后在同一事务创建邮箱／主体／密码／会话。
- [ ] MAIL-02：公开 request／login 不通过明确状态码或正文枚举邮箱是否注册。
- [ ] MAIL-03：错误、过期、已消费、superseded 和跨用途验证码全部拒绝。
- [ ] MAIL-04：requestSecret 不匹配拒绝；OTP 数据库存 MAC，日志无验证码和请求秘密。
- [ ] MAIL-05：同验证码并发确认只一次成功；失败次数原子累计；新挑战不能重置全局累计限流。
- [ ] MAIL-06：60 秒重发间隔、邮箱／IP／全局预算与 Retry-After 正常。
- [ ] MAIL-07：Outbox 接收、实际发送、真实邮箱到达的状态分开；发送失败不宣称成功送达。
- [ ] MAIL-08：重发／重复幂等 key 不重复扣费或发送多封；同 key 不同载荷返回 409。
- [ ] MAIL-09：加密验证码 Outbox 载荷在完成／过期后销毁，worker 重启不会无限重复发送。
- [ ] PASS-01：15/128 码点边界、Unicode／空格、禁止静默截断／trim，经前后端一致测试。
- [ ] PASS-02：拒绝常见弱密码；Argon2id 参数在目标机器有实测，不使用普通 SHA 保存密码。
- [ ] PASS-03：未知邮箱 dummy hash 与限流受控；昂贵哈希并发不会拖垮同机旧产品。
- [ ] PASS-04：密码重置不自动登录；credential_version 增加且旧 access／refresh／reauth 失效。
- [ ] PASS-05：Apple 资料邮箱未主动绑定成登录邮箱时，不能被密码重置接管。
- [ ] PASS-06：密码修改、邮箱更换按主规格撤销旧会话并通知；断网不删本地文件。

## 4. 会话与刷新（SA-03/05）

- [ ] SES-01：拒绝错误签名、issuer、audience、算法、token_use、过期与不合理时间。
- [ ] SES-02：注销／账号冻结／credential_version 变化后，尚未到期 access 也不能访问。
- [ ] SES-03：`GET /account/session` 保持严格原对象；无 query/body 凭据、重复 Authorization 或多余字段。
- [ ] SES-04：十个业务请求同时过期，只产生一个客户端 refresh，所有合法等待者恢复。
- [ ] SES-05：旧 refresh 只能产生一个后继；会话 180 天绝对期限不随刷新延长。
- [ ] SES-06：服务器已提交但响应丢失，60 秒内相同 rotationId 恢复完全相同后继。
- [ ] SES-07：恢复缓存加密、有界、到期删除；不能在日志或数据库普通列看到 token 明文。
- [ ] SES-08：同旧 token 不同 rotationId 重放，撤销对应设备 session 链。
- [ ] SES-09：同请求超过恢复窗口要求重新登录，不重新创建后继、不删除本地白板。
- [ ] SES-10：安全存储写入失败不能发布“已登录”状态；无明文 fallback。
- [ ] SES-11：access 过期仍可通过 refresh 证明仅撤销本设备；不能自报 sessionId 撤销别人。
- [ ] SES-12：离线退出只宣称本机退出；隔离撤销队列联网后撤销，不能用于自动恢复登录。

## 5. Apple（SA-06/07）

- [ ] APPLE-01：真实 bundle／Team／Key／client ID 一致，原生 capability 与签名构建成功。
- [ ] APPLE-02：新增 Apple plugin 不移除现有 SecureStore／SQLite／图像／白板插件。
- [ ] APPLE-03：真实 iPhone 和 iPad 首次登录、再次登录通过；不以 Expo Go 结果替代。
- [ ] APPLE-04：隐藏邮箱可以正常进入；再次姓名／邮箱缺失不报错、不覆盖已编辑资料。
- [ ] APPLE-05：不强迫 Apple 用户额外提供真实邮箱／密码才能使用；可选邮箱绑定可跳过。
- [ ] APPLE-06：错误 nonce/state、伪造签名、错误 aud/iss、过期 Token、错 transactionSecret 被拒绝。
- [ ] APPLE-07：SDK nonce 变换经固定版本和真机确认；没有重复哈希／模糊兼容放宽。
- [ ] APPLE-08：服务端真实 code exchange；返回 identity 与交易一致；不信任客户端 user/email。
- [ ] APPLE-09：授权码或 flow 重放不创建第二组账号／会话；并发首次登录只有一个 subject。
- [ ] APPLE-10：Apple 已消费 code 但网络响应丢失，有明确重新授权路径，不伪造身份。
- [ ] APPLE-11：JWKS 缓存／kid 轮换可恢复，有界重取；拒绝任意 jku/x5u 下载。
- [ ] APPLE-12：用户取消不创建账号；服务暂时失败不会被处理为永久身份撤销。
- [ ] APPLE-13：Apple .p8／client-secret／外部 refresh 不进客户端／日志／仓库；外部凭据有加密与轮换。
- [ ] APPLE-14：Apple 中继邮箱真实送达测试通过；发送来源配置错误有可恢复处理。
- [ ] APPLE-15：通知验签／去重／错应用拒绝；邮箱转发关闭与授权撤销不混同。
- [ ] APPLE-16：注销／主动解绑 Apple 的外部 revoke 有真实或受控失败恢复证据，普通 logout 不解绑。

## 6. 绑定、设备与注销（SA-07）

- [ ] ACC-01：Apple-only 主体能主动绑定邮箱并在 Android／Electron 登录同一 subject。
- [ ] ACC-02：邮箱与 Apple 身份属于另一个账号时明确冲突，不根据 email 相同自动合并。
- [ ] ACC-03：reauthGrant 绑定主体／session／action／credential_version，一次消费且 5 分钟过期。
- [ ] ACC-04：Apple-only 可通过已有 Apple 重新验证，不要求不存在的旧密码。
- [ ] ACC-05：发起绑定后 logout／重置密码，旧挑战或 Apple flow 不能继续绑定。
- [ ] ACC-06：并发解绑两种方法不能清空全部可用登录方式；已撤销身份不算可用。
- [ ] ACC-07：本人可见本人设备；不能查看／撤销其他主体设备；注销全部需要 fresh reauth。
- [ ] DEL-01：应用内注销入口可找到；确认影响＋重新验证后提交，不要求额外客服操作作为默认前置。
- [ ] DEL-02：受理即 deletion_pending 并撤销本人及受影响派生授权，无法静默重登恢复。
- [ ] DEL-03：云端个人资料、自己上传内容、凭据和衍生缓存按实际范围删除；不能以“已共享”一概保留本人内容。
- [ ] DEL-04：其他家庭成员自身数据不被误删；唯一 owner／监护人有明确可完成的依赖处理。
- [ ] DEL-05：Apple 撤销故障按期限重试并显示真实状态，不无限保留秘密、不假称全部完成。
- [ ] DEL-06：受限删除回执仅查进度，无普通账号访问权；不放 URL；过期不可用。
- [ ] DEL-07：本机数据、服务器数据、其他离线合法副本的清理边界在 UI 中区分。

## 7. 原生、桌面与账号隔离（SA-05）

- [ ] CLI-01：启动顺序先本地空间与会话恢复，后鉴权业务连接；不产生错误账号网络订阅。
- [ ] CLI-02：断网／5xx 不清安全 refresh；401 明确撤销才进入重新登录；403 不循环刷新。
- [ ] CLI-03：切换账号后旧请求／定时任务／连接立即失效；迟到响应不能写新账号缓存。
- [ ] CLI-04：缓存与文件索引按 environment/subject/space 隔离；本地 guest 空间不自动归属或上传。
- [ ] CLI-05：iOS SecureStore／Android 重装与备份／生物识别变更路径有设备证据。
- [ ] CLI-06：Electron safeStorage 不可用／basic_text 拒绝持久化；Renderer／DOM 无 refresh。
- [ ] CLI-07：IPC 校验 sender/frame／参数，不允许任意 URL 带生产凭据请求。
- [ ] CLI-08：当前 Excalidraw 编辑、多页、图片保存重开无回归；登录失败不删除原件。
- [ ] CLI-09：中英、iPhone/iPad、Android、已声明 Electron 矩阵覆盖；Apple 不支持端只展示可用邮箱入口。

## 8. 家庭、儿童与真实房间（SA-08/09）

- [ ] FAM-01：服务端 subjectKind 不被客户端覆盖；owner/admin/member 与 guardian 分开。
- [ ] FAM-02：familyPolicySnapshot 来自可信仓储，不能提交伪造 snapshot 获权。
- [ ] FAM-03：受控邀请一次消费，限期生效，有目标邮箱时核验；无公开房间码绕过。
- [ ] FAM-04：非监护人不能批准儿童设备；二维码不含 pollSecret 或成人 Token。
- [ ] FAM-05：child 设备拿到的是受限 child session，不是成人 session 复制。
- [ ] FAM-06：配对过期、重复领取、并发批准、错误 pollSecret 均安全；授权撤销即时影响后续请求。
- [ ] FAM-07：家庭成员不自动获得个人记录／图片／永久另存权限；成员／grant 版本改变拒绝旧写入。
- [ ] RTC-01：五台实际设备被原子分配名额，第六台拒绝；同账号两设备占两席。
- [ ] RTC-02：伪造相同 installationId 或旧 deviceSession 不能绕过限额；断线重连不重复占席。
- [ ] RTC-03：失去会话／成员资格后，不能续签 RTC 凭据；实际在线连接撤权效果有供应商证据。
- [ ] RTC-04：多设备真实音视频和共同编辑通过，不以五个浏览器页或单机保存替代。
- [ ] RTC-05：录制与另存仍遵守明确授权；主存档失联不自动将所有设备升级为永久持有者。

## 9. 上线门禁与证据

- [ ] OPS-01：生产／预发布 Mock 开关触发拒绝启动；必需 Secret 缺失或占位符不能启动。
- [ ] OPS-02：生产日志／错误／APM／代理／构建产物抽检无凭据与真实家庭数据。
- [ ] OPS-03：运行指标、Outbox、删除积压、备份任务报警可验证，不只有文档。
- [ ] OPS-04：Nginx 增量配置经 nginx -t；旧产品回归完成；回退不执行破坏性 down migration。
- [ ] OPS-05：正式邮件、Apple 真机、ECS 角色资源、隐私／注销均有发布证据；未定 RTC 不伪装已启用。
- [ ] OPS-06：所有遗留门禁明确归属，不把账号 Done、家庭 Done 和五设备 Done 混为一项。

## 10. 单项证据模板

```text
用例 ID：
工作包：
代码 SHA／分支：
执行日期：
环境：unit / real-postgres / staging / real-device / production
设备与系统（适用时）：
前置条件：
操作步骤：
预期结果：
实际结果：
状态：通过 / 失败 / 阻塞 / 未执行
证据位置（不包含秘密）：
剩余风险：
```
