-- 0017_inventory_stocktakes.sql
-- 盘点调整 I。
--
-- 依据：
--   packages/contracts/src/stocktakes.ts（契约第一批 §4 / §8）
--   D15 / D16 / D47 / D51 / D52 / D54 / D60 / D67。
--
-- 口径：
--   * 审批流三态：待审批 / 已批准 / 已驳回，不复用单据框架的 HEADER_STATES；
--   * 差异量服务端计算：diff_qty = actual_qty - book_qty，且必须非零
--     （无差异不允许开单；DB 兜底公式与零差异约束）；
--   * 数量使用 amount 域 numeric(18,6)，读出时 trim_scale 为 decimal 字符串（D54）；
--   * D47：盘盈盘亏走冲正流水，本表与库存流水、批次一律不物理删除；
--     应用角色只授 SELECT / INSERT / UPDATE，不授 DELETE / TRUNCATE；
--   * D16：单号 `I-<公司码4>-<日期8>-<流水4>` 由 platform numbering 在业务事务内取号；
--   * D15：tenant_id + company_id 行级隔离，ENABLE / FORCE RLS。
--
-- 历史迁移（0001-0016）一律不改：本文件是纯前向追加。

CREATE TABLE inventory_stocktake (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  stocktake_no text NOT NULL CHECK (length(btrim(stocktake_no)) > 0),
  -- 一期一张盘点单对应一个批次；批次被引用后禁止物理删除（D47）。
  batch_id uuid NOT NULL REFERENCES inventory_batch (id) ON DELETE RESTRICT,
  -- 账面量 / 实盘量：客户端录入。
  book_qty amount NOT NULL CHECK (book_qty >= 0),
  actual_qty amount NOT NULL CHECK (actual_qty >= 0),
  -- 差异量：服务端计算，盘盈为正、盘亏为负（D47 / D54）。
  diff_qty amount NOT NULL,
  status text NOT NULL DEFAULT '待审批'
    CHECK (status IN ('待审批', '已批准', '已驳回')),
  -- 发起人 / 审批人：审批前 approver_id 为空。
  applicant_id uuid NOT NULL REFERENCES employee (id),
  approver_id uuid REFERENCES employee (id),
  remark text CHECK (remark IS NULL OR length(remark) <= 200),
  -- 乐观锁版本：审批用强 ETag `"<version>"`（D60③ 同款）。
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_stocktake_tenant_no_key UNIQUE (tenant_id, stocktake_no),
  -- 服务端计算口径落库兜底：差异必须等于实盘量减账面量，且不允许零差异（D47）。
  CONSTRAINT inventory_stocktake_diff_formula_check
    CHECK (diff_qty = actual_qty - book_qty),
  CONSTRAINT inventory_stocktake_diff_nonzero_check CHECK (diff_qty <> 0)
);

CREATE INDEX inventory_stocktake_tenant_company_id_idx
  ON inventory_stocktake (tenant_id, company_id, id DESC);
CREATE INDEX inventory_stocktake_tenant_company_status_idx
  ON inventory_stocktake (tenant_id, company_id, status, id DESC);
CREATE INDEX inventory_stocktake_tenant_company_no_idx
  ON inventory_stocktake (tenant_id, company_id, stocktake_no);

CREATE FUNCTION inventory_stocktake_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_stocktake_touch_updated_at
BEFORE UPDATE ON inventory_stocktake
FOR EACH ROW
EXECUTE FUNCTION inventory_stocktake_touch_updated_at();

-- 盘点单不物理删除（D47）：应用角色只授 SELECT / INSERT / UPDATE。
GRANT SELECT, INSERT, UPDATE ON inventory_stocktake TO qingdan_app;
REVOKE DELETE, TRUNCATE ON inventory_stocktake FROM qingdan_app;

ALTER TABLE inventory_stocktake ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_stocktake FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON inventory_stocktake;
CREATE POLICY tenant_isolation ON inventory_stocktake
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
