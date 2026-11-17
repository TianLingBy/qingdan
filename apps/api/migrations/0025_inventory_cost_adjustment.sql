-- 0025_inventory_cost_adjustment.sql
-- 库存成本更正（Issue #163 / #100）。
--
-- 依据：
--   packages/contracts/src/cost-adjustments.ts
--   D5 / D15 / D50 / D51 / D54 / D60 / D70。
--
-- 口径：
--   * 成本更正是「只改成本、不改数量」：绝不写 inventory_flow.delta，
--     单独落本表，再把 inventory_batch.locked_unit_cost 改成新值；
--   * 分档全自动：T1 无下游引用且未结算（直接生效）、T2 已被引用但未结算（待审批）、
--     T3 已进入结算（拒绝，不落库）。tier 存判定结果快照；
--   * 下游引用事实按 D70 由各模块自建只读端口聚合，本表只存判定时的 reference_snapshot；
--   * delta_amount = (after_unit_cost - before_unit_cost) * 批次 inbound_qty（服务端算）；
--   * 金额使用 amount 域 numeric(18,6)（D54），正数/负数都以 decimal 字符串读出；
--   * D51：提交 / 审批 / 驳回全量写审计；本表不物理删除，
--     应用角色只授 SELECT / INSERT / UPDATE，不授 DELETE / TRUNCATE；
--   * D15：tenant_id + company_id 行级隔离，ENABLE / FORCE RLS。
--
-- 历史迁移（0001-0023）一律不改：本文件是纯前向追加。

CREATE TABLE inventory_cost_adjustment (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  company_id uuid NOT NULL REFERENCES company (id),
  -- 批次被成本更正引用后禁止物理删除（与盘点单同口径，ON DELETE RESTRICT）。
  batch_id uuid NOT NULL REFERENCES inventory_batch (id) ON DELETE RESTRICT,
  -- 自动判定档位快照：T1 直接生效 / T2 待审批；T3 直接拒绝、不落库。
  tier text NOT NULL CHECK (tier IN ('T1', 'T2', 'T3')),
  -- 更正前 / 后的单位成本：before 取自批次当时的 locked_unit_cost。
  before_unit_cost amount NOT NULL CHECK (before_unit_cost >= 0),
  after_unit_cost amount NOT NULL CHECK (after_unit_cost >= 0),
  -- 差额金额 =（后 - 前）× 批次 inbound_qty：正=调增、负=调减。
  delta_amount amount NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  status text NOT NULL
    CHECK (status IN ('pending_approval', 'applied', 'rejected')),
  requested_by uuid NOT NULL REFERENCES employee (id),
  -- 审批人：T1 直接生效与待审批时为空；T2 审批通过 / 驳回后落值。
  approved_by uuid REFERENCES employee (id),
  -- 判定时看到的下游引用快照（D70 端口回传，不直读别人表）。
  reference_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  -- 乐观锁版本：审批 / 驳回用强 ETag `"<version>"`（D60③ 同款）。
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- 生效时间：T1 创建即生效；T2 审批通过后落值。
  applied_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 差额符号兜底：调增差额非负、调减差额非正。
  CONSTRAINT inventory_cost_adjustment_delta_sign_check CHECK (
    (after_unit_cost >= before_unit_cost AND delta_amount >= 0)
    OR (after_unit_cost <= before_unit_cost AND delta_amount <= 0)
  )
);

-- 按批次列历史（契约的列表端点固定按 batch + 创建时间倒序）。
CREATE INDEX inventory_cost_adjustment_tenant_company_batch_idx
  ON inventory_cost_adjustment (tenant_id, company_id, batch_id, created_at DESC);
-- 按状态筛待审批（T2 审批队列）。
CREATE INDEX inventory_cost_adjustment_tenant_company_status_idx
  ON inventory_cost_adjustment (tenant_id, company_id, status, id DESC);

CREATE FUNCTION inventory_cost_adjustment_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_cost_adjustment_touch_updated_at
BEFORE UPDATE ON inventory_cost_adjustment
FOR EACH ROW
EXECUTE FUNCTION inventory_cost_adjustment_touch_updated_at();

-- 不物理删除：应用角色只授 SELECT / INSERT / UPDATE。
GRANT SELECT, INSERT, UPDATE ON inventory_cost_adjustment TO qingdan_app;
REVOKE DELETE, TRUNCATE ON inventory_cost_adjustment FROM qingdan_app;

ALTER TABLE inventory_cost_adjustment ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_cost_adjustment FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON inventory_cost_adjustment;
CREATE POLICY tenant_isolation ON inventory_cost_adjustment
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
