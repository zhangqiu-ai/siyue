# 账号基础改动跨包整合检查

范围：0.0.1 当前未提交工作树。覆盖新增家庭权限契约/领域内核、会话入口与并发保护及其现有消费者；不代表账号服务或跨设备同步完成。

仓库根目录实际执行：

- `corepack pnpm typecheck`：11/11 Turbo任务成功，0缓存（包括依赖构建），覆盖所有现有包和三端应用的类型检查。日志 `/tmp/siyue-account-integration-typecheck.log`。
- `corepack pnpm test`：11/11 Turbo任务成功，4缓存。输出报告contracts10、domain49、ai9、adapters50、mobile110、desktop14、server23项，共265项通过；进一步核对cache行：7个test任务均为cache miss并重新执行，4个缓存仅为依赖build任务。日志 `/tmp/siyue-account-integration-tests.log`。
- `corepack pnpm release:check`：版本记录检查通过，不表示发布验收。

未执行生产部署、发布构建或真机测试。Supabase测试项目/测试邮件仍待外部授权。已有iPhone/iPad代表原生证据不覆盖全语言/主题/尺寸/故障矩阵，尚未完成的Figma创建/异常页面及冲突原生注入仍需继续。
