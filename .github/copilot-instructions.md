# 轻单 · 协作者说明（Copilot）

- 技术栈：TypeScript 全栈（Node 24 + Fastify 5 + Drizzle + PostgreSQL 18 + React 19/Vite + pnpm 11）。
- 接口唯一真源：`packages/contracts` 的 Zod 注册表；`docs/api/openapi.yaml` 由 `pnpm openapi` 生成，不要手改。
- 模块边界：业务模块之间只走服务层函数或只读视图，禁止直接 import 对方实现、禁止直读对方数据表（`eslint.config.js` 里有机械约束）。
- 提交前必须：`pnpm -r build`、`pwsh -NoProfile -File tests\run.ps1` 全绿；契约有改动需重生成 OpenAPI。
- 写 `.ps1` 时保持 UTF-8 BOM；`tools/pre-commit` 必须是 LF。
- 业务口径与内部文档不在本仓；需求不明确时先问，不要猜着实现。
