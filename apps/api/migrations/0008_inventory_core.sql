-- 0008_inventory_core.sql
-- inventory 库存核心表（D67 / D2① / D38 / D41 / D47）。
--
-- 用途：
--   库存模块的首批业务表，字段与 packages/contracts/src/inventory.ts 的
--   InventoryBatchSchema / InventoryFlowSchema 一一对应（契约实体里只读派生列
--   remaining_qty / available_qty 由本文件按 D67 落成数据库生成列）。
--
-- 口径：
--   * D67：数量存「四个基础列 + 两个生成列」——基础列 inbound_qty / referenced_qty /
--     in_transit_qty / pending_execution_qty 持久化；remaining_qty = inbound_qty - referenced_qty、
--     available_qty = 剩余量 - 在途占用 - 待执行占用，均由 PG STORED 生成列维护，
--     应用层不可写；available_qty 是唯一可引用数字（D38），DB 兜底 >= 0；
--   * D38：剩余量 / 可用量的公式固化在生成列里，避免各读路径各算一套；
--   * D41：出库时待执行占用转为已引用量，可用量保持不变、不重复扣——
--     流水只记录数量变化，派生量由基础列 + 生成列保证一致；
--   * D47：批次与流水一律不物理删除，错账走冲正流水；流水只追加；
--   * D2①：单据与流水同事务写入；流水表**只追加**，应用角色只授 SELECT / INSERT；
--   * D15：tenant_id + company_id 行级隔离，RLS 沿用 0001 的 `app.tenant_id` 模式。
--
-- 历史迁移（0001-0007）一律不改：本文件是纯前向追加，回滚靠后续迁移。

-- ---------------------------------------------------------------------------
-- 1. 库存批次表（D67：四个基础列 + 两个生成列）
-- ---------------------------------------------------------------------------

CREATE TABLE inventory_batch (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  -- 公司隔离（D15）：批次归属单一公司，不允许跨公司可见。
  company_id uuid NOT NULL REFERENCES company (id),
  -- 批次关联商品；商品被批次引用后禁止物理删除。
  product_id uuid NOT NULL REFERENCES product (id) ON DELETE RESTRICT,
  -- 批次号由系统取号（D16）；租户内唯一。
  batch_no text NOT NULL CHECK (length(btrim(batch_no)) > 0),
  -- 锁定单位成本：A 单入库 / B 单产出时锁定（D5），复用 0001 的 amount 域。
  locked_unit_cost amount,
  -- 四个基础数量列（D67①）：持久化，应用层可写。
  inbound_qty amount NOT NULL DEFAULT 0 CHECK (inbound_qty >= 0),
  referenced_qty amount NOT NULL DEFAULT 0 CHECK (referenced_qty >= 0),
  in_transit_qty amount NOT NULL DEFAULT 0 CHECK (in_transit_qty >= 0),
  pending_execution_qty amount NOT NULL DEFAULT 0 CHECK (pending_execution_qty >= 0),
  -- 两个派生数量列（D67②）：由数据库生成，应用层不可写。
  -- 剩余量 = 入库量 - 已引用量（D38）。
  remaining_qty amount GENERATED ALWAYS AS (inbound_qty - referenced_qty) STORED,
  -- 可用量 = 剩余量 - 在途占用 - 待执行占用（D38 / D41）。
  available_qty amount GENERATED ALWAYS AS (
    inbound_qty - referenced_qty - in_transit_qty - pending_execution_qty
  ) STORED,
  -- 保管人（F5）：批次级责任人，可空；盘点差异据此追责。
  custodian_id uuid REFERENCES employee (id),
  -- 乐观锁版本：写接口用强 ETag `"<version>"`（D60③ 同款）。
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 可用量是唯一可引用数字（D38），不允许被基础列组合成负数。
  CONSTRAINT inventory_batch_available_qty_nonnegative CHECK (available_qty >= 0)
);

-- 库存页 / 选批次按「租户 + 公司 + 商品」定位。
CREATE INDEX inventory_batch_tenant_company_product_idx
  ON inventory_batch (tenant_id, company_id, product_id);
-- 批次号租户内唯一（D16）。
CREATE UNIQUE INDEX inventory_batch_tenant_batch_no_key ON inventory_batch (tenant_id, batch_no);
-- 列表按「租户 + 公司 + 批次号」检索；唯一性同时兜底。
CREATE UNIQUE INDEX inventory_batch_tenant_company_batch_no_key
  ON inventory_batch (tenant_id, company_id, batch_no);

-- ---------------------------------------------------------------------------
-- 2. 库存流水表（D2① / D47：只追加）
-- ---------------------------------------------------------------------------

CREATE TABLE inventory_flow (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant (id),
  -- 公司隔离（D15）：流水跟随批次归属公司。
  company_id uuid NOT NULL REFERENCES company (id),
  -- 指向批次；批次被引用后禁止物理删除（D47：错账走冲正流水）。
  batch_id uuid NOT NULL REFERENCES inventory_batch (id) ON DELETE RESTRICT,
  -- 数量变化：正入负出（出库 / 冲减为负数）。
  delta amount NOT NULL,
  -- 来源单据：类型为各单据模块自行登记的文本，id 为对应单据 uuid。
  source_doc_type text NOT NULL CHECK (length(btrim(source_doc_type)) > 0),
  source_doc_id uuid NOT NULL,
  -- 经手人。
  handled_by uuid NOT NULL REFERENCES employee (id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 批次流水按时间回放。
CREATE INDEX inventory_flow_tenant_batch_occurred_idx
  ON inventory_flow (tenant_id, batch_id, occurred_at);
-- 公司级流水查询按时间定位。
CREATE INDEX inventory_flow_tenant_company_occurred_idx
  ON inventory_flow (tenant_id, company_id, occurred_at);

-- ---------------------------------------------------------------------------
-- 3. updated_at 自动维护（与 0005 / 0006 / 0007 同款）
--    流水只追加，不建触发器（D2① / D47）。
-- ---------------------------------------------------------------------------

CREATE FUNCTION inventory_batch_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER inventory_batch_touch_updated_at
BEFORE UPDATE ON inventory_batch
FOR EACH ROW
EXECUTE FUNCTION inventory_batch_touch_updated_at();

-- ---------------------------------------------------------------------------
-- 4. 应用角色授权 + RLS 兜底（D15 / D55①）
--    模式与 0001 的内核表 / 0004 的商品表 / 0005 的客户表 / 0006 / 0007 一致：
--    FORCE RLS + tenant_isolation 策略，current_setting('app.tenant_id') 未设置时
--    比较为 NULL，fail-closed 返回 0 行。
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_batch TO qingdan_app;

ALTER TABLE inventory_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_batch FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON inventory_batch;
CREATE POLICY tenant_isolation ON inventory_batch
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- 流水只追加（D2① / D47）：应用角色只授 SELECT / INSERT，显式回收 UPDATE / DELETE / TRUNCATE。
-- 更正错账只能追加冲正流水，不能改历史行，也不能物理删除。
GRANT SELECT, INSERT ON inventory_flow TO qingdan_app;
REVOKE UPDATE, DELETE, TRUNCATE ON inventory_flow FROM qingdan_app;

ALTER TABLE inventory_flow ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_flow FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON inventory_flow;
CREATE POLICY tenant_isolation ON inventory_flow
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
