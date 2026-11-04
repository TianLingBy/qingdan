import { ROUTES, routesOfModule } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes } from '../../platform/http/route-mount.js';

/**
 * masterdata 端点挂载（Issue #15 首切：商品资料）。
 *
 * 契约侧已登记 5 条 `product.*` 路由；实现尚未落地，先全部走 `mountRoutes` 的默认
 * 501 `NOT_IMPLEMENTED`——先保证 platform 不再接管业务端点，再按用例逐个补 handler。
 */
export function registerMasterdataRoutes(app: FastifyInstance): void {
  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'masterdata'),
    handlers: {},
  });
}
