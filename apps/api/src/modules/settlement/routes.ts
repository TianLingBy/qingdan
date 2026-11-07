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
  confirmSettlementOrder,
  getSettlementOrder,
  listSettlementOrders,
} from './usecases/settlement-orders.js';
import {
  createCommissionRate,
  deleteCommissionRate,
  listCommissionRates,
} from './usecases/commission-rates.js';

/**
 * settlement 模块骨架（契约第一批 §3.4 C 结算单首批 3 条）。
 *
 * 三条端点现按 operationId 注入 list / detail / confirm 用例。注意：
 * - C 单状态是**独立两态** `待确认 / 已结算`（D19），不复用 `HEADER_STATES`；
 * - **一期一单一次结算**，不支持部分 / 多次（D19）；草稿由 E/N 单「已完成」时系统自动生成，
 *   本模块**不提供创建端点**（D19 / D29）；
 * - **结算后不可冲正**，错账走 R 退货（D2③）；
 * - 毛利 / 毛利率按 D5 服务端计算；净毛利 = 毛利 − 本单相关损失（D26 / D33）；
 *   本单相关损失按 D35 的归属单聚合，并在结算时快照（§11-5）；
 * - 提成以 C 单为单位结算（D36），`commissionRateSnapshot` 结算时快照，改比例不重算历史单；
 * - 确认结算属审批动作：scope `settlement.approve`、AI 禁止且必须给原因（D52）、强 ETag；
 * - 金额一律 decimal 字符串（D54）。
 */

const FAILURE_OBJECT_TYPES: Readonly<Record<string, string>> = {
  'settlement.order.confirm': 'settlement_order',
  'commission.rate.create': 'commission_rate',
  'commission.rate.delete': 'commission_rate',
};

/** 无数据库时保持模块骨架语义：501 + operationId。 */
function assertDatabaseConfigured(
  instance: FastifyInstance,
  route: RouteDef,
): void {
  if (instance.database) return;
  throw new AppError(
    'NOT_IMPLEMENTED',
    `${route.operationId} 尚未实现（数据库未配置）`,
    { operationId: route.operationId },
  );
}

export function registerSettlementRoutes(app: FastifyInstance): void {
  const handlers: RouteHandlers = {
    'settlement.order.list.read': async ({
      app: instance,
      request,
      route,
    }) => {
      assertDatabaseConfigured(instance, route);
      return await listSettlementOrders({
        database: instance.database,
        request,
      });
    },
    'settlement.order.detail.read': async ({
      app: instance,
      request,
      reply,
      route,
    }) => {
      assertDatabaseConfigured(instance, route);
      const detail = await getSettlementOrder({
        database: instance.database,
        request,
      });
      reply.header('ETag', etagOf(detail.version));
      return detail;
    },
    'settlement.order.confirm': async ({
      app: instance,
      request,
      reply,
      route,
    }) => {
      assertDatabaseConfigured(instance, route);
      return await confirmSettlementOrder({
        database: instance.database,
        request,
        reply,
      });
    },
    'commission.rate.list.read': async ({ app: instance, request, route }) => {
      assertDatabaseConfigured(instance, route);
      return await listCommissionRates({
        database: instance.database,
        request,
      });
    },
    'commission.rate.create': async ({
      app: instance,
      request,
      reply,
      route,
    }) => {
      assertDatabaseConfigured(instance, route);
      return await createCommissionRate({
        database: instance.database,
        request,
        reply,
      });
    },
    'commission.rate.delete': async ({
      app: instance,
      request,
      reply,
      route,
    }) => {
      assertDatabaseConfigured(instance, route);
      return await deleteCommissionRate({
        database: instance.database,
        request,
        reply,
      });
    },
  };

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'settlement'),
    failureObjectTypes: FAILURE_OBJECT_TYPES,
    handlers,
  });
}
