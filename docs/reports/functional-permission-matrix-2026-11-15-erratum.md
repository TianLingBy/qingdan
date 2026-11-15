# 逻辑权限报告单 · 勘误与使用须知（2026-11-16）

> 对象：`docs/reports/functional-permission-matrix-2026-11-15.md`（下称「原报告」）。
> 方法：对原报告逐句拆事实性陈述，到 `packages/contracts`、`apps/api`、`apps/web`、`apps/api/migrations` 逐条核实，判定 `TRUE` / `PARTIAL` / `FALSE` / `UNVERIFIABLE` 并附 `文件:行号`。
> 用途：**前端照原报告写页面前必须先看这份勘误**；主线按第 4 节开单。

## 0. 基线（用户口径，2026-11-16 拍板）

> 用户原话：「仓库目前的前端都是不完善的，不能作为真实参考意见。现在的功能都是按照后端来开发的，所以后端的功能一定要完善。」

- 功能是否存在，只认 `packages/contracts/src/*.ts` + `apps/api/**` + `apps/api/migrations/*.sql`。`apps/web/**` 是半成品，不能当能力证明，也不能用来反驳「某功能缺失」。
- 判副作用只看用例层有没有调 `stockFlowPort()` / `settlementDraftPort()`；判权限只看契约 `action` 与 `requireScope`。
- 本勘误的基线提交：`1baa6ee`（含 D81 权限口径 / D82 结算看价 / D83 费用非负 / D84 费用摊入 / #265 列级 GRANT）。

## 1. 核验统计

| 段 | 覆盖范围 | 陈述数 | TRUE | PARTIAL | FALSE | UNVERIFIABLE |
|---|---|---|---|---|---|---|
| 3.1 主数据 | 原报告 110–211 | 84 | 79 | 4 | 0 | 0 |
| 3.2 A 采购 + 入库 | 212–296 | 52 | 41 | 7 | 4 | 0 |
| 3.3 B 加工 | 297–380 | 53 | 45 | 6 | 2 | 0 |
| 3.4 E 销售 + 收款 + 支付 | 381–469 | 63 | 58 | 4 | 1 | 0 |
| 3.5 N + 盘点 + R/S | 470–619 | 71 | 55 | 12 | 4 | 0 |
| 3.6 C 结算 + 报表 + 日志 + 集成 | 620–750 | 61 | 55 | 5 | 1 | 0 |
| 1/2/4/6 章（速览·权限模型·缺口总表·前端清单） | 17–102 / 751–841 / 894–924 | 113 | 70 | 17 | 16 | 10 |

结论：**主干可信（约 81% 完全一致），但不能整份照抄**。错得最集中的是第 1、2、4 章（速览与缺口总表）——恰好是前端最先读的部分。

## 2. 四个硬问题的正确答案（直接覆盖原报告）

### 2.1 domain 共 24 个，第 24 个是 `stocktake_page`

原报告 2.2 说「只能确证 23 个」，并断言 `stocktake_page` 是「页面 id 不是 domain」。**两处都错**：`packages/contracts/src/domains.ts:24` 里 `stocktake_page: '盘点'` 就在 `DOMAINS` 表内，`apps/web/src/lib/access.ts:38` 把它当 domain 用是对的。

### 2.2 动作共 8 个，不是 7 个

`packages/contracts/src/domains.ts:40-49` 的 `ACTIONS` 是 8 个：`read` / `create` / `update` / `approve` / `ship` / `delete` / `view_price` / `export`。

原报告 P1-30 说「代码 7 个 vs 设计 4 个」——「7」的来源是权限模板勾选表去掉了 `view_price`（`packages/contracts/src/positions.ts:47`），不是动作总量；设计稿 4 列见 `design/v0.11/权限设置.html:103`（原报告写的 `design/权限设置.html` 路径不存在）。

### 2.3 端点共 106 个，不是 98 个

`docs/api/openapi.yaml` 实际 `operationId` 106 个（paths 73 / operations 106 / schemas 42）。原报告少算的 8 条：

- 认证 4 条：`platform.auth.login` / `platform.auth.logout` / `platform.auth.me` / `platform.code.send`
- 库存成本调整 4 条：`inventory.cost.adjustment.create` / `.approve` / `.reject` / `.history.read`

连带结论：原报告「库存模块没有任何 HTTP 写端点」**不成立**。批次与流水确实只读，但 `apps/api/src/modules/inventory/routes.ts:50-126` 挂了盘点 5 条 + 成本调整 4 条写端点，成本调整审批会直接改 `inventory_batch.locked_unit_cost`（`apps/api/src/modules/inventory/repo-cost-adjustments.ts:351-352`）。

