# SA-05 Android 未提交计划输入舍弃 · 2026-09-23

## 发现与修复

正式 `PlanCreateScreen` 的“舍弃修改”操作只发出导航，未清除 `workspace-scratch` 的进程内缓存；并且 `useWorkspaceValue` 过去依赖 `useEffect` 写缓存，页面卸载前的清空状态可能还没落入缓存。Android 原生 QA 能稳定复现：舍弃后同一进程重新打开仍出现刚输入的目标。

现在舍弃动作会清空目标、项目、未知结果标记和待重试手动命令。`useWorkspaceValue` 在同步 setter 中同时更新 React 状态、当前值 ref 和对应空间的进程内 buffer，避免立即导航卸载时丢失最终变更。缓冲仍按 local / account namespace 分隔，仍不承诺强杀或崩溃后恢复。

## 验证

使用 Android API 36 模拟器、独立 QA 应用 `app.siyue.mobile.accountqa`，直接挂载正式 `PlanCreateScreen` 并由 UIAutomator 操作系统文本框、导航按钮和原生 Alert。测试只含合成输入，不登录账号、不访问云端。

| 检查 | 结果 |
| --- | --- |
| `corepack pnpm --filter @siyue/mobile typecheck` | 通过 |
| `corepack pnpm --filter @siyue/mobile test` | 143/143 通过 |
| `node --check apps/mobile/e2e/account-auth/android.mjs` | 通过 |
| Android QA Release 构建 | 通过；AAPT 确认独立包标识 `app.siyue.mobile.accountqa` |
| `SIYUE_QA_ANDROID=emulator-5554 node apps/mobile/e2e/account-auth/android.mjs --draft-discard` | 2/2 通过；中英离开提示、选择舍弃、同进程重开后目标为空 |
| QA 结果与截图 | `artifacts/account-ui-android-1790130158974/result.json`、`zh-draft-discard-cleared.png`、`en-draft-discard-cleared.png` |

首次原生断言在修复前失败并显示原目标仍被恢复；修复后同一测试通过。QA 专用包测试前以 `pm clear app.siyue.mobile.accountqa` 重置残留的旧 SecureStore 缺项状态，没有清理或触碰正式应用数据。

## 未覆盖

本结果只验证用户明确选择舍弃后的本机页面状态。移动端账号空间切换时如何告知并保护未提交页面、A/B/local 草稿隔离及恢复、离线未决命令、iOS/iPadOS 与真机路径仍未验收；因此 SA-05 6.4b 和 6.4 整体不勾选。
