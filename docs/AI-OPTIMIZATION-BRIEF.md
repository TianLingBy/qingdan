# 轻单仓库：智能体代码优化任务书

## 使用说明

将本文档完整交给执行优化的智能体。智能体必须先阅读仓库现状和本文件，再分阶段实施；未经用户确认，不得擅自扩大范围。

## 任务目标

在不改变现有业务口径、接口契约、权限模型、数据隔离和用户可见行为的前提下，提升轻单仓库的代码质量、可维护性、性能和工程门禁质量。

优化原则：

1. 正确性、安全性和可调试性优先。
2. 先遵循仓库已有约定，再引入通用模式。
3. 优先修复有证据的问题，不做纯风格偏好的大规模重构。
4. 保持最小完整改动；不得为了“看起来规范”新增无实际收益的抽象层。
5. 所有结论必须有文件、行号、测试结果或构建结果支持。

## 仓库基线

- 技术栈：Node 24、TypeScript、pnpm workspace、Fastify 5、Drizzle、PostgreSQL 18、React 19、Vite、Vitest。
- 契约真源：`packages/contracts`；OpenAPI 文档由 `pnpm openapi` 生成，禁止手改生成文件。
- 模块边界：业务模块之间通过 `apps/api/src/platform/services/registry.ts` 的端口通信，禁止直接 import 对方 repo/schema 或直读对方业务表。
- 测试入口：`tests/run.ps1`；提交前必须通过构建和测试。
- 重要安全约束：多租户隔离、RLS、审计 outbox、幂等、乐观锁、金额 decimal 字符串纪律不得削弱。
- 当前分支：`feat/settlement-profit-aggregate`。
- 当前未提交状态中已有 `.codex/` 未跟踪目录，除非用户明确要求，不要删除或修改它。

## 已知基线结果

最近一次只读评估结果：

- 全量 workspace build：通过。
- 全量测试：通过；API 为 60 个测试文件、412 个测试全部通过。
- 利润聚合定向测试：5/5 通过。
- TypeScript typecheck：通过。
- ESLint：失败，存在仓库既有错误和警告；不能把它们误认为本次利润聚合改动引入的问题。
- Web 构建产物主 JS 约 813 kB，Vite 报超过 600 kB 的 chunk 警告。

## 优化范围与优先级

### 阶段一：修复 ESLint 门禁问题（P1）

先定位并修复现有 error，再处理 warning。重点文件：

- `apps/api/src/modules/payment/services/alipay-signature.ts`
- `apps/api/src/modules/payment/services/wechat-signature.ts`
- `apps/api/src/platform/db/db-concurrency.integration.ts`
- `apps/api/src/platform/db/migrate.ts`
- `tools/spike-0001-pipeline.mjs`

要求：

- 不得通过关闭规则、扩大 ignore 范围或降低 lint 严格度来“修复”。
- `catch` 重新抛错时保留原始 `cause`。
- 删除真正无用变量；如果变量是故意保留，使用仓库约定的命名或最小注释说明原因。
- 修复后运行 `pnpm lint`，并记录剩余 warning。

### 阶段二：显式建模结算确认时间（P2，需谨慎）

当前 `apps/api/src/modules/settlement/services/profit-aggregate.ts` 使用 `settlement_order.updated_at` 推断结算确认时间；数据库触发器会在任何更新时刷新 `updated_at`。

建议方案：

1. 新增 `settled_at` 或 `confirmed_at` 字段，允许待确认状态为空。
2. 在确认结算的原子 UPDATE 中写入该字段。
3. 利润聚合改用该字段筛选期间。
4. 增加迁移、类型、查询、测试和必要的 OpenAPI/文档更新。
5. 评估历史已结算数据的回填策略；不能凭空猜测历史确认时间。若无法安全回填，必须先报告阻塞点，不得静默填充。
6. 为“确认后其他字段更新不会改变报表归属期间”增加回归测试。

如果当前业务尚未批准新增字段，先只提交设计方案和迁移风险，不要直接改数据库。

