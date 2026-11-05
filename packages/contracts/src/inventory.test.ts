import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ROUTES } from './routes.js';
import {
  INVENTORY_ROUTES,
  InventoryBatchDetailSchema,
  InventoryBatchListQuerySchema,
  InventoryBatchSchema,
  InventoryFlowListQuerySchema,
  InventoryFlowSchema,
} from './inventory.js';
import { ENTITIES } from './entities.js';
import { buildOpenApiDocument } from './openapi.js';
import { routesOfModule } from './registry.js';

/**
 * 库存契约（inventory 首批只读，Issue #48 / D67）。
 *
 * 这些断言锁的是「契约签名」本身，不是实现：批次四列查询与流水查询的实现
 * 由 inventory 负责人按本文件落地，改签名必须先改这里并过评审。
 */

const BATCH = {
  id: 'b1',
  tenantId: 't1',
  companyId: 'co1',
  productId: 'p1',
  batchNo: 'B0001-20261105-0001',
  lockedUnitCost: '12.5',
  inboundQty: '100',
  referencedQty: '10',
  remainingQty: '90',
  inTransitQty: '5',
  pendingExecutionQty: '5',
  availableQty: '80',
  custodianId: 'e1',
  version: 1,
  createdAt: '2026-11-05T00:00:00.000Z',
  updatedAt: '2026-11-05T00:00:00.000Z',
} as const;

const DETAIL = {
  ...BATCH,
  productName: '白橡木板',
  productNo: 'P-001',
  pendingOccupancies: [{ sourceDocType: 'E', sourceDocId: 'e-1', qty: '5' }],
} as const;

const FLOW = {
  id: 'f1',
  tenantId: 't1',
  companyId: 'co1',
  batchId: 'b1',
  delta: '-1.5',
  sourceDocType: 'E',
  sourceDocId: 'e-1',
  handledBy: 'e1',
  occurredAt: '2026-11-05T00:00:00.000Z',
} as const;

