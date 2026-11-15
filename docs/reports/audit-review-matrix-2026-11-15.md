# 审核（审批）功能四层取证报告（2026-11-15）

**范围**：契约层（`packages/contracts/src`）、后端（`apps/api/src`）、前端（`apps/web/src`）、设计稿（`design/v0.9`、`design/v0.10`、`design/v0.11`）。

**口径**：approve 端点的检索条件是精确匹配 `action: 'approve'`，全仓共 6 条（`packages/contracts/src/cost-adjustments.ts:182`、`packages/contracts/src/cost-adjustments.ts:196`、`packages/contracts/src/processing-orders.ts:395`、`packages/contracts/src/purchase-orders.ts:223`、`packages/contracts/src/settlement-orders.ts:201`、`packages/contracts/src/stocktakes.ts:258`）。每条结论后括注 `文件:行号`；查不到的写「未找到证据」，不做推断；不引用未在代码或文档中出现的决策编号。

---

## 1. 契约层：所有 `action: 'approve'` 的端点

| # | operationId | 方法 / path | domain | 前置单据状态 | 配套 reject 端点 | requiresIfMatch | 证据 |
|---|---|---|---|---|---|---|---|
| 1 | `inventory.cost.adjustment.approve` | POST `/api/v1/inventory/cost-adjustments/{id}/approve` | `inventory_qty` | `pending_approval` → `applied` | 有：`inventory.cost.adjustment.reject` | 是 | `packages/contracts/src/cost-adjustments.ts:176-189`（action 在 :182，summary 在 :184，If-Match 在 :187）；状态集合 `packages/contracts/src/cost-adjustments.ts:44` |
| 2 | `inventory.cost.adjustment.reject` | POST `/api/v1/inventory/cost-adjustments/{id}/reject` | `inventory_qty` | `pending_approval` → `rejected` | 本身即驳回端点（与 #1 共用 `approve` 动作） | 是 | `packages/contracts/src/cost-adjustments.ts:190-203`（action 在 :196，summary 在 :197，If-Match 在 :200） |
| 3 | `processing.order.complete` | POST `/api/v1/processing-orders/{id}/complete` | `processing` | `进行中` → `已完成` | 未找到证据 | 是 | `packages/contracts/src/processing-orders.ts:389-402`（action 在 :395，summary 在 :396，If-Match 在 :399）；状态由后端 SQL 约束，见第 2 节 |
| 4 | `purchase.order.complete` | POST `/api/v1/purchase-orders/{id}/complete` | `purchase` | `进行中` → `已完成` | 未找到证据 | 是 | `packages/contracts/src/purchase-orders.ts:221-227`（action 在 :223，summary 在 :224，If-Match 在 :225） |
| 5 | `settlement.order.confirm` | POST `/api/v1/settlement-orders/{id}/confirm` | `settlement` | `待确认` → `已结算` | 未找到证据 | 是 | `packages/contracts/src/settlement-orders.ts:195-208`（action 在 :201，summary 在 :203，If-Match 在 :206） |
| 6 | `stocktake.approve` | POST `/api/v1/stocktakes/{id}/approve` | `stocktake` | `待审批` → `已批准` | 明确不做：契约写明「一期先做「批准」路径，驳回留后续批次」 | 是 | `packages/contracts/src/stocktakes.ts:252-265`（action 在 :258，summary 在 :260，If-Match 在 :263）；不做驳回见 `packages/contracts/src/stocktakes.ts:26`；三态见 `packages/contracts/src/stocktakes.ts:45` |

补充事实：普通单据状态机只有 `进行中 / 已完成 / 已取消` 三态（`packages/contracts/src/documents.ts:7`），所以 #3 / #4 的 `approve` 动作并不对应「待审核」中间态。

---

## 2. 后端落点：用例函数、repo 函数与状态机