### 阶段三：优化利润聚合查询（P2）

当前查询对时间列使用 `(updated_at AT TIME ZONE ...)::date`。在明确时间字段后：

- 将本地日期转换为 UTC 的半开区间 `[start, end)`，避免对列做函数转换。
- 根据实际查询条件评估索引：租户、公司、状态、确认时间。
- 保持金额使用 PostgreSQL numeric 和 decimal 字符串，禁止改成 JavaScript number 计算。
- 保持空公司集合返回 0、空结果返回 0、跨租户和跨公司隔离。
- 增加边界测试：起始瞬间、结束日最后一刻、时区跨日、空集合、负毛利和多租户。

### 阶段四：Web 首包拆分（P2）

在不改变路由行为的前提下，分析 `apps/web` 的入口和路由，优先对低频页面使用动态加载。要求：

- 先确认实际 bundle 来源，再决定拆分点，不要盲目加入依赖。
- 登录、主工作台等高频路径不能因拆分明显变慢。
- 保留加载态和错误态。
- 运行 Web 测试和生产构建，记录构建前后主要 chunk 大小。
- 不要仅通过调高 `chunkSizeWarningLimit` 隐藏问题，除非有明确理由并记录。

### 阶段五：测试执行效率（P3）

只在前面阶段完成后评估。可以考虑测试分组、数据库初始化复用和 CI 并行，但必须保持测试隔离和确定性。不得通过减少测试、跳过测试或放宽断言来缩短时间。

## 必须遵守的安全与业务约束

- 不得关闭或绕过 ESLint、TypeScript strict、RLS、审计、幂等或版本校验。
- 不得把金额、数量、比例转换成 JavaScript 浮点数参与业务计算。
- 不得让业务模块直接访问其他业务模块的表或实现。
- 不得改变既有 HTTP 错误码、CLI 退出码、OpenAPI 契约或用户权限。
- 不得删除测试、迁移、文档、CI 检查或已有失败证据。
- 不得修改用户已有未提交改动；开始前和结束后都要检查 `git status`。
- 不得执行 `git reset --hard`、`git checkout --`、批量删除或覆盖不相关文件。
- 不得把 token、密码、Cookie 或数据库连接串写入日志、错误信息、测试快照或文档。

## 推荐执行流程

1. 阅读 `README.md`、`.github/copilot-instructions.md`、`docs/DEV-SETUP.md`、`docs/adr-0001-tech-stack.md` 和相关模块文档。
2. 运行 `git status --short --branch`，记录基线。
3. 针对每个阶段先搜索调用方、迁移、测试和配置，再写代码。
4. 每个阶段单独修改、测试和总结，不要把多个阶段混成一个不可审查的大 diff。
5. 运行与改动范围匹配的定向测试，再运行完整构建、完整测试和 lint。
6. 检查 `git diff --check`、`git diff --stat`、`git status`。
7. 输出逐项报告：改了什么、为什么改、验证命令和结果、剩余风险、未处理事项。

## 验收门槛

优化完成前必须满足：

- `pnpm -r build` 通过。
- `pnpm test` 通过。
- `pnpm lint` 通过；若仍有 warning，必须逐项解释。
- 相关定向测试通过。
- 数据库迁移可重复执行且不会破坏现有数据。
- OpenAPI 或契约有变化时，已运行 `pnpm openapi` 并检查生成文件漂移。
- 没有跨模块越界 import。
- 没有未解释的行为变化、性能回退或安全回退。

## 输出格式

请按以下结构回复：

```text
## 结果
一句话说明本轮是否完成，以及是否修改了代码。

## 修改清单
- 文件：行号范围
- 修改内容
- 修改原因

## 验证结果
- 命令：结果

## 风险与未完成事项
- 风险、阻塞点或需要用户决策的事项

## 下一步建议
- 只列出经过证据支持的下一步
```

如果发现新增数据库字段、改变业务口径、改变接口契约或需要删除数据，必须先停止该部分并请求用户确认。
