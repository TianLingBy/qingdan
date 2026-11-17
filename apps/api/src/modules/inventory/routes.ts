import {
  AppError,
  EXPORT_CONTENT_TYPE,
  ROUTES,
  etagOf,
  exportContentDisposition,
  routesOfModule,
  type RouteDef,
} from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes, type RouteHandlers } from '../../platform/http/route-mount.js';
import { listInventoryAlerts } from './usecases/alerts.js';
import { getBatch, listBatches } from './usecases/batches.js';
import { exportInventoryBatches } from './usecases/export-inventory-batches.js';
import {
  approveCostAdjustment,
  createCostAdjustment,
  listCostAdjustments,
  rejectCostAdjustment,
} from './usecases/cost-adjustments.js';
import { listFlows } from './usecases/flows.js';
import {
  approveStocktake,
  createStocktakeDecrease,
  createStocktakeIncrease,
  getStocktake,
  listStocktakes,
  rejectStocktake,
} from './usecases/stocktakes.js';

/**
 * inventory 端点：首批只读 3 条（Issue #49）+ 盘点调整 I 6 条（D71：盘盈/盘亏拆两条，
 * 另含审批 / 驳回）。
 *
 * 全部端点由用例完成权限、公司隔离与查询；本层只做 operationId 分派和 ETag。
 * **不要在这里直接写 SQL 或改批次数字**——库存写入只能经单据用例调用 inventory
 * 服务函数（Issue #48 §2 / D67）。
 */
function assertDatabaseConfigured(app: FastifyInstance, route: RouteDef): void {
  if (app.database) return;
  throw new AppError('NOT_IMPLEMENTED', `${route.operationId} 尚未实现（数据库未配置）`, {
    operationId: route.operationId,
  });
}

export function registerInventoryRoutes(app: FastifyInstance): void {
  const handlers: RouteHandlers = {
    'inventory.batch.list.read': async ({ app: instance, request, route }) => {
      assertDatabaseConfigured(instance, route);
      return await listBatches({ database: instance.database, request });
    },
    // #354 第 2 条：低库存预警，只读、无副作用（口径见 D104）。
    'inventory.alert.list': async ({ app: instance, request, route }) => {
      assertDatabaseConfigured(instance, route);
      return await listInventoryAlerts({ database: instance.database, request });
    },
    'inventory.batch.detail.read': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const batch = await getBatch({ database: instance.database, request });
      reply.header('ETag', etagOf(batch.version));
      return batch;
    },
    'inventory.batch.export': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      // 原生 CSV（不是 JSON 信封）：设好响应头直接返回文本，点开即下载（D96）。
      const file = await exportInventoryBatches({
        database: instance.database,
        request,
      });
      reply
        .type(EXPORT_CONTENT_TYPE)
        .header('content-disposition', exportContentDisposition(file.filename));
      return file.content;
    },
    'inventory.flow.read': async ({ app: instance, request, route }) => {
      assertDatabaseConfigured(instance, route);
      return await listFlows({ database: instance.database, request });
    },
    'stocktake.list.read': async ({ app: instance, request, route }) => {
      assertDatabaseConfigured(instance, route);
      return await listStocktakes({ database: instance.database, request });
    },
    'stocktake.increase.create': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const stocktake = await createStocktakeIncrease({
        database: instance.database,
        request,
        reply,
      });
      reply.header('ETag', etagOf(stocktake.version));
      return stocktake;
    },
    'stocktake.decrease.create': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const stocktake = await createStocktakeDecrease({
        database: instance.database,
        request,
        reply,
      });
      reply.header('ETag', etagOf(stocktake.version));
      return stocktake;
    },
    'stocktake.detail.read': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const detail = await getStocktake({
        database: instance.database,
        request,
      });
      reply.header('ETag', etagOf(detail.version));
      return detail;
    },
    'stocktake.approve': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const detail = await approveStocktake({
        database: instance.database,
        request,
        reply,
      });
      reply.header('ETag', etagOf(detail.version));
      return detail;
    },
    'stocktake.reject': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const stocktake = await rejectStocktake({
        database: instance.database,
        request,
        reply,
      });
      reply.header('ETag', etagOf(stocktake.version));
      return stocktake;
    },
    'inventory.cost.adjustment.create': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const adjustment = await createCostAdjustment({
        database: instance.database,
        request,
        reply,
      });
      reply.header('ETag', etagOf(adjustment.version));
      return adjustment;
    },
    'inventory.cost.adjustment.history.read': async ({ app: instance, request, route }) => {
      assertDatabaseConfigured(instance, route);
      return await listCostAdjustments({ database: instance.database, request });
    },
    'inventory.cost.adjustment.approve': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const adjustment = await approveCostAdjustment({
        database: instance.database,
        request,
        reply,
      });
      reply.header('ETag', etagOf(adjustment.version));
      return adjustment;
    },
    'inventory.cost.adjustment.reject': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const adjustment = await rejectCostAdjustment({
        database: instance.database,
        request,
        reply,
      });
      reply.header('ETag', etagOf(adjustment.version));
      return adjustment;
    },
  };

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'inventory'),
    handlers,
  });
}
