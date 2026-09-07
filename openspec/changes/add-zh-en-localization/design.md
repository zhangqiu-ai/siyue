## Context and scope
当前移动设置已经包含AI服务、外观和本机信息；新增同级语言行。桌面暂无设置页面，增加齿轮入口与轻量设置dialog，仅包含语言，不改变目标工作台导航。

## Low-cost interaction prototype
移动：设置 → 语言 → [简体中文 ✓] [English]（同一页面内的两项选择，大字允许上下排列）。
桌面：工作台齿轮 → 设置dialog → Language [简体中文 / English] → Close；Escape关闭并恢复触发焦点。
选择立即更新可见UI，控件显示语言自身名称以方便恢复；切换不执行AI请求，不提交/清空编辑表单。
已有视觉方向的M级组件扩展；此文字结构明确唯一新增入口，不重做整套页面设计。

## Decisions
使用各应用资源catalog与小型React context；领域层不依赖语言资源。默认zh-CN，支持en；存储键siyue.locale。移动使用已安装expo-sqlite/kv-store，桌面renderer使用localStorage（仅非敏感外观偏好）；写失败保持当前运行选择并本地化告知，不能宣称下次启动已保存。

业务状态保存语义key/参数或原始安全错误，渲染时按当前locale转换，以保证切换时已有状态也更新。已知安全错误双语映射，未知错误回退可恢复通用提示，不把堆栈/密钥给UI。原有业务生成内容不自动改写。

## Validation and risks
类型/资源完整性、未知语言回退/存储失败测试；中文既有测试及英文Electron闭环；iPhone/iPad中文英文设置/聊天/表单检查，旋转或语言切换保持输入。Android打包；原生、真机和完整辅助技术矩阵分别如实记录。无数据schema变化、迁移或远端操作，回滚UI不会修改正式记录。
