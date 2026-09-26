# 视频白板服务官方资料初筛（2026-09-20 初筛 · 2026-09-24 复核）

关联 [tasks 2.1 / O06](../../openspec/changes/add-family-video-whiteboard/tasks.md)、[设计](../../openspec/changes/add-family-video-whiteboard/design.md)、SY-022。

状态：**部分完成**。未选供应商、未接 SDK、未安装任何 RTC/白板依赖、未开通试用或云资源、未上传题图或音视频。本轮只复核官方公开文档与官方包元数据；文档写明的能力不是本工程兼容性、真实网络、账户额度或五设备验收的证据。tasks 2.1 不勾选完成，O06 不关闭，2.2/2.5/V15 不据此提升为通过。

## 1. 本轮复核方法（2026-09-24）

- 腾讯云文档为 JS 渲染且带反爬脚本，改用本机 headless Chromium（仓库已有 Playwright 1.62.1）渲染后取正文，并读取页面顶部“最近更新时间”。
- 声网文档正文在 HTML 中，直接 HTTP 取回解析；另取 `https://doc.shengwang.cn/sitemap.xml`（2026-09-24 解析出 8214 条 URL）确认引用页面仍在发布目录内。
- RN/Electron SDK 版本与发布时间取自 `registry.npmjs.org` 官方包元数据；端上 API 面取自官方 npm 包内容（`trtc-react-native@3.3.0` 的 `.d.ts`）与官方 API 文档。
- 本轮共打开约 20 个官方页面（含 3 个目录索引页与 2 个已重定向到“文档指引”的声网 landing 页），本文直接引用其中 10 余个关键页；另用 1 个 sitemap 与 4 个官方包元数据页核对页面存在性与版本。相比“只查十个左右页面”的初始要求略有超出，超出部分仅用于确认引用页在 2026-09-24 仍可访问，未扩展到产品全文档集。
- 未做：未安装依赖、未注册或开通试用、未登录控制台查额度、未构建或真机运行、未核对合同价格与商业条款、未核对海外站。凡出处为文档声明的“支持/兼容”，下文标为文档声明。

## 2. 工程基线对照

当前工程为 Expo 57.0.20、React Native 0.86.3、React 19.2.3、Electron 44.2.0、Node 22.13.0 以上（版本取自本仓库 package.json）。两家供应商的官方文档与包元数据都没有给出与这三个版本的实测兼容声明，下列“要求”只到供应商自己写明的下限。

## 3. 腾讯 TRTC / 互动白板（TIW）

