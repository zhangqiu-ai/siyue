# 账号、邮件与同步预算初筛 · 2026-09-09

状态：官方资料初筛与预算情景计算，非供应商批准、报价或部署验收。目标版本0.0.1，关联[活动提案](../../openspec/changes/add-account-family-spaces/proposal.md)及[验证计划](../../openspec/changes/add-account-family-spaces/validation-plan.md)。维护者允许首版统一海外存储，先验证大陆访问；账号、邮件和同步合计每月不超过人民币200元。具体地域、服务和测试资源尚未决定。

## 结论

现有 Supabase + PowerSync 候选可以继续验证，但不能直接按“双付费托管”落地。两项基础订阅合计74美元/月，未含邮件、业务API、备份额外存储和税费。免费托管组合有低成本验证价值，但休眠、容量、投递和恢复边界必须验收；不能因费用为零就宣称适合首版稳定交付。自托管也尚未证明完整月账单和运维能力符合预算。

本报告不改变技术选型。下一步是先完成本地合成数据验证，再对具体、可审阅的测试资源清单请求外部操作授权；不先注册服务或发测试邮件。

## 官方费用与约束

以下均于2026-09-09查阅；实际开通前须复核价格和账单设置。

| 服务 | 已核实事实 | 初筛影响 |
|---|---|---|
| Supabase Free | 0美元/月，数据库500MB，5GB出站流量；闲置一周暂停，免费档无自动备份 | 可作小规模验证候选，须独立验证备份和唤醒，不把50,000 MAU额度当可用性承诺。[官方价格](https://supabase.com/pricing) |
| Supabase Pro | 起价25美元/月；包含首个Micro项目，额外项目另计；每日备份保留7天 | 首个项目不是25+10美元重复相加。单独它已占预算大部，不能忽略业务API、同步和邮件成本。[官方价格](https://supabase.com/pricing) |
| PowerSync Cloud Free | 0美元/月，2GB/月同步量、500MB托管数据、50峰值并发客户端，闲置一周停用 | 并发按客户端而非家庭人数估算；手机、平板、桌面可能同时连接。[官方价格](https://powersync.com/pricing) |
| PowerSync Cloud Pro | 起价49美元/月，30GB/月同步量、10GB托管数据、1,000峰值并发客户端 | 与Supabase Pro叠加后无法作为200元上限内的默认方案。[官方价格](https://powersync.com/pricing) |
| Resend Free / Pro | Free为3,000封/月且100封/日；Pro为20美元/月含50,000封/月，无每日发送上限，另有超量计费 | OTP重发和邀请邮件同样占用发送量，日限不能按月均摊消除。发件域名及实际投递必须单独验证。[官方价格](https://resend.com/pricing) |
| 完整Supabase自托管 | 官方给出最低4GB RAM、2核、40GB SSD，推荐8GB+、4核+、80GB+ | 不能用未经压测的廉价小主机报价代表完整组合；还需PowerSync、API、备份资源及运维。[官方Docker要求](https://supabase.com/docs/guides/self-hosting/docker) |

PowerSync同步量、Supabase出站流量与数据库容量是不同计量项，不合并成一个“流量”。客户端重建/重同步须纳入容量测量。Supabase默认测试SMTP不能作为面向家庭成员的生产发信链路，见[前期接口资料](account-sync-options-2026-09-08.md)。

## 可复算预算情景

为显示余量，**仅取7.5元/美元作为预算压力情景，不是查询到的实时汇率或支付报价**。付款费率、税费、域名年费摊销、业务API和备份记为额外成本E；E未知不能填0。

`月总成本 = 基础美元订阅 × 7.5 + E`，需满足`月总成本 ≤ 200`。

| 组合 | 基础订阅 | 情景人民币 | 留给E的空间 | 当前判断 |
|---|---:|---:|---:|---|
| Supabase Free + PowerSync Free + Resend Free | $0 | ¥0 | ¥200 | 仅候选验证档；休眠/恢复和容量门槛未通过 |
| Supabase Pro + PowerSync Free + Resend Free | $25 | ¥187.50 | ¥12.50 | 余量很小，尚不能证明完整费用可控 |
| Supabase Pro + PowerSync Pro + Resend Free | $74 | ¥555 | -¥355 | 在该情景下超限，不作为默认首版组合 |
| Supabase Pro + PowerSync Free + Resend Pro | $45 | ¥337.50 | -¥137.50 | 在该情景下超限 |
| 海外自托管 + SMTP | 未报价 | 未知 | 未知 | 暂不宣称可满足200元；需要符合资源要求的具体报价与恢复验证 |

不得把Supabase Spend Cap、PowerSync套餐额度或邮件日限视为跨厂商人民币200元的统一硬停机保护。具体账单上限/超量/停用行为需逐服务核对后设计；没有授权自动升档。可以先用合成负载记录每次增量与全量同步字节数、连接峰值、OTP/邀请日峰值，再决定免费档是否适合实际家庭规模。

## 许可与退出边界

PowerSync客户端SDK是Apache 2.0；Open Edition服务端是FSL-1.1-ALv2源码可用，含竞争用途限制，各版本公布满两年后另获Apache 2.0授权。不能以SDK许可推导服务端全部无条件开源。实际引入时必须固定版本并保存相应LICENSE，本文不作法律适用保证。[官方许可](https://powersync.com/legal/licensing-terms)、[服务端LICENSE](https://github.com/powersync-ja/powersync-service/blob/main/service/LICENSE)

Supabase可导出`auth.users`和`auth.identities`；完整数据库恢复与CSV账号名单不同。迁往自托管须另配置SMTP、JWT/API密钥等，Storage对象另迁；签名密钥改变意味着现有会话需重新登录。业务空间、授权和账号UUID关联必须同时核对，不能承诺访问令牌无缝迁移。[账号导出](https://supabase.com/docs/guides/auth/managing-user-data)、[平台备份恢复](https://supabase.com/docs/guides/self-hosting/restore-from-platform)

PowerSync同源数据库、基本配置和规则下更换端点仍要求客户端重新同步；它不证明脱离该引擎的通用迁出能力。服务替换需单独验证客户端队列、撤权、删除标记与幂等回执。[官方实例迁移](https://docs.powersync.com/maintenance-ops/self-hosting/migrating-instances)

## 尚需真实证据

1. 固定待测版本、完整资源与地域清单、退出路径和账单余量；东京仍只是原候选共同地域，不是已选定。
2. 合成账号/空间/共享授权的数据库备份恢复；核对UUID、版本、删除标记、回执，换签名密钥后旧令牌拒绝、新OTP可登录。
3. iPhone/iPad与Electron同步适配、离线24小时锁定、旧请求/旧队列隔离，不能用普通JS时钟实验替代原生保证。
4. 获具体测试资源授权后，分别在大陆与海外实际网络验证DNS/TLS、邮件投递、会话刷新、同步与重连；本机访问官网不计产品网络验收。
5. 用户删除、备份保留、监护变更等待决政策确认后再完成对应正式路径；不得为适应免费档擅自降低既定隐私或离线要求。

此次只研究公开资料和计算费用情景，没有注册、购买、部署、发信、安装依赖或操作个人数据。OpenSpec任务1.3仍未完成：许可与费用初筛已有依据，完整资源报价、实际版本和PoC结果尚缺；2.3不因本报告自动批准实施方案。
