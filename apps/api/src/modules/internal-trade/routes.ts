import {
  AppError,
  ROUTES,
  etagOf,
  routesOfModule,
  type RouteDef,
} from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes, type RouteHandlers } from '../../platform/http/route-mount.js';
import {
  cancelInternalTradeOrder,
  createInternalTradeOrder,
  getInternalTradeOrder,
  listInternalTradeOrders,
  shipInternalTradeOrder,
  updateInternalTradeOrder,
} from './usecases/internal-trade-orders.js';

/**
 * internal-trade 模块（契约第二批 §1 / §3 N 内部交易单首批 5 条）。
 *
 * 按 operationId 注入全部已登记用例。注意：
 * - N 单是**独立四态** `进行中 / 在途 / 已完成 / 已取消`（D68②），不复用 `HEADER_STATES`；
 * - 取消按四态映射后复用 `assertCancelable`（D21）：`internalTradeHeaderState(status)`；
 * - 内部价由制单人手填、系统不自动算（D68①）；一期不做内部定价规则表（D45）；
 * - 明细只能引用**发出公司**批次（D22），`batchIds` 至少 1 条；
 * - 发货 / 在途端点已按 D73 接线：`进行中` → `在途`，按行锁定批次 `in_transit_qty`（D31 / D68③），
 *   批次 `company_id` 不变，仍归发出公司；取消在途单会同事务释放在途占用；
 * - 到货确认 / 转司端点仍未登记（要改批次 `company_id` 并生成 C 草稿，D29 另案拍板）。
 */

const FAILURE_OBJECT_TYPES: Readonly<Record<string, string>> = {
  'internal_trade.order.create': 'internal_trade_order',
  'internal_trade.order.update': 'internal_trade_order',
  'internal_trade.order.ship': 'internal_trade_order',
  'internal_trade.order.cancel': 'internal_trade_order',
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

export function registerInternalTradeRoutes(app: FastifyInstance): void {
  const handlers: RouteHandlers = {
    'internal_trade.order.list.read': async ({
      app: instance,
      request,
      route,
    }) => {
      assertDatabaseConfigured(instance, route);
      return await listInternalTradeOrders({
        database: instance.database,
        request,
      });
    },
    'internal_trade.order.create': async ({
      app: instance,
      request,
      reply,
      route,
    }) => {
      assertDatabaseConfigured(instance, route);
      const order = await createInternalTradeOrder({
        database: instance.database,
        request,
        reply,
      });
      reply.header('ETag', etagOf(order.version));
      return order;
    },
    'internal_trade.order.detail.read': async ({
      app: instance,
      request,
      reply,
      route,
    }) => {
      assertDatabaseConfigured(instance, route);
      const detail = await getInternalTradeOrder({
        database: instance.database,
        request,
      });
      reply.header('ETag', etagOf(detail.version));
      return detail;
    },
    'internal_trade.order.update': async ({
      app: instance,
      request,
      reply,
      route,
    }) => {
      assertDatabaseConfigured(instance, route);
      return await updateInternalTradeOrder({
        database: instance.database,
        request,
        reply,
      });
    },
    'internal_trade.order.ship': async ({
      app: instance,
      request,
      reply,
      route,
    }) => {
      assertDatabaseConfigured(instance, route);
      return await shipInternalTradeOrder({
        database: instance.database,
        request,
        reply,
      });
    },
    'internal_trade.order.cancel': async ({
      app: instance,
      request,
      reply,
      route,
    }) => {
      assertDatabaseConfigured(instance, route);
      return await cancelInternalTradeOrder({
        database: instance.database,
        request,
        reply,
      });
    },
  };

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'internal-trade'),
    failureObjectTypes: FAILURE_OBJECT_TYPES,
    handlers,
  });
}
