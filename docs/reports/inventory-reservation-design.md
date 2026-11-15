# 库存占用列设计方案

> Issue：`#264`  
> 取证基线：`f0ff4dd1376e92c3006c5ae108c2c97c7fa7c28e`  
> 本文件只给设计口径与落地顺序，不包含代码、契约或迁移改动。

## 0. 结论摘要

1. `referenced_qty` 表示**已经实际出库 / 领用完成的数量**，不是“建单时预留”。
2. `pending_execution_qty` 表示**已提交、尚未执行完成的单据占用**。
3. 销售 E、加工 B、供应商退货 S 在提交建单时占用；修改按差额调整，取消释放，完成时从待执行转为已引用。
4. 盘点 I 不占 `pending_execution_qty`：它是实物盘点的差异纠正，审批时重新校验可用量即可。
5. N 单仍只使用 `in_transit_qty`；A 采购与 R 客户退货不占用现有批次。
6. 两列继续作为库存批次上的持久化余额，不从 `inventory_flow` 聚合。
7. 当前实现把 E / B / S 的完成出库写成 `inbound_qty -= qty`，与 D41 的“出库转已引用”冲突；实现时必须先拆分库存写入语义，不能只补 `referenced_qty += qty`，否则会重复扣减。

## 1. 现有事实

### 1.1 数据库公式

- 四个基础列是 `inbound_qty`、`referenced_qty`、`in_transit_qty`、`pending_execution_qty`。
- `remaining_qty = inbound_qty - referenced_qty`。
- `available_qty = inbound_qty - referenced_qty - in_transit_qty - pending_execution_qty`。
- 数据库约束 `available_qty >= 0`。

依据：

- `apps/api/migrations/0008_inventory_core.sql:27-57`
- `apps/api/migrations/0008_inventory_core.sql:40-48`
- `packages/contracts/src/inventory.ts:64-75`

### 1.2 已冻结的占用生命周期

D41 明确写的是“提交即占用、取消释放、出库转已引用”；迁移文件进一步说明：出库时待执行占用转已引用，可用量保持不变、不重复扣。

依据：

- `docs/decisions.md:42`
- `apps/api/migrations/0008_inventory_core.sql:15`
- `packages/contracts/src/inventory.ts:10`

### 1.3 当前缺口

- `referenced_qty` 与 `pending_execution_qty` 在业务代码中没有写入方，只有库存读取、测试手工写入和当前出库调整 `inbound_qty`。
- 库存详情中的 `pendingOccupancies` 固定返回空数组。

依据：

- `apps/api/src/modules/inventory/repo.ts:148-153`
- `apps/api/src/modules/inventory/repo.ts:167`
- `packages/contracts/src/inventory.ts:34-42`
- `packages/contracts/src/inventory.ts:94`

## 2. 四个问题的结论

### 2.1 `referenced_qty` 的语义

`referenced_qty` = **从该批次实际发出或领用后，累计转入“已引用”的数量**。

- 建单只进入待执行占用，不直接写 `referenced_qty`。
- 完成 E 销售出库、B 加工领料、S 供应商退货出库时，把相应待执行量转成已引用量。
- 取消只释放待执行量，不影响已引用量。
- `inbound_qty` 表示累计入库量；出库不应再直接减 `inbound_qty`。

依据：

- `docs/decisions.md:42`
- `apps/api/migrations/0008_inventory_core.sql:15`
- `apps/api/migrations/0008_inventory_core.sql:45-48`

### 2.2 哪些动作写 `referenced_qty`

| 动作             | 是否写已引用 | 说明                                 | 依据                                                                                                    |
| ---------------- | ------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| E 销售单完成     | 是           | 实际出库时从待执行转已引用           | `apps/api/src/modules/sales/usecases/sales-orders.ts:697-779`                                           |
| B 加工单完成     | 是           | 材料被实际领用，按材料行数量转已引用 | `apps/api/src/modules/processing/usecases/processing-orders.ts:493-585`                                 |
| S 供应商退货完成 | 是           | 实际退货出库时从待执行转已引用       | `apps/api/src/modules/purchase/usecases/supplier-returns.ts:277-318`                                    |
| A 采购完成       | 否           | A 单创建新批次，不引用已有批次       | `apps/api/src/modules/purchase/usecases/purchase-orders.ts:445-454`                                     |
| R 客户退货完成   | 否           | R 是实物入库，不产生已引用量         | `apps/api/src/modules/sales/usecases/customer-returns.ts:345-374`                                       |
| I 盘点审批       | 否           | 盘盈/盘亏是入库量纠正，不是出库引用  | `apps/api/src/modules/inventory/usecases/stocktakes.ts:434-442`                                         |
| N 到货确认       | 否           | N 使用在途量和批次转司，不进入已引用 | `docs/decisions.md:66`、`apps/api/src/modules/internal-trade/usecases/internal-trade-orders.ts:721-746` |

