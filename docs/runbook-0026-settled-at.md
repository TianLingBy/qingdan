# 迁移 0026 / 0027 上线运行手册（settled_at + 采购单 D15 触发器）

> 关联：ADR-0002（结算确认时间）、ADR-0003（采购单商品归属）、PR #193。
> 本手册只讲**怎么安全地把这两条迁移放到真库上**，以及万一出问题怎么退。

## 0. 一句话结论

**先跑迁移，再上新代码。** 顺序错了 API 会**拒绝启动**并打印缺哪条迁移（`apps/api/src/platform/db/schema-guard.ts`），
不会带着旧库跑新代码、也不会把错误藏到业务请求里变成 500。

## 1. 这两条迁移做了什么

| 迁移 | 行为 | 对新代码的依赖 |
| --- | --- | --- |
| `0026_settlement_orders_settled_at.sql` | 给 `settlement_order` 加 `settled_at`；用 `audit_log` 的 `settlement.order.confirm` 成功记录回填；加 CHECK 约束与部分索引 | **硬依赖**：利润聚合按 `settled_at` 落期间，缺列就没法跑 |
| `0027_purchase_order_line_product_company.sql` | 给 `purchase_order_line` 加 D15 触发器；先体检历史越权行 | 软依赖：业务层已有 422 校验，缺触发器只是少一层兜底 |

## 2. 执行顺序

```bash
# 1）确认发布窗口（建议低峰；0026 会锁 settlement_order，见第 4 节）
# 2）备份（必须，且要验证备份可读，见第 3 节）
docker compose exec postgres pg_dump -U qingdan -Fc qingdan > ops/backups/pre-0026-$(date +%Y%m%d-%H%M).dump
pg_restore --list ops/backups/pre-0026-*.dump | head    # 确认不是空文件

# 3）跑迁移（独立容器，失败能直接看到输出；不随应用自启）
docker compose --profile tools run --rm migrate

# 4）按第 6 节的 SQL 自检，全绿再继续
# 5）起 / 升级 API（新代码）
docker compose up -d api

# 6）健康检查 + 浏览器实测一次「结算确认」与「采购单开单」
curl -fsS http://127.0.0.1/api/v1/health
```

迁移失败时：单个迁移文件是**一个事务**（SQL + `schema_migrations` 记录同事务提交），
失败会整体回滚、不会留下「列加了但没回填」的中间态；修完数据后**原样重跑同一条命令**即可。

## 3. 备份要求

- 迁移前必须有一份**可读**的 `pg_dump -Fc` 备份（用 `pg_restore --list` 验证，别只看文件存在）。
- 备份要覆盖 `settlement_order`、`audit_log`、`purchase_order_line`、`product`（回填只读 `audit_log`，但回滚方案依赖整库）。
- 恢复演练：按 `docs/deploy.md` 第三节恢复到临时库，比对行数后再动生产。

## 4. 锁表风险

0026 在一个事务里做四件事，锁的粒度不同：

| 语句 | 锁 | 影响 |
| --- | --- | --- |
| `ALTER TABLE settlement_order ADD COLUMN settled_at timestamptz` | `ACCESS EXCLUSIVE` | 秒级，但会挡住该表所有读写 |
| `UPDATE ... SET settled_at = a.occurred_at` | 行锁 | 只锁「已结算」的行，行数 = 已结算 C 单数 |
| `ADD CONSTRAINT ... CHECK (...)` | `ACCESS EXCLUSIVE` + 全表校验扫描 | 扫描期间挡写 |
| `CREATE INDEX ... (非 CONCURRENTLY)` | `SHARE`（挡写不挡读） | 建索引期间挡写 |

全体在同一事务里，所以**实际挡写时长 ≈ 加列 + 回填 + 约束校验 + 建索引的总和**。

- 当前仓库是首期、`settlement_order` 行数很小（PGlite 测试库 0 行），影响可忽略。
- 若未来表很大（>50 万行）再上类似迁移：`CREATE INDEX CONCURRENTLY` **不能**放在事务里，
  需要拆成「事务外建索引」的独立迁移方式，本 runner 不支持，届时要改 runner 或换工具——不要硬改这条历史文件（checksum 会拦）。

