-- 0027_purchase_order_line_product_company.sql
-- D15 数据库级防线：采购单明细的商品必须属于**该采购单所在公司**。
--
-- 业务层（apps/api/src/modules/purchase/repo.ts 的 assertProductsInCompany）负责给用户
-- 422 和友好 details；本触发器负责兜底：任何入口（新模块、脚本、手工 SQL、以后加的
-- 批量导入）只要往 purchase_order_line 写跨公司商品，一律在数据库层被拒。
-- 两层的关系：业务层是体验，数据库层是保证。
--
-- 错误用 SQLSTATE 23514（check_violation）+ 消息前缀 'D15:'，
-- apps/api/src/platform/http/errors.ts 会把它映射成 422 VALIDATION_FAILED。

CREATE OR REPLACE FUNCTION purchase_order_line_assert_product_company()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  order_company uuid;
  product_company uuid;
BEGIN
  SELECT po.company_id INTO order_company
    FROM purchase_order po
   WHERE po.id = NEW.order_id
     AND po.tenant_id = NEW.tenant_id;

  IF order_company IS NULL THEN
    RAISE EXCEPTION 'D15: 采购单行引用的采购单不存在或不属于同一租户（order_id=%）', NEW.order_id
      USING ERRCODE = '23514';
  END IF;

  IF order_company <> NEW.company_id THEN
    RAISE EXCEPTION 'D15: 采购单行的公司 % 与采购单公司 % 不一致（order_id=%）',
      NEW.company_id, order_company, NEW.order_id
      USING ERRCODE = '23514';
  END IF;

  SELECT p.company_id INTO product_company
    FROM product p
   WHERE p.id = NEW.product_id
     AND p.tenant_id = NEW.tenant_id;

  IF product_company IS NULL THEN
    RAISE EXCEPTION 'D15: 采购单行引用的商品不存在或不属于同一租户（product_id=%）', NEW.product_id
      USING ERRCODE = '23514';
  END IF;

  IF product_company <> NEW.company_id THEN
    RAISE EXCEPTION 'D15: 商品 % 属于公司 %，不属于采购单公司 %',
      NEW.product_id, product_company, NEW.company_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

-- 只在这几个列变化时检查，避免改数量/单价也白跑一次。
-- 插入时一定检查（WITH CHECK 语义由触发器决定，不存在「不检查的 INSERT」）。
CREATE TRIGGER purchase_order_line_product_company_check
  BEFORE INSERT OR UPDATE OF order_id, tenant_id, company_id, product_id
  ON purchase_order_line
  FOR EACH ROW
  EXECUTE FUNCTION purchase_order_line_assert_product_company();

-- 历史数据体检：建触发器只管未来写入，已存在的越权行必须让上线的人看见。
-- 与 0026 同策略：有违规就整文件回滚，给清单让业务决定怎么处理，不静默保留。
DO $$
DECLARE
  offending integer;
BEGIN
  SELECT count(*) INTO offending
    FROM purchase_order_line l
    LEFT JOIN purchase_order po
      ON po.id = l.order_id AND po.tenant_id = l.tenant_id
    LEFT JOIN product p
      ON p.id = l.product_id AND p.tenant_id = l.tenant_id
   WHERE po.id IS NULL
      OR p.id IS NULL
      OR po.company_id <> l.company_id
      OR p.company_id <> l.company_id;

  IF offending > 0 THEN
    RAISE EXCEPTION
      'D15 历史数据体检失败：% 行采购单明细的商品/公司归属不一致，触发器已建但数据需先修。'
      ' 清单：SELECT l.id, l.order_id, l.company_id, l.product_id, po.company_id AS order_company, '
      'p.company_id AS product_company FROM purchase_order_line l '
      'LEFT JOIN purchase_order po ON po.id = l.order_id AND po.tenant_id = l.tenant_id '
      'LEFT JOIN product p ON p.id = l.product_id AND p.tenant_id = l.tenant_id '
      'WHERE po.id IS NULL OR p.id IS NULL OR po.company_id <> l.company_id OR p.company_id <> l.company_id;',
      offending;
  END IF;
END;
$$;
