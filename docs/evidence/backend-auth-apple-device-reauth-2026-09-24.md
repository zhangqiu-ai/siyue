# Apple-only 设备撤销重新验证 · 2026-09-24

## 服务端切片

Apple reauth 的动作白名单从 `link-identity` 增加 `revoke-session`、`revoke-all-sessions`。客户端在 start 时选择其中一个动作；服务端把动作与当前已验证会话写进 flow，完成时重新核对已绑定 Apple 身份和会话，只签发同动作的一次性五分钟 grant。设备撤销接口既有的 `consumeReauth` 再核对 subject、session、credential version 和动作，不接受把绑定邮箱的 grant 用于撤销设备。

采用新增 `0008_apple_reauth_actions.sql` 扩大数据库 CHECK 白名单，未改旧迁移；本地临时 PostgreSQL 已核对 0007 旧库升级和历史 flow 语义。

验证：服务端完整集成套件 104/104；其中 Apple reauth 11/11。Playwright 相关 HTTP 批次 39/39，含撤销其他设备、撤销全部设备、跨动作拒绝及邮箱绑定原路径；contracts 32/32、adapters 103/103、类型检查 13/13、OpenSpec 6/6。以上为合成 Apple issuer/JWKS/exchange 和隔离临时 PostgreSQL，不是 Apple Developer 实际授权。执行 full integration 时一个邮箱预算用例恰好跨整点导致一次失败；已把该用例固定在小时窗口内，单独重跑 21/21。

## 共享客户端切片

共享认证控制器现提供 `revokeDeviceSessionWithApple` 和 `revokeAllDeviceSessionsWithApple`：Apple native 授权、同一 complete key 的丢响应恢复和动作 grant 消费均留在内部闭包；grant 不进入 UI 状态或本机 vault。撤销请求已送出却丢失响应时不自动重放或报成功，调用者可重新读取设备清单；确认撤销全部后才清除本机会话。已有邮箱密码撤销路径保持独立。

新增 adapters 单测后 112/112 通过。主代理再构建 packages/server，并运行真实 HTTP + 临时 PostgreSQL 的 `tests/e2e/auth-client.spec.mjs`，25/25 通过，其中新用例验证 Apple-only 撤销其他设备再撤销全部、跨动作 grant 分离、保存的本机凭据清除，以及单设备撤销响应丢失后以设备清单核对。Apple issuer、授权和换码仍为本地合成适配器。

产品账号页尚未接入这两个控制器方法；真实 Apple 授权、iPhone/iPad 真机及生产数据库迁移未验证。8.4、SA-07 仍未完成。
