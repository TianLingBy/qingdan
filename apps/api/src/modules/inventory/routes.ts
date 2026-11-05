import { ROUTES, routesOfModule } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes, type RouteHandlers } from '../../platform/http/route-mount.js';

/**
 * inventory 模块骨架（Issue #48 首批只读契约）。
 *
 * 本批只接线挂载、不实现用例：`handlers` 为空，三条端点统一由 `mountRoutes` 返回
 * 501 `NOT_IMPLEMENTED`（与 masterdata 首切前的骨架同款）。
 *
 * 实现由 inventory 负责人接 `usecases/` 后按 operationId 注入；**不要在这里直接写 SQL
 * 或改批次数字**——库存写入只能经单据用例调用 inventory 服务函数（Issue #48 §2）。
 */
export function registerInventoryRoutes(app: FastifyInstance): void {
  const handlers: RouteHandlers = {};

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'inventory'),
    handlers,
  });
}
