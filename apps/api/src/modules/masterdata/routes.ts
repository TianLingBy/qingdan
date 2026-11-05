import { AppError, ROUTES, etagOf, routesOfModule, type RouteDef } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes, type RouteHandlers } from '../../platform/http/route-mount.js';
import {
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  updateProduct,
} from './usecases/products.js';

/**
 * masterdata 端点挂载（Issue #15 首切：商品资料）。
 *
 * 契约侧登记了 5 条 `product.*` 路由；这里按 operationId 分派到 `usecases/products.ts`：
 *   - list / detail / create / update / delete 的状态码与响应实体由用例决定；
 *   - create / detail 由本层补强 ETag（用例只负责 update / delete 的新版本 ETag）；
 *   - 权限、公司隔离、审计、If-Match、AI 危险动作拦截都在用例内（与 platform 同款）；
 *   - 机械部分（路径转换 / config 透传 / 失败审计 / 默认 501）交给 `mountRoutes`。
 */

/** 失败审计的 objectType：商品写操作统一记 product（成功路径由用例写）。 */
const FAILURE_OBJECT_TYPES: Readonly<Record<string, string>> = {
  'product.create': 'product',
  'product.update': 'product',
  'product.delete': 'product',
};

/**
 * 无数据库时保持骨架语义：501 + operationId（与用例内 `requireDatabase` 的口径一致）。
 * 注册表边界测试会在无库实例上验证「端点仍由 masterdata 挂载、operationId 可识别」。
 */
function assertDatabaseConfigured(instance: FastifyInstance, route: RouteDef): void {
  if (instance.database) return;
  throw new AppError('NOT_IMPLEMENTED', `${route.operationId} 尚未实现（数据库未配置）`, {
    operationId: route.operationId,
  });
}

export function registerMasterdataRoutes(app: FastifyInstance): void {
  const handlers: RouteHandlers = {
    // 与 platform 一致：handler 内 await 用例，让拒绝走 mountRoutes 的失败审计 catch。
    'product.list.read': async ({ app: instance, request, route }) => {
      assertDatabaseConfigured(instance, route);
      return await listProducts({ database: instance.database, request });
    },
    'product.create': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const product = await createProduct({ database: instance.database, request, reply });
      reply.header('ETag', etagOf(product.version));
      return product;
    },
    'product.detail.read': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const product = await getProduct({ database: instance.database, request });
      reply.header('ETag', etagOf(product.version));
      return product;
    },
    'product.update': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await updateProduct({ database: instance.database, request, reply });
    },
    'product.delete': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await deleteProduct({ database: instance.database, request, reply });
    },
  };

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'masterdata'),
    failureObjectTypes: FAILURE_OBJECT_TYPES,
    handlers,
  });
}
