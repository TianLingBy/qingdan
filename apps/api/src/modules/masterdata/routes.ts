import { AppError, ROUTES, etagOf, routesOfModule, type RouteDef } from '@qingdan/contracts';
import type { FastifyInstance } from 'fastify';
import { mountRoutes, type RouteHandlers } from '../../platform/http/route-mount.js';
import {
  createCustomer,
  deleteCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
} from './usecases/customers.js';
import {
  createProduct,
  deleteProduct,
  getProduct,
  listProducts,
  updateProduct,
} from './usecases/products.js';
import {
  createSupplier,
  deleteSupplier,
  getSupplier,
  listSuppliers,
  updateSupplier,
} from './usecases/suppliers.js';
import {
  createProcessor,
  createQuote,
  deleteProcessor,
  getProcessor,
  listProcessors,
  listQuotes,
  updateProcessor,
} from './usecases/processors.js';

/**
 * masterdata 端点挂载（Issue #15 首切：商品资料）。
 *
 * 契约侧登记了 5 条 `product.*` 路由；这里按 operationId 分派到 `usecases/products.ts`：
 *   - list / detail / create / update / delete 的状态码与响应实体由用例决定；
 *   - create / detail 由本层补强 ETag（用例只负责 update / delete 的新版本 ETag）；
 *   - 权限、公司隔离、审计、If-Match、AI 危险动作拦截都在用例内（与 platform 同款）；
 *   - 机械部分（路径转换 / config 透传 / 失败审计 / 默认 501）交给 `mountRoutes`。
 */

/** 失败审计的 objectType：写操作按对象归类（成功路径由用例写）。 */
const FAILURE_OBJECT_TYPES: Readonly<Record<string, string>> = {
  'product.create': 'product',
  'product.update': 'product',
  'product.delete': 'product',
  'customer.create': 'customer',
  'customer.update': 'customer',
  'customer.delete': 'customer',
  'supplier.create': 'supplier',
  'supplier.update': 'supplier',
  'supplier.delete': 'supplier',
  'processor.create': 'processor',
  'processor.update': 'processor',
  'processor.delete': 'processor',
  // 报价是独立子表（D64④），失败审计按对象记 processor_quote，与 usecases 常量一致。
  'processor.quote.create': 'processor_quote',
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
    // 客户 5 条：权限 / 公司隔离 / 审计 / If-Match / AI 危险动作都在用例内（与商品同款）。
    'customer.list.read': async ({ app: instance, request, route }) => {
      assertDatabaseConfigured(instance, route);
      return await listCustomers({ database: instance.database, request });
    },
    'customer.create': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const customer = await createCustomer({ database: instance.database, request, reply });
      reply.header('ETag', etagOf(customer.version));
      return customer;
    },
    'customer.detail.read': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const customer = await getCustomer({ database: instance.database, request });
      reply.header('ETag', etagOf(customer.version));
      return customer;
    },
    'customer.update': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await updateCustomer({ database: instance.database, request, reply });
    },
    'customer.delete': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await deleteCustomer({ database: instance.database, request, reply });
    },
    // 供应商 5 条：权限 / 公司隔离 / 审计 / If-Match / AI 危险动作都在用例内（与商品 / 客户同款）。
    'supplier.list.read': async ({ app: instance, request, route }) => {
      assertDatabaseConfigured(instance, route);
      return await listSuppliers({ database: instance.database, request });
    },
    'supplier.create': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const supplier = await createSupplier({ database: instance.database, request, reply });
      reply.header('ETag', etagOf(supplier.version));
      return supplier;
    },
    'supplier.detail.read': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const supplier = await getSupplier({ database: instance.database, request });
      reply.header('ETag', etagOf(supplier.version));
      return supplier;
    },
    'supplier.update': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await updateSupplier({ database: instance.database, request, reply });
    },
    'supplier.delete': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await deleteSupplier({ database: instance.database, request, reply });
    },
    // 加工厂 5 条：权限 / 公司隔离 / 审计 / If-Match / AI 危险动作都在用例内（与前三切同款）。
    'processor.list.read': async ({ app: instance, request, route }) => {
      assertDatabaseConfigured(instance, route);
      return await listProcessors({ database: instance.database, request });
    },
    'processor.create': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const processor = await createProcessor({ database: instance.database, request, reply });
      reply.header('ETag', etagOf(processor.version));
      return processor;
    },
    'processor.detail.read': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const processor = await getProcessor({ database: instance.database, request });
      reply.header('ETag', etagOf(processor.version));
      return processor;
    },
    'processor.update': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await updateProcessor({ database: instance.database, request, reply });
    },
    'processor.delete': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      return await deleteProcessor({ database: instance.database, request, reply });
    },
    // 报价 2 条（D64④ 只增不改）：只有 list / create，没有 update / delete 路由。
    'processor.quote.read': async ({ app: instance, request, route }) => {
      assertDatabaseConfigured(instance, route);
      return await listQuotes({ database: instance.database, request });
    },
    'processor.quote.create': async ({ app: instance, request, reply, route }) => {
      assertDatabaseConfigured(instance, route);
      const quote = await createQuote({ database: instance.database, request, reply });
      // 报价只增不改：创建时回强 ETag，后续没有修改入口，因而不校验 If-Match。
      reply.header('ETag', etagOf(quote.version));
      return quote;
    },
  };

  mountRoutes(app, {
    routes: routesOfModule(ROUTES, 'masterdata'),
    failureObjectTypes: FAILURE_OBJECT_TYPES,
    handlers,
  });
}
