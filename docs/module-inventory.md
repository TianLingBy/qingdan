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

- `StockFlowPort.createBatch` 已由 #136 拍板命令与返回结构，#147 未把接口写入 `apps/api/src/platform/services/registry.ts`，由主线补齐。

## 验收标准

- 新批次按 `PB-<公司码4>-<日期8>-<流水4>` 服务端取号。
- 批次、正数入库流水同事务写入，调用方回滚时全部撤销。
- 商品必须属于同一租户与公司；数量必须大于 0；锁定单价不得为负。
- 库存不足时拒绝扣成负数，并返回批次与数量明细。

## 当前状态

进行中：`createBatch` 服务与测试已完成，等待平台端口接口后接线。

## 已完成

- 2026-11-08：#137 `createBatch` 服务实现，使用 `number_sequence` 原子取 `PB` 批号。
- 2026-11-08：批次与入库流水同事务写入；商品跨公司、非法数量/单价拒绝；事务回滚测试。
- 2026-11-08：定向测试 5 项、inventory 测试 23 项、完整 API 测试 366 项均通过；API 类型检查与 ESLint 通过。

## 进行中

- #137：等待负责人把 #136 已批准的 `CreateBatchCommand` / `CreateBatchReceipt` 与 `createBatch` 方法补进平台 `StockFlowPort`，随后在 `apps/api/src/modules/inventory/services/ports.ts` 接线。

## 下一步

- 平台接口合并后完成端口映射，重跑 #137 的三条验收命令并开 PR。
- #138 依赖 #150 对成品商品字段的拍板，批准前不修改 processing 完成链路。

## 已知问题 / 坑

- #137 正文提到“库存不足”测试，但 `createBatch` 只新增批次、不扣减已有库存，该场景无法由本函数产生；库存不足的拒绝测试属于后续按材料批次扣减的 #138。
- 当前工作区尚无历史 `docs/module-inventory.md`，本文件从 `docs/module-template.md` 建立并在本任务开始留痕。

## 相关文件

- `apps/api/src/modules/inventory/services/stock-flow.ts`
- `apps/api/src/modules/inventory/services/stock-flow-create-batch.test.ts`
- `apps/api/src/modules/inventory/services/ports.ts`