0027 的触发器只影响 `purchase_order_line` 的写入（`BEFORE INSERT OR UPDATE OF order_id, tenant_id, company_id, product_id`），
建触发器本身是元数据操作，秒级；体检 SQL 只读。

## 5. 回填策略与「回填不出来」

- 口径：`settled_at` 只认 `audit_log` 里 `action='settlement.order.confirm' AND result='success'` 的**最早** `occurred_at`。
- **不允许**用 `updated_at` 兜底：触发器会让任何一次 UPDATE（包括回填自己）刷新 `updated_at`，
  用它推断确认时间等于回到旧 bug（ADR-0002 有实证）。
- 有「已结算」单找不到审计记录时：迁移**主动失败**并报数量，不做静默补值。处理顺序：
  1. 用下面的诊断 SQL 拉清单；
  2. 交业务确认：①线下凭证能证明确认时刻 → 由运维补录一条审计记录（`source='manual'`，注明依据），再重跑迁移；
     ②确认是脏数据/误操作 → 走业务的反结算或作废流程，**不要**改结算口径；
  3. 两种情况都要留书面确认，迁移不会替业务决定。

```sql
-- 已结算但没有确认审计记录的单（迁移会因为这些行而失败）
SELECT s.id, s.order_no, s.status, s.updated_at
  FROM settlement_order s
  LEFT JOIN audit_log a
    ON a.action = 'settlement.order.confirm' AND a.result = 'success' AND a.object_id = s.id::text
 WHERE s.status = '已结算' AND a.id IS NULL;
```

0027 的历史体检同理：有越权行就整文件回滚，并用文件里的清单 SQL 拉出明细，先修数据再重跑。

## 6. 迁移后自检（全绿才算完成）

```sql
-- 两条迁移都记账了
SELECT id FROM schema_migrations WHERE id IN
  ('0026_settlement_orders_settled_at.sql', '0027_purchase_order_line_product_company.sql');

-- 已结算必有时间、待确认必须为空
SELECT count(*) AS settled_missing FROM settlement_order WHERE status = '已结算' AND settled_at IS NULL;   -- 0
SELECT count(*) AS draft_dirty     FROM settlement_order WHERE status = '待确认' AND settled_at IS NOT NULL; -- 0

-- 回填值与审计一致（抽样，期望 0 行）
SELECT s.id, s.settled_at, a.occurred_at
  FROM settlement_order s
  LEFT JOIN LATERAL (
    SELECT min(occurred_at) AS occurred_at FROM audit_log
     WHERE action = 'settlement.order.confirm' AND result = 'success' AND object_id = s.id::text
  ) a ON true
 WHERE s.status = '已结算' AND a.occurred_at IS DISTINCT FROM s.settled_at;

-- D15 触发器在位
SELECT tgname FROM pg_trigger WHERE tgname = 'purchase_order_line_product_company_check';  -- 1 行
```

再跑一遍报表冒烟：对同一个月，用确认前/后的数据核对「已结算单数 / 毛利 / 净利」与业务台账一致。

## 7. 回滚方案

| 场景 | 做法 |
| --- | --- |
| 迁移执行中失败 | 不用回滚：单文件事务已整体回滚，`settled_at` 列与约束都不存在；修数据后重跑 |
| 迁移成功、代码要退回旧版 | **可以**：旧代码不读 `settled_at`（回滚镜像即可）。代价是报表期间口径退回旧的 `updated_at` 算法，需业务知情 |
| 迁移成功、schema 必须撤销 | 不能改历史迁移（checksum 守卫）；新增 `0028_*.sql` 前滚：`DROP TRIGGER` → `DROP INDEX` → `DROP CONSTRAINT` → `DROP COLUMN settled_at`。注意 `DROP COLUMN` 会丢已回填数据，撤销后要再从 `audit_log` 回填 |
| 数据被写坏 | 停写 → 从第 3 节的备份恢复到新库 → 验证 → 切流量 |

## 8. 发布状态必须写明

PR / 发布记录里必须由发布负责人明确勾选一项，避免「代码已合并、库没迁移」的状态说不清：

- [ ] 0026 / 0027 **已执行**：环境 `____`，时间 `____`，执行人 `____`
- [ ] 0026 / 0027 **待发布执行**：计划窗口 `____`（此时 API 不能先上，`schema-guard` 会拒绝启动）
