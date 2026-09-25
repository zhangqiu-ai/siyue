# SA-05 客户端会话基础 · 2026-09-22

## 代码与范围

`feature/dev`，基于 `fee1f4bde860f6d6fad01dd1ebe3b146278f2fb1` 的未提交工作区。承接 [SA-04](backend-auth-email-2026-09-21.md)；三份[原始方案](../architecture/backend-auth-v1/README.md)保持原件。无提交、推送或部署。

新增 contracts/auth-client、adapters/auth-api-client 与 auth-controller；移动 AccountAuthProvider/SecureStore 适配接入现有根布局；Electron 主进程启动单一认证服务，preload 暴露白名单账号操作。没有重写本地编辑器、账号归属或家庭权限。

本批复用 Expo 57.0.20、React 19.2.3、React Native 0.86.3、expo-secure-store ~57.0.3、expo-crypto ~57.0.2、Electron 44.2.0，不新增依赖。用户仍不能通过正式界面完成注册／登录：表单接入及账号空间映射是后续任务，不以测试调用 IPC 代替产品可用。

## 实现约束

- 固定生产地址 `https://api.qiugeapp.com/api/siyue/v1`。开发／测试仅接受回环地址及 `/v1`；staging 未确认具体入口，拒绝配置。拒绝重定向、任意 URL、未知字段及大于 16 KiB 的响应；超时、错误码和取消统一处理。
- access 只在宿主内存；安全包只包含版本、环境／地址、installationId、refresh、会话引用、轮换请求身份和待撤销证明，最多 2048 字节。无密码、用户资料或 access 落盘。
- 保存 rotationId 后才刷新；同一代际的刷新与身份查询合并。后继凭据落盘确认后才显示已认证，丢响应用原请求身份恢复。
- 所有存储写入串行。超时结束用户等待，但不可取消的原生写仍占据序列；较新写不能越过迟到写。损坏／未来格式／环境不匹配不重置为新空包。
- 退出先持久化 active=null 和仅供撤销的证明，再报告本机退出。队列最多4项，满时须联网清理，不丢旧证明。退出／恢复的迟到完成也检查 generation；旧实例销毁后不能清理新实例的存档。
- 移动使用 WHEN_UNLOCKED_THIS_DEVICE_ONLY；不可用或失败不转存普通 SQLite。桌面使用 safeStorage + 0600 原子替换；Linux 仅允许已知加密后端，拒绝 basic_text/unknown。主进程单实例持有安全包。
- IPC 校验 sender、主 frame、当前 URL、参数、请求身份与 generation；无任意路径、URL或凭据读取接口。16个身份只读请求和4个其他操作分开限流；共享查询仍只产生一个 HTTP 请求。没有放宽服务端并发限制。
- 本地窗口启动不等待云请求。原有未登录空间继续保留，不自动改 owner／上传文件；尚未创建账号私有内容或实时订阅，不声称这些后续路径已隔离验收。

## 实际执行

测试数据全部为合成邮箱、独立临时 PostgreSQL 17.11、回环 HTTP 和可丢弃 Electron 用户目录。不读取部署 `.env`，不接触云数据库或真实邮箱。

| 命令／验证 | 结果与边界 |
| --- | --- |
| `corepack pnpm --filter @siyue/adapters test` | 63/63；包括4项 typed API 地址、错误、输入、取消／超时、响应限制测试；其余为已有回归 |
| `corepack pnpm --filter @siyue/adapters build` | 通过；最终状态机改动后重新生成实际 E2E 使用的包 |
| `corepack pnpm exec playwright test tests/e2e/auth-client.spec.mjs tests/e2e/desktop-auth.spec.mjs` | 最终13/13；12项客户端与真实 HTTP／PG 路径，1项真实 macOS Electron 加密存储与主进程 IPC。共享客户端测试的 vault 为注入内存，不能充当原生证据 |
| `corepack pnpm --filter @siyue/desktop test` | 最终21/21；含存储损坏、不安全 Linux 后端、IPC 不可信来源／过时代际拒绝及关闭竞态。系统加密替身仅证明适配器路径 |
| `node --experimental-strip-types --test apps/mobile/tests/auth-vault.test.mjs` | 1/1（与桌面3项共4项联合执行）；验证原生 API 参数、失败与无明文回退，不证明系统 Keychain/Keystore |
| `corepack pnpm --filter @siyue/mobile typecheck` | 通过 |
| `corepack pnpm --filter @siyue/desktop build` | 通过；保留既有 Excalidraw chunk 体积警告 |
| `corepack pnpm --filter @siyue/mobile exec expo export --platform ios --platform android --output-dir dist-auth-validation` | 双平台 Hermes 导出通过；产物移到忽略目录 `artifacts/auth-client-2026-09-22/mobile-export`。这是打包证据，不是原生运行验收 |
| `corepack pnpm exec playwright test tests/e2e/desktop.spec.mjs --grep 'manual create, rename'` | 中英2/2；本地创建／改名／完成／归档与重启保留通过 |
| `corepack pnpm exec playwright test tests/e2e/excalidraw.spec.mjs` | 修复后5/5；书写与页面历史隔离、图片完整字节、写入失败原件保护与重试、正常退出落盘、选择移动／橡皮／撤销、英文暗色窄窗口通过 |

