import { AppError, ROUTES, etagOf, routesOfModule, type RouteDef } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes, type RouteHandlers } from '../../platform/http/route-mount.js';
import {
  cancelProcessingOrder,
  createProcessingOrder,
  getProcessingOrder,
  listProcessingOrders,
  updateProcessingOrder,
} from './usecases/processing-orders.js';

/**
 * processing 模块端点挂载（契约第一批 §3.2 B 加工单首批 5 条）。
 *
 * 按 operationId 分派到 `usecases/processing-orders.ts`：
 *   - list / detail / create / update / cancel 的状态码与响应实体由用例决定；
 *   - create / detail 由本层补强 ETag，update / cancel 由用例写新版本 ETag；
 *   - 权限、公司隔离、审计、If-Match、AI 危险动作拦截都在用例内；
 *   - 机械部分交给 `mountRoutes`，未登记的 operationId 仍默认 501。
 *
 * - 完成 / 验收要按 `批次单价 = (引用材料成本 + 辅料 + 加工费 + 运杂费) ÷ 可售量`
 *   生成产出批次并锁价（D5），依赖 inventory 写能力，本批**不登记**该端点；
 * - 可售量 = 0（全损耗）需二次确认、不生成产出批次、材料与加工费全额记损失（G2 / D26）；
 * - 损耗量验收时一次填入、事后不改（F3），修改入参不接收 `lossQty`；
 * - 取消必须复用 `assertCancelable`（D21），有下游时先取消下游；
 * - 只能引用本公司批次（D22），至少 1 条材料投入（F2b）。
 */

const FAILURE_OBJECT_TYPES: Readonly<Record<string, string>> = {
  'processing.order.create': 'processing_order',
  'processing.order.update': 'processing_order',
  'processing.order.cancel': 'processing_order',
};

/** 无数据库时保持骨架语义：501 + operationId。 */
function assertDatabaseConfigured(instance: FastifyInstance, route: RouteDef): void {
  if (instance.database) return;
  throw new AppError('NOT_IMPLEMENTED', `${route.operationId} 尚未实现（数据库未配置）`, {
    operationId: route.operationId,
  });
}

export function registerProcessingRoutes(app: FastifyInstance): void {
  const handlers: RouteHandlers = {
    'processing.order.list.read': async ({ app: instance, request, route }) => {
      assertDatabaseConfigured(instance, route);
      return await listProcessingOrders({ database: instance.database, request });
    },
    'processing.order.create': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const order = await createProcessingOrder({
        database: instance.database,
        request,
        reply,
      });
      reply.header('ETag', etagOf(order.version));
      return order;
    },
    'processing.order.detail.read': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const detail = await getProcessingOrder({ database: instance.database, request });
      reply.header('ETag', etagOf(detail.version));
      return detail;
    },
    'processing.order.update': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await updateProcessingOrder({
        database: instance.database,
        request,
        reply,
      });
    },
    'processing.order.cancel': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await cancelProcessingOrder({
        database: instance.database,
        request,
        reply,
      });
    },
  };

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'processing'),
    failureObjectTypes: FAILURE_OBJECT_TYPES,
    handlers,
  });
}