| 端点 | 用例函数 | repo 函数 | SQL `SET status = ...` | SQL `WHERE ... status = ...` | 用例内状态闸门 | 权限作用域（用例） |
|---|---|---|---|---|---|---|
| `purchase.order.complete` | `apps/api/src/modules/purchase/usecases/purchase-orders.ts:429` `completePurchaseOrder` | `apps/api/src/modules/purchase/repo.ts:701` `completePurchaseOrder` | `SET status = '已完成', version = version + 1`（`apps/api/src/modules/purchase/repo.ts:705`） | `AND version = $4 AND status = '进行中'`（`apps/api/src/modules/purchase/repo.ts:707`） | 版本不符 → `VERSION_CONFLICT`；`state.status !== '进行中'` → `VALIDATION_FAILED`（`apps/api/src/modules/purchase/usecases/purchase-orders.ts:441-442`） | `requireScope(principal, 'update')`（`apps/api/src/modules/purchase/usecases/purchase-orders.ts:432`） |
| `processing.order.complete` | `apps/api/src/modules/processing/usecases/processing-orders.ts:493` `completeProcessingOrder` | `apps/api/src/modules/processing/repo.ts:393` `completeProcessingOrder` | `SET status = '已完成',`（`apps/api/src/modules/processing/repo.ts:408`） | `AND version = $10 AND status = '进行中'`（`apps/api/src/modules/processing/repo.ts:420`） | `state.status !== '进行中'` → `VALIDATION_FAILED`（`apps/api/src/modules/processing/usecases/processing-orders.ts:513`） | `requireScope(principal, 'approve')`（`apps/api/src/modules/processing/usecases/processing-orders.ts:498`） |
| `settlement.order.confirm` | `apps/api/src/modules/settlement/usecases/settlement-orders.ts:287` `confirmSettlementOrder` | `apps/api/src/modules/settlement/repo.ts:435` `confirmSettlementOrder` | `SET status = '已结算', settled_at = now(),`（`apps/api/src/modules/settlement/repo.ts:443`） | `AND version = $4 AND status = '待确认'`（`apps/api/src/modules/settlement/repo.ts:454`） | 已结算 → `VALIDATION_FAILED`（`apps/api/src/modules/settlement/usecases/settlement-orders.ts:309-315`）；repo 未命中 → `VERSION_CONFLICT`（`apps/api/src/modules/settlement/usecases/settlement-orders.ts:340-344`） | `requireScope(principal, 'approve')`（`apps/api/src/modules/settlement/usecases/settlement-orders.ts:292`） |
| `stocktake.approve` | `apps/api/src/modules/inventory/usecases/stocktakes.ts:379` `approveStocktake` | `apps/api/src/modules/inventory/repo-stocktakes.ts:294` `approveStocktake` | `SET status = '已批准', approver_id = $4::uuid,`（`apps/api/src/modules/inventory/repo-stocktakes.ts:302`） | `AND version = $5 AND status = '待审批'`（`apps/api/src/modules/inventory/repo-stocktakes.ts:309`） | `stocktakeApprovable(state.status)` 不通过 → `VERSION_CONFLICT`（`apps/api/src/modules/inventory/usecases/stocktakes.ts:402-409`） | `requireScope(principal, 'approve')`（`apps/api/src/modules/inventory/usecases/stocktakes.ts:384`） |
| `inventory.cost.adjustment.approve` | `apps/api/src/modules/inventory/usecases/cost-adjustments.ts:394` `approveCostAdjustment` | `apps/api/src/modules/inventory/repo-cost-adjustments.ts:312` `updateCostAdjustmentDecision` | `SET status = $4::text,`（`apps/api/src/modules/inventory/repo-cost-adjustments.ts:323`），调用处传 `status: 'applied'`（`apps/api/src/modules/inventory/usecases/cost-adjustments.ts:453`） | `AND version = $6 AND status = 'pending_approval'`（`apps/api/src/modules/inventory/repo-cost-adjustments.ts:331`） | `state.status !== 'pending_approval'` → `VERSION_CONFLICT`（`apps/api/src/modules/inventory/usecases/cost-adjustments.ts:416-421`） | `requireScope(principal, 'approve')`（`apps/api/src/modules/inventory/usecases/cost-adjustments.ts:399`） |
| `inventory.cost.adjustment.reject` | `apps/api/src/modules/inventory/usecases/cost-adjustments.ts:494` `rejectCostAdjustment` | 同上 `apps/api/src/modules/inventory/repo-cost-adjustments.ts:312` | `SET status = $4::text,`（`apps/api/src/modules/inventory/repo-cost-adjustments.ts:323`），调用处传 `status: 'rejected'`（`apps/api/src/modules/inventory/usecases/cost-adjustments.ts:542`） | `AND version = $6 AND status = 'pending_approval'`（`apps/api/src/modules/inventory/repo-cost-adjustments.ts:331`） | `state.status !== 'pending_approval'` → `VERSION_CONFLICT`（`apps/api/src/modules/inventory/usecases/cost-adjustments.ts:522-527`） | `requireScope(principal, 'approve')`（`apps/api/src/modules/inventory/usecases/cost-adjustments.ts:499`） |

