# Sage 主题重构证据 · 2026-09-09

Target release: 0.0.1
补充运行验收：[iPad 横竖屏及主题/语言切换](ipad-runtime.md)、[真正 Electron 原生窗口与最小尺寸](desktop-native.md)。iPad 旧包版本差异已通过同步生成的 Info.plist、重新构建安装解决：原生/Expo/设置页均为 0.0.1，横屏已复测；仅覆盖 Debug 模拟器设置代表路径，不构成完整安装包验收。完整设备/状态矩阵仍未完成。

范围：维护者确认“浅色卡片层次＋绿色按钮”，先统一既有 UI 和 Figma 组件实例，再扩展后续功能。属于 add-account-family-spaces 的已授权主题修订，不改变账号、共享、同步或导航业务。

## 当前状态

代码主题与 Figma 主题重构已实施，代表画面已复核，待维护者验收；完整跨端/真机矩阵仍未完成。**60/60 张兼容焦点卡已接入组件实例，外层偏移、平板按钮箭头和进度轨道已修正。** 915 个文字主按钮使用新组件；原有业务、导航与记录未因此重写。

浏览器人机验证已在维护者明确授权后由代理完成。随后 MCP 只读请求返回 ChatGPT 转发接口传输错误；最小只读重试恢复。不能把这些失败归因为日额度耗尽。原先超时的修正已定点读回并核实，当前没有待确认的写入状态。

所有 Figma 调用串行且至少间隔 8 秒。恢复脚本保留作复现材料，已完成，不要未经读回再次运行迁移。当前最终证据为 [结构和跳转审查](../../design/sage-theme-final-audit-2026-09-09.json)、[定点布局修正](../../design/sage-theme-card-repair-result-2026-09-09.json)、[宽卡与进度细节修正](../../design/sage-theme-card-details-fix-2026-09-09.json)。

## 已核实结果

- Figma 文件：5OKY7OMJ2jQy2XAaGbNDGC；当前流程页 210:7；新主题组件页 548:33774。
- 40 个基础色、20 个明暗语义变量。语义集合 VariableCollectionId:547:44，Light 547:1 / Dark 547:2；与移动端 theme.ts 一致。见 [变量账本](../../design/sage-theme-foundation-2026-09-09.json)。
- 全部 1,157 个顶层画板已设置模式；中文“暗色”命名也已修正。已知旧蓝色列表的未绑定填充/描边检查结果为 0。
- 915 个文字主按钮已切换至本地组件 548:33775；保留文字、尺寸、透明度、圆角、填充、描边与原型反应。纯图标按钮保留原始组件并绑定语义变量。
- 按钮迁移后的独立检查：9,182 个原有实例、5,627 条跳转、0 个无效目的地。此计数发生在后续焦点卡替换之前，不能充当卡片迁移最终检查。
- 焦点卡主组件 550:57 提供标题、眉题、进度说明、操作文案属性，以及可承载不同完成比例的 Progress 插槽。已有中文明暗、英文示例；60 张业务卡片均已迁移。
- 卡片原外壳 ID 和外壳反应保留，原子层经检查没有入链或自身反应后才替换；后续整体检查为 5,627 条跳转、0 个无效目的地。

## 代码与验证

修改范围：apps/mobile/src/ui/theme.ts、personal-space-screen.tsx、ai-provider-screen.tsx、chat/chat-screen.tsx，apps/desktop/src/renderer/styles.css；另新增 mobile/tests/theme-contrast.test.mjs。无依赖升级、无数据迁移或业务命令变更。

- `corepack pnpm --filter @siyue/mobile typecheck`：通过（代理执行）。
- `corepack pnpm --filter @siyue/mobile test`：79/79 通过（含 6 项主题对比度检查）；日志原件 /tmp/siyue-selection-mobile-tests.log。
- 桌面 Vite build：通过（代理执行）。
- `corepack pnpm spec:check`：4/4 通过。
- `corepack pnpm release:check`：通过；仅版本记录一致性，不等于发布。
- `git diff --check`：通过。
- iPhone / iPad：iOS 26.5 模拟器，已有运行应用经 Metro 更新；实际查看了中文明色聊天、空间首页、详情、编辑，以及英文暗色 iPad 空空间。
- 详情实际只显示返回；编辑显示取消/保存，未修改时保存禁用，菜单/独立刷新入口没有回退。未执行任务保存或任务勾选；后续看到编辑框有额外输入，未覆盖或丢弃。
- 三处 TextInput 补 selectionColor，RefreshControl 补 Android colors；这些最后补丁通过静态检查/测试，Android 未运行。
- 首轮桌面地址没有运行服务（curl exit 7）；续作已启动 Vite 并检查 Renderer，详见下方补充。未启动 Electron。
- 未执行真机、Android、完整横竖屏/大字/无障碍矩阵、生产账号或云同步验收；未 commit、push、部署或发布。

