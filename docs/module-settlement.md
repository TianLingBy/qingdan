# 模块：settlement（结算、提成与利润报表）

> 所属交付模块：**MAIN 主线**（负责人 + DSH 智能体团队）｜分支 `feat/main-settlement`

## 目标

把「一单一成本、一单一毛利」变成可结算的数字：C 单算毛利并按快照计提成，利润报表按「毛利 − 全损耗损失 = 净毛利」展示且支持未归属损失下钻。

## 范围与页面

- **功能域（D44）**：结算单 C、提成、利润报表。
- **页面**：7 结算单 C、20 利润报表。
- **实体**：C 结算单（单号/来源单/总售价/总成本/毛利/毛利率/本单相关损失/净毛利/提成比例快照/提成金额/状态）、提成记录；利润报表为查询视图。
- **不做**：借贷/总账/凭证（D2 非目标）；代发工资与提成记账（D11）；集团合并指标（D45）。

## 依赖

- 上游：platform（权限/取号/审批）、sales（E 单完成事件、退款重算事件）、internal-trade（N 单完成事件）、inventory（成本）、processing（损失记录/归属单）。
- 下游：无（报表是末端）。

## 开放项

- 契约第一批 §11-5：**C 单「本单相关损失」是否实时重算** —— 拟定结算时快照。开工前拍板并追加 decisions.md。
- 契约第二批 §4-3：**提成比例按人还是按岗** —— 拟定按岗设、可覆盖到人。
- 契约第二批 §4-4：**E→N 提成归属** —— 拟定归 E 单负责人（跨公司时归属人所在公司待定）。
- 契约第二批 §4-5：**提成负数处理** —— 已由 D5④ 定「负毛利记 0」，仅确认。

## 验收标准

- E/N 单单头「已完成」自动生成 C 单草稿，财务确认后生效；一期一单一次结算，不支持部分/多次（D19/D29）。
- 毛利 = 总售价 − 总成本；毛利率 = 毛利 ÷ 总售价（D5）。
- 本单相关损失 = Σ(归属单 = 本单对应 E/N 单 的 B 单损失金额)；N 单的 C 单 = 挂在本 N 单上的 + 挂在其源 E 单上的，同一条 E→N 只算一次（D35）。
- 净毛利 = 毛利 − 本单相关损失；只做展示层聚合，不改 D5 公式（D26/D33）。
- 提成：比例按人/岗设、结算时快照、改比例不重算历史单、负毛利记 0；减成交额退款按快照比例重算并留痕，纠收款退款不重算（D5④/D36/D40）。
- C 单状态：待确认 / 已结算；结算后不可冲正，走退货（D2③）。
- 利润报表：期间「毛利 − 全损耗损失 = 净毛利」两行；未归属损失可下钻（来源 B 单、金额、归属状态）；金额受「看价」权限管（D26/D43/D27）。

## 当前状态

C 单 3 端点 + 提成比例配置 3 端点已实现（2026-11-07）；C 单金额已按「看价」脱敏（D78）；本模块端点 0 个 501

## 已完成

