import { AppError, ROUTES, etagOf, routesOfModule, type RouteDef } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes, type RouteHandlers } from '../../platform/http/route-mount.js';
import {
  cancelPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  updatePurchaseOrder,
} from './usecases/purchase-orders.js';
import {
  createSupplierReturn,
  getSupplierReturn,
  listSupplierReturns,
} from './usecases/supplier-returns.js';

/**
 * purchase 模块端点挂载（A 采购单首批 5 条，契约第一批 §3.1）。
 *
 * 按 operationId 分派到 `usecases/purchase-orders.ts`：
 *   - list / detail / create / update / cancel 的状态码与响应实体由用例决定；
 *   - create / detail 由本层补强 ETag（用例只负责 update / cancel 的新版本 ETag）；
 *   - 权限、公司隔离、审计、If-Match、AI 危险动作拦截都在用例内（与 platform / masterdata 同款）；
 *   - S 供应商退货 3 条由 `usecases/supplier-returns.ts` 处理，F4c 只退钱；
 *   - 机械部分（路径转换 / config 透传 / 失败审计 / 默认 501）交给 `mountRoutes`。
 *
 * 本批明确不登记「完成 / 入库」、成本更正 T1/T2/T3 端点（D5 / D37）。
 */

/** 失败审计的 objectType：写操作按对象归类（成功路径由用例写）。 */
const FAILURE_OBJECT_TYPES: Readonly<Record<string, string>> = {
  'purchase.order.create': 'purchase_order',
  'purchase.order.update': 'purchase_order',
  'purchase.order.cancel': 'purchase_order',
  'supplier_return.create': 'supplier_return',
};

/**
 * 无数据库时保持骨架语义：501 + operationId（与用例内 `requireDatabase` 的口径一致）。
 * 注册表边界测试会在无库实例上验证「端点仍由 purchase 挂载、operationId 可识别」。
 */
function assertDatabaseConfigured(instance: FastifyInstance, route: RouteDef): void {
  if (instance.database) return;
  throw new AppError('NOT_IMPLEMENTED', `${route.operationId} 尚未实现（数据库未配置）`, {
    operationId: route.operationId,
  });
}

export function registerPurchaseRoutes(app: FastifyInstance): void {
  const handlers: RouteHandlers = {
    'purchase.order.list.read': async ({ app: instance, request, route }) => {
      assertDatabaseConfigured(instance, route);
      return await listPurchaseOrders({ database: instance.database, request });
    },
    'purchase.order.create': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const order = await createPurchaseOrder({ database: instance.database, request, reply });
      reply.header('ETag', etagOf(order.version));
      return order;
    },
    'purchase.order.detail.read': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const detail = await getPurchaseOrder({ database: instance.database, request });
      reply.header('ETag', etagOf(detail.version));
      return detail;
    },
    'purchase.order.update': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await updatePurchaseOrder({ database: instance.database, request, reply });
    },
    'purchase.order.cancel': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await cancelPurchaseOrder({ database: instance.database, request, reply });
    },
    'supplier_return.list.read': async ({ app: instance, request, route }) => {
      assertDatabaseConfigured(instance, route);
      return await listSupplierReturns({ database: instance.database, request });
    },
    'supplier_return.create': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const supplierReturn = await createSupplierReturn({
        database: instance.database,
        request,
        reply,
      });
      reply.header('ETag', etagOf(supplierReturn.version));
      return supplierReturn;
    },
    'supplier_return.detail.read': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const supplierReturn = await getSupplierReturn({ database: instance.database, request });
      reply.header('ETag', etagOf(supplierReturn.version));
      return supplierReturn;
    },
  };

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'purchase'),
    failureObjectTypes: FAILURE_OBJECT_TYPES,
    handlers,
  });
}
