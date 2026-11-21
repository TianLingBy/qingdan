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
- commit：以 tag `backend-v1.0.1` 指向的 commit 为准（含 #428 修复，业务代码停在 `3437aef`）
- 冻结后 `git log --oneline <tag>..main -- apps/api packages/contracts apps/api/migrations docs/api/openapi.yaml` 应当只看到 `[unfreeze]` 的提交；出现别的就是有人绕过了规矩。

## 六、基线更新：`backend-v1.0.1`（2026-11-21 12:55）

用户 12:54 明确要求「不要再改了，现在问题很多，现在的前端与设计稿完全不一样」——工作重心整体转前端/设计，后端从「可以冻」转为「**冻结期，除真 bug 外不停手**」。

- 基线从 `6154f6d`（`backend-v1.0.0`）前移到 **`3437aef`**（tag `backend-v1.0.1`），中间唯一一笔是 #428 的 `[unfreeze]` 修复（加工厂汇总 500）。
- **新增 CI 守卫** `.github/workflows/frozen-guard.yml`：动了冻结清单却在 PR 标题里没写 `[unfreeze]` → 直接红。这条是机器执行的，不靠自觉。
- 冻结期内允许动的只有两类：①**P0/P1 真 bug**（有复现路径、有日志/证据）②冻结文本本身（本文件、`docs/decisions.md`）。
- 允许动的也照样走 `[unfreeze]` + 补回归测试；顺手优化、重构、加字段、换写法一律不做。
- 新需求（新的统计口径、新字段、新端点）**不进冻结期**，等前端与设计对齐之后统一评估。

## 七、完全冻结（2026-11-21 13:15，用户二次定调）

用户原话：「后端完全冻结。」——上一节那条 `[unfreeze]` 的口子也收了。

- **冻结清单上的文件，一个都不许再改**：`apps/api/**`、`packages/contracts/**`、`apps/api/migrations/**`、`docs/api/openapi.yaml`、`apps/cli/**`、`apps/mcp/**`。
- **`[unfreeze]` 前缀不再是通行证**。`.github/workflows/frozen-guard.yml` 已改成「碰冻结清单就红」，标题写什么都不放行。
- 唯一的合法改法：先改守卫本身（一次公开、可审计的动作），并在 issue 里带复现步骤与日志说明为什么必须动。**P0 真 bug 也走这条路**，没有例外。
- 冻结基线：tag **`backend-v1.0.2`**（业务代码仍停在 `3437aef`，本 tag 只包含冻结文本与守卫的变更）。
- 允许动的范围：`apps/web/**`、`docs/**`（除 `docs/api/openapi.yaml`）、`.github/**` 里与前端/协作相关的 workflow。
- 前端改造的规范边界写在 `docs/ui/frontend-change-rules.md`，派给前端（何永上 / `Meow-Yay`）的 issue 都引用它。

