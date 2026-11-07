# 模块：inventory（库存与批次）

> 所属交付模块：**M2 库存与盘点**（人类开发者 2）｜分支 `feat/m2-inventory`
> **负责人（inventory）**：梁海俊｜接手日期：2026-11-04

## 目标

做批次与库存这条**唯一账实真相**：锁价、占用、可用量、只追加流水、盘点冲正、成本更正。所有单据的库存动作都落到这里，别模块不许直接改批次数字。

## 范围与页面

- **功能域（D44）**：库存数量、库存流水、盘点调整 I。
- **页面**：13 库存数量、14 库存流水、15 盘点。
- **实体**：批次（锁定单价/入库量/已引用量/剩余量/在途占用/待执行占用/可用量/公司/保管人）、库存流水（批次/变动量/来源单据/经手人/时间）、盘点调整 I。
- **不做**：货物位置（二期，D6a）；盘点物理删除（禁止，只走冲正流水，D47）。

## 依赖

- 上游：platform（公司隔离、审批、取号）、masterdata（商品）。
- 下游：purchase（A 单入库锁价）、processing（B 单引用/产出批次）、sales（E 单引用批次）、internal-trade（N 单在途占用/转司）、settlement（成本与损失口径）。

## 开放项

- 已关闭：契约第一批 §11-3 由 **D67** 拍板为「四个基础列 + 两个数据库生成列」；
  不在应用层重复计算剩余量与可用量。

## 验收标准

- 库存数量页四列：入库量 / 剩余量 / 在途占用 / 可用量；**可用量是唯一可引用数字**（D38）。
- 选批次弹窗只显示可用量，不可引用行置灰并注明原因（在途占用 / 已出库 / 待执行，D38）。
- 提交即占用；取消时占用与单据同事务释放；出库把「待执行占用」转为「已引用量」，可用量不变、不重复扣（D41）。
- 库存流水只追加，与单据同事务写入（D2①）。
- 盘点：盘盈盘亏走冲正流水，不物理删除；发起拆成两个端点——盘盈 `stocktake.increase.create`（scope `stocktake.create`）、盘亏 `stocktake.decrease.create`（scope `stocktake.delete`），方向由入参 schema 锁死；老板/经理审批后追加流水（D47、D71）。
- 成本更正三段：T1 未被引用可改价重算（审批）、T2 逆向解锁后改（审批）、T3 锁定不改只留日志 + 免责说明（D37）；审批人老板/经理/财务（D42）。
- 批次保管人字段维护，变更留痕（F5）。

## 当前状态

进行中（2026-11-07）：批次只读 + 盘点 I 已实现（5 条，D71 拆分盘盈/盘亏）；**库存写联动（单据出入库流水）待 #79 / D70 落地**。

- 2026-11-05（Lead，Issue #78）：盘点 I 4 条端点接 HTTP——`stocktake.list.read / create / detail.read / approve`。
  - 迁移 `0017_inventory_stocktakes.sql`；三态审批流、单号按 D16、`diff_qty` 由 SQL 计算且 DB 兜底非零。
  - 审批：强 If-Match、非待审批 409 带 `details.reason`、AI 禁审批且必须给 reason；同一事务内先锁批次、校验
    调整后入库量与可用量均非负，再改 `inbound_qty` 并追加 `source_doc_type='stocktake'` 流水，行不物理删。
  - `apps/api/src/modules/inventory/services/stock-flow.ts` 是全仓唯一改批次数字的库存服务函数（D67）。
  - 测试：`inventory-http.test.ts` 新增 5 组（公司隔离、无差异 422、缺 If-Match 428、非待审批 409、盘亏超可用量 409）。
- 2026-11-06（Issue #84）：盘点审批审计增加批次 `custodianId` 快照，差异可直接追溯到实物责任人（F5）。
- 2026-11-07（Lead，Issue #84 / D71）：盘点发起拆两条端点，动作词表不动——
  - 盘盈 `stocktake.increase.create` → `POST /api/v1/stocktakes/increases`，scope `stocktake.create`；
  - 盘亏 `stocktake.decrease.create` → `POST /api/v1/stocktakes/decreases`，scope `stocktake.delete`
    （「仅删减」不新增动作名：D4 的 8 动作是全局封闭枚举，加动作会污染 22 个域的权限表）；
  - 原 `stocktake.create` 移除（契约未投产，前端已由 #90 撤回）；方向不符 422，文案写清「盘盈单要求实盘量大于账面量」；
  - seed：经理补 `stocktake.approve`（D47 明文老板或经理审批），采购 `read/create/delete`，纯仓管 `read/delete`；
  - 契约 5 条路由、OpenAPI 重新发射（paths 52 / operations 82），`inventory-http.test.ts` 增方向锁与仓管盘亏 201。

## 已完成

- 模块边界与功能域映射已登记。
- platform 与 masterdata 上游依赖已可用。
- Issue #48：库存首批契约、D67 占用字段口径、`0008_inventory_core.sql` 与
  inventory 模块路由骨架已合入 `main`。
- Issue #49：批次列表、批次详情、库存流水列表三条只读端点已接 HTTP。
- 新增 13 个 inventory 用例/HTTP 测试，覆盖 D15 公司隔离、D38/D67 四列、
  权限、cursor 分页、普通读不审计与无数据库 501。

## 进行中

- 库存写操作尚未开放；后续必须由 A/B/E/N/I/R/S 单据用例在同一事务内调用
  inventory 服务函数，禁止新增直接改库存的 HTTP 入口。

## 下一步

- 由采购/加工/销售/内部交易模块接入占用、释放、出库与冲正服务函数。
- 再实现盘点调整 I、成本更正 T1/T2/T3 与批次保管人变更留痕。

## 已知问题 / 坑

- 「剩余量 = 入库量 − 已引用量」与「可用量 = 剩余量 − 在途占用 − 待执行占用」是两个数：前端只给剩余量会被当成 bug（D38）。
- 出库时**不要把可用量再减一次**（D41）：占用转已引用，是两个内部量之间转账。
- 成本更正的 T2 走「取消下游 → 改价 → 重开下游」，必须同事务或可补偿，否则账面断裂（D37/D21）。
- `0008_inventory_core.sql` 的 `locked_unit_cost` / `custodian_id` 允许 NULL，但当前契约要求
  non-null；只读 repo 遇到缺值时报 `INTERNAL_ERROR`。后续写单据必须保证两列落值，
  是否收紧数据库约束需主线另行评审。

## 相关文件

- 口径：`docs/decisions.md`（D2/D5/D22/D31/D37/D38/D41/D42/D47）
- 契约：`docs/轻单_接口契约第一批_v1_20261103.md` §7/§8/§11
- 原型：`docs/prototype-v0.md` §2（页面 13-15）
- 实现：`apps/api/src/modules/inventory/{routes.ts,repo.ts,usecases/}`
