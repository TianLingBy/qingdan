import { ROUTES, routesOfModule } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes, type RouteHandlers } from '../../platform/http/route-mount.js';

/**
 * purchase 模块骨架（契约第一批 §3.1 A 采购单首批 5 条）。
 *
 * 本批只接线挂载、不实现用例：`handlers` 为空，五条端点统一由 `mountRoutes` 返回
 * 501 `NOT_IMPLEMENTED`（与 inventory / sales 首切前的骨架同款）。
 *
 * 实现由 purchase 负责人接 `usecases/` 后按 operationId 注入；注意：
 * - 入库锁价 `批次单价 = (货款+运费+杂费) ÷ 入库数量`（D5）依赖 inventory 写能力，
 *   本批**不登记**「完成 / 入库」端点；
 * - 成本更正 T1/T2/T3 走 platform 审批（D37 / D42），不在这里另造审批表；
 * - 取消必须复用 `assertCancelable`（D21），已完成/已结算不可取消，有下游先取消下游；
 * - S 供应商退货是独立单据，不在本模块本批。
 */
export function registerPurchaseRoutes(app: FastifyInstance): void {
  const handlers: RouteHandlers = {};

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'purchase'),
    handlers,
  });
}
