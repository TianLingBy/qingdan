import {
  AppError,
  ROUTES,
  allowsScope,
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
  completeSalesOrder,
  createSalesOrder,
  getSalesOrder,
  listSalesOrders,
  updateSalesOrder,
} from './usecases/sales-orders.js';
import {
  createSalesReceipt,
  getSalesReceiptBlock,
  listSalesReceipts,
} from './usecases/sales-receipts.js';
import {
  createCustomerReturn,
  getCustomerReturn,
  listCustomerReturns,
} from './usecases/customer-returns.js';
import { maskSalesOrderDetailAmounts } from './services/masking.js';

/**
 * sales 模块（E 销售单一期 5 条 + 收款记录 2 条 + R 客户退货 3 条）。
 *
 * 按 operationId 注入全部已登记用例。注意：
 * - 开单 / 修改的破下限审批走 platform（D20），不要在这里另造审批表；
 * - 取消必须复用 `assertCancelable`（D21），有下游时先取消下游；
 * - E 单详情内嵌收款块，余额由 SQL 聚合（D24）；
 * - R 客户退货录入按 D47 校验老板 / 经理 / 财务岗位；
 * - 完成端点按 D72 接线：扣库存 + 生成 C 单草稿（D70 端口，同事务）。
 */

const FAILURE_OBJECT_TYPES: Readonly<Record<string, string>> = {
  'sales.order.create': 'sales_order',
  'sales.order.update': 'sales_order',
  'sales.order.complete': 'sales_order',
  'sales.order.cancel': 'sales_order',
  'sales.receipt.create': 'sales_receipt',
  'customer_return.create': 'customer_return',
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
      const receiptBlock = await getSalesReceiptBlock({
        database: instance.database,
        request,
      });
      reply.header('ETag', etagOf(detail.version));
      // 收款块由本 handler 合并进来，故 D79 脱敏在这里再做一次（幂等）。
      const canViewPrice = request.principal
        ? allowsScope(request.principal.scope, 'sales', 'view_price')
        : false;
      return maskSalesOrderDetailAmounts(
        { ...detail, ...receiptBlock },
        canViewPrice,
      );
    },
    'sales.order.update': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await updateSalesOrder({
        database: instance.database,
        request,
        reply,
      });
    },
    'sales.order.complete': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await completeSalesOrder({
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
    'sales.receipt.read': async ({ app: instance, request }) =>
      await listSalesReceipts({ database: instance.database, request }),
    'sales.receipt.create': async ({ app: instance, request, reply }) =>
      await createSalesReceipt({
        database: instance.database,
        request,
        reply,
      }),
    'customer_return.list.read': async ({ app: instance, request }) =>
      await listCustomerReturns({ database: instance.database, request }),
    'customer_return.detail.read': async ({ app: instance, request }) =>
      await getCustomerReturn({ database: instance.database, request }),
    'customer_return.create': async ({ app: instance, request, reply }) =>
      await createCustomerReturn({
        database: instance.database,
        request,
        reply,
      }),
  };

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'sales'),
    failureObjectTypes: FAILURE_OBJECT_TYPES,
    handlers,
  });
}
