# 后端冻结（2026-11-21）

**结论**：后端功能面已封口，可以冻结。冻结的是「后端实现 + 接口契约 + 数据库结构」这条线，不是整个产品。
前端页面重做（#337–#340）、设计稿（#145/#146/#153/#154）、功能接线（#303/#305/#307/#425）照旧推进，**不受本冻结影响**。

## 一、冻结范围

| 路径 | 状态 | 说明 |
| --- | --- | --- |
| `apps/api/**` | 冻结 | 业务模块、platform 内核、用例、repo |
| `packages/contracts/**` | 冻结 | 24 个域、152 个 operation 的定义与 `x-scope` |
| `apps/api/migrations/**` | 冻结 | 55 个迁移，前向 only |
| `docs/api/openapi.yaml` | 冻结 | 接口真源，CI `spec-drift` 保证与契约一致 |
| `apps/cli/**`、`apps/mcp/**` | 冻结 | 与契约同生共死，spec 不动它们就不动 |
| `apps/web/**` | **不冻结** | 前端接线与页面重做照常 |
| `docs/**`（除 `docs/api/openapi.yaml`） | **不冻结** | 文档、决策记录照常补 |

## 二、为什么可以冻（证据，不是感觉）

1. **端点面无缺口**：152 个端点 / 24 个域，全部有实现、有契约、有权限声明。路由 handler 与 spec operationId 逐条对账，`code-but-not-spec` = 0。
   spec 里 16 条「代码字面搜不到」的是模板串键（`apps/api/src/modules/masterdata/routes.ts:272` 的 `contactHandlers[`${kind}.contact.list`]`、`:289` 的 `${kind}.summary.read`）与支付回调常量（`apps/api/src/modules/payment/routes.ts:28`），不是缺实现。
2. **测试全绿**：main 上最近一次全量 CI 8/8（`test (windows-latest) 7m11s`、`test (ubuntu-latest) 6m32s`、`integration (ubuntu-latest, PostgreSQL 18) 1m0s`、`e2e 53s`、`spec-drift`、`numbering`、`route`、`fields`）。本地 pre-commit 同样跑全量。
3. **真库业务流跑通**：`apps/api/src/platform/db/e2e-business-flow.integration.ts` 12 个 `check`，覆盖 E→C、A、B、R、S、N 六条链路（A `:304`、B `:378`、R `:459`、S `:562`、N `:663`）。
4. **数据结构一致**：55 个迁移全部应用（E 盘库最后一次 `pnpm -C apps/api migrate` 是 `applied=2 skipped=53`），`apps/api/src/platform/db/schema-guard.ts` 有 `REQUIRED_MIGRATIONS` 断言，缺一条直接拒绝启动。
5. **决策面无悬空**：`docs/decisions.md` 79 条「已落地」、7 条「已采纳」（架构决定，无代码待落）、1 条「已冻结」（D54）、0 条「待补（需主线确认）」。
6. **代码里没有半成品**：`apps/api/src` 全量搜 `TODO`/`FIXME`/`XXX` 零命中；出现的 `NOT_IMPLEMENTED` 全是「数据库未配置」的兜底分支（无库环境下路由桩），不是功能缺失。
7. **部署已验证**：E 盘容器重建后，老板 `10000000001` 的 `/auth/me` 带四域 `read_all`，四类单据 `?scope=all|mine|不传` 全 200。

## 三、冻结之后新增东西的规矩

任何要动上面「冻结」清单的改动，一律：

1. **PR 标题带 `[unfreeze]` 前缀**，正文第一段写清三件事：为什么要动后端、不动会怎样、影响哪些既有端点/表。
2. 迁移只许**新增**，不许改已应用的（改一次新库老库就不一致，2026-11-20 的 `read_all` 就是这么埋的坑）。
3. 改契约必须同步 `docs/api/openapi.yaml` 并让 `spec-drift` 绿；改权限动作必须同步 `packages/contracts/src/domains.ts` 与 `docs/decisions.md` 并记新 D 号。
4. 动完把 `docs/api/feature-matrix.md` 重生成（`node tools/gen-feature-matrix.mjs`）。
5. 解冻不是永久开口：这次改动合完，本条子事项即回到冻结状态，不需要另开「重新冻结」的 PR。

## 四、唯一现实的解冻来源（提前写明，免得到时候争论）

- **前端接线时发现端点行为不对**：功能表里 22 个端点从未被真实页面调用过，接线过程中暴露的字段缺失/口径错误，按上面第 1 条走 `[unfreeze]`。
- **老板要报表**：除 `profit_report` 与 `commission` 之外的统计口径后端确实没有（见 `docs/api/feature-matrix.md` 末节）。要新的统计就是新功能，不是「补漏」。
- **巡检发现真 bug**（#291）：真 bug 走普通 `fix` 分支，但同样在 PR 标题标 `[unfreeze]`，方便回溯冻结期内的所有后端改动。

## 五、冻结标记

- 分支：main
- commit：以 tag `backend-v1.0.0` 指向的 commit 为准
- 冻结后 `git log --oneline <tag>..main -- apps/api packages/contracts apps/api/migrations docs/api/openapi.yaml` 应当只看到 `[unfreeze]` 的提交；出现别的就是有人绕过了规矩。