路由挂载均已接到实现（不是 501 骨架）：`apps/api/src/modules/purchase/routes.ts:79-82`、`apps/api/src/modules/processing/routes.ts:97`、`apps/api/src/modules/settlement/routes.ts:82`、`apps/api/src/modules/inventory/routes.ts:83`、`apps/api/src/modules/inventory/routes.ts:107`、`apps/api/src/modules/inventory/routes.ts:117`。

**本节关键异常**：`purchase.order.complete` 契约写 `action: 'approve'`（`packages/contracts/src/purchase-orders.ts:223`），后端用例却要求 `purchase.update`（`apps/api/src/modules/purchase/usecases/purchase-orders.ts:432`）；前端按钮按 `purchase.approve` 显隐（见第 3 节）。三处口径不一致。

---

## 3. 前端落点：approve 的 UI 入口

| 端点 | UI 入口（组件:行号） | 按钮文案 | 权限来源 | 证据 |
|---|---|---|---|---|
| `purchase.order.complete` | `apps/web/src/pages/purchase/PurchaseOrdersPage.tsx:632-639`（详情操作区） | 「完成采购单」（:638） | `can('approve')`（`apps/web/src/pages/purchase/PurchaseOrdersPage.tsx:1205`），`can` = `allows(meData?.scope, 'purchase', action)`（:666）；无权限提示写的是「purchase.approve」（:653） | 请求 `apps/web/src/pages/purchase/purchase-api.ts:64` |
| `processing.order.complete` | `apps/web/src/pages/processing/ProcessingOrdersPage.tsx:1546-1558`（列表行内） | 「完成 / 验收」（:1557） | `can('approve')`（:1549、:1555、:1628），`can` = `allows(meData?.scope, 'processing', action)`（:940） | 请求 `apps/web/src/pages/processing/processing-api.ts:80` |
| `settlement.order.confirm` | `apps/web/src/pages/settlements/SettlementsPage.tsx:208-217`（详情操作区） | 「确认结算」（:216） | `canApprove` 由 `can('approve')` 传入（:635），`can` = `allows(scope, 'settlement', action)`（:251）；无权限提示写「需要 settlement.approve」（:220、:432） | 请求 `apps/web/src/pages/settlements/settlements-api.ts:64` |
| `stocktake.approve` | `apps/web/src/pages/reversals/StocktakesPanel.tsx:505-514`（详情操作区） | 「批准」（:513） | `canApprove` prop（:509-510）；`apps/web/src/pages/inventory/StocktakesPage.tsx:33` 与 `apps/web/src/pages/reversals/ReversalsPage.tsx:160` 均传 `allows(..., 'stocktake', 'approve')` | 页面用 `reversalsApi.approveStocktake`（`apps/web/src/pages/reversals/StocktakesPanel.tsx:147-148`），请求 `apps/web/src/pages/reversals/reversals-api.ts:143-144`；`apps/web/src/pages/inventory/inventory-api.ts:141-146` 另有一套同路径封装 |
| `inventory.cost.adjustment.approve` | `apps/web/src/pages/inventory/BatchCostAdjustments.tsx:392-412`（T2 历史表行内） | 「审批通过」（:411） | `canApprove` prop（:392），由 `apps/web/src/pages/inventory/InventoryPage.tsx:39` 的 `allows(me.data?.scope, 'inventory_qty', 'approve')` 传入（:243）；无权限文案「需 inventory_qty.approve」（:429） | 请求 `apps/web/src/pages/inventory/inventory-cost-adjustment-api.ts:69-79` |
| `inventory.cost.adjustment.reject` | `apps/web/src/pages/inventory/BatchCostAdjustments.tsx:413-424`（同一表格行内） | 「驳回」（:423） | 与 approve 共用 `canApprove`（:392） | 驳回 mutation `apps/web/src/pages/inventory/BatchCostAdjustments.tsx:171-177`；请求 `apps/web/src/pages/inventory/inventory-cost-adjustment-api.ts:81` 起 |

