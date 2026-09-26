# 真实线上邮箱账号链路 · 2026-09-25

## 授权与范围

维护者要求彻底打通注册页面、真实验证码邮件、公网注册、登录与重启恢复、注销；明确允许暂时共用 qiuge-helper 邮件服务，并授权自行决定所需细节。仅新增思玥服务及 nginx 路径，未修改秋哥业务数据。本文所列结果为本次实际执行，非先前本地 fixture 结果。

## 公网部署

- 固定地址：`https://api.qiugeapp.com/api/siyue/v1`；TLS 由原有 host nginx 提供。
- `siyue-api`、`siyue-mail-worker` 独立 Docker 服务，非 root、只读文件系统、限内存，API 仅监听宿主回环 8787。
- PostgreSQL 17 新建 `siyue`、`siyue_deletion_ledger`，独立最小权限角色；**同一集群及主机，不是独立故障域**。原有秋哥数据库与角色未修改。
- 主库 26 项迁移成功。API 不持迁移凭据；发信、签名、加密与 pepper 配置留在远程 `/etc/siyue`，不进入仓库或客户端。复用 Resend 发信账户，思玥使用自己的邮件队列。
- 首次运行工件 `0.0.1-fee1f4b-dirty`，上传 tarball SHA-256：`9bc976f5e2e096124f34d0441e2aba3afc90f0bd6f1659e0bb009a3f773adf9e`；运行镜像 SHA-256：`4f9395a5c6767b9b48fd77c59e29e433f973965bad47527d0852a9a0d5b0247d`。基于当前未提交工作区，不等于 Git 发布。实际上传包保留在服务器 `/tmp/siyue-server-20260925.tar.gz`；后续本地同名构建不能替代此摘要。
- nginx 只增加思玥 include；原配置备份 `/etc/siyue/nginx-api-before-siyue.conf`，原 SHA-256 `8953a5c6186e0ada1c075e23451be807b5bff7b4147e209173c20bb8808ca737`。语法校验通过后 reload，失败自动回退。
- 注册政策版本 `2026-09-25`：[用户协议](https://api.qiugeapp.com/api/siyue/legal/terms.html)、[隐私政策](https://api.qiugeapp.com/api/siyue/legal/privacy.html)。运营联系人使用维护者已连接的邮箱，未虚构公司主体或合规认证。

## 真实公网验收：通过

执行：

```sh
SIYUE_ONLINE_ACCEPTANCE_DIR=<本机私有测试输入目录> \
  node_modules/.bin/playwright test tests/e2e/online-account-lifecycle.spec.mjs
```

结果：**1 passed，37.9 秒用例 / 38.2 秒总计**。实际 Electron UI、正式固定公网地址、真实 Resend、维护者已连接 Gmail 的专用测试别名；未设置本地 API override、未从数据库提取验证码、未预创建账号、未使用假邮件提供者。密码与验证码不写入测试源码，真实凭据输入期间不采集 trace 或截图。

1. 从账号页进入注册，阅读链接并勾选同意，发送验证码。
2. Gmail 实际收到“思玥注册验证码”；收件时间 `2026-09-24T17:46:05Z`。**进入 SPAM**，并非收件箱。邮件头 SPF 与 DKIM 均为 pass；此结论不保证后续邮件进入收件箱。
3. 在 UI 输入实际收到的验证码和测试密码，注册成功。
4. 关闭 Electron，再次启动；安全存储恢复同一个主体。
5. UI 退出后以邮箱密码重新登录，仍为同一个主体。
6. UI 查看注销影响、再次验证密码、确认注销，轮询直至“已受理并完成”。
7. 再次关闭重启，旧会话不恢复，使用原邮箱密码登录被拒绝。

测试专用主体 `4c933875-05a6-4617-a970-6e0d51d95413` 已经正式注销。随后只读核查：主体 `deleted`，邮箱/密码/会话记录均为 0，删除作业 `completed` 且 `local_data_deleted=true`，独立账本 `accepted`，邮件队列一笔 `sent`。邮件实际收件证据独立于队列的 `sent` 状态。

公网 `/health/ready`、协议接口、协议页面返回 200；秋哥 `/api/cloud/health` 部署前后及注销后均为 200。观察时 API/worker 分别约 64/44 MiB，无 OOM 或重启。

## 实现与定向回归

注册使用共享 `createEmailRegistration` 状态机与公开政策 schema；服务端缺配置关闭注册、版本不一致拒绝、已成功的同键请求仍可恢复。Resend 固定 HTTPS 端点、稳定作业幂等键、响应体不记日志，不确定结果不盲目重发。提供者说明见 [Resend send API](https://resend.com/docs/api-reference/emails/send-email) 与 [idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys)。

定向回归与原生矩阵结果在本轮完成后追加于此，不以设计图或编译成功替代运行验收。

## 边界

- 本次线上主体无家庭、儿童设备或 Apple 登录；家庭处置此前的隔离验证见[注销补全](backend-auth-deletion-completion-2026-09-25.md)，不能据本次结果声称真实多人家庭/Apple 已验收。
- iPhone/iPad、Android 真机、商店分发与完整版本发布分别计状态。
- 注销账本与主库逻辑隔离，但集群级备份或同机故障可能同时影响两库。跨基础设施灾备与两库共同回退的外部见证不在本次通过结论内。
- Gmail 首封验证码落入垃圾邮件，不能承诺收件箱送达。应用明确提示检查垃圾邮件。

### 收尾回归与最终服务工件

- Playwright `registration-ui.spec.mjs`：**5/5，19.5 秒**。同意门控、错误验证码、丢响应原键恢复、政策读取失败、未发布、版本变化重新同意、关闭注册后的恢复均覆盖。
- Playwright `registration-policy.spec.mjs`：**3/3，3.1 秒**，真实 HTTP 门禁与实际数据库无发信副作用。
- Node 集成 `runtime`、`registration-policy`、`resend`、`mail-config`、`mail-worker`：**21/21，6.48 秒**。
- 协议配置单测 **5/5**，包括共享 schema 对纯空白版本拒绝。contracts/adapters 代理定向全包分别 **63/63、274/274**；版本空白收尾修正另以配置单测验证。
- desktop/mobile TypeScript 检查通过；OpenSpec 6/6、版本记录检查及 `git diff --check` 通过。
- 最终 tarball SHA-256 `82a0fae0054f52a60eea1a84595cf2bdca5913eecc81036edf2183445478e103`，本地保留在 `artifacts/server-deploy/verified-20260925/`，服务器 `/tmp/siyue-server-20260925-final.tar.gz`。部署目录 `/opt/siyue/releases/20260925-final/0.0.1-fee1f4b-dirty`，镜像 tag `siyue-server:20260925-final-82a0fae0`，实际镜像 SHA-256 `35fa63fbef95b17f1ab3427783d1cd7359c4e1c40b212cc0c6b88fcae470fab2`。最终增量恢复空白政策版本拒绝并补齐错误恢复，正常已发布版本不变。
- 预建的 `siyue-internal` 网络使用 `/etc/siyue/network-compose.yml` 显式 external override；后续 compose 操作同时传入该文件。可信代理只允许两个实际 Docker 网关 `/32`，不信任整个私网。
- 初次 compose 因预建网络缺少 compose 标签而拒绝，未影响旧服务；添加 external override 后正常。两次服务更新均出现启动期间短暂连接重置，随后就绪 200、无退出/OOM/自动重启；不能把过早健康检查失败描述为已通过。

### 原生注册回归与修复

隔离 QA bundle 为 `app.siyue.mobile.accountqa`，`tests/e2e/native-registration-server.mjs` 仅监听本机回环，使用临时 PostgreSQL 与注销账本。它不预创建账号；XCTest 通过真实页面输入并注册，验证码来自隔离测试服务。此项不等于移动端真实邮件、公网或真机验收。

构建执行：

```sh
EXPO_NO_DOTENV=1 EXPO_NO_BUNDLE_SPLITTING=1 xcodebuild build-for-testing \
  -workspace apps/mobile/ios/Siyue.xcworkspace -scheme AccountAuthUITests \
  -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/siyue-deletion-ios ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-
```

随后以 `test-without-building`、同一 scheme/DerivedData、`-parallel-testing-enabled NO`、`-only-testing:AccountAuthUITests/RegistrationUITests` 在两个专用模拟器运行。iPhone 17 Pro 为 `96945097-A203-4EC9-8651-7953F7EF0681`，iPad Pro 11 M5 为 `69400DC1-4561-488D-BE95-E417FCD3E39E`，均为 iOS 26.5。

- 首轮 iPhone 中文、iPad 中英文均在同意协议后仍无法发送验证码。无障碍树显示 checkbox 仍未选中，发送按钮禁用；嵌套协议链接与勾选控件争夺点击。已把勾选区与两个协议链接分开，各自至少 48 点高，并在测试中直接断言勾选后发送按钮可用。
- 第一轮点击修复后的 iPad 中英文 **2/2，152.554 秒**，结果包 `artifacts/registration-native/ipad-20260925-r2.xcresult`。iPhone 中文通过，但英文在 XCTest 输入六位验证码时两次读回字符顺序与输入不一致，尚未提交注册即由精确值断言拦住；失败包 `artifacts/registration-native/iphone-20260925-r2.xcresult` 和 `iphone-20260925-r4.xcresult` 均保留，未删除失败证据或放松输入断言。
- 失败值 `011046 → 010461` 与 `650398 → 603985` 都显示受控字段回写期间光标回跳，后续数字插入旧位置。注册表单原来通过订阅回调异步复制外部 flow 状态；改为 `useSyncExternalStore` 同步读取不可变快照，使原生编辑事件与 React 回写值保持同一版本。密码、验证码规则及服务调用未变。
- 最终构建在 iPhone 上英文完整链路连续 **3/3，225.834 秒**，中文 **1/1，79.613 秒**；结果包分别为 `artifacts/registration-native/iphone-20260925-r5.xcresult` 和 `iphone-20260925-r6-zh.xcresult`。iPad 同一最终构建中英文 **2/2，157.972 秒**，结果包 `artifacts/registration-native/ipad-20260925-r5.xcresult`。每条均覆盖未同意不发信、屏幕注册、同账号冷启动恢复、屏幕注销与重启后完成回执。
- 新增 iPhone 软件键盘压力回归，在同一验证码字段依次全选替换并精确核对 20 组不同六位数字，包含两组历史失败输入；**20/20，202.136 秒**，结果包 `artifacts/registration-native/iphone-20260925-r7-input-stress.xcresult`。最终 QA `main.jsbundle` SHA-256 为 `a6b7ee1386e8a16e44f2830e259e5a4436a185499d26bd7edaefd7bd359a590e`。
- 检查 iPhone/iPad 英文深色注册页截图，表单可见且可滚动、标签换行正常、主操作可达。模拟器通过不等于真机或移动端真实邮件/公网验收。
- 本轮 pnpm 包装命令因 `enableGlobalVirtualStore` 配置与现存依赖不同被拒绝，未重新安装依赖；改用已安装的 `node_modules/.bin/tsc --noEmit -p apps/mobile/tsconfig.json` 检查通过，移动端 Node 回归 **174/174**，OpenSpec **6/6**、版本记录检查及 `git diff --check` 通过。
- 测试完成后的线上只读复核：最终镜像一致，思玥 ready 为 true、秋哥健康端点 200、专用测试账号删除作业仍为 completed/local_data_deleted=true。已清除本机该注销测试账号的临时密码及验证码输入文件。
