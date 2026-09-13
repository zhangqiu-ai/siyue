# 草稿冲突后重新读取：原生验证

2026-09-13，工作树未提交。设备为隔离测试 iPad `42C82E31-F592-4C74-99BF-3579F5DD674F` / iOS26.5，当前 Metro JS。启动前无已启动模拟器，8081无监听；启动此设备与 `corepack pnpm --filter @siyue/mobile exec expo start --localhost --port 8081`，没有重启存活进程。

只在已核实的隔离容器内，通过正式领域服务/LocalClient创建合成草稿，不直接改JSON、版本或审批数据。辅助驱动保存于 `isolated-driver.mjs`（硬编码本次隔离设备与容器，不用于生产或其他设备）。旧9月10日草稿已过期，不修改过期时间，创建新合成目标 `QA conflict refresh Sep13`。

## 操作与结果

1. 驱动create生成草稿 `ae1c0549-e093-4d22-a282-267125b38df5`，版本1；原生页面加载，项目为QA conflict project。
2. 驱动edit通过正式editDraft更新为版本2、QA version 2；原生页面仍持有版本1。点击Confirm and save plan，出现版本变化提示及QA version 2预览，确认/拒绝禁用，保留原输入。
3. 再次editDraft产生版本3、QA version 3。原生点击Reload后，AX显示项目QA version 3、旧冲突卡消失、确认和拒绝均恢复可用。
4. 点击Confirm and save plan，界面显示Plan saved on this device。sqlite3只读核对：指定draft为applied，保存的项目标题QA version 3；对应目标恰好1个、该项目恰好1个。

结论：此前 `plan-draft-screen.tsx` 清除过时latest快照的修复，在本次真实原生冲突→刷新→确认流程通过。辅助进程模拟另一写入者，不是实际云同步或另一设备。

截图检查发现模拟器外壳横向、内容旋转90度，未据此声称横屏视觉验收；本次结论限AX可操作状态及SQLite结果。未执行新的生产代码修改，无需重复全仓测试。完整横竖屏视觉矩阵仍待核查。

## 同日方向异常复核

后续通过模拟器Rotate操作切到竖屏，保存成功页文字与外壳方向一致；返回个人空间，进入QA conflict refresh Sep13详情，再Rotate至横屏，CUA实际截图显示正常横屏双栏。点击任务编辑，页面仅有Cancel / Edit task / Save，无侧栏菜单；未修改时Save禁用。点Cancel返回同一目标详情，任务内容保持不变。

结论：此前内容90度异常在旋转后消失，未证明是应用布局缺陷，因此未改生产代码。已取得此英文暗色设备的详情横屏和编辑/取消代表证据；不外推至其他语言、主题或完整尺寸矩阵。此前异常原始记录保留。

## 过期草稿入口修正

观察到9月10日已过期草稿仍位于“Drafts to review”，入口未提示过期。本次局部展示修正：列表改称“草稿 / Drafts”，按状态或expiresAt显示既有双语过期提示；保留查看入口。页面聚焦期间刷新时间判断，失焦清理定时器；不改变领域审批、有效期或正式数据。

原生iPad AX实测：列表出现`QA conflict refresh, Draft expired`；进入后标题Draft expired，说明不可编辑/确认，字段只读且无确认按钮。`corepack pnpm --filter @siyue/mobile typecheck`通过。中文文案来自既有draft.expired资源，中文原生画面本步未重测。简化路径：纠正误导性状态展示，未新增权限或改变过期语义。
