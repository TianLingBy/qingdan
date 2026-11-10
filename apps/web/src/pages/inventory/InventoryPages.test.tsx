import type {
  InventoryBatch,
  InventoryFlow,
  Stocktake,
} from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { IMPLEMENTED_PAGES } from '../../router/implemented';
import { InventoryFlowsPage } from './InventoryFlowsPage';
import { InventoryPage } from './InventoryPage';
import { inventoryQueryKeys } from './inventory-api';
import { StocktakesPage } from './StocktakesPage';

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const BATCH_ID = '00000000-0000-4000-8000-000000000002';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000003';
const FLOW_ID = '00000000-0000-4000-8000-000000000004';
const STOCKTAKE_ID = '00000000-0000-4000-8000-000000000005';

const BATCH: InventoryBatch = {
  id: BATCH_ID,
  tenantId: 't1',
  companyId: COMPANY_ID,
  productId: PRODUCT_ID,
  batchNo: 'PB-0001-20261110-0001',
  lockedUnitCost: '18.75',
  inboundQty: '100',
  referencedQty: '10',
  remainingQty: '90',
  inTransitQty: '5',
  pendingExecutionQty: '3',
  availableQty: '82',
  custodianId: 'employee-1',
  version: 1,
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
};

const FLOW: InventoryFlow = {
  id: FLOW_ID,
  tenantId: 't1',
  companyId: COMPANY_ID,
  batchId: BATCH_ID,
  delta: '-3',
  sourceDocType: 'E',
  sourceDocId: 'SALE-0007',
  handledBy: 'employee-2',
  occurredAt: '2026-11-10T09:30:00.000Z',
};

const STOCKTAKE: Stocktake = {
  id: STOCKTAKE_ID,
  tenantId: 't1',
  companyId: COMPANY_ID,
  stocktakeNo: 'I-0001-20261110-0001',
  batchId: BATCH_ID,
  bookQty: '82',
  actualQty: '80',
  diffQty: '-2',
  status: '待审批',
  applicantId: 'employee-2',
  approverId: null,
  remark: '现场复核',
  version: 1,
  createdAt: '2026-11-10T09:00:00.000Z',
  updatedAt: '2026-11-10T09:00:00.000Z',
};

function render(
  page: React.ReactElement,
  seed: (client: ReturnType<typeof createQueryClient>) => void,
) {
  const client = createQueryClient();
  seed(client);
  return renderToStaticMarkup(<QueryClientProvider client={client}>{page}</QueryClientProvider>);
}

const ME = {
  employeeId: 'employee-1',
  tenantId: 't1',
  displayName: '仓管',
  companyIds: [COMPANY_ID],
  scope: [
    { domain: 'inventory_qty', actions: ['read'] },
    { domain: 'inventory_flow', actions: ['read'] },
    { domain: 'stocktake', actions: ['read', 'create', 'delete', 'approve'] },
  ],
};

describe('库存页面路由登记', () => {
  it('数量、流水、盘点三页均覆盖占位页', () => {
    expect(IMPLEMENTED_PAGES.inventory).toBe(InventoryPage);
    expect(IMPLEMENTED_PAGES['inventory-flows']).toBe(InventoryFlowsPage);
    expect(IMPLEMENTED_PAGES.stocktakes).toBe(StocktakesPage);
  });
});

describe('库存数量页（#143）', () => {
  it('渲染真实批次数量，无看价权限时显示占位而不显示金额', () => {
    const html = render(<InventoryPage />, (client) => {
      client.setQueryData(inventoryQueryKeys.me, ME);
      client.setQueryData(
        inventoryQueryKeys.batches({
          companyId: undefined,
          keyword: undefined,
          cursor: null,
        }),
        { items: [BATCH], nextCursor: null },
      );
    });

    expect(html).toContain('库存数量');
    expect(html).toContain(BATCH.batchNo);
    expect(html).toContain('82');
    expect(html).toContain('无看价权限');
    expect(html).not.toContain('18.75');
  });

  it('空批次列表有明确空态', () => {
    const html = render(<InventoryPage />, (client) => {
      client.setQueryData(inventoryQueryKeys.me, ME);
      client.setQueryData(
        inventoryQueryKeys.batches({
          companyId: undefined,
          keyword: undefined,
          cursor: null,
        }),
        { items: [], nextCursor: null },
      );
    });
    expect(html).toContain('没有符合条件的库存批次');
  });
});

describe('库存流水页（#143）', () => {
  it('展示正负变动与来源单据追溯信息', () => {
    const html = render(<InventoryFlowsPage />, (client) => {
      client.setQueryData(inventoryQueryKeys.me, ME);
      client.setQueryData(
        inventoryQueryKeys.flows({
          companyId: undefined,
          batchId: undefined,
          sourceDocType: undefined,
          sourceDocId: undefined,
          cursor: null,
        }),
        { items: [FLOW], nextCursor: null },
      );
    });

    expect(html).toContain('库存流水');
    expect(html).toContain('-3');
    expect(html).toContain('E');
    expect(html).toContain('SALE-0007');
    expect(html).toContain('批次号追溯');
  });
});

describe('盘点页（#143）', () => {
  it('渲染待审批记录，并给有权限的账号提供审批入口', () => {
    const html = render(<StocktakesPage />, (client) => {
      client.setQueryData(inventoryQueryKeys.me, ME);
      client.setQueryData(inventoryQueryKeys.batches({ limit: 200 }), {
        items: [BATCH],
        nextCursor: null,
      });
      client.setQueryData(
        inventoryQueryKeys.stocktakes({
          companyId: undefined,
          status: undefined,
          keyword: undefined,
          cursor: null,
        }),
        { items: [STOCKTAKE], nextCursor: null },
      );
    });

    expect(html).toContain('盘点');
    expect(html).toContain(STOCKTAKE.stocktakeNo);
    expect(html).toContain('待审批');
    expect(html).toContain('审批');
    expect(html).toContain('盘盈与盘亏分开授权');
  });
});