无 approve 端点的业务域在前端没有对应审批按钮：销售单页明确写「本批没有审批端点」（`apps/web/src/pages/sales/SalesOrdersPage.tsx:428`、`apps/web/src/pages/sales/sales-api.ts:15-16`）。

---

## 4. 设计稿对照（v0.9 / v0.10 / v0.11）

| 版本 | 文件:行号 | 原文片段 | 与第 1–3 节对照 | 设计有但代码没有 | 代码有但设计没画 |
|---|---|---|---|---|---|
| v0.9 | `design/v0.9/业务全流程图.html:98` | 「损耗率超阈值的审批」 | 后端加工单只有「完成 / 验收」语义（`packages/contracts/src/processing-orders.ts:395-396`），无按损耗率阈值触发的审批端点 | 阈值审批规则与端点 | — |
| v0.9 | `design/v0.9/冲正单据.html:98` | R-0088「待审批」 | `customer_return.complete` 的 action 是 `create`，不是 `approve`（`packages/contracts/src/customer-returns.ts:180-181`）；全仓 `action: 'approve'` 检索无客户退货端点 | 客户退货审批 | — |
| v0.9 | `design/v0.9/冲正单据.html:98` | I-0012「已审批」 | 盘点审批有端点（`packages/contracts/src/stocktakes.ts:258`）与按钮（`apps/web/src/pages/reversals/StocktakesPanel.tsx:513`） | — | — |
| v0.9 | `design/v0.9/工作台.html:61` | R-0088「待审批」 | 客户退货无 approve 端点（`packages/contracts/src/customer-returns.ts:181`） | 客户退货审批 | — |
| v0.9 | `design/v0.9/操作日志.html:98` | 「客户退货审批」 | 同上，后端无该动作 | 客户退货审批 | — |
| v0.9 | `design/v0.9/权限设置.html:100` | 「查看 / 新建 / 审批 / 导出」 | 契约动作表含 `approve`（`packages/contracts/src/domains.ts:44`）；前端权限矩阵测试覆盖 approve（`apps/web/src/lib/access.test.ts:42`） | — | — |
| v0.9 | `design/v0.9/盘点.html:95` | 筛选按钮「待审批」 | 前端筛选同样有「待审批」（`apps/web/src/pages/reversals/StocktakesPanel.tsx:206`） | — | — |
| v0.9 | `design/v0.9/盘点.html:98` | 「待审批」+ 按钮「审核」 | 状态存在（`packages/contracts/src/stocktakes.ts:45`）；按钮实际文案是「批准」（`apps/web/src/pages/reversals/StocktakesPanel.tsx:513`） | — | — |
| v0.9 | `design/v0.9/盘点.html:100` | 「盘盈盘亏需老板或经理审批……审批后自动生成 I 单冲正并写库存流水」 | 有端点 `stocktake.approve`（`packages/contracts/src/stocktakes.ts:258`）且审批同事务写库存调整（`apps/api/src/modules/inventory/usecases/stocktakes.ts:434-442`） | — | — |
| v0.9 | `design/v0.9/销售单E.html:21` | E-0308「待审核」；E-0306「草稿（需放行）」 | 销售单无 approve 端点；`sales.order.complete` 的 action 是 `update`（`packages/contracts/src/sales-orders.ts:264`） | 销售单审核 / 破成本放行审批 | — |
| v0.10 | `design/v0.10/业务全流程图.html:98` | 「损耗率超阈值的审批」 | 同 v0.9（`packages/contracts/src/processing-orders.ts:395-396`） | 阈值审批规则与端点 | — |
| v0.10 | `design/v0.10/冲正单据.html:98` | R-0088「待审批」；I-0012「已审批」 | 客户退货无 approve（`packages/contracts/src/customer-returns.ts:181`）；盘点有（`packages/contracts/src/stocktakes.ts:258`） | 客户退货审批 | — |
| v0.10 | `design/v0.10/工作台.html:131` | 「待审批」 | 客户退货无 approve 端点（`packages/contracts/src/customer-returns.ts:181`） | 客户退货审批 | — |
| v0.10 | `design/v0.10/工作台.html:138` | 「陈默 提交客户退货 R-0088 / 待你审批」 | 同上 | 客户退货审批 | — |
| v0.10 | `design/v0.10/操作日志.html:98` | 「客户退货审批」 | 同上 | 客户退货审批 | — |
| v0.10 | `design/v0.10/权限设置.html:100` | 「查看 / 新建 / 审批 / 导出」 | `packages/contracts/src/domains.ts:44`；`apps/web/src/lib/access.test.ts:42` | — | — |
| v0.10 | `design/v0.10/盘点.html:95` | 筛选「待审批」 | `apps/web/src/pages/reversals/StocktakesPanel.tsx:206` | — | — |
| v0.10 | `design/v0.10/盘点.html:98` | 「待审批」+「审核」 | `packages/contracts/src/stocktakes.ts:45`；`apps/web/src/pages/reversals/StocktakesPanel.tsx:513` | — | — |
| v0.10 | `design/v0.10/盘点.html:100` | 「盘盈盘亏需老板或经理审批……」 | `packages/contracts/src/stocktakes.ts:258` | — | — |
| v0.10 | `design/v0.10/销售单E.html:21` | 「待审核」；「草稿（需放行）」 | `packages/contracts/src/sales-orders.ts:264`；前端自述无审批端点（`apps/web/src/pages/sales/SalesOrdersPage.tsx:428`） | 销售单审核 / 破成本放行审批 | — |
| v0.11 | `design/v0.11/review-logic.md:30` | 「编辑/审核/查看/吊销」 | 这是审查文档对 9 个资料页通用按钮的描述；契约中未找到资料页的 approve 端点 | 资料页通用「审核」按钮无 approve 落点（盘点页除外） | — |
| v0.11 | `design/v0.11/review-logic.md:38` | 「列＝查看 / 新建 / 审批 / 导出」 | 权限矩阵的 approve 动作存在（`packages/contracts/src/domains.ts:44`） | — | — |
| v0.11 | `design/v0.11/review-logic.md:39` | 「查看/新建/审批/导出」 | 同上 | — | — |
| v0.11 | `design/v0.11/review-logic.md:77` | 「待审批 warn」状态色 | 盘点待审批状态与筛选均有实现（`apps/web/src/pages/reversals/StocktakesPanel.tsx:206`）；退货待审批无端点（`packages/contracts/src/customer-returns.ts:181`） | 退货待审批状态无后端动作 | — |
| v0.11 | `design/v0.11/业务全流程图.html:101` | 「损耗率超阈值的审批」 | `packages/contracts/src/processing-orders.ts:395-396` 只有完成 / 验收 | 阈值审批规则与端点 | — |
| v0.11 | `design/v0.11/冲正单据.html:101` | R-0088「待审批」；I-0012「已审批」 | 客户退货无 approve（`packages/contracts/src/customer-returns.ts:181`）；盘点有（`packages/contracts/src/stocktakes.ts:258`） | 客户退货审批 | — |
| v0.11 | `design/v0.11/审查报告.html:64` | 「编辑/审核/查看/吊销」 | 同 review-logic.md:30 | 资料页通用「审核」无 approve 落点 | — |
| v0.11 | `design/v0.11/审查报告.html:70` | 「查看 / 新建 / 审批 / 导出」 | `packages/contracts/src/domains.ts:44` | — | — |
| v0.11 | `design/v0.11/审查报告.html:71` | 「查看/新建/审批/导出」 | 同上 | — | — |
| v0.11 | `design/v0.11/审查报告.html:99` | 「待审批 warn」 | 同 review-logic.md:77 | 退货待审批无后端动作 | — |
| v0.11 | `design/v0.11/工作台.html:137` | 「待审批」 | 客户退货无 approve 端点（`packages/contracts/src/customer-returns.ts:181`） | 客户退货审批 | — |
| v0.11 | `design/v0.11/工作台.html:144` | 「陈默 提交客户退货 R-0088 / 待你审批」 | 同上 | 客户退货审批 | — |
| v0.11 | `design/v0.11/操作日志.html:101` | 「客户退货审批」 | 同上 | 客户退货审批 | — |
| v0.11 | `design/v0.11/权限设置.html:103` | 「查看 / 新建 / 审批 / 导出」 | `packages/contracts/src/domains.ts:44` | — | — |
| v0.11 | `design/v0.11/盘点.html:98` | 筛选「待审批」 | `apps/web/src/pages/reversals/StocktakesPanel.tsx:206` | — | — |
| v0.11 | `design/v0.11/盘点.html:101` | 「待审批」+ 按钮「审核」 | `packages/contracts/src/stocktakes.ts:45`；`apps/web/src/pages/reversals/StocktakesPanel.tsx:513` | — | — |
| v0.11 | `design/v0.11/盘点.html:103` | 「盘盈盘亏需老板或经理审批……」 | `packages/contracts/src/stocktakes.ts:258` | — | — |
| v0.11 | `design/v0.11/销售单E.html:22` | 「待审核」；「草稿（需放行）」 | `packages/contracts/src/sales-orders.ts:264`；`apps/web/src/pages/sales/SalesOrdersPage.tsx:428` | 销售单审核 / 破成本放行审批 | — |
| 三版均无 | （检索「成本更正」「确认结算」在三版设计稿中均无命中） | — | 代码有 T2 成本更正审批 / 驳回（`apps/web/src/pages/inventory/BatchCostAdjustments.tsx:411`、`:423`）与结算确认（`apps/web/src/pages/settlements/SettlementsPage.tsx:216`） | — | T2 成本更正「审批通过 / 驳回」、结算「确认结算」 |
| 三版均无 | `design/v0.11/采购单A.html:22` 表头无「操作」列（v0.9/v0.10 同为 `:21`） | — | 代码有「完成采购单」按钮（`apps/web/src/pages/purchase/PurchaseOrdersPage.tsx:638`） | — | 采购单完成 / 入库按钮 |
| 三版均无 | `design/v0.11/加工单B.html:22` 表头无「操作」列（v0.9/v0.10 同为 `:21`） | — | 代码有「完成 / 验收」按钮（`apps/web/src/pages/processing/ProcessingOrdersPage.tsx:1557`） | — | 加工单完成 / 验收按钮 |
| 三版均无 | `design/v0.11/结算单C.html:22` 表头无「操作」列（v0.9/v0.10 同为 `:21`） | — | 代码有「确认结算」按钮（`apps/web/src/pages/settlements/SettlementsPage.tsx:216`） | — | 结算确认按钮 |
| 三版均无 | `design/v0.11/工作台.html:133-138` 只画了客户退货 1 条待办 | — | 代码工作台按 7 条规则生成待办（`apps/web/src/pages/workbench/workbench-mock.ts:60-66`） | — | 采购 / 加工 / 销售 / 结算 / 供应商退货 / 盘点 6 类待办卡片 |