### 失败证据与修复

1. 10个消费者同时查询会话时，刷新已合并但身份请求未合并，触发服务端既有限流。按 generation 合并身份查询；复验通过。
2. 桌面原4项总 IPC 上限先拒绝并发查询，无法到达共享协调器。独立限制身份只读消费者与其他操作，不提高后台 API 限额；真实 Electron 并发复验通过。
3. 旧账号退出等待服务端撤销时登录另一账号，旧请求错误返回 `{local:true,server:'confirmed'}`。新增稳定复现测试，修复前1项失败；退出／恢复结束检查 generation，修复后最终13项通过，新账号状态与存档保持。
4. 存储延迟、旧实例撤销回调分别通过故障注入验证；不可取消的写不允许并行覆盖，销毁的实例不能写入替代实例。
5. 白板回归初次4/5通过：图片保存、磁盘失败恢复与重开断言完成，但点击返回后立即退出的 teardown 超时。定向重跑再次复现；主进程关闭协调器在可信编辑器正常退出卸载后仍等待已移除的监听器。新增单元测试修复前失败、修复后通过；可信的 inactive 通知完成在途关闭，不可信 frame 不能解除等待。`native image adapter` 原 Playwright 场景复验1/1通过。测试 fixture 同时增加失败才附带的最小关闭事件诊断和15秒隔离进程退出上限，不改变产品退出时限或跳过保存。

## 原方案验收映射

| 原始用例 | 当前证据／未覆盖范围 |
| --- | --- |
| SES-04、SES-12 | 会话查询10并发单刷新、离线退出／重启不复活／联网撤销通过；其他未来业务请求接线仍需复用该规则 |
| CLI-01 | 本地窗口可独立打开且认证不阻塞；未来家庭／白板实时订阅未接入 |
| CLI-02 | 网络／503保留凭据、撤销重新登录通过；后续业务403/UI重试另验 |
| CLI-03 | 身份请求、退出、旧实例晚回包与新账号存档隔离通过；账号缓存、上传任务及连接尚未接入 |
| CLI-04 | guest 原件未改归属；显式账号空间映射与私有缓存尚未完成 |
| CLI-05 | not_run：原生 iOS／Android 安全存储、重装备份、生物识别与生命周期设备验证 |
| CLI-06／07 | macOS Electron 真实加密／重启／退出、受限 IPC 通过；Linux 后端拒绝仅为注入测试，Windows/Linux 实机 not_run |
| CLI-08 | 桌面白板回归发现并修复正常退出竞态，最终5/5通过；移动原生白板未重验 |
| CLI-09 | not_run：登录页面尚未接入，中英／明暗／iPhone/iPad／Android完整交互矩阵未执行 |

## 后续与来源

SA-05 保持进行中：完成正式表单、账号范围缓存与显式空间映射，再验收各平台生命周期。SA-04 真实邮件送达、SA-06 Apple、SA-07账号安全、SA-08/09家庭及五设备、SA-10部署均未被本批验证替代。没有授权即不部署或调用真实发件服务。

独立审查尝试显式路由 `deepseek/deepseek-flash`，本轮服务返回429并终止，无审查结论；上述检查由主代理完成，不声称独立评审通过。

参考当前官方 [Expo SecureStore](https://docs.expo.dev/versions/latest/sdk/securestore/) 与 [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)，并核对本地安装包类型。操作系统保护不能保证抵御同一用户上下文中的恶意进程。

文档门禁：`corepack pnpm spec:check` 6/6、`corepack pnpm release:check` 与 `git diff --check` 通过。它们仅验证结构及记录一致性，不提高上述产品验收状态。