### 2.4 P0 15 条的现状

| 状态 | 条目 |
|---|---|
| 已修（6 条，均在 `1baa6ee` 内） | P0-01 采购完成权限三处不一致（D81）／P0-02 费用未摊入锁价（D84）／P0-03 R·S 完成 action（D81）／P0-04 迁移 REVOKE（#265 列级 GRANT，`apps/api/migrations/0031_returns_status_update_grant.sql:21-22`）／P0-05 客户退货岗位硬编码（#266）／P0-13 结算看价门禁（D82） |
| 仍成立（8 条） | P0-06 销售出库挂 `sales.update`（已派 #268）／P0-07 加工金额无服务端脱敏／P0-08 加工详情编辑与打印不判权限（已派 #261）／P0-09 主数据写入口无 scope（已派 #262）／P0-10 权限设置页写入口无 scope（已派 #263）／P0-11 主数据 status 可写且软删除无守卫（已派 #270）／P0-12 占用列无写入方（方案 #271）／P0-14 盘点「已驳回」死态 |
| 描述不准（1 条） | P0-15 库存校验文案——那是安全兜底文案，不是权限口径错误；改的是「按调用方分文案」，已派 #269 |

## 3. 必须修订的条目（前端不能照抄）

### 3.1 权限与动作口径

1. **P0-06 结论保留，但注意 `sales.ship` 已存在**：`domains.ts` 里有 `ship` 动作，E 单完成却挂在 `update` 上，等于「能改单的人就能出库」。前端授权判断照 `sales.update` 实现，等 #268 落地后再改。
2. **`internal_trade.update` 一个权限点管两件事**：改单（PATCH，仅「进行中」）与到货确认（在途→已完成，转司 + 建 C 草稿，`apps/api/src/modules/internal-trade/usecases/internal-trade-orders.ts:727-740`）。真正被拆开的只有 `ship`。
3. **采购完成权限已统一为 `purchase.update`**：契约 `packages/contracts/src/purchase-orders.ts:212`、后端 `apps/api/src/modules/purchase/usecases/purchase-orders.ts:446`、前端 `apps/web/src/pages/purchase/PurchaseOrdersPage.tsx:1202` 三处一致。**但提示文案 `:649-650` 仍写 `purchase.approve`**（#258 漏改），原报告竟把这段当「正确样例」推荐照抄。
4. **结算确认是双权限点 + 五道前置**：`approve` → `view_price` → 人类凭证（AI 一律 `AI_ACTION_FORBIDDEN`）→ `If-Match` 强 ETag → 状态「待确认」。后端硬校验在 `apps/api/src/modules/settlement/usecases/settlement-orders.ts:296`（缺 `view_price` 抛 `FORBIDDEN`，不是脱敏、不靠前端）。
5. **提成金额受 `settlement.view_price` 管，提成比例快照不受管**：`packages/contracts/src/settlement-orders.ts:103` 非 nullable，`masking.ts` 不含该字段。不要写「整块随看价权限一起遮」。
6. **报表脱敏域独立**：`profit_report.view_price`（`apps/api/src/modules/report/usecases/profit-report.ts:125`）与 `settlement.view_price` 互不影响。
7. **自建 API Token 不需要 `api_integration.create`**：只对「代他人建」校验（`apps/api/src/platform/api-tokens.ts:280-361`）。按 create 权限隐藏按钮会把「给自己建 Token」也藏掉。

### 3.2 副作用与库存语义