describe('库存契约（inventory）', () => {
  it('3 条端点全部登记并汇总进 ROUTES，且归属 inventory', () => {
    expect(INVENTORY_ROUTES).toHaveLength(3);
    for (const route of INVENTORY_ROUTES) expect(route.module).toBe('inventory');

    const inventoryIds = routesOfModule(ROUTES, 'inventory').map((r) => r.operationId);
    for (const route of INVENTORY_ROUTES) expect(inventoryIds).toContain(route.operationId);
  });

  it('operationId / 方法 / 路径 / scope 与契约一致', () => {
    const actual = INVENTORY_ROUTES.map((r) => `${r.method} ${r.path} ${r.operationId}`).sort();
    expect(actual).toEqual(
      [
        'GET /api/v1/inventory/batches inventory.batch.list.read',
        'GET /api/v1/inventory/batches/{id} inventory.batch.detail.read',
        'GET /api/v1/inventory/flows inventory.flow.read',
      ].sort(),
    );

    const byId = new Map(INVENTORY_ROUTES.map((r) => [r.operationId, r]));
    expect(byId.get('inventory.batch.list.read')?.scope).toBe('inventory_qty.read');
    expect(byId.get('inventory.batch.detail.read')?.scope).toBe('inventory_qty.read');
    expect(byId.get('inventory.flow.read')?.scope).toBe('inventory_flow.read');
  });

  it('全部只读、普通读不记审计；本批不登记任何 HTTP 写端点', () => {
    for (const route of INVENTORY_ROUTES) {
      expect(route.method, route.operationId).toBe('GET');
      expect(route.audit, route.operationId).toEqual({ kind: 'none', required: false });
    }
    // 反向锁：库存写入只能经单据用例（Issue #48 §2），不允许出现 direct-write 端点。
    // 盘点调整 I 的 `stocktake.create` 与 `stocktake.approve` 是**唯一**允许出现在 inventory 模块里的写动作：
    // 它只追加库存流水，不改批次数量（D47/D67）。白名单写死，避免将来有人往 inventory
    // 塞「直接改库存」的写端点而被前缀过滤悄悄放行。
    const nonGetInventoryRoutes = routesOfModule(ROUTES, 'inventory')
      .filter((route) => route.method !== 'GET')
      .map((route) => route.operationId);
    expect(nonGetInventoryRoutes).toEqual(['stocktake.create', 'stocktake.approve']);
  });

  it('批次列表查询：公司/商品/关键字 + 游标分页；流水查询：公司/批次/来源单据', () => {
    const companyId = '00000000-0000-4000-8000-000000000001';
    const productId = '00000000-0000-4000-8000-000000000002';

    expect(
      InventoryBatchListQuerySchema.safeParse({
        companyId,
        productId,
        keyword: 'k'.repeat(64),
        cursor: 'abc',
        limit: 50,
      }).success,
    ).toBe(true);
    expect(InventoryBatchListQuerySchema.safeParse({ keyword: 'k'.repeat(65) }).success).toBe(false);
    expect(InventoryBatchListQuerySchema.safeParse({ companyId: 'not-a-uuid' }).success).toBe(false);
    expect(InventoryBatchListQuerySchema.safeParse({}).success).toBe(true);

    expect(
      InventoryFlowListQuerySchema.safeParse({
        companyId,
        batchId: 'b1',
        sourceDocType: 'E',
        sourceDocId: 'e-1',
        cursor: 'abc',
      }).success,
    ).toBe(true);
    expect(
      InventoryFlowListQuerySchema.safeParse({ sourceDocType: 'x'.repeat(33) }).success,
    ).toBe(false);
    expect(InventoryFlowListQuerySchema.safeParse({ companyId: 'not-a-uuid' }).success).toBe(false);
  });

  it('InventoryBatch 字段与 D67 一致，数量/金额全部是 decimal 字符串', () => {
    const keys = Object.keys(InventoryBatchSchema.shape).sort();
    expect(keys).toEqual(
      [
        'id',
        'tenantId',
        'companyId',
        'productId',
        'batchNo',
        'lockedUnitCost',
        'inboundQty',
        'referencedQty',
        'remainingQty',
        'inTransitQty',
        'pendingExecutionQty',
        'availableQty',
        'custodianId',
        'version',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    // 两个派生列必须在实体里展示（D38 四列 + 待执行占用），但只读由数据库生成列保证。
    expect(keys).toContain('remainingQty');
    expect(keys).toContain('availableQty');

    expect(InventoryBatchSchema.safeParse(BATCH).success).toBe(true);
    // 数量/金额传 number 一律拒绝（D54：契约边界用 decimal 字符串，避免浮点误差）。
    for (const field of [
      'lockedUnitCost',
      'inboundQty',
      'referencedQty',
      'remainingQty',
      'inTransitQty',
      'pendingExecutionQty',
      'availableQty',
    ] as const) {
      expect(InventoryBatchSchema.safeParse({ ...BATCH, [field]: 1 }).success, field).toBe(false);
    }
    // 基础列非负 + 最多 6 位小数。
    expect(InventoryBatchSchema.safeParse({ ...BATCH, inboundQty: '1.234567' }).success).toBe(true);
    expect(InventoryBatchSchema.safeParse({ ...BATCH, inboundQty: '1.2345678' }).success).toBe(false);
    expect(InventoryBatchSchema.safeParse({ ...BATCH, inboundQty: '-1' }).success).toBe(false);
    expect(InventoryBatchSchema.safeParse({ ...BATCH, lockedUnitCost: '-0.5' }).success).toBe(false);
  });

  it('InventoryBatchDetail 增加商品展示信息与待执行占用来源（D38 / D67⑤）', () => {
    const keys = Object.keys(InventoryBatchDetailSchema.shape);
    for (const key of ['productName', 'productNo', 'pendingOccupancies']) expect(keys).toContain(key);
    expect(InventoryBatchDetailSchema.safeParse(DETAIL).success).toBe(true);

    const pendingElement = InventoryBatchDetailSchema.shape.pendingOccupancies.element as {
      readonly shape: Record<string, unknown>;
    };
    const occupancy = Object.keys(pendingElement.shape).sort();
    expect(occupancy).toEqual(['qty', 'sourceDocId', 'sourceDocType']);
    expect(
      InventoryBatchDetailSchema.safeParse({
        ...DETAIL,
        pendingOccupancies: [{ sourceDocType: 'E', sourceDocId: 'e-1', qty: 1 }],
      }).success,
    ).toBe(false);
  });

  it('InventoryFlow 只追加：delta 可负、无 version/updatedAt', () => {
    expect(Object.keys(InventoryFlowSchema.shape).sort()).toEqual(
      [
        'id',
        'tenantId',
        'companyId',
        'batchId',
        'delta',
        'sourceDocType',
        'sourceDocId',
        'handledBy',
        'occurredAt',
      ].sort(),
    );
    expect(Object.keys(InventoryFlowSchema.shape)).not.toContain('version');
    expect(Object.keys(InventoryFlowSchema.shape)).not.toContain('updatedAt');

    expect(InventoryFlowSchema.safeParse(FLOW).success).toBe(true);
    expect(InventoryFlowSchema.safeParse({ ...FLOW, delta: '1.5' }).success).toBe(true);
    expect(InventoryFlowSchema.safeParse({ ...FLOW, delta: '1.2345678' }).success).toBe(false);
    expect(InventoryFlowSchema.safeParse({ ...FLOW, delta: -1.5 }).success).toBe(false);
    expect(InventoryFlowSchema.safeParse({ ...FLOW, delta: 'abc' }).success).toBe(false);
  });

  it('三个实体已登记（ENTITIES / globalRegistry / components.schemas 三处一致）', () => {
    const names = ENTITIES.map((e) => e.name);
    for (const name of ['InventoryBatch', 'InventoryBatchDetail', 'InventoryFlow']) {
      expect(names, name).toContain(name);
    }

    expect(z.globalRegistry.get(InventoryBatchSchema)?.id).toBe('InventoryBatch');
    expect(z.globalRegistry.get(InventoryBatchDetailSchema)?.id).toBe('InventoryBatchDetail');
    expect(z.globalRegistry.get(InventoryFlowSchema)?.id).toBe('InventoryFlow');

    const doc = buildOpenApiDocument(ROUTES);
    const batch = doc.components.schemas.InventoryBatch as { properties: Record<string, unknown> };
    const detail = doc.components.schemas.InventoryBatchDetail as {
      properties: Record<string, unknown>;
    };
    const flow = doc.components.schemas.InventoryFlow as { properties: Record<string, unknown> };
    expect(batch).toBeDefined();
    expect(detail).toBeDefined();
    expect(flow).toBeDefined();
    expect(batch.properties).toHaveProperty('remainingQty');
    expect(batch.properties).toHaveProperty('availableQty');
    expect(detail.properties).toHaveProperty('pendingOccupancies');
    expect(detail.properties).toHaveProperty('productName');
    expect(flow.properties).toHaveProperty('delta');
  });

  it('OpenAPI 发射出 inventory 端点与 x-module / x-scope / x-mcp-tool 标记', () => {
    const doc = buildOpenApiDocument(ROUTES);
    const batches = doc.paths['/api/v1/inventory/batches'] as Record<string, Record<string, unknown>>;
    expect(batches.get?.['x-module']).toBe('inventory');
    expect(batches.get?.['x-scope']).toBe('inventory_qty.read');
    expect(batches.get?.['x-audit']).toEqual({ kind: 'none', required: false });
    expect(batches.get?.['x-mcp-tool']).toBe('qingdan_inventory_batch_list_read');
    const queryNames = (batches.get?.parameters as Array<{ name: string }>).map((p) => p.name).sort();
    expect(queryNames).toEqual(['companyId', 'cursor', 'keyword', 'limit', 'productId']);

    const detail = doc.paths['/api/v1/inventory/batches/{id}'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(detail.get?.['x-mcp-tool']).toBe('qingdan_inventory_batch_detail_read');

    const flows = doc.paths['/api/v1/inventory/flows'] as Record<string, Record<string, unknown>>;
    expect(flows.get?.['x-scope']).toBe('inventory_flow.read');
    expect(flows.get?.['x-mcp-tool']).toBe('qingdan_inventory_flow_read');
  });
});
