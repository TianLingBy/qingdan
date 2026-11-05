import { ROUTES, routesOfModule } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes, type RouteHandlers } from '../../platform/http/route-mount.js';

/**
 * sales 模块骨架（契约第一批 §3.3 E 销售单首批 5 条）。
 *
 * 本批只接线挂载、不实现用例：`handlers` 为空，五条端点统一由 `mountRoutes` 返回
 * 501 `NOT_IMPLEMENTED`（与 inventory / masterdata 首切前的骨架同款）。
 *
 * 实现由 sales 负责人接 `usecases/` 后按 operationId 注入；注意：
 * - 开单 / 修改的破下限审批走 platform（D20），不要在这里另造审批表；
 * - 取消必须复用 `assertCancelable`（D21），有下游时先取消下游；
 * - 出库 / 完成端点本批未登记（依赖 inventory 写路径，D41）。
 */
export function registerSalesRoutes(app: FastifyInstance): void {
  const handlers: RouteHandlers = {};

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'sales'),
    handlers,
  });
}