8. **「完成」扣的是 `inbound_qty`，不是 `referenced_qty` / `pending_execution_qty`**（E 单：`apps/api/src/modules/sales/usecases/sales-orders.ts:749-759` → `apps/api/src/modules/inventory/services/stock-flow.ts:424-435`）。`available_qty` / `remaining_qty` 是 PG 生成列（`apps/api/migrations/0008_inventory_core.sql:45-48`），可用量是被动下降。前端不要渲染四个量并暗示「占用逻辑已生效」。
9. **采购完成锁价 = 摊入费用后的单价**，不是明细单价：`apps/api/src/modules/purchase/usecases/purchase-orders.ts:467-473` 调 `allocatePurchaseFees`，取 `line.adjustedUnitCost`（`:480-484`）。且 `qty = 0` 的行**不建批次**，「每行 1 条批次」不成立。分摊退化规则：全部行金额合计为 0 时按数量占比（`apps/api/src/modules/purchase/services/fee-allocation.ts:81-126`）。
10. **费用行金额不得为负**（D83）：`packages/contracts/src/purchase-orders.ts` 用 `NonNegativeDecimal`，迁移 `apps/api/migrations/0032_no_negative_purchase_fee.sql` 加了 `CHECK (amount >= 0)`。原报告完全没有费用维度。
11. **加工「完成」才扣料，开单不预占**：`apps/api/src/modules/processing/repo.ts:601-642` 不写 `pending_execution_qty`。前端写「已建单即锁定材料」是错的；开单到完成之间材料可能被别单消耗，完成会因 `available_qty >= 0` 守卫失败报 `VERSION_CONFLICT`。
12. **全损耗也照样扣材料**（`packages/contracts/src/processing-orders.ts:30`、`apps/api/src/modules/processing/usecases/processing-orders.ts:533-541`）。
13. **加工「打印」与「取消」都不动库存**：`cancelProcessingOrder` 无任何 `stockFlowPort()` 调用。原报告/前端文案说「取消会释放材料占用」是错的。
14. **N 到货确认会生成 C 结算草稿**，字段硬编码：`commissionRateSnapshot: '0'`、`commissionOwnerId: source.handlerId`、`companyId: toCompanyId`（`internal-trade/usecases/internal-trade-orders.ts:727-740`）。前端展示草稿别指望有提成率。一旦 receive 就不可逆。
15. **R/S 完成不入账**：`sales_receipt` 支持 `direction IN ('收款','退款')`（`apps/api/migrations/0014_sales_receipts_returns.sql:108-119`），但 R 完成不写它，也不冲减应收——仓库里**根本没有应收/应付表**。「冲抵应收」只是 `method` 的枚举值。
16. **破成本下限拦在开单/改单**，不是完成时：`apps/api/src/modules/sales/repo.ts:642`（insert）与 `:712-715`（update）调 `resolveLineCostFloors`，`:505-515` 抛 `VALIDATION_FAILED`，`details = {lineNo, unitPrice, costFloor}`。
17. **E 单可取消性的判定依据是「有没有库存流水」**（`apps/api/src/modules/sales/repo.ts:381-397` 查 `inventory_flow`），与 C 结算单是否存在无关。前端禁用理由要说「已产生库存流水」。
18. **利润报表净毛利是现算的**：`subtractDecimal(settlement.grossProfit, processing.lossAmount)`（`apps/api/src/modules/report/usecases/profit-report.ts:148-158`），**丢弃**了端口返回的 `sum(net_profit)`。报表口径 = 毛利 − B 单全损耗，**不等于**各单净毛利之和。前端文案别写「各单净毛利之和」。
19. **提成比例解析用 `effective_from <= CURRENT_DATE`，不是结算日**（`apps/api/src/modules/settlement/repo.ts:293-311`）。别宣传「按结算当日比例」。

### 3.3 端点与响应细节

20. **库存流水页已经有来源筛选**：`apps/web/src/pages/inventory/InventoryFlowsPage.tsx:14` 定义 `SOURCE_TYPES = ['A','B','E','N','I','R','S']`，`:117-131` 是下拉。原报告说「前端全文无来源筛选」是错的。
21. **加工列表已有「投入→可售」「损耗」两列**（`apps/web/src/pages/processing/ProcessingOrdersPage.tsx:1515-1525`），缺的只是「损耗率(%)」列。且**没有负责人列**（`ProcessingOrderSchema` 只有 `handlerId`）。
22. **加工产出批次号与锁价只出现在 complete 的响应体**，详情只有 `outputBatchId`（uuid）。要展示必须扩 `ProcessingOrderDetailSchema` 或另查 `/api/v1/inventory/batches/{id}`（需 `inventory_qty.read`）。
23. **加工成本快照有落库无出参**：`material_cost_amount` / `loss_amount` / `partial_loss_amount`（`apps/api/migrations/0028_processing_cost_snapshots.sql:7-10`、`0029_processing_partial_loss_snapshot.sql:3-4`）在完成时写入，但 `ProcessingOrderDetailSchema` 不返回。
24. **销售收款创建响应不脱敏**：`apps/api/src/modules/sales/usecases/sales-receipts.ts:226-242` 直接返回 `created`，路由原样回（`:162-166`），也没有 `sales.view_price` 校验；而 detail/list 会脱敏（`masking.ts:40-63`）。
25. **收款创建无 `If-Match`**（`packages/contracts/src/sales-receipts.ts:132-145`），并发追加不会 409。
26. **回调金额必须精确等于剩余应收**（`apps/api/src/modules/payment/services/callback.ts:328-335`），部分付款/多付/超额一律 `VALIDATION_FAILED`；`payment_transaction.status` 是自由文本且只写 `'已支付'`，没有「待支付/失败/已关闭」态可展示。
27. **在线支付商户配置是环境变量**（`QINGDAN_PAYMENT_CONFIG`，`apps/api/src/modules/payment/services/merchant-config.ts:8-9`），不在 DB、没有界面。前端做「支付设置」页属于新需求。
28. **确认结算的响应仍脱敏**：通过 `view_price` 硬校验后，返回前还套 `maskSettlementAmounts`（`apps/api/src/modules/settlement/usecases/settlement-orders.ts:365-366`）。拿到 200 也要按 `null` 兜底。
29. **Token 撤销的幂等路径绕过 If-Match**：已 `revoked` 时直接返回成功不校验 version（`apps/api/src/platform/api-tokens.ts:421-476`）。连点两次不会 409。
30. **审计日志服务端只认分页**（`audit-logs.ts` 只解 `PageQuerySchema`），「按对象类型/操作人筛」必须扩契约；前端客户端过滤只对当前页有效（`AuditLogsPage.tsx:33-47` 就是只滤当前页）。响应里 `changeSummary` / `businessTxId` / `dryRun` / `ip` / `ua` / `reason` 现成可用（`packages/contracts/src/audit.ts:30-51`），前端一个都没渲染。
31. **`stocktake_page` 的盘点面板实际位置**：`apps/web/src/pages/reversals/StocktakesPanel.tsx` 与 `apps/web/src/pages/inventory/StocktakesPage.tsx`（原报告写的 `StocktakesPage.tsx` 路径正确，但 m5 提到的 `pages/stocktakes` 目录不存在）。
32. **公司切换下拉在各 Panel 内部**（R `:243-253` / S `:214-222` / 盘点 `:188-198`），且 `companyIds.length > 1` 才出现。

