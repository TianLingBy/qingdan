import { AppError, ROUTES, etagOf, routesOfModule, type RouteDef } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes, type RouteHandlers } from '../../platform/http/route-mount.js';
import { getBatch, listBatches } from './usecases/batches.js';
import { listFlows } from './usecases/flows.js';

/**
 * inventory 首批只读端点（Issue #49）。
 *
 * 三条端点全部由用例完成权限、公司隔离与查询；本层只做 operationId 分派和详情 ETag。
 * **不要在这里直接写 SQL 或改批次数字**——库存写入只能经单据用例调用 inventory
 * 服务函数（Issue #48 §2）。
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
    'inventory.batch.detail.read': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const batch = await getBatch({ database: instance.database, request });
      reply.header('ETag', etagOf(batch.version));
      return batch;
    },
    'inventory.flow.read': async ({ app: instance, request, route }) => {
      assertDatabaseConfigured(instance, route);
      return await listFlows({ database: instance.database, request });
    },
  };

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'inventory'),
    handlers,
  });
}
