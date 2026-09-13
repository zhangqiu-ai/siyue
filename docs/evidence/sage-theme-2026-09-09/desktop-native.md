# Sage 桌面原生窗口视觉检查 · 2026-09-09

本次运行真正 Electron 主进程、preload 和 Renderer，使用新建隔离目录；不是浏览器预览验收。仅覆盖中文明色空数据首页、设置弹层与键盘焦点。

## 环境与命令

工作目录：`/Users/feature/code/siyue`。macOS 26.6.2 (25G83)，Node v22.22.3，工程 Electron 44.2.0。已有 Vite 8.2.2 服务 `http://127.0.0.1:5173/`，启动前 `curl -sI --max-time 3 http://127.0.0.1:5173/` 返回 HTTP 200。

```sh
SIYUE_DATA_DIR=$(mktemp -d /tmp/siyue-sage-native.XXXXXX) corepack pnpm --filter @siyue/desktop dev:electron
```

脚本实际执行 `cross-env SIYUE_RENDERER_URL=http://127.0.0.1:5173 electron .`。本轮隔离目录 `/tmp/siyue-sage-native.NtGP6w`；Electron PID 47193；工具会话 44573。隔离方法来自 `apps/desktop/src/main/index.mjs:15`：未打包应用才接受绝对路径 `SIYUE_DATA_DIR`，不会访问默认用户业务库。未输入目标、生成计划、保存正式记录或发送 AI 请求。

原生 UI 自动显示“本机空间 · 离线可用”“暂无行动”，与缺少 bridge 的浏览器预览不同。源码表明主进程当前接入 MockAgentExecutor；本轮没有触发它。

## 实际检查

- **通过（当前范围）**：原生首页暖浅背景、奶油卡片、深绿灰文字，设置选中项深绿白字。两列卡片对齐，截图范围内无重叠、裁切或横向溢出的可见迹象。
- **通过**：设置打开后 AX 焦点是关闭；Tab 到简体中文，再到 English，再到关闭，焦点留在弹层。简体中文的绿色焦点环清楚可见。Escape 关闭后焦点回到设置入口。未切换语言或修改设置。
- **通过（最小窗口空数据范围）**：通过 CUA 拖动窗口右下角缩小，窗口在 900 × 640 停止，匹配源码 minWidth/minHeight。卡片、输入、按钮和设置弹层仍完整可见；最小窗口再验证 Tab 焦点与 Escape 返回。
- 默认构造值为 1180 × 780；本机可用屏幕约束下首次实际截图 1162 × 768，不能将其报告成精确 1180 × 780 检查。
- 本轮没有发现需要修改 CSS 的明显局部缺陷，未改代码。

## 截图（均已实际查看）

- [原生首页，1162 × 768](desktop-native-default.png)
- [原生设置焦点，1162 × 768](desktop-native-settings-focus.png)
- [最小窗口首页，900 × 640](desktop-native-small.png)
- [最小窗口设置焦点，900 × 640](desktop-native-small-settings.png)

尺寸来自 `sips -g pixelWidth -g pixelHeight`；没有把截图尺寸泛化成其他设备覆盖。

## 未运行与限制

英文、暗色（桌面目前没有新增暗色切换）、长内容/有数据列表、编辑保存、真实 AI、账号和同步、安装包与发布均未运行。本轮原生空库没有制造错误，不把此前浏览器 unsupported 截图当作原生错误状态通过。禁用生成按钮的淡绿色可见，但未通过填写输入启用该按钮；启用态绿色由设置选中按钮展示，不能替代完整业务按钮交互验收。

保留隔离 Electron 进程供主线检查；未触碰用户原有窗口或业务输入。最终仅此文档及四张截图新增。
