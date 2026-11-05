import { ROUTES, routesOfModule } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes, type RouteHandlers } from '../../platform/http/route-mount.js';

/**
 * processing 模块骨架（契约第一批 §3.2 B 加工单首批 5 条）。
 *
 * 本批只接线挂载、不实现用例：`handlers` 为空，五条端点统一由 `mountRoutes` 返回
 * 501 `NOT_IMPLEMENTED`（与 inventory / sales / purchase 首切前的骨架同款）。
 *
 * 实现由 processing 负责人接 `usecases/` 后按 operationId 注入；注意：
 * - 完成 / 验收要按 `批次单价 = (引用材料成本 + 辅料 + 加工费 + 运杂费) ÷ 可售量`
 *   生成产出批次并锁价（D5），依赖 inventory 写能力，本批**不登记**该端点；
 * - 可售量 = 0（全损耗）需二次确认、不生成产出批次、材料与加工费全额记损失（G2 / D26）；
 * - 损耗量验收时一次填入、事后不改（F3），修改入参不接收 `lossQty`；
 * - 取消必须复用 `assertCancelable`（D21），有下游时先取消下游；
 * - 只能引用本公司批次（D22），至少 1 条材料投入（F2b）。
 */
export function registerProcessingRoutes(app: FastifyInstance): void {
  const handlers: RouteHandlers = {};

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'processing'),
    handlers,
  });
}
