# 视频白板服务官方资料初筛（2026-09-20）

关联 [tasks 2.1 / O06](../../openspec/changes/add-family-video-whiteboard/tasks.md)、[设计](../../openspec/changes/add-family-video-whiteboard/design.md)、SY-022。状态：**部分完成**。未选供应商、未接 SDK、未开通资源、未上传题图或音视频；公开资料不能证明当前工程兼容、真实网络、账户额度或五设备验收。

## 工程与核查边界

当前工程为 Expo 57.0.20、React Native 0.86.3、Electron 44.2.0，版本来自应用 package.json；本轮未安装 RTC/白板依赖。子代理用浏览器查阅公开官方文档，主代理复核关键录制、留存和费用结论。初稿把已查服务端录制概括为“只有服务端录制”，已依据下列客户端官方接口纠正。

## 可证实能力与缺口

| 项目 | 腾讯 TRTC / 互动白板 | 声网 RTC / 互动白板 |
|---|---|---|
| RN / Electron | 有 [RN API](https://cloud.tencent.com/document/product/647/63792) 和 [Electron API](https://cloud.tencent.com/document/product/647/38551)。旧目录不能证明当前 RN/Expo/Electron 版本兼容，须锁版本构建验证 | 有 [RN 快速开始](https://doc.shengwang.cn/doc/rtc/rn/get-started/quick-start) 和 [Electron 文档](https://doc.shengwang.cn/doc/rtc/electron/landing-page)。RN 最低要求不是 RN 0.86 / Expo 57 兼容实证 |
| 白板接入 | [文档目录](https://cloud.tencent.com/document/product/1137) 提供原生及 Web SDK；已查目录未见专门 RN/Electron 入口，桥接方式待验证 | [Fastboard 文档](https://doc.shengwang.cn/doc/whiteboard/javascript/fastboard-sdk/landing-page) 有 Web/JS，另有原生端；已查目录未见专门 RN/Electron 入口，不等于无法桥接 |
| 端上录制 | 原生 [TRTCCloud](https://cloud.tencent.com/document/product/647/79620) 和 [API 概览](https://cloud.tencent.com/document/product/647/32258) 有 `startLocalRecording`；不能仅因旧 RN 概览缺项推断端上没有录制。RN 封装暴露范围、实际采集范围及 C10 成品链路待验证 | [RN 音视频录制](https://doc.shengwang.cn/api-ref/rtc/rn/API/toc_recording) 有 `createMediaRecorder` / `startRecording`，按流创建对象，可指定本地或远端用户。[RN 总览](https://doc.shengwang.cn/api-ref/rtc/rn/API/rtc_api_overview) 另列 `startLocalVideoTranscoder`；平台限制、与录制的衔接及白板采集仍待验证 |
| 云端/服务端录制 | [互动白板混流录制](https://cloud.tencent.com/document/product/1137/49834) 为服务端能力；不符合把录像文件只长期保存在用户设备的简单端上路径 | [白板录制](https://doc.shengwang.cn/doc/whiteboard/javascript/fastboard-sdk/advanced-features/record-and-replay) 记录白板信令；[云录制概念](https://doc.shengwang.cn/doc/cloud-recording/restful/overview/concepts) 描述云录制机器人与第三方存储。不能把该云录制页面当作所有本地服务端/客户端录制的说明 |
| 可编辑本地保存和退出 | 未取得完整白板对象、题图与页面可编辑导出及脱离供应商重开的实证；不能用视频或转码图片代替 | 未取得完整可编辑导出及脱离供应商重开的实证；信令回放与可迁移文档是不同能力 |
| 题图分发 | [存储配置](https://cloud.tencent.com/document/product/1137/45256) 涉及 COS；必须区分自行配置与默认公共桶。题图临时 URL 的到期/撤销与实际访问验证未做 | [图片与媒体](https://doc.shengwang.cn/doc/whiteboard/javascript/fastboard-sdk/basic-features/present-files-fb) 使用客户端可访问的图片 URL；需单独解决存储、临时授权和删除，不能宣称题图只在本机 |
| 服务留存 | [其他功能限制](https://cloud.tencent.com/document/product/1137/86844) 的官方搜索索引说明：课堂数据在最后操作后的七天无操作时清理；未配置自有桶时，公共桶转码结果七天、视频三天。主代理直开该页失败，此处为索引证据，正式选型前需完整复核及验证删除接口 | 白板房间、转换中间产物、日志的完整保留与主动删除口径未取得；RTC 媒体传输口径不得外推为白板零留存 |
| 许可 | 客户端封装、白板依赖及商业服务条款未逐项完成审查 | 客户端封装、白板依赖及商业服务条款未逐项完成审查 |

**C10 完整成品仍未验证**：白板主画面＋参与者小画面＋本地和远端声音；没有白板时多人视频及声音。已存在端上录制/合图接口，是后续验证入口，不等于该成品已经可用，也不能由文档缺项得出不可实现。

## 费用口径（公开刊例，不是报价或开通授权）

- 腾讯 [TIW 定价](https://cloud.tencent.com/document/product/1137/46355)（页面更新时间 2024-09-09；本轮再次读取）列出 1000 元/月功能费、相应赠送额度及超额按量计费。这个固定成本需纳入候选比较，不能只列 5 元/千分钟的超额白板单价。
- 声网 [白板计费](https://doc.shengwang.cn/doc/whiteboard/javascript/fastboard-sdk/overview/billing)（页面更新时间 2024-08-30；本轮再次读取）列出白板 9.6 元/千分钟、每月前 10000 分钟免费；白板录制与转换独立计费，合同价格可能不同。
- 音视频另按各自的 [腾讯 RTC 时长计费](https://cloud.tencent.com/document/product/647/44248)、[声网 RTC 计费](https://doc.shengwang.cn/doc/rtc/rn/billing/billing-strategy) 计算；五设备使用量不能当成一台设备的房间分钟数。还需根据所选计费定义核算分辨率/订阅量、会话时长、存储分发、控制服务和可能的录制成本。
- 未验证账户当前免费额度、月总价或硬限额。原账号/邮件/同步的 200 元月预算不是本次 RTC/白板采购授权。云录制、本地服务端录制与客户端录制的费用不能混用。

## 下一步可执行项与仍需决策的内容

1. 以 C10 为输入验证端上合成方案，先使用合成媒体；区分无网络本地能力验证与需要供应商测试资源的联调。无外部副作用的能力验证不被 O06 全部阻塞。
2. 锁定候选 SDK 版本，验证 RN/Expo 原生桥接、Electron 隔离与构建；核对许可、当前版本、已知平台限制后再引入依赖。
3. 用可编辑对象与合成题图验证导出、再次编辑、供应商不可达时的退出路径；现有 Node 存档实验不证明供应商能导出这些对象。
4. 明确服务地域、每类数据的临时留存/删除、访问授权、预算与限额，供维护者做 O06 决策；随后才创建或使用获准资源进行真实设备联调。

本文件只完成文档初筛。tasks 2.1 不勾选完成，O06 不关闭；2.2/2.5/V15 不据此提升为通过。