### 3.4 行号与路径

33. **原报告的行号系统性漂移 3–40 行**，几乎每一格都要重新定位。按本勘误给的行号为准。
34. **设计稿路径全部漏了版本目录**：原报告把 `design/` 前缀定义为 `design/v0.11/`，但正文引用时写成 `design/单据详情.html` 这类路径，在仓库里打不开。`design/` 实测 131 个文件，均在 `design/v0.8|v0.9|v0.10|v0.11/` 下。

## 4. 「前端不许写」黑名单

以下功能**设计稿有、后端没有**，画出来就是点了没反应或 403。要写必须先由主线扩契约、补端点。

| # | 不许写的功能 | 依据 |
|---|---|---|
| B1 | 冲正单据（「错账走冲正」入口、冲正列表、冲正详情） | 全仓无冲正模块、无端点、无 reopen；只有 4 处错误文案写着「请走冲正单据」。口径见 `apps/api/src/modules/settlement/routes.ts:28`「错账走 R 退货（D2③）」 |
| B2 | 采购「确认入库」独立步骤、批次号回显 | 完成采购单即建批次，无独立入库端点；`PurchaseOrderSchema` 无 `batchIds` / `batchNo` |
| B3 | 库存页「录入入库」抽屉、仓库列与仓库筛选 | 契约明令不开放直接改库存（`packages/contracts/src/inventory.ts:8-10`）；`inventory_batch` 建表无 `warehouse_id` |
| B4 | 采购单 / 库存页「导出」 | 两个契约均无 export 端点 |
| B5 | 库存页 KPI（可售批次 / 在途量 / 锁定金额汇总） | 无汇总端点，`apps/api/src/modules/inventory/routes.ts:34-133` 只有 list/detail/flows |
| B6 | 加工「发料」独立动作、加工产出入库/回传/核对 | 全无端点；加工只有 create/detail/list/update/cancel/complete/print 七条 |
| B7 | 加工「损耗率超阈值审批」 | 无 threshold 字段、无审批态、无端点；只有 `confirmFullLoss` |
| B8 | 加工状态机的「草稿 / 已发料 / 待核对」 | 只有三态（`进行中 / 已完成 / 已取消`），扩枚举需同时改 DB CHECK 与迁移 |
| B9 | 销售「破成本下限审批 / 需放行」按钮 | 无 `sales.approve` 端点、无 pending 表；下限在开单/改单直接拒 |
| B10 | 客户扫码付款的预下单 / 取二维码 / 查支付状态 / 关单 | 只有回调一条 `payment.callback.receive`；商户配置走环境变量，无界面 |
| B11 | 在线支付的「待支付 / 失败 / 已关闭」状态展示 | `payment_transaction.status` 是自由文本，实际只写 `'已支付'` |
| B12 | R/S「待审批」态与提交/驳回按钮 | 只有 `进行中 → 已完成` 单向，无 submit/reject 端点 |
| B13 | 结算单「撤销确认 / 反结算」 | 无 reverse 端点；DB CHECK 要求待确认时 `snapshot IS NULL` |
| B14 | 盘点「驳回」按钮 | 「已驳回」是死态，无 reject 端点 |
| B15 | 员工页「停用公司」、公司状态字段 | `company` 表无 `status` 字段 |
| B16 | 权限矩阵「4 个动作」 | 实际 8 个动作；照设计稿 4 列写会漏 `ship` / `view_price` / `export` / 部分 `approve` |
| B17 | 客户/供应商/加工厂「合作中 / 暂停」 | 契约只有 `启用 / 停用`（`packages/contracts/src/customers.ts:17` 等三处） |
| B18 | 工作台「待我审批」聚合入口、`GET /api/v1/todos` | 端点不存在，`apps/web/src/pages/workbench/workbench-mock.ts` 是假数据 |