### 2.3 `pending_execution_qty` 对应哪些动作

| 动作              | 处理方式                                       | 依据                                                                                                  |
| ----------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| E 销售单建单      | 按商品行引用的批次等额占用                     | `apps/api/src/modules/sales/repo.ts:439-441`、`:636-682`                                              |
| E 销售单修改      | 释放旧占用，再按新明细原子占用                 | `apps/api/src/modules/sales/usecases/sales-orders.ts:567-627`                                         |
| E 销售单取消      | 释放全部待执行占用                             | `apps/api/src/modules/sales/usecases/sales-orders.ts` 的取消流程；`docs/decisions.md:42`              |
| E 销售单完成      | 待执行转已引用并追加负库存流水                 | `apps/api/src/modules/sales/usecases/sales-orders.ts:697-779`                                         |
| B 加工单建单      | 按 `materialBatchIds[].qty` 占用               | `packages/contracts/src/processing-orders.ts:53-58`、`:154-159`                                       |
| B 加工单修改      | 释放旧材料占用，按新行原子占用                 | `apps/api/src/modules/processing/repo.ts:648-748`                                                     |
| B 加工单取消      | 释放全部材料占用                               | `apps/api/src/modules/processing/repo.ts:749-780`                                                     |
| B 加工单完成      | 待执行转已引用并追加负库存流水                 | `apps/api/src/modules/processing/usecases/processing-orders.ts:493-585`                               |
| S 供应商退货建单  | 按退货行引用批次等额占用                       | `packages/contracts/src/supplier-returns.ts:41-51`、`apps/api/src/modules/purchase/repo.ts:1046-1110` |
| S 供应商退货取消  | 释放全部待执行占用；当前缺该端点，必须先补     | `packages/contracts/src/supplier-returns.ts:112-162`                                                  |
| S 供应商退货完成  | 待执行转已引用并追加负库存流水                 | `apps/api/src/modules/purchase/usecases/supplier-returns.ts:277-318`                                  |
| N 建单            | 不占待执行量；仍保持“进行中”                   | `docs/decisions.md:66`                                                                                |
| N 确认发货        | 占用 `in_transit_qty`                          | `apps/api/src/modules/internal-trade/repo.ts:743-791`                                                 |
| N 撤销发货        | 释放 `in_transit_qty`                          | `apps/api/src/modules/internal-trade/repo.ts:837-859`                                                 |
| I 盘点提交/待审批 | **不占用待执行量**；审批时按当时可用量校验盘亏 | `apps/api/src/modules/inventory/services/stock-flow.ts:366-420`                                       |

你已确认的口径：

- S 选 A：建单即占，后续实现必须先补取消释放路径。
- 盘点选 A：待审批期间不冻结 `pending_execution_qty`。

### 2.4 是否从 `inventory_flow` 聚合

**结论：不采用聚合，继续使用持久化余额列。**

原因：

1. `inventory_flow` 只记录实际入出库的 `delta`，没有“占用 / 释放 / 转已引用”的事件类型。
   - `packages/contracts/src/inventory.ts:103-121`
2. 建单占用和取消释放不会改变实物库存，不应伪造零数量或非实物流水。
   - `docs/decisions.md:65`
3. D67 已明确一期不建占用明细表；余额列就是占用状态的持久化载体。
   - `docs/decisions.md:65`
4. 从流水无法可靠区分历史出库、盘亏、退货入库与转司，所以不能作为两个占用余额的唯一真源。
   - `apps/api/migrations/0008_inventory_core.sql:45-48`

待执行占用的**来源明细**另走只读端口：各来源模块返回活动单据的 `sourceDocType / sourceDocId / qty`，由 inventory 聚合给批次详情使用。库存模块不直读其他模块表（D70）。

依据：

- `docs/decisions.md:69`
- `apps/api/src/platform/services/registry.ts:327-338`
- `packages/contracts/src/inventory.ts:37-42`
- `apps/api/src/modules/inventory/repo.ts:163-167`

## 3. 目标生命周期

### 3.1 统一动作模型

库存写入端口需要把当前一个宽泛的 `applyAdjustment` 拆成有业务含义的动作：

| 端口动作                 | 库存列变化                                  | 流水         | 用途                           |
| ------------------------ | ------------------------------------------- | ------------ | ------------------------------ |
| `reserve`                | `pending += qty`，并校验 `available >= qty` | 无           | E / B / S 建单与扩量           |
| `release`                | `pending -= qty`                            | 无           | 改单缩量、取消                 |
| `commitReservation`      | `pending -= qty`、`referenced += qty`       | 追加 `-qty`  | E / B / S 完成出库             |
| `applyInboundAdjustment` | `inbound += delta`                          | 追加 `delta` | A/B 新批次、R 入库、I 盘盈盘亏 |
| `transferBatches`        | 仅转移公司，按 N 现有规则处理在途量         | 维持现状     | N 到货                         |

