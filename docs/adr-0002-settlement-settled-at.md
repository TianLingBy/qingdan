# ADR-0002：结算确认时间独立成列（`settlement_order.settled_at`）

- 状态：已采纳（2026-11-11），迁移 0026 已写好但**尚未在任何数据库执行**
- 关联：`docs/AI-OPTIMIZATION-BRIEF.md` 阶段二 / 阶段三；Issue #97（D43 利润报表）、#185（C 单毛利聚合端口）
- 影响文件：`apps/api/migrations/0026_settlement_orders_settled_at.sql`、`apps/api/src/modules/settlement/repo.ts`、`apps/api/src/modules/settlement/services/profit-aggregate.ts`

## 背景

利润报表要按「结算确认时间」把已结算 C 单归到某个期间。原实现（0016 → #185）用 `settlement_order.updated_at` 推断确认时间，这在**当前代码**下成立：确认结算的 `UPDATE` 与单据其它写入共用一条语句，之后没有别的逻辑改这张单。

但它不是不变量：

1. `settlement_order_touch_updated_at` 是 `BEFORE UPDATE` 触发器，**任何** UPDATE 都会把 `updated_at` 刷成 `now()`（0016 第 79-92 行）。哪天加了「损耗重算」「版本订正」「运维修数」，历史单据的 `updated_at` 就会被推到操作时刻，报表期间归属随之漂移，且**没有任何报错**。
2. 报表 SQL 原本写 `(updated_at AT TIME ZONE $5)::date BETWEEN $3::date AND $4::date`：对列做函数/时区转换，索引不可用，期间边界也只能按「日期」比较。

## 决策

### 1. 新增列，只在确认结算时写一次

```sql
ALTER TABLE settlement_order ADD COLUMN settled_at timestamptz;
```

- `confirmSettlementOrder`（`apps/api/src/modules/settlement/repo.ts:433`）在同一条原子 UPDATE 里写 `settled_at = now()`，与快照、提成金额一起落库。
- **不用触发器自动填**：触发器会在任何状态变更时触发，等于把「确认时间」又变回「最后一次改动时间」。
- **不给默认值**：`now()` 默认值会让直接 INSERT 的历史数据拿到建库时间，制造假证据。

### 2. 状态与列值强绑定（fail closed）

```sql
ALTER TABLE settlement_order ADD CONSTRAINT settlement_order_settled_at_check CHECK (
  (status = '待确认' AND settled_at IS NULL)
  OR (status = '已结算' AND settled_at IS NOT NULL)
);
```

「已结算」但没有确认时间 = 口径不明，宁可让写入失败，也不留含糊态给报表层猜。

### 3. 历史回填只认审计证据

```sql
UPDATE settlement_order s
   SET settled_at = a.occurred_at
  FROM (SELECT object_id, min(occurred_at) AS occurred_at
          FROM audit_log
         WHERE action = 'settlement.order.confirm' AND result = 'success'
         GROUP BY object_id) a
 WHERE s.status = '已结算' AND s.settled_at IS NULL AND a.object_id = s.id::text;
```

依据：确认结算在本仓**只有一条生产写入路径**（`apps/api/src/modules/settlement/usecases/settlement-orders.ts` 的 `confirmSettlementOrder`，内部 `withAudit` 必写 `action='settlement.order.confirm'`、`result='success'`、`occurred_at`=确认时刻）。审计行是当时留下的、不可改的旁证，比 `updated_at` 可信。

回填后再检查一遍，仍有缺值就让迁移**整文件回滚并报错**：

```
settled_at 回填失败：N 张「已结算」C 单在 audit_log 中没有 settlement.order.confirm 成功记录
```

### 4. 期间聚合改半开区间，配部分索引

```sql
AND settled_at >= ($3::date)::timestamp AT TIME ZONE $5
AND settled_at <  (($4::date + 1)::timestamp) AT TIME ZONE $5
```

`[periodStart 本地零点, periodEnd 次日零点)`：列在比较左侧保持裸露，可走索引；末日 23:59:59 仍计入，次日零点整不计入。索引：

```sql
CREATE INDEX settlement_order_tenant_company_settled_at_idx
  ON settlement_order (tenant_id, company_id, settled_at)
  WHERE status = '已结算';
```

## 历史数据无法可靠回填时怎么办

结论：**不猜、不静默丢、失败即停**。

| 情况 | 处理 |
| --- | --- |
| 有 `settlement.order.confirm` 成功审计 | 自动回填为该审计的 `occurred_at`（本次迁移做的） |
| 有审计但 `result='fail'` | 不算证据；该行没有确认记录，归入下一行处理 |
| 完全没有审计（手工改库 / 外部导入 / 旧库迁移） | 迁移失败，打印待处理清单：`SELECT id, order_no, created_at FROM settlement_order WHERE status='已结算' AND settled_at IS NULL;` |
| 人工核对出来源单据的确认时间 | 手工 `UPDATE ... SET settled_at = '<确认时间>'` 后重跑迁移（幂等：已有值不再覆盖） |
| 核对不出来 | 由业务决定作废这批单据（`status` 回退或删库重录）；**禁止**用 `updated_at` 回填，那正是本 ADR 要修的错口径 |

`updated_at` 为什么不能当兜底：迁移里的回填 UPDATE 自己就会触发 `touch_updated_at`（`apps/api/src/platform/db/migrate-settled-at-backfill.test.ts` 已把这条行为钉成断言），拿它回填等于把「迁移执行时间」写进历史账。

## 后果

- 好：报表期间归属变成显式数据，后续任何 UPDATE 不再影响历史；查询可命中索引；期间边界从「日期比较」变成明确的半开区间。
- 代价：迁移在脏库上会**阻塞**（fail closed 的代价）；需要人工核对，不允许自动糊过去。
- 未做：`settled_at` 暂未加进 API 契约（`packages/contracts`）与 OpenAPI，避免顺手改契约；报表页若要展示确认时间，另开契约变更。
- 验证：`apps/api/src/platform/db/migrate-settled-at-backfill.test.ts` 覆盖「按审计回填」与「无证据失败并回滚」；`profit-aggregate.test.ts` 覆盖半开区间边界与「updated_at 在期间外也不影响归属」。
