-- 20261117093000_workbench_todos_owner_indexes.sql
-- 工作台待办（D89 / #308）：给「本人负责」的 4 类待办补索引。
--
-- 背景：
--   GET /api/v1/todos 对 settlement / stocktake / cost_adjustment / processing
--   四类待办按「tenant_id + company_id + status + 负责人」计数。已有索引
--   （0012 / 0016 / 0017 / 0025）只覆盖到 (tenant_id, company_id, status[, id])，
--   负责人列只能回表过滤：单据一多，命中待处理状态的整段行都要读一遍。
--
-- 本迁移只加 4 条组合索引（纯前向、无数据改写、无回填；runner 单文件单事务）：
--   * settlement_order          (tenant_id, company_id, status, commission_owner_id)
--   * inventory_stocktake       (tenant_id, company_id, status, applicant_id)
--   * inventory_cost_adjustment (tenant_id, company_id, status, requested_by)
--   * processing_order          (tenant_id, company_id, status, handler_id)
--
-- 体积影响：每条是 4 列 btree，单行约 60–80 字节（uuid × 4 + 行指针 + 页头摊销），
-- 随对应表的行数线性增长；这四张表都是一期业务单据表，量级远小于库存流水。
-- 查询收益：待办计数从「扫完该公司所有待处理行」变为「按负责人等值定位」。
--
-- 历史迁移（0001-0033、20261116*、20261117013000、20261117090000）一律不改。

CREATE INDEX settlement_order_tenant_company_status_owner_idx
  ON settlement_order (tenant_id, company_id, status, commission_owner_id);

CREATE INDEX inventory_stocktake_tenant_company_status_applicant_idx
  ON inventory_stocktake (tenant_id, company_id, status, applicant_id);

CREATE INDEX inventory_cost_adjustment_tenant_company_status_requester_idx
  ON inventory_cost_adjustment (tenant_id, company_id, status, requested_by);

CREATE INDEX processing_order_tenant_company_status_handler_idx
  ON processing_order (tenant_id, company_id, status, handler_id);