关键约束：

- 所有动作必须复用调用方业务事务。
- 所有批次先按 batchId 排序，再统一 `FOR UPDATE`，避免多批次订单互相死锁。
- 同批次多行数量先聚合，再执行一次占用或释放。
- `reserve` / `commitReservation` 都要校验“变更后 available 非负”和“待执行量足够”。
- 任一明细失败，整张单据事务回滚。

### 3.2 出库时不重复扣量

当前 `applyStockAdjustment` 对负 delta 执行：

`SET inbound_qty = inbound_qty + delta`

依据：`apps/api/src/modules/inventory/services/stock-flow.ts:366-432`

新口径下，E / B / S 完成时只做：

`pending_execution_qty -= qty`  
`referenced_qty += qty`

这时：

- `remainingQty` 减少 `qty`；
- `availableQty` 保持不变，因为待执行和已引用合计不变；
- 同时追加 `delta = -qty` 的实物出库流水。

不能再让同一笔完成同时减 `inbound_qty` 和加 `referenced_qty`，否则会双扣。

### 3.3 页面占用来源

`InventoryBatchDetail.pendingOccupancies` 不直接查其他模块表，而由新增只读聚合端口提供：

```text
inventory 详情
  → 已注册的待执行占用检查端口
  → sales / processing / purchase 分别返回活动单据占用
  → inventory 合并为 sourceDocType + sourceDocId + qty
```

这保持 D70 边界，也解决当前详情永远显示“无待执行占用”的问题。

依据：

- `apps/api/src/modules/inventory/repo.ts:163-167`
- `packages/contracts/src/inventory.ts:34-42`
- `apps/web/src/pages/inventory/InventoryPage.tsx:223-242`
- `docs/decisions.md:69`

## 4. 最小落地顺序

### 第一步：主线确认端口与 S 取消前置

- 确认 `StockFlowPort` 新增 `reserve / release / commitReservation`，保留入站纠正动作。
- 先补 `supplier_return.cancel` 的契约、状态机和前端入口。
- 若不先补 S 取消，不允许上线 S 建单占用，否则未完成 S 单会永久占用库存。

涉及：

- `apps/api/src/platform/services/registry.ts`
- `packages/contracts/src/supplier-returns.ts`
- `apps/api/src/modules/purchase/routes.ts`
- `apps/web/src/pages/reversals/SupplierReturnsPanel.tsx`

### 第二步：先做库存服务原子能力

- 实现 reserve / release / commitReservation。
- 保持 `available_qty` 生成列不变。
- 当前 `applyStockAdjustment` 改名为入站/盘点纠正，禁止 E/B/S 出库继续调用。
- 增加并发、余额不足、待执行不足、重复释放、排序锁批次测试。

涉及：

- `apps/api/src/modules/inventory/services/stock-flow.ts`
- `apps/api/src/modules/inventory/services/ports.ts`
- `apps/api/src/modules/inventory/services/stock-flow-create-batch.test.ts`
- `apps/api/src/modules/inventory/inventory-http.test.ts`

### 第三步：接 E 销售单

- 建单：占用。
- 改单：释放旧明细，再占用新明细。
- 取消：释放。
- 完成：待执行转已引用并写一条负流水。
- 可用量不足时建单直接 409，不再等完成时才失败。

涉及：

- `apps/api/src/modules/sales/usecases/sales-orders.ts`
- `apps/api/src/modules/sales/repo.ts`
- `apps/api/src/modules/sales/sales-order-complete.test.ts`
- `apps/api/src/modules/sales/usecases/sales-orders.test.ts`
- `apps/api/src/modules/sales/sales-orders-http.test.ts`

### 第四步：接 B 加工单

- 建单：按材料行占用。
- 改单：释放旧材料行，再占用新行。
- 取消：释放。
- 完成：待执行转已引用，再生成产出批次。
- 材料不足在建单时拒绝，不再拖到完成时才发现。

涉及：

- `apps/api/src/modules/processing/usecases/processing-orders.ts`
- `apps/api/src/modules/processing/repo.ts`
- `apps/api/src/modules/processing/usecases/processing-orders.test.ts`
- `apps/api/src/modules/processing/processing-orders-http.test.ts`

### 第五步：补 S 取消并接 S 供应商退货

- 新增取消/释放流程。
- 建单占用、取消释放、完成转已引用。
- S 没有修改端点，本期不做改单差额逻辑。

涉及：

- `apps/api/src/modules/purchase/usecases/supplier-returns.ts`
- `apps/api/src/modules/purchase/repo.ts`
- `apps/api/src/modules/purchase/usecases/supplier-returns.test.ts`
- `apps/web/src/pages/reversals/SupplierReturnsPanel.tsx`

