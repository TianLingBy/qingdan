# 轻单 · 协作者说明（Copilot）

- 技术栈：TypeScript 全栈（Node 24 + Fastify 5 + Drizzle + PostgreSQL 18 + React 19/Vite + pnpm 11）。
- 接口唯一真源：`packages/contracts` 的 Zod 注册表；`docs/api/openapi.yaml` 由 `pnpm openapi` 生成，不要手改。
- 模块边界：业务模块之间只走服务层函数或只读视图，禁止直接 import 对方实现、禁止直读对方数据表（`eslint.config.js` 里有机械约束）。
- 提交前必须：`pnpm -r build`、`pwsh -NoProfile -File tests\run.ps1` 全绿；契约有改动需重生成 OpenAPI。
- 写 `.ps1` 时保持 UTF-8 BOM；`tools/pre-commit` 必须是 LF。
- 业务口径与内部文档不在本仓；需求不明确时先问，不要猜着实现。

## 硬规则（2026-11-11 优化任务后补，评审会按这些卡）

1. **D15 数据隔离**：采购单的创建**和**修改路径都必须校验明细商品属于该单公司（`assertProductsInCompany`）。只补一条路径等于没补；新增类似「单据引用他表主数据」的路径时，校验放在任何写入之前。
2. **结算确认时间只认 `settlement_order.settled_at`**（迁移 0026）。`updated_at` 被触发器在任何 UPDATE 时刷新，**不是**业务时间；新增结算/报表逻辑不要再用它推断结算时刻。口径见 `docs/adr-0002-settlement-settled-at.md`。
3. **跨模块只走端口**：利润聚合这类跨模块读取必须经 `apps/api/src/platform/services/registry.ts` 注册的端口（D70），禁止直读别的模块的表、禁止 import 对方 repo。
4. **金额与数量**：一律 PostgreSQL `numeric` 落库、在应用层用 decimal 字符串传递；**禁止** JS `number` 参与金额/数量运算（包括临时变量与求和）。
5. **新模块/新路径必须补行为测试**（L1 纯逻辑或 L2 PGlite 真 SQL），并在提交前跑通 `pnpm -r build`、`pnpm test`、`pnpm lint`。
6. **契约一改就重生成**：动过 `packages/contracts` 必须 `pnpm openapi` 并提交 `docs/api/openapi.yaml`；CI 的 spec-drift 会对比。
7. **前端路由保持 `lazyRouteComponent` 懒加载**：首包只放登录/工作台等高频页面，页面区用 `Suspense` 包住。开发模式里 React 19 的 `use()` 断言（`did not call use() when it finished`）是上游 `@tanstack/react-router` 已知现象、生产包不存在，**不作为业务缺陷**处理。


8. **业务校验要有数据库兜底**：能跨入口写入的关键归属校验（如 D15）不能只放在某一条业务路径里；用触发器/约束在库里再挡一次（0027），并把 SQLSTATE 映射成 422（`apps/api/src/platform/http/errors.ts` 的 `isD15Violation`）。新增同类防线时照 `purchase-line-db-guard.test.ts` 写原始 SQL 用例。
9. **新迁移必须配回归测试 + 运行手册**：迁移要能重复执行、单文件一个事务、失败整体回滚；涉及新列/回填/触发器的，同步更新 `docs/runbook-<编号>-*.md`，并在 PR 里写明该迁移是「已执行」还是「待发布执行」。代码依赖新列的，必须在 `apps/api/src/platform/db/schema-guard.ts` 登记，让旧库启动即失败。
10. **上面这些规则有机械检查**：`apps/api/src/modules/architecture-guards.test.ts` 会盯端口注册、operationId 与 OpenAPI 同步、D15 双路径、迁移测试引用；改规则时改测试，不要删测试。