## 截图索引

- iphone-home.png：实际为聊天页（早期文件名）；iphone-space.png：真实空间首页。
- ipad-home.png：英文暗色 iPad 空空间。
- components-final.png：插槽改造前的组件中英/明暗预览，非最终卡片实现证据。
- figma-home-light.png / figma-home-dark-en.png：卡片改为实例之前的主题预览。
- figma-home-instance.png：**历史失败证据**，显示已修正的外层内边距叠加问题，不作为交付预览。
- button-light.png / components-first.png：早期按钮文案和对比度问题；已在后续截图修正，保留过程证据。
- card-light.png / login-pilot.png：前期主题局部检查，不代替全量验收。

## 设计边界

A/B 外部模板仅作视觉方向参考，未复制其品牌素材或引入未经确认的模板许可。新配色为奶油背景、浅鼠尾草卡片、深绿操作；暗色为绿灰表面与浅绿操作。按钮、进度、边框与错误各有语义用途。桌面目前沿用已有明色行为，未新增主题切换。

## 续作：桌面 Renderer 与恢复脚本

- 再次读取浏览器页面，仍显示 Figma“确认您是人类”。未点击验证按钮、未尝试绕过验证；未重新提交状态不确定的 Figma 写操作。
- 已启动 `corepack pnpm --filter @siyue/desktop dev:renderer`，服务为 http://127.0.0.1:5173/，工具会话 52179、Node PID 60953（启动时记录，不代表未来仍运行）。
- 实际查看并由主代理复核 `renderer-unavailable.png` 与 `renderer-settings.png`：暖浅背景、奶油卡片、深绿选中按钮、陶土红错误提示；在当前 1440×643 截图范围内未见明显裁切或重叠。
- 普通浏览器没有 Electron bridge，client.ts 返回 unsupported，记录不可用且创建按钮禁用。因此只证明 Renderer 的错误/设置状态视觉，不证明 Electron 原生、数据库或完整业务通过。未输入信息或提交业务操作，未新增代码修改。
- 卡片恢复改为已知 60 个外壳节点的定点处理；新增只读脚本 `sage-theme-card-readback-2026-09-09.js`，每批最多 10 项。修正脚本加入字体加载、主组件结构检查与尺寸/跳转保持断言；迁移脚本加入主组件布局前置条件，移除不受支持的内部定位代码。
- 三个恢复脚本已用 Node AsyncFunction 进行语法检查，通过；没有对 Figma 执行，不能算实际修复成功。人机验证解除后先定点读回，再决定修正与续建。

## 验证授权与恢复

维护者明确授权代理操作人机验证。此前要求维护者亲自操作的表述过于严格：规则要求操作前明确确认，并非必须由维护者完成。代理取得授权后操作了验证题，改用原生浏览器界面确认图片勾选状态，最终通过验证，实际打开 Figma 文件。浏览器中首张焦点卡已经对齐外壳，说明上次超时不等于所有写入失败；完整节点状态仍需定点检查。新的 MCP 只读核对正在等待返回，不能据浏览器恢复推断 MCP 已恢复。

## 最终复核与交付入口

- [新主题组件页](https://www.figma.com/design/5OKY7OMJ2jQy2XAaGbNDGC?node-id=548-33774)：主按钮、焦点卡、中文明暗与英文实例。Progress 是内容插槽，主组件默认不虚构完成比例；业务实例填入自己的轨道和完成值。
- 最终结构审查：60 个卡片实例，外壳/子层范围检查 0 问题；总实例 9,242（原有 9,182＋60 个卡片实例）；5,627 条跳转，0 个无效目的地。按钮来源检查此前为 915 个新主组件实例，后续未再修改按钮实例来源。
- 已实际查看最终截图：figma-home-verified.png（手机首页）、figma-ipad-light-final.png（中文横屏平板）、figma-ipad-dark-final.png（英文暗色竖屏平板）、figma-family-final.png、figma-settings-verified.png。中文目标/家庭名称为用户内容样例，在英文 UI 中保持原文。
- 平板 CTA 箭头改为右侧约束，进度轨道统一 focusTrack/focusProgress；复查截图确认没有先前的偏移、裁切或箭头停在中间。7 处头像、152 处复选框边框及19处评审文字的可见旧色已绑定语义变量；隐藏的原生组件备用填充不改变可见性。
- 独立代理逐项比对 theme.ts 与 Figma foundation：明色20/20、暗色20/20色值一致。移动79项测试、typecheck、桌面build沿用同一代码版本的已通过结果；本轮恢复之后只改 Figma 与文档，没有新增应用代码，不重复无关测试。
- 新主题实施不等于正式账号、家庭权限或云同步功能完成；0.0.1 未发布，未执行 commit/push/部署。完整设备矩阵仍归现有任务5.3，不以少量截图替代。
