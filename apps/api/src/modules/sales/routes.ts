import {
  AppError,
  ROUTES,
  etagOf,
  routesOfModule,
  type RouteDef,
} from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import {
  mountRoutes,
  type RouteHandlers,
} from '../../platform/http/route-mount.js';
import {
  cancelSalesOrder,
  createSalesOrder,
  getSalesOrder,
  listSalesOrders,
  updateSalesOrder,
} from './usecases/sales-orders.js';

/**
 * sales 模块骨架（契约第一批 §3.3 E 销售单首批 5 条）。
 *
 * 本批按 operationId 注入 E 单 5 条用例；收款记录 2 条仍由 `mountRoutes`
 * 返回 501。注意：
 * - 开单 / 修改的破下限审批走 platform（D20），不要在这里另造审批表；
 * - 取消必须复用 `assertCancelable`（D21），有下游时先取消下游；
 * - 出库 / 完成端点本批未登记（依赖 inventory 写路径，D41）。
 */

const FAILURE_OBJECT_TYPES: Readonly<Record<string, string>> = {
  'sales.order.create': 'sales_order',
  'sales.order.update': 'sales_order',
  'sales.order.cancel': 'sales_order',
};

/** 无数据库时保持骨架语义：501 + operationId。 */
function assertDatabaseConfigured(
  instance: FastifyInstance,
  route: RouteDef,
): void {
  if (instance.database) return;
  throw new AppError(
    'NOT_IMPLEMENTED',
    `${route.operationId} 尚未实现（数据库未配置）`,
    {
      operationId: route.operationId,
    },
  );
}

export function registerSalesRoutes(app: FastifyInstance): void {
  const handlers: RouteHandlers = {
    'sales.order.list.read': async ({ app: instance, request, route }) => {
      assertDatabaseConfigured(instance, route);
      return await listSalesOrders({ database: instance.database, request });
    },
    'sales.order.create': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const order = await createSalesOrder({
        database: instance.database,
        request,
        reply,
      });
      reply.header('ETag', etagOf(order.version));
      return order;
    },
    'sales.order.detail.read': async ({
      app: instance,
      request,
      reply,
      route,
    }) => {
      assertDatabaseConfigured(instance, route);
      const detail = await getSalesOrder({
        database: instance.database,
        request,
      });
      reply.header('ETag', etagOf(detail.version));
      return detail;
    },
    'sales.order.update': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await updateSalesOrder({
        database: instance.database,
        request,
        reply,
      });
    },
    'sales.order.cancel': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await cancelSalesOrder({
        database: instance.database,
        request,
        reply,
      });
    },
  };

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'sales'),
    failureObjectTypes: FAILURE_OBJECT_TYPES,
    handlers,
  });
}