- 模块边界与功能域映射已登记。
- **2026-11-05 C 单 3 端点实现（PR #77）**：`apps/api/migrations/0016_settlement_orders.sql`（来源单唯一约束 + 金额约束 + ENABLE/FORCE RLS，禁删授权）+ `modules/settlement/{repo.ts,usecases/settlement-orders.ts,routes.ts}`；list/detail/confirm 接 HTTP；confirm 需 `settlement.approve`、AI 禁止审批（D52.1，必须带 reason）、成功后冻结 `related_loss_amount_snapshot`（**D69 落地**）；一期一单一次结算（D19）。**未做**：E/N 完成态自动生成 C 单草稿（无跨模块读取通道，`TODO(D19)` 留在迁移与用例里）。测试 +4（apps/api 41 文件 295 例），tsc 0，全量门禁 ALL PASSED。
- **2026-11-07 提成比例配置 + 确认时算提成（D77，Issue #96）**：`apps/api/migrations/0018_settlement_commission.sql`（`commission_rate` 表：租户+公司+员工+生效日唯一、rate CHECK 0..1、RLS；`settlement_order.commission_owner_id` 可空列）+ `packages/contracts/src/commission-rates.ts`（3 端点：list / create / delete）+ `modules/settlement/{repo.ts,usecases/commission-rates.ts,routes.ts}`；确认结算时按归属人在本公司的**最新生效比例**解析（无配置记 0、负毛利记 0）并同事务快照，改配置不影响已结算单。E 单完成时把来源单负责人写进 `commission_owner_id`（D72 ④ 的提成占位由本项收口）；`SettlementDraftPort` 命令新增 `commissionOwnerId`。测试：契约 253 例（+13）、api 314 例（+4，含配置 CRUD / 权限与公司隔离 / 算提成 / 负毛利与无配置）；`pnpm openapi` → paths 55 / operations 86 / schemas 38。

- **2026-11-07 看价脱敏 + 敏感金额读取审计（D78）**：`apps/api/src/modules/settlement/services/masking.ts`（`maskSettlementAmounts` 把 7 个金额字段置 null）+ `apps/api/src/platform/audit/sensitive-read.ts`（`recordAmountDetailRead`，持 `settlement.view_price` 时写 `action='amount.detail'` 审计）+ `usecases/settlement-orders.ts` 的 list/detail/confirm 接线；契约 `SettlementOrderSchema` 的 7 个金额字段改 `.nullable()`（`commissionRateSnapshot` 不脱敏）。口径：无看价权限**记录可见、金额为 null、不 403**；列表不记敏感读，只有详情记。测试：新增 `settlement-amount-masking.test.ts` 5 例（有价可见+审计、无价 null+不记、列表脱敏、销售只读、列表不记审计）+ 1 例确认响应脱敏，api 45 文件 320 例；契约 253 例；`pnpm openapi` 仍 paths 55 / operations 86 / schemas 38。

## 进行中
- **2026-11-07 D70 端口就绪（Issue #79）**：apps/api/src/modules/settlement/services/drafts.ts 提供
  SettlementDraftPort.createDraft(tx, command)——金额与佣金费率快照由来源模块算好传入，settlement 不读 E/N 表；
  同事务、来源单唯一（重复 409）、实现在 outbox 追加一行审计并返回 auditId 由调用方提交后 flush。
  端口已在 registerModules() 注册（platform/services/registry.ts），测试 services/drafts.test.ts 3 例。
  **已接线 E 单**（D72，2026-11-07）：`sales.order.complete` 在同一事务里调本端口生成草稿；N 单完成仍未接线。
  草稿的 `relatedLossAmount` 与提成比例/金额本期由调用方传 `0`（D35 / D5④ 未落地，见 D72 ④）。

## 下一步

- 拍板四个开放项 → 追加 decisions.md。
- 等 sales 的「E 单完成」事件与 processing 的损失记录就绪后开工。
- 提成「按岗」配置（D5④ 另一半）待 platform 岗位解析端口落地；利润报表（#97）待口径（D26/D43）。
- sales / purchase 的金额脱敏按 D78 口径从 D79 起追加（同一套 `view_price` + `amount.detail`）。

## 已知问题 / 坑

- 报表净毛利 ≠ 各 C 单净毛利之和，差额 = 未归属损失，必须可下钻说明（D26）；口径写错会被当成 bug。
- 提成必须**快照**比例，否则「改比例不重算历史单」无法执行（D36）。
- 损失金额与提成金额都受「看价」权限管：接口返回前就要过滤，不能只靠前端隐藏（D27）。

## 相关文件

- 口径：`docs/decisions.md`（D2/D5/D11/D19/D26/D27/D29/D33/D35/D36/D40/D43/D45）
- 契约：`docs/轻单_接口契约第一批_v1_20261103.md` §3.4/§9/§11；`docs/轻单_接口契约第二批_v1_20261103.md` §2/§4