---

## 5. 工作台待办专项：`TODO_RULES` 逐条核查

数据源确认：工作台待办不是接口数据，而是 `fetchWorkbenchOverview(scope)` 的本地计算（`apps/web/src/pages/workbench/WorkbenchPage.tsx:385-387`），规则定义在 `apps/web/src/pages/workbench/workbench-mock.ts:59-67`，过滤条件是「`count > 0` 且该域持 `approve`」（`apps/web/src/pages/workbench/workbench-mock.ts:118-120`）。

| id | domain | title | 与 title 语义对应的后端 approve 端点 | 判定 | 证据 |
|---|---|---|---|---|---|
| `todo-purchase` | `purchase` | 「采购单待审核」 | 有 `action: 'approve'` 端点，但语义是「完成采购单并入库」，状态 `进行中 → 已完成`，无「待审核」中间态 | **待办条目无审核语义后端支撑，纯 mock**；不存在可查询的待审核采购单 | `packages/contracts/src/purchase-orders.ts:223-224`；`apps/api/src/modules/purchase/usecases/purchase-orders.ts:442`；普通单据三态 `packages/contracts/src/documents.ts:7` |
| `todo-processing` | `processing` | 「加工单待确认」 | `POST /api/v1/processing-orders/{id}/complete`（action `approve`），语义为「确认损耗、扣材料、生成产出批次」 | 有对应端点；但状态是 `进行中 → 已完成`，没有独立「待确认」态 | `packages/contracts/src/processing-orders.ts:395-396`；`apps/api/src/modules/processing/usecases/processing-orders.ts:513`；`apps/api/src/modules/processing/repo.ts:408`、`:420` |
| `todo-sales` | `sales` | 「销售单待审核」 | 无 approve 端点；`sales.order.complete` 的 action 是 `update` | **无后端支撑，纯 mock 数据** | `packages/contracts/src/sales-orders.ts:264`；`apps/web/src/pages/sales/SalesOrdersPage.tsx:428` |
| `todo-settlement` | `settlement` | 「结算单待确认」 | `POST /api/v1/settlement-orders/{id}/confirm`（action `approve`），`待确认 → 已结算` | 有对应端点 | `packages/contracts/src/settlement-orders.ts:201-203`；`apps/api/src/modules/settlement/repo.ts:443`、`:454` |
| `todo-customer-return` | `customer_return` | 「客户退货待审批」 | 无 approve 端点；`customer_return.complete` 的 action 是 `create` | **无后端支撑，纯 mock 数据** | `packages/contracts/src/customer-returns.ts:181` |
| `todo-supplier-return` | `supplier_return` | 「供应商退货待审批」 | 无 approve 端点；`supplier_return.complete` 的 action 是 `create` | **无后端支撑，纯 mock 数据** | `packages/contracts/src/supplier-returns.ts:120` |
| `todo-stocktake` | `stocktake` | 「盘点盈亏待审批」 | `POST /api/v1/stocktakes/{id}/approve`（action `approve`），`待审批 → 已批准` | 有对应端点 | `packages/contracts/src/stocktakes.ts:258-260`；`apps/api/src/modules/inventory/repo-stocktakes.ts:302`、`:309` |

