import type { ServiceRegistry } from '../../../platform/services/registry.js';

/**
 * masterdata 对外端口实现（D70）。
 *
 * 打印类场景（如销售单客户联）要显示商品名，sales **不得**直读 `product` 表；
 * 由这里以稳定 interface 暴露只读查询，租户隔离靠调用方已 `set app.tenant_id` + 显式 tenant_id 条件。
 */
export const masterdataServices: Pick<ServiceRegistry, 'productDirectory'> = {
  productDirectory: {
    lookupProducts: async (tx, query) => {
      if (query.productIds.length === 0) return [];
      const result = await tx.query<{
        id: string;
        product_no: string | null;
        name: string;
        unit: string;
      }>(
        `SELECT id::text AS id, product_no, name, unit
           FROM product
          WHERE tenant_id = $1
            AND id = ANY($2::uuid[])`,
        [query.tenantId, query.productIds],
      );
      return result.rows.map((row) => ({
        id: row.id,
        productNo: row.product_no,
        name: row.name,
        unit: row.unit,
      }));
    },
  },
};