## 5. 后端现有能力里，前端不要漏做的

1. **成本更正入口**：`apps/api/src/modules/inventory/routes.ts:93-126` 四条端点（create / history.read / approve / reject），审批会改 `locked_unit_cost`。库存页必须有这个面板，权限走 `inventory_qty.update` / `.approve` / `.read`。
2. **批次成本可被改**：`repo-cost-adjustments.ts:351-352` 能改 `locked_unit_cost`，前端不要把产出批次单价当不可变。
3. **加工 `lossQty` 可在开单时预填**（`apps/api/src/modules/processing/repo.ts:609,628`）。
4. **审计字段现成**：`changeSummary` / `businessTxId` / `dryRun` / `ip` / `ua` / `reason` 都在响应里（`packages/contracts/src/audit.ts:30-51`）。
5. **`recoverFromStaleVersion` 可复用**：`apps/web/src/pages/settlement/SettlementsPage.tsx:310-326` 是现成的 409 重取模式。
6. **S 单没有类型字段**：`refund_amount` 建单即定、完成不重算，别做「退款方式」下拉。
7. **前后端不一致的现成缺陷**（写页面时别照抄旧页面）：
   - 详情「编辑」不判 scope，列表行「编辑」判 `update + view_price`（采购、加工都有这个不一致）
   - 加工取消提示文案是死分支（`ProcessingOrdersPage.tsx:1281-1283`）
   - 客户退货面板仍有岗位口径文案（`CustomerReturnsPanel.tsx:12`、`:292`）与不存在的「换货类型」（`:736`）
   - 销售单页文案把 D21 编号串了（`SalesOrdersPage.tsx:1003`）

## 6. 后端缺陷（本勘误新发现，用于开单）

按「后端必须先完善」，以下 8 条是代码缺陷而非文档笔误：

| # | 缺陷 | 位置 | 影响 |
|---|---|---|---|
| D1 | 加工打印端点不判看价 | `apps/api/src/modules/processing/usecases/processing-orders.ts:317-347`、`factory-copy.ts:40-69`，路由只挂 `processing.read` | 任何有 `processing.read` 的人可拿到真实单价与成本；前端遮罩成假象 |
| D2 | 销售收款创建不脱敏、不校验看价 | `apps/api/src/modules/sales/usecases/sales-receipts.ts:226-242`、`routes.ts:162-166` | 无 `sales.view_price` 也能拿到金额 |
| D3 | 打印/导出路由无 `ai` 字段 | `packages/contracts/src/prints.ts:21-32`、`:44-55` | AI 凭证可调 `sales.order.print` / `export`（导出还带 `sensitive-read` 审计），与写路径 `forbid` 口径不一致 |
| D4 | 加工材料行允许重复引用同一批次 | `packages/contracts/src/processing-orders.ts:67-72` 只 `.min(1)`，无去重 | 完成时同一批次被重复扣 |
| D5 | 加工 `update` 无人类凭证校验 | `apps/api/src/modules/processing/usecases/processing-orders.ts`（create/cancel/complete 有，update 没有） | AI 可改单 |
| D6 | 收款创建无 `If-Match` | `packages/contracts/src/sales-receipts.ts:132-145` | 并发追加不会 409 |
| D7 | `internal_trade.update` 同时管改单与到货确认 | 到货确认在 `internal-trade/usecases/internal-trade-orders.ts:727-740` | 违反「一个动作只对应一件事」：能改单的人就能转司 + 建结算草稿 |
| D8 | 陈旧注释集中在本该是最新的事实处 | `internal-trade-orders.ts:31`、`:147-149`、`customer-returns.ts:25-27`、`masking.ts:10-11`、`processing/routes.ts:24-26` | 照注释读会把已有能力当成没有（D1/D2 之前就是这样被漏掉的） |