### 第六步：接占用来源与页面

- 实现活动 E / B / S 单的待执行占用只读聚合。
- 库存详情显示真实来源单；列表四列继续使用数据库生成值。
- 销售/加工页面选批次时使用服务端 `availableQty`，不在前端自行猜测锁量。

涉及：

- `apps/web/src/pages/inventory/InventoryPage.tsx`
- `apps/web/src/pages/sales/SalesOrdersPage.tsx`
- `apps/web/src/pages/processing/ProcessingOrdersPage.tsx`
- `apps/web/src/pages/reversals/SupplierReturnsPanel.tsx`
- `apps/web/src/pages/internal-trades/InternalTradeOrdersPage.tsx`

### 第七步：历史数据切换

若目标环境已有真实数据：

1. 对历史 `inventory_flow` 中 `delta < 0` 且来源为 E / B / S 的流水，按批次汇总为历史已引用量。
2. 因为旧实现曾用这些负流水直接减 `inbound_qty`，迁移时需把对应绝对量加回 `inbound_qty`，再写入 `referenced_qty`，保持当前可用量不变。
3. 对当前活动的 E / B / S 单补 `pending_execution_qty`。
4. 盘亏流水 `stocktake` 不回填成已引用，仍属于入库量纠正。
5. 迁移前后逐批次校验：
   - `remaining = inbound - referenced`
   - `available = remaining - in_transit - pending`
   - 迁移前后 `available` 不变
   - 四列均非负

空库/演示库可跳过历史流水回填，但仍需给活动单补占用。

## 5. 影响面

### 5.1 后端测试

- `apps/api/src/modules/inventory/services/stock-flow-create-batch.test.ts`
- `apps/api/src/modules/inventory/inventory-http.test.ts`
- `apps/api/src/modules/sales/sales-order-complete.test.ts`
- `apps/api/src/modules/sales/usecases/sales-orders.test.ts`
- `apps/api/src/modules/sales/sales-orders-http.test.ts`
- `apps/api/src/modules/processing/usecases/processing-orders.test.ts`
- `apps/api/src/modules/processing/processing-orders-http.test.ts`
- `apps/api/src/modules/purchase/usecases/supplier-returns.test.ts`
- `apps/api/src/modules/internal-trade/usecases/internal-trade-orders.test.ts`
- `apps/api/src/modules/inventory/inventory-http.test.ts` 的盘点用例
- `apps/api/src/platform/db/e2e-business-flow.integration.ts`
- `apps/api/src/platform/db/db-concurrency.integration.ts`

### 5.2 前端页面与测试

- `apps/web/src/pages/inventory/InventoryPage.tsx`
- `apps/web/src/pages/inventory/InventoryPages.test.tsx`
- `apps/web/src/pages/sales/SalesOrdersPage.tsx`
- `apps/web/src/pages/sales/SalesOrdersPage.test.tsx`
- `apps/web/src/pages/processing/ProcessingOrdersPage.tsx`
- `apps/web/src/pages/processing/ProcessingOrdersPage.test.tsx`
- `apps/web/src/pages/reversals/SupplierReturnsPanel.tsx`
- `apps/web/src/pages/reversals/ReversalsPage.test.tsx`
- `apps/web/src/pages/internal-trades/InternalTradeOrdersPage.tsx`
- `apps/web/src/pages/internal-trades/InternalTradeOrdersPage.test.tsx`
- `apps/web/src/pages/flow/FlowPage.tsx` 与对应测试中的库存口径说明

## 6. 验收标准

实现单至少满足：

1. E / B / S 建单后，目标批次 `pending_execution_qty` 立即增加，`available_qty` 立即减少。
2. 改单缩量/换批次后，旧占用释放、新占用生效；总额与明细一致。
3. 取消 E / B / S 后占用为 0，可用量恢复。
4. 完成 E / B / S 后待执行量归零、已引用量增加，可用量不在完成瞬间二次减少，库存流水只有一条实际出库负流水。
5. 盘点待审批不改变 `pending_execution_qty`；盘亏审批仍按当时可用量校验，不足则整单回滚。
6. N 发货仍只增加 `in_transit_qty`，撤销释放，到货按现规则转司。
7. 任一单据整单失败时，库存四列、流水、单据和审计全部回滚。
8. 同批次并发占用/释放不会死锁，最终余额满足数据库非负约束。

## 7. 明确不做

- 不改 `in_transit_qty` 现有口径。
- 不把占用状态写进 `inventory_flow` 伪造零变化事件。
- 不新增一期占用明细表。
- 不由 inventory 直接读取 sales / processing / purchase 的表。
- 不在本设计单修改代码、契约或迁移。
