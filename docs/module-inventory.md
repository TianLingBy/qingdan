# 模块：inventory（库存）

> 口径真源：`docs/TEAM-PLAN.md`、#136 负责人拍板评论与 #137 子单。
> 本文件只记模块边界与进度，不改业务口径。

## 目标

维护库存批次、库存流水与盘点，并作为全仓唯一库存写入实现，供 A / B / E / N / R / S / I 等单据在各自事务内调用。

## 范围与页面

- 后端：批次、流水、盘点的查询与写入服务。
- 页面：库存数量、库存流水、盘点；负责人为梁海俊。
- 不做：不开放直接修改库存的 HTTP 写端点；跨模块写入只经 `StockFlowPort`。

## 依赖

- 上游：`platform` 提供租户上下文、取号与应用端口定义；`masterdata` 提供商品归属。
- 下游：`processing` 通过 `StockFlowPort.createBatch` 写入产出批次。
- 商品、员工与公司校验通过 SQL 与端口命令完成，库存模块不拥有这些主数据。

## 开放项

- `StockFlowPort.createBatch` 与 `takeBatchNo` 已随 #162 合入主干；inventory 端口已接真实创建批次服务。
- #100、#97 所需的成本更正与利润报表结构/聚合端口已随 #163、#164 合入主干。

## 验收标准

- 新批次按 `PB-<公司码4>-<日期8>-<流水4>` 服务端取号。
- 批次、正数入库流水同事务写入，调用方回滚时全部撤销。
- 商品必须属于同一租户与公司；数量必须大于 0；锁定单价不得为负。
- 库存不足时拒绝扣成负数，并返回批次与数量明细。

## 当前状态

进行中：`createBatch` 服务、平台取号器和 `StockFlowPort` 接线均已完成，PR #157 等待最终门禁与评审；库存前端三页在 PR #182。成本更正与利润报表已具备主线结构，后续按任务推进。

## 已完成

- 2026-11-08：#137 `createBatch` 服务实现，使用 `number_sequence` 原子取 `PB` 批号。
- 2026-11-08：批次与入库流水同事务写入；商品跨公司、非法数量/单价拒绝；事务回滚测试。
- 2026-11-08：定向测试 5 项、inventory 测试 23 项、完整 API 测试 366 项均通过；API 类型检查与 ESLint 通过。
- 2026-11-09：#150 已按方案 A 合并到主干，`processing_order.output_product_id` 与 contracts/repo 已就绪。
- 2026-11-09：#137 分支 `e88bf21` 已推送；随后同步最新 `main` 并以 merge commit `814eb72` 更新 PR #157，远端 head 一致且可合并。合并后 `pnpm -r build`、`pnpm -r test`（API 57 个文件 / 381 项）与 `pwsh -NoProfile -File tests\run.ps1`（`ALL PASSED (7 files)`）全部通过；PR 的 7 项 CI 全部通过。
- 2026-11-10：同步主干 `8416a33` 到 PR #157，新 head `bb25d6e`；`pnpm -r build`、`pnpm -r typecheck`、`pnpm -r test`（API 57 个文件 / 381 项，Web 8 个文件 / 52 项）与 `tests\run.ps1` 全部通过，7 项 CI 全绿。最新主干 `StockFlowPort` 仍只有 `applyAdjustment`，#162 未解除。
- 2026-11-10：#162 合入主干，`createBatch` 改用 platform `takeBatchNo`，并按端口命令补齐 `handledBy`；`inventory/services/ports.ts` 已删除 NOT_IMPLEMENTED 占位并接真实服务，定向测试与 API typecheck 通过。
- 2026-11-10：库存前端数量、流水、盘点三页已实现并创建 PR #182，复用主线权限、decimal 与盘点面板。

## 进行中

- #137：端口接线已完成，等待全量门禁、PR #157 CI 与评审。
- #182：库存前端三页等待 CI 与评审；利润报表页仍不包含。

## 下一步

- #137 合并后接 #138；#150 已关闭，B 单可直接使用单头 `outputProductId`。
- 复核 #177 后继续推进 #100，复核 #178 后继续利润报表与前端。

## 已知问题 / 坑

- #137 正文提到“库存不足”测试，但 `createBatch` 只新增批次、不扣减已有库存，该场景无法由本函数产生；库存不足的拒绝测试属于后续按材料批次扣减的 #138。
- #100 不能把成本差额写进 `inventory_flow.delta`，否则会错误改变库存数量；也不能由 inventory 直接查询 processing / sales / settlement 表。
- 当前工作区尚无历史 `docs/module-inventory.md`，本文件从 `docs/module-template.md` 建立并在本任务开始留痕。

## 相关文件

- `apps/api/src/modules/inventory/services/stock-flow.ts`
- `apps/api/src/modules/inventory/services/stock-flow-create-batch.test.ts`
- `apps/api/src/modules/inventory/services/ports.ts`
