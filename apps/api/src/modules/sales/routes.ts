import {
  AppError,
  EXPORT_CONTENT_TYPE,
  ROUTES,
  allowsScope,
  etagOf,
  exportContentDisposition,
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
  exportSalesOrders,
  getSalesOrder,
  getSalesOrderForPrint,
  listSalesOrders,
  shipSalesOrder,
  updateSalesOrder,
} from './usecases/sales-orders.js';
import {
  createSalesReceipt,
  getSalesReceiptBlock,
  listSalesReceipts,
} from './usecases/sales-receipts.js';
import {
  createCustomerReturn,
  completeCustomerReturn,
  getCustomerReturn,
  listCustomerReturns,
} from './usecases/customer-returns.js';
import { maskSalesOrderDetailAmounts } from './services/masking.js';
import { renderSalesOrderCustomerCopy } from './services/customer-copy.js';
import { maskHandlerId, maskHandlerIdInPage } from '../../platform/authz/handler-mask.js';

/**
 * sales 模块（E 销售单一期 5 条 + 收款记录 2 条 + R 客户退货 3 条）。
 *
 * 按 operationId 注入全部已登记用例。注意：
 * - 开单 / 修改的破下限审批走 platform（D20），不要在这里另造审批表；
 * - 取消必须复用 `assertCancelable`（D21），有下游时先取消下游；
 * - E 单详情内嵌收款块，余额由 SQL 聚合（D24）；
 * - R 客户退货录入只校验 `customer_return.create` 权限点，不看岗位；
 * - 出库端点 `sales.order.ship` 按 D72 接线：扣库存 + 生成 C 单草稿（D70 端口，同事务），
 *   权限走 `sales.ship`（D85）；D94 起只到「已发货」；
 * - 签收端点 `sales.order.complete` 权限走 `sales.approve`（D94 ④），
 *   按批次反查来源 A/B 单是否全部「已完成」，否则 409（D94 ③）。
 */

const FAILURE_OBJECT_TYPES: Readonly<Record<string, string>> = {
  'sales.order.create': 'sales_order',
  'sales.order.update': 'sales_order',
  'sales.order.ship': 'sales_order',
  'sales.order.complete': 'sales_order',
  'sales.order.cancel': 'sales_order',
  'sales.order.export': 'sales_order',
  'sales.receipt.create': 'sales_receipt',
  'customer_return.create': 'customer_return',
  'customer_return.complete': 'customer_return',
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
      const page = await listSalesOrders({ database: instance.database, request });
      return maskHandlerIdInPage(page, request.principal);
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
      return maskHandlerId(
        maskSalesOrderDetailAmounts({ ...detail, ...receiptBlock }, canViewPrice),
        request.principal,
      );
    },
    'sales.order.export': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      // 导出返回原生 CSV（不是 JSON 信封）：直接设响应头返回文本，
      // 浏览器 / Excel 点开即下载，前端不用再转一手落盘（D96）。
      const file = await exportSalesOrders({
        database: instance.database,
        request,
      });
      reply
        .type(EXPORT_CONTENT_TYPE)
        .header('content-disposition', exportContentDisposition(file.filename));
      return file.content;
    },
    'sales.order.print': async ({ app: instance, request, route }) => {
      assertDatabaseConfigured(instance, route);
      // 复用详情取数 + view_price 脱敏；无权限时金额为 null，由渲染层显示「—」。
      const { detail, companyName, labels } = await getSalesOrderForPrint({
        database: instance.database,
        request,
      });
      return {
        contentType: 'text/html',
        content: renderSalesOrderCustomerCopy(detail, companyName, labels),
        filename: `销售单-${detail.orderNo}.html`,
      };
    },
    'sales.order.update': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await updateSalesOrder({
        database: instance.database,
        request,
        reply,
      });
    },
    'sales.order.ship': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await shipSalesOrder({
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
    'customer_return.complete': async ({ app: instance, request, reply }) =>
      completeCustomerReturn({ database: instance.database, request, reply }),
  };

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'sales'),
    failureObjectTypes: FAILURE_OBJECT_TYPES,
    handlers,
  });
}