**`GET /api/v1/todos` 是否存在**：不存在。契约源码 `packages/contracts/src`、后端 `apps/api/src`、`docs/api/openapi.yaml` 三处检索 `todo`（忽略大小写）均无该路由；唯一出现是前端文件里的 TODO 注释「TODO(接口待做): GET /api/v1/todos」（`apps/web/src/pages/workbench/workbench-mock.ts:9`）。工作台实际调用的是本地 `fetchWorkbenchOverview`（`apps/web/src/pages/workbench/WorkbenchPage.tsx:387`）。**结论：该接口在契约与后端均未找到证据。**

---

## 缺口清单

1. **采购单完成的权限口径三处打架**：契约写 `approve`（`packages/contracts/src/purchase-orders.ts:223`），前端按 `purchase.approve` 显隐按钮（`apps/web/src/pages/purchase/PurchaseOrdersPage.tsx:1205`），后端却要求 `purchase.update`（`apps/api/src/modules/purchase/usecases/purchase-orders.ts:432`）。只被授予 `approve` 的账号会看到按钮但请求 403；只被授予 `update` 的账号看不到按钮。
2. **客户退货「待审批」贯穿三版设计与工作台待办，但后端没有 approve 端点**：`customer_return.complete` 是 `create` 动作（`packages/contracts/src/customer-returns.ts:181`），设计稿见 `design/v0.11/工作台.html:137`、`design/v0.11/冲正单据.html:101`、`design/v0.11/操作日志.html:101`，待办见 `apps/web/src/pages/workbench/workbench-mock.ts:64`。
3. **供应商退货「待审批」同样无 approve 端点**：`supplier_return.complete` 是 `create` 动作（`packages/contracts/src/supplier-returns.ts:120`），待办见 `apps/web/src/pages/workbench/workbench-mock.ts:65`。
4. **销售单「待审核 / 需放行」无 approve 端点**：`sales.order.complete` 是 `update` 动作（`packages/contracts/src/sales-orders.ts:264`），设计见 `design/v0.11/销售单E.html:22`，待办见 `apps/web/src/pages/workbench/workbench-mock.ts:62`；前端自己已声明「本批没有审批端点」（`apps/web/src/pages/sales/SalesOrdersPage.tsx:428`）。
5. **加工单「损耗率超阈值的审批」只有设计，没有代码**：设计见 `design/v0.11/业务全流程图.html:101`；后端唯一 approve 动作是完成/验收（`packages/contracts/src/processing-orders.ts:395-396`）；未找到阈值审批端点或阈值配置的证据。
6. **4 个 approve 端点没有配套 reject**：只有成本更正有驳回（`packages/contracts/src/cost-adjustments.ts:196`）；盘点明确一期不做（`packages/contracts/src/stocktakes.ts:26`）；采购、加工、结算未找到证据。
7. **`GET /api/v1/todos` 不存在**：契约与后端均无该路由（检索无命中），工作台待办全部由本地规则生成（`apps/web/src/pages/workbench/workbench-mock.ts:9`、`apps/web/src/pages/workbench/WorkbenchPage.tsx:387`）。
8. **7 条待办规则里 4 条没有同语义 approve 端点**：`todo-sales` / `todo-customer-return` / `todo-supplier-return` 明确无（见上）；`todo-purchase` 的 approve 端点语义是「完成入库」而非「审核」（`packages/contracts/src/purchase-orders.ts:223-224`）。
9. **T2 成本更正审批 / 驳回在 v0.9–v0.11 三版设计稿里完全没画**：三版检索「成本更正」无命中；代码入口见 `apps/web/src/pages/inventory/BatchCostAdjustments.tsx:411`、`:423`。
10. **「确认结算」「完成采购单」「完成 / 验收」三个审批按钮在设计稿里没有落点**：结算 / 采购 / 加工三张设计页表头都没有「操作」列（`design/v0.11/结算单C.html:22`、`design/v0.11/采购单A.html:22`、`design/v0.11/加工单B.html:22`；v0.9/v0.10 同为 `:21`），而代码分别有按钮（`apps/web/src/pages/settlements/SettlementsPage.tsx:216`、`apps/web/src/pages/purchase/PurchaseOrdersPage.tsx:638`、`apps/web/src/pages/processing/ProcessingOrdersPage.tsx:1557`）。
11. **工作台待办的展示广度与设计不一致**：代码按 7 条规则生成（`apps/web/src/pages/workbench/workbench-mock.ts:60-66`），设计工作台只画了客户退货 1 条（`design/v0.11/工作台.html:133-138`）。
12. **文案差异（低风险）**：盘点页设计按钮是「审核」（`design/v0.11/盘点.html:101`），代码按钮是「批准」（`apps/web/src/pages/reversals/StocktakesPanel.tsx:513`）。

---

## 验收

- 报告文件：`docs/reports/audit-review-matrix-2026-11-15.md`（纯新增，未改代码、未改测试、未 commit）。
- 首次执行 `pwsh -NoProfile -File tests/run.ps1` 失败，失败项为 `platform-spec.test.ps1`、`workspace.test.ps1`；根因是仓库迁移后 `node_modules` 符号链接仍指向旧路径 `/d/Desktop/dsh/Qingdan/...`，`pnpm -r build` 报 `Cannot find module '...\node_modules\typescript\bin\tsc'`，`pnpm -r test` 报 `Cannot find module '...\node_modules\vitest\vitest.mjs'`，与本次新增 md 无关。
- 执行 `CI=true pnpm install --frozen-lockfile`（reused 307，6.8s）修复依赖链接后重跑，结果：`ALL PASSED (7 files)` / `OK 8 checks`；各包测试数：contracts 25 文件 257 例、api 70 文件 497 例、web 40 文件 360 例、cli 1 文件 17 例、mcp 1 文件 5 例，全部通过。
