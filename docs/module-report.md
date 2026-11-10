# 模块：report（报表）

> 口径真源：#97 / #164、`packages/contracts/src/profit-report.ts`。
> 本文件只记模块边界与进度，不改业务口径。

## 目标

按期间汇总已结算 C 单毛利和 B 单全损耗，计算净毛利，并提供未归属损失下钻入口。

## 范围与页面

- 后端：`GET /api/v1/reports/profit`、`GET /api/v1/reports/profit/losses`。
- 页面：利润报表。
- 本期 `unattributedLoss = null`、`unattributedLossAvailable = false`，前端隐藏下钻入口。

## 依赖

- settlement 提供 `SettlementProfitAggregateSource.aggregateSettledProfit`。
- processing 提供 `ProcessingLossAggregateSource.aggregateFullLoss`。
- report 只编排端口，不直接读取结算或加工表。

## 验收标准

- 金额使用 decimal 字符串，净毛利 = 毛利 − 全损耗损失。
- 无 `profit_report.view_price` 时金额字段为 `null`，不出 0、不 403。
- 显式请求不可见公司时拒绝。
- 期间起止倒置时返回 `VALIDATION_FAILED`。

## 当前状态

后端编排已实现并等待 PR/CI；真实数据返回取决于 settlement / processing 两个聚合端口是否注册。

## 已完成

- 2026-11-10：实现利润报表与损失下钻的端口编排、companyIds 隔离、期间校验和字段级看价脱敏。
- 2026-11-10：定向测试 5 项通过，覆盖净毛利定点计算、无看价掩码、跨公司拒绝、期间校验和损失下钻脱敏。

## 进行中

- 等待 settlement / processing 聚合端口实现并注册后验证真实数据端到端。

## 下一步

- PR 合并后监控真实端口注册状态；端口可用后补真实 PostgreSQL 集成用例。
- 未归属损失口径具备真实归属数据后再放开 `unattributedLossAvailable`。

## 已知问题 / 坑

- 端口缺失时应明确返回 501，不能用 0 假装“当期无利润、无损失”。
- 报表模块必须保持只编排、不直读对方表。

## 相关文件

- `apps/api/src/modules/report/routes.ts`
- `apps/api/src/modules/report/usecases/profit-report.ts`
- `apps/api/src/modules/report/profit-report.test.ts`
