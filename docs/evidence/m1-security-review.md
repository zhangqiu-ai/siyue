# M1 本地 Mock 安全审查与移动错误脱敏

日期：2026-09-06。范围为当前本地 Mock 默认调用链、Electron/本地服务边界及错误输出；只使用合成测试数据，没有配置或调用真实供应商。本记录属于源码审查和指定测试，不是完整渗透测试、全安装包网络审计、生产鉴权或密钥安全存储验收。

## 已核对的默认边界

| 范围 | 源码事实与证据边界 |
|---|---|
| 正常移动入口 | [native-client.ts](../../apps/mobile/src/native-client.ts) 默认使用本机Mock，250毫秒延迟、默认10秒执行超时；正常工厂没有fetch、凭据读取或远程服务调用。QA的延迟/超时与数据库注入不改变默认入口。这是默认调用链源码核对，不证明整个依赖包所有潜在网络路径均已审计。 |
| Electron宿主 | [main/index.mjs](../../apps/desktop/src/main/index.mjs) 使用Mock；启用contextIsolation、sandbox，禁用nodeIntegration；CSP限制资源与连接，拒绝导航、重定向、新窗口和webview，默认拒绝权限请求。开发入口限显式loopback URL，打包入口使用本地资源。 |
| Electron IPC | [ipc.mjs](../../apps/desktop/src/main/ipc.mjs) 绑定实际所属webContents、主frame与精确URL，方法及参数白名单校验；不开放通用Shell/SQL/文件访问，错误仅暴露受限code。非法来源、参数、身份/空间注入与取消作用域已有测试。 |
| 本地开发服务 | [index.ts](../../apps/server/src/index.ts) 仅监听127.0.0.1；[app.ts](../../apps/server/src/app.ts) logger=false、请求体上限4096字节、拒绝带Origin的请求、返回固定错误码，默认只生成Mock预览。这些控制不是身份认证；服务明确声明none-local-development-only、productionReady=false。 |
| 本地pending日志 | key为输入/身份/空间摘要，value只存命令身份和时间等元数据；未知结果保留待对账。hash不是加密，不据此宣称输入具备保密性或数据库加密。 |

本阶段没有BYOK输入、真实Provider或生产账号服务，因此“平台秘密存储”和“生产服务鉴权”对当前默认Mock分支不适用；应继续作为启用相关能力前的门槛，不能写成已实现。既有权限/数据用途规则不因此取消。

## 发现并修复的移动错误展示问题

旧移动错误格式化会回显未知 `error.code`；直接查询普通对象字典会命中 `constructor` / `__proto__` 等原型名称；非字符串code还可能触发 `String()` 的自定义副作用。这会使不受信任的错误内容进入用户提示，或使错误处理本身失败。

新增 [src/errors.ts](../../apps/mobile/src/errors.ts)，只有消息字典的自有白名单键可返回对应提示，其他情况返回固定generic提示；非字符串code不做String转换，不回显未知code、message或stack。已知错误及AbortError继续提供恢复/取消指导。[正常HomeScreen](../../apps/mobile/app/index.tsx) 导入并复用该函数，不保留另一套格式化实现。

[errors.test.mjs](../../apps/mobile/tests/errors.test.mjs) 使用合成敏感字符串验证未知code/message/stack不泄露、原型键不能绕过白名单、对象code不被字符串化，以及已知错误指导保持。旧实现先运行得到1通过3失败（`artifacts/m1/mobile-error-redaction-red.log`，退出1）；修复后4通过0失败（`mobile-error-redaction-green.log`）。移动包增加独立test脚本 `node --experimental-strip-types --test tests/*.test.mjs`。

## 本轮执行结果

仓库根目录的准确复现命令与实际日志：

| 命令 | 本轮结果 | 日志（artifacts/m1/） |
|---|---|---|
| `corepack pnpm --filter @siyue/mobile test` | 4项通过、0失败 | mobile-error-redaction-green.log；旧实现RED另存 |
| `corepack pnpm --filter @siyue/mobile typecheck` | 通过 | mobile-error-redaction-typecheck.log |
| `corepack pnpm --filter @siyue/desktop test` | 13项通过、0失败 | security-desktop-tests.log |
| `corepack pnpm --filter @siyue/server test` | 7项通过、0失败 | security-server-tests.log |
| `corepack pnpm --filter @siyue/adapters test` | 40项通过、0失败 | security-adapter-tests.log |
| `corepack pnpm --filter @siyue/ai test` | 9项通过、0失败 | security-ai-tests.log |
| `corepack pnpm bundle:mobile` | 通过；iOS/Android Hermes JS导出 | mobile-error-redaction-bundle.log |

`bundle:mobile` 退出0，导出iOS `entry-1e3f598f80ec75347681da1cef42662a.hbc`（3.2 MB）与Android `entry-fde10dc2aae02884e7fa0ee5c48663b6.hbc`（3.6 MB）。这只证明Hermes JS导出，不是新原生包或真机回归。

本轮上述实现测试共73项通过，不能把本轮未重跑的domain/contracts测试算入该数字，也不替代此前分别记录的原生UI用例。Node模块类型警告在原日志中保留，未将其删除或误写为测试失败。

## 未完成与版本界限

此脱敏改动尚未进行原生UI故障注入回归。此前iPhone、iOS/Android模拟器及独立QA通过对应修改前的构建，不能据此宣称当前新原生包已通过同样回归。本轮移动JS导出已经通过，但不能替代原生UI结果。

正常用户UI其余错误恢复、真实平台密钥存储/加密、生产鉴权、导出秘密检查、完整包体网络与供应商审计仍未验收。新功能启用真实密钥、外发或同步时需重新验证用途授权和相关边界。本轮只补SY-005与AT-023的本地Mock证据，整体工作包及跨阶段状态不提升。总记录见 [M1验证](m1-validation.md)。