| 项目 | 官方一手证据（链接 + 页面最近更新时间） | 未证实 |
| --- | --- | --- |
| RN SDK 版本 | npm `trtc-react-native` 最新 **3.3.0**，发布 2026-08-07，MIT，`peerDependencies` 为 `react: *`、`react-native: *`（[registry](https://registry.npmjs.org/trtc-react-native)）；包内 devDependencies 锁 RN 0.74.2，podspec 依赖 `TXLiteAVSDK_Professional ~> 13.4.21067`，包内无 `codegenConfig`（未见新架构 TurboModule/Fabric 代码生成声明） | 与 RN 0.86.3 / Expo 57 的兼容性；新架构下的实际运行；Expo prebuild 出包结果 |
| RN 文档 | [React Native API 概览](https://cloud.tencent.com/document/product/647/63792)，页面最近更新 **2023-09-19**，正文只有 API 列表与错误码入口，没有版本要求或兼容矩阵 | 文档是否覆盖 3.3.0 的完整接口；无版本矩阵可引用 |
| Electron SDK | npm `trtc-electron-sdk` 最新稳定 **13.3.801**，发布 2026-05-28，`peerDependencies: electron >=4.0.0`（无上限声明）（[registry](https://registry.npmjs.org/trtc-electron-sdk)）；[Electron API 概览](https://cloud.tencent.com/document/product/647/38551) 页面最近更新 **2024-03-08**，列出 `snapshotVideo`、`startLocalRecording`、`stopLocalRecording` | 与 Electron 44 / Node 22 的原生模块 ABI 兼容；预编译产物是否可用；沙箱与隔离 IPC 下的采集 |
| 白板 SDK 平台 | [SDK 下载](https://cloud.tencent.com/document/product/1137/39896) 页面最近更新 **2025-04-08**，平台为 Android / iOS / macOS / Web / 小程序 / HarmonyOS，**没有 RN 或 Electron 入口**；页面披露 TEduBoardSDK 版本 2.9.4.257 与《互动白板 SDK 合规使用指南》 | RN/Electron 的白板接入方式（原生视图桥接或 WebView 承载 Web SDK）均未验证；npm `@tencentcloud/tiw` 2.9.12（2026-01-12，维护者含腾讯邮箱）未在官方文档中确认为文档所指 Web SDK |

## 4. 声网 RTC / 互动白板

| 项目 | 官方一手证据（链接 + 页面最近更新时间） | 未证实 |
| --- | --- | --- |
| RN/Expo SDK | npm `react-native-agora` 最新 **4.6.4**，发布 2026-09-03，MIT，`engines.node >=18`，包内含 `codegenConfig`（声明为新架构生成代码）（[registry](https://registry.npmjs.org/react-native-agora)）；[Expo 集成文档](https://doc.shengwang.cn/doc/rtc/rn/get-started/quick-start-expo) 页面最近更新 **2026-04-29**：需 `expo-dev-client`、`expo prebuild`、`expo-build-properties`，Android `minSdkVersion = 24`，iOS `deploymentTarget 12.4+`，Xcode 14.0 以上，Node.js 18 以上 | RN 版本上限未给；与 RN 0.86.3 / Expo 57 的实测；新架构编译与真机采集 |
| Electron SDK | npm `agora-electron-sdk` 最新稳定 **4.6.2**，发布 2026-03-05（[registry](https://registry.npmjs.org/agora-electron-sdk)）；仓库 [AgoraIO-Extensions/Electron-SDK](https://github.com/AgoraIO-Extensions/Electron-SDK) 未归档，2026-09-24 仍有提交；[Electron 快速开始](https://doc.shengwang.cn/doc/rtc/electron/get-started/quick-start) 页面最近更新 **2026-04-29**，文档声明支持 Electron 5.0.0 及以上（含最新），M1 需 11.0.0 以上，推荐 `prebuilt: true` 规避 Electron/Node 不兼容 | 文档的“含最新”是声明，不是 Electron 44 实测；Node 22 ABI；与既有 Electron 隔离与沙箱配置的配合 |
| 白板 SDK 平台 | [Fastboard 产品概述](https://doc.shengwang.cn/doc/whiteboard/javascript/fastboard-sdk/overview/product-overview) 页面最近更新 **2026-05-09**，平台支持表为 Android 5.0 以上 / iOS 9.0 以上 / Web（Chrome 69+ 完整支持、降级 58+；Safari 16+、降级 11+；Firefox 105+、降级 58+），Web 行标明“浏览器/Webview”；未列 RN 或 Electron 专用 SDK | 可用 WebView 承载或自行桥接原生 SDK，哪条适合 RN/Electron 尚未验证；触摸、手写、多窗口与 iPad 体验未验证 |
| 白板能力边界 | 同上页列出白板录制与回放为“云端高保真信令录制”；[录制与回放](https://doc.shengwang.cn/doc/whiteboard/javascript/fastboard-sdk/advanced-features/record-and-replay) 页面最近更新 **2025-11-18** 明确录制在服务端进行，内容是“信令与数据增量构成的私有二进制数据”，需创建房间时设置 `isRecord: true`，回放依赖 SDK | 私有二进制是否可脱离声网服务解析或迁移；录制数据的保留期与删除方式 |

## 5. C10 本地混合成品的技术路线

C10 要求“有白板时录像以白板为主画面、参与者视频为小画面，包含本地及远端声音”。本轮查阅的 API 未直接证明任一家能在端上一调用生成这种混合成品；不能从公开文档缺项推断其全部 SDK 都没有该能力。

- 腾讯 RN SDK 的 `startLocalRecording` 参数只有 `filePath`、`recordType`（音频/视频/两者）、`interval`、`maxDurationPerFile`（源自官方包 `trtc-react-native@3.3.0` 的 `trtc_cloud_def.d.ts`）；这一接口没有声明白板与远端小画面的合成范围。[Electron API 概览](https://cloud.tencent.com/document/product/647/38551) 同名接口描述为“开启本地媒体录制”。
- 腾讯的服务端成品路线是另一条：[混流录制](https://cloud.tencent.com/document/product/1137/49834)（2025-01-21）需在服务端调用开始录制接口并提供 `MixStream` 与 `Extra.N` 或 `CustomLayout`，需先提交工单开通模板，结果存 COS，混流会额外生成白板、音视频、混流三类视频且各自单独计费；[白板推流观看](https://cloud.tencent.com/document/product/1137/52231)（2025-11-24）给出的推荐录制路径是“白板推流加 TRTC 云端录制”（全局自动录制或指定用户录制），并明确会产生云端录制费用。两条路线都与 C04/C06 的“本地长期保存、默认不录制、家长手动开启”边界不同，需要单独的数据与费用决定。
- 声网端上有 `createMediaRecorder` 与 `startRecording`（[RN 音视频录制 API](https://doc.shengwang.cn/api-ref/rtc/rn/API/toc_recording)），按“本地或远端某个用户的单条流”录制为 MP4，可多次创建对象并行录多路；`startAudioRecording` 只录音频。已查页面未说明把这些流与白板合成为一个成品的端上接口。
- 当前可评估的路线包括自建端上合成层（本地渲染白板主画面加参与者小画面，采集本地与远端音频，自行编码封装）及供应商服务端混流或云录制。后者改变数据与费用边界，需单独决策；是否存在可用的其他端上接口仍须锁版本验证。本轮没有验证任何一条，C10 仍未验证。

## 6. 可编辑白板导出与脱离供应商重开

- 腾讯：官方文档目录（[互动白板文档首页](https://cloud.tencent.com/document/product/1137)）给出的客户端 API 面向 Android、iOS、macOS、Web、小程序、HarmonyOS，未见“导出为可编辑通用格式”或脱离腾讯服务重开的能力说明；[其他功能限制说明](https://cloud.tencent.com/document/product/1137/86844)（2024-08-21）说明课堂内数据会在最后操作后 7 天清理且不可恢复。本轮未取得可编辑导出或自持退出的实证。
- 声网：公开服务端 API 目录（声网 sitemap 中的场景管理条目，例如[场景跳转](https://doc.shengwang.cn/doc/whiteboard/restful/fastboard-sdk/restful-wb/operations/patch-v5-rooms-uuid-scene-state)）包含场景管理与截图接口，[录制与回放](https://doc.shengwang.cn/doc/whiteboard/javascript/fastboard-sdk/advanced-features/record-and-replay) 的回放数据是私有二进制增量。未见“导出为可编辑通用格式”的公开说明，也未见房间数据删除接口；相关操作页正文为客户端渲染，本轮未取到正文，只作为目录级线索，不作为能力证据。
- 结论维持：现有 Node 存档实验与 Excalidraw 本机存档（见[本地交接证据](video-whiteboard-local-2026-09-20.md)、[接入证据](excalidraw-integration-2026-09-20.md)）不能证明供应商侧对象可以导出、再编辑或脱离供应商重开。

## 7. 临时数据留存与删除

- 腾讯（[其他功能限制说明](https://cloud.tencent.com/document/product/1137/86844)，2024-08-21）：课堂内数据以天为单位、默认保存 7 天，以课堂内最后一条操作数据为节点，7 天内无操作即清空且无法恢复；一个房间同时只能发起 1 个课中录制任务，单应用最多 100 个并发录制任务；单房间白板页数上限 2000。未配置自有存储桶时，转码结果在互动白板公共桶保存 7 天、录制视频保存 3 天，官方建议先做[存储桶配置](https://cloud.tencent.com/document/product/1137/45256)以自行管理访问权限与生命周期。
- 声网：本节未取得书面口径。白板的[产品概述](https://doc.shengwang.cn/doc/whiteboard/javascript/fastboard-sdk/overview/product-overview)（2026-05-09）与[基本概念](https://doc.shengwang.cn/doc/whiteboard/javascript/fastboard-sdk/overview/concepts)都没有给出房间信令或录制数据的保留期限与删除方式，公开服务端 API 目录也未列出房间数据删除接口。不能把 RTC 的媒体传输口径外推为白板零留存。
- 题图分发沿用 2026-09-20 结论：腾讯涉及 COS（需区分自行配置与默认公共桶），声网使用客户端可访问的图片 URL，存储、临时授权与删除都需本项目自行解决，不能宣称题图只在本机。
- 两家均未在本轮验证删除接口的实际行为、生效时延或残留副本。

## 8. 许可

- 包级许可：`trtc-react-native` 3.3.0、`trtc-electron-sdk` 13.3.801、`react-native-agora` 4.6.4、`agora-electron-sdk` 4.6.2 在 npm 元数据中分别标注 MIT 或 ISC。
- 腾讯额外要求：互动白板 SDK 下载页明示需按《互动白板 SDK 合规使用指南》使用并做第三方 SDK 信息标注（名称、版本、提供方、使用目的、处理的个人信息类型、权限、隐私政策链接）；该合规披露义务属于本项目发布前必须落实的事项。
- 商业服务条款（数据用途、地域、SLA、终止后的数据处置、二次分发限制）两家都未逐项审查。

## 9. 公开价格与试用、免费额度（刊例，不是报价，也不是开通授权）

腾讯互动白板（[产品定价](https://cloud.tencent.com/document/product/1137/46355)，2024-09-09；[免费试用](https://cloud.tencent.com/document/product/1137/46356)，2024-09-09）：

- 月功能费 1000 元/月，一个账号一份，月内赠送白板使用时长 10000 分钟、课中录制 1000 分钟、文档转码 15000 页。
- 超出后按量：白板使用时长 5 元/千分钟、静态转码 2 元/千页（动态转码按静态 8 倍计）、课中录制时长 10 元/千分钟。
- 新用户 15 天不限量试用（白板 SDK 时长、文档转码、实时录制），但使用 COS 存储可能另产生对象存储费用。
- 音视频另按腾讯 RTC 时长计费，与本页白板费用叠加。

声网互动白板（[计费说明](https://doc.shengwang.cn/doc/whiteboard/android/whiteboard-sdk/overview/billing)，页面最近更新 2026-05-09）：

- 互动白板 9.6 元/千分钟，每月前 10000 分钟免费；白板录制 12 元/千分钟，每月前 1000 分钟免费；文档转换 3 元/千页（网页按 5 张图片折算），每月前 1000 张图片免费；也可按 QPS 600 元/QPS/月 单独计费且与标准计费互斥。
- RTC 侧另有套餐：[计费策略](https://doc.shengwang.cn/doc/rtc/rn/billing/billing-strategy)（2026-06-04）说明未购买套餐包时默认赠送免费版（1 万分钟/月），购买任意套餐包后不再享受该赠送额度。
- 白板用量按房间内所有用户时长之和计算；签约价格以合同为准。

未验证：两家账户的实际可用额度、地域可用性、账户是否仍享新用户试用、五设备场景下的月总价与硬限额。原账号、邮件、同步的 200 元月预算不是本次 RTC/白板采购授权。

## 10. 与 C12 对照的三条待验证路线

现有 [C12 决定](../../openspec/changes/add-family-video-whiteboard/proposal.md)要求保留 `@excalidraw/excalidraw` 作为移动和桌面的共同编辑层；当前 [编辑器实现](../../packages/whiteboard/src/Editor.tsx)确实以 Excalidraw 元素、附件与页面存档。腾讯 TIW 和声网 Fastboard 各有白板文档模型，本轮官方资料未证明它们能无损承载、回传或脱离供应商重开现有 Excalidraw 作品。因此下列 A/B 只可作为 RTC 加供应商白板的待验证路线，**不能直接替换 C12 编辑层**。这项兼容门槛先于选型，不能仅凭白板 SDK 能画线就通过。

三条路线都只覆盖“RTC 加协作白板加 C10 录制”的技术骨架，不包含选厂商的最终决定，也不包含采购、开通或外发。

**方案 A｜腾讯 TRTC 加 TIW，自建端上合成（自持路线）**

- 组合：`trtc-react-native@3.3.0`（移动）加 `trtc-electron-sdk@13.3.801`（桌面）加 TIW 以原生视图桥接或 WebView 承载；端上自建合成层负责白板主画面、参与者小画面、本地与远端声音。
- 优点：录制成品只落在用户设备，最贴近 C04/C06/C08；腾讯侧留存口径明确（课堂数据 7 天清理、公共桶 3 天与 7 天），可配置自有 COS 自行控制生命周期。
- 代价：白板没有 RN 或 Electron SDK，桥接工作量与风险最高；端上合成需自行处理编码、音画同步、前后台中断与电量；RN 包无新架构声明，Electron 包 peer 只写 `electron >=4.0.0`，与 RN 0.86、Electron 44 的兼容必须先锁版本构建验证。

**方案 B｜声网 RTC 加 Fastboard，WebView 白板加自建端上合成**

- 组合：`react-native-agora@4.6.4`（有官方 Expo 集成文档与 `expo-dev-client`、`expo prebuild` 路径）加 `agora-electron-sdk@4.6.2` 加 Fastboard 经 WebView 嵌入；录制仍走自建端上合成。
- 优点：RN 与 Expo 接入路径官方文档化程度最高，新架构代码生成已在包内声明；白板平台表明确 WebView 属支持范围；端上合成同样满足本地留存方向。
- 代价：白板数据留存与删除口径未取得，“脱离供应商重开”证据最少；WebView 内的触摸、手写、多窗口与 iPad 体验需真机验证；端上合成成本与方案 A 同级。

**方案 C｜国内 RTC 加现有 Excalidraw，自持授权协作与端上合成**

- 组合：RTC 只负责媒体，继续使用现有 Excalidraw 编辑器及本机可编辑格式；由思玥服务端为已授权房间同步操作、附件和恢复快照。Excalidraw 上游提供 [示例协作服务](https://github.com/excalidraw/excalidraw-room/blob/master/README.md)及 [应用层协作实现](https://github.com/excalidraw/excalidraw/blob/master/excalidraw-app/collab/Collab.tsx)，但本工程使用的 npm 编辑器不会自动获得这套房间权限、持久化或故障恢复。这是依据上游代码和当前工程作出的架构推论，尚未实测。
- 优点：最直接遵守 C12，可编辑作品无需映射成供应商白板格式；题图和长期存档的控制边界可由思玥自己设计。RTC 厂商仍须另选和验证。
- 代价：可信邀请、对象操作顺序/冲突、晚加入快照、附件分发、断线重连及临时数据删除均由本项目负责；不能把上游示例服务当成已可用的家庭协作产品。端上合成同样未验证。

三条路线都未解决 C10：端上合成是本轮已识别、可在不引入服务端录制前提下验证的路线；服务端混流或云录制（腾讯混流录制或白板推流加云录制、声网云端录制）需要重新决策，因为它会同时改变数据边界和费用结构。

## 11. 需要维护者选择或授权的事项

1. C12 协作编辑路线：优先验证现有 Excalidraw 加自持操作同步，还是评估 TIW/Fastboard 与 Excalidraw 作品的无损桥接；不能把改用厂商编辑器当作已授权。
2. C10 落地方式：自建端上合成，还是接受服务端混流或云录制（后者改变“本地长期保存、默认不录制”的边界，并引入新的数据外发与费用）。
3. 若走厂商白板，是否允许白板房间数据在供应商侧短期留存及其上限，以及是否配置自有对象存储（腾讯 COS 配置项与费用）。
4. O06 的数据处理授权：服务地域、每类数据的留存与删除要求、访问授权，以及可核查的删除证据要求。
5. 预算与额度：腾讯月功能费 1000 元/月与 RTC 叠加、声网白板与 RTC 计费档位，以及是否使用试用或免费额度做验证。
6. 合规披露：按腾讯《互动白板 SDK 合规使用指南》补齐第三方 SDK 标注与隐私政策内容；声网侧的对应义务需在选型后单独核对。
7. 平台验证矩阵：RN 0.86.3 与 Expo 57、Electron 44 的实际构建兼容，以及 WebView 白板在 iPhone、iPad、Android 上的触摸与手写是否可接受。

## 12. 明确无法证明的缺口（本轮）

- 两家 SDK 与本工程 RN 0.86.3、Expo 57、Electron 44 的实际兼容（含新架构、原生模块 ABI、Expo prebuild 出包），未安装依赖、未构建。
- C10 端上混合成品的可行性、性能与音画同步，无原型、无合成媒体验证。
- 可编辑白板导出与脱离供应商重开，两家官方文档均未给出可引用的能力说明，腾讯无实证，声网仅有目录级线索。
- 声网白板数据的保留期限、主动删除方式与删除证据；腾讯删除接口的实际生效行为。
- 账户真实可用额度、地域可用性、合同价格、SLA 与商业条款。
- 真实设备、真实网络、五设备房间、录制告知与权限流程，全部未开始。

## 13. 下一步（保持未完成）

1. 维护者在第 11 节选择后，再锁定候选 SDK 版本并做锁版本构建兼容验证，先本地、无外部副作用。
2. 用合成媒体验证 C10 端上合成原型，区分纯本地能力验证与需要供应商测试资源的联调。
3. 用可编辑对象与合成题图验证导出、再次编辑、供应商不可达时的退出路径；现有 Node 与 Excalidraw 存档不能替代该验证。
4. 明确服务地域、每类数据留存与删除、访问授权、预算与限额后再申请真实资源，进入 2.2 与 2.5。

本文件只完成文档复核。tasks 2.1 保持未勾选，O06 不关闭；未提及的旧结论不因本轮而改变。
