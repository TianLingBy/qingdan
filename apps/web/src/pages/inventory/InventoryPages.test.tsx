import type {
  InventoryBatch,
  InventoryBatchDetail,
  InventoryFlow,
  Stocktake,
} from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { isImplementedPage } from '../../router/implemented';
import { authKeys } from '../auth/auth-api';
import { reversalsQueryKeys } from '../reversals/reversals-api';
import { InventoryFlowsPage } from './InventoryFlowsPage';
import { batchAgeDays, InventoryPage } from './InventoryPage';
import { inventoryQueryKeys } from './inventory-api';
import { StocktakesPage } from './StocktakesPage';

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const BATCH_ID = '00000000-0000-4000-8000-000000000002';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000003';
const FLOW_ID = '00000000-0000-4000-8000-000000000004';
const STOCKTAKE_ID = '00000000-0000-4000-8000-000000000005';
const ALERT_BATCH_ID = BATCH_ID;

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

const BATCH_DETAIL: InventoryBatchDetail = {
  ...BATCH,
  productName: '烘焙坚果礼盒',
  productNo: 'P-0001',
  pendingOccupancies: [
    {
      sourceDocType: 'E',
      sourceDocId: 'SALE-0007',
      qty: '3',
    },
  ],
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

const INBOUND_FLOW: InventoryFlow = {
  ...FLOW,
  id: '00000000-0000-4000-8000-000000000006',
  delta: '5',
  sourceDocType: 'A',
  sourceDocId: 'PURCHASE-0003',
  handledBy: 'employee-3',
  occurredAt: '2026-11-10T10:00:00.000Z',
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
  rejectReason: null,
  remark: '现场复核',
  version: 1,
  createdAt: '2026-11-10T09:00:00.000Z',
  updatedAt: '2026-11-10T09:00:00.000Z',
};

const ALERT = {
  batchId: ALERT_BATCH_ID,
  productId: PRODUCT_ID,
  productName: '烘焙坚果礼盒',
  batchNo: 'PB-0001-20261110-0001',
  availableQty: '82',
  avgDailyOut: '12.5',
  daysLeft: 6,
};

const INVENTORY_PAGE_FILTERS = {
  companyId: undefined,
  keyword: undefined,
  page: 1,
  pageSize: 20,
  sort: 'createdAt' as const,
  order: 'desc' as const,
};

const LEGACY_UTILITY_CLASS =
  /^(?:(?:sm|md|lg|xl|2xl):)?(?:(?:p|m)[xytrbl]?-(?:\d|\[|auto|full)|gap-.+|space-[xy]-.+|inline-flex|flex|grid|block|hidden|grid-cols-.+|col-span-.+|items-.+|justify-.+|text-(?:xs|sm|base|lg|xl|2xl|slate-.+|\[.+\])|font-.+|rounded(?:-.+)?|border-(?:slate|rose|emerald|amber).+|bg-(?:slate|white|rose|emerald|amber).+|w-full|min-w-.+|max-w-.+|whitespace-.+|overflow-.+)$/;

function render(
  page: React.ReactElement,
  seed: (client: ReturnType<typeof createQueryClient>) => void,
) {
  const client = createQueryClient();
  seed(client);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>{page}</QueryClientProvider>,
  );
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
    expect(isImplementedPage('inventory')).toBe(true);
    expect(isImplementedPage('inventory-flows')).toBe(true);
    expect(isImplementedPage('stocktakes')).toBe(true);
  });
});

describe('库存三页样式边界', () => {
  it('页面 JSX 不再混入 Tailwind 工具类', () => {
    const files = [
      './InventoryPage.tsx',
      './InventoryFlowsPage.tsx',
      './StocktakesPage.tsx',
      '../reversals/StocktakesPanel.tsx',
    ] as const;

    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      const classValues = Array.from(
        source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g),
        (match) => match[1] ?? match[2] ?? '',
      );
      for (const value of classValues) {
        for (const token of value.split(/\s+/)) {
          expect(token, `${file} 包含旧工具类 ${token}`).not.toMatch(
            LEGACY_UTILITY_CLASS,
          );
        }
      }
    }
  });
});

describe('库存数量页（#143）', () => {
  it('渲染真实批次数量、库龄与低库存预警，无看价权限时显示占位而不显示金额', () => {
    const html = render(<InventoryPage />, (client) => {
      client.setQueryData(authKeys.me, ME);
      client.setQueryData(inventoryQueryKeys.batches(INVENTORY_PAGE_FILTERS), {
        items: [BATCH],
        total: 1,
        page: 1,
        pageSize: 20,
        nextCursor: null,
      });
      client.setQueryData(inventoryQueryKeys.alerts(COMPANY_ID), {
        items: [ALERT],
      });
    });

    expect(html).toContain('库存数量');
    expect(html).toContain(BATCH.batchNo);
    expect(html).toContain('82');
    expect(html).toContain('库龄');
    expect(html).toContain('低于安全库存');
    expect(html).toContain('需要 inventory_qty.view_price 权限');
    expect(html).not.toContain('18.75');
  });

  it('批次列表使用页码模式并展示当前筛选条件', () => {
    const html = render(<InventoryPage />, (client) => {
      client.setQueryData(authKeys.me, ME);
      client.setQueryData(inventoryQueryKeys.batches(INVENTORY_PAGE_FILTERS), {
        items: [BATCH],
        total: 1,
        page: 1,
        pageSize: 20,
        nextCursor: null,
      });
      client.setQueryData(inventoryQueryKeys.alerts(COMPANY_ID), {
        items: [],
      });
    });

    expect(html).toContain('当前筛选：全部可见公司 · 全部批次 · 按入库时间');
    expect(html).toContain('20 条 / 页');
    expect(html).toContain('共 1 个批次');
  });

  it('四态行常驻 DOM，加载、空与错误只靠 tbody 属性切换', () => {
    const html = render(<InventoryPage />, (client) => {
      client.setQueryData(authKeys.me, ME);
      client.setQueryData(inventoryQueryKeys.batches(INVENTORY_PAGE_FILTERS), {
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        nextCursor: null,
      });
      client.setQueryData(inventoryQueryKeys.alerts(COMPANY_ID), {
        items: [],
      });
    });

    expect(html).toContain('data-state="empty"');
    expect(html).toContain('st-empty');
    expect(html).toContain('st-loading');
    expect(html).toContain('st-error');
    expect(html).toContain('没有符合条件的库存批次');
  });

  it('空批次列表仍保留完整表头与分页页脚', () => {
    const html = render(<InventoryPage />, (client) => {
      client.setQueryData(authKeys.me, ME);
      client.setQueryData(inventoryQueryKeys.batches(INVENTORY_PAGE_FILTERS), {
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        nextCursor: null,
      });
      client.setQueryData(inventoryQueryKeys.alerts(COMPANY_ID), {
        items: [],
      });
    });

    expect(html).toContain('批次号');
    expect(html).toContain('当前筛选');
    expect(html).toContain('没有符合条件的库存批次');
  });

  it('库龄按 createdAt 计算，超过 45 天进入慢库龄样式', () => {
    expect(
      batchAgeDays(
        '2026-09-01T00:00:00.000Z',
        new Date('2026-11-25T00:00:00.000Z'),
      ),
    ).toBe(85);
  });

  it('分页响应不足一页时页码仍为 1 / 1', () => {
    const html = render(<InventoryPage />, (client) => {
      client.setQueryData(authKeys.me, ME);
      client.setQueryData(inventoryQueryKeys.batches(INVENTORY_PAGE_FILTERS), {
        items: [BATCH],
        total: 1,
        page: 1,
        pageSize: 20,
        nextCursor: null,
      });
      client.setQueryData(inventoryQueryKeys.alerts(COMPANY_ID), {
        items: [],
      });
    });

    expect(html).toContain('1 / 1');
  });

  it('批次详情使用 v3.0 语义排版并保留权限占位与占用来源', () => {
    const html = render(
      <InventoryPage initialBatchId={BATCH_ID} />,
      (client) => {
        client.setQueryData(authKeys.me, ME);
        client.setQueryData(
          inventoryQueryKeys.batches(INVENTORY_PAGE_FILTERS),
          {
            items: [BATCH],
            total: 1,
            page: 1,
            pageSize: 20,
            nextCursor: null,
          },
        );
        client.setQueryData(inventoryQueryKeys.alerts(COMPANY_ID), {
          items: [],
        });
        client.setQueryData(inventoryQueryKeys.batch(BATCH_ID), BATCH_DETAIL);
      },
    );

    expect(html).toContain('class="card detail-card"');
    expect(html).toContain('class="detail-grid"');
    expect(html).toContain(BATCH_DETAIL.productName);
    expect(html).toContain('SALE-0007');
    expect(html).toContain('需要 inventory_qty.view_price 权限');
  });
});

describe('库存流水页（#143）', () => {
  it('只展示冻结契约字段，并按 delta 正负与来源类型如实标向', () => {
    const html = render(<InventoryFlowsPage />, (client) => {
      client.setQueryData(authKeys.me, ME);
      client.setQueryData(
        inventoryQueryKeys.flows({
          companyId: undefined,
          batchId: undefined,
          sourceDocType: undefined,
          sourceDocId: undefined,
          cursor: null,
        }),
        { items: [FLOW, INBOUND_FLOW], nextCursor: null },
      );
    });

    expect(html).toContain('库存流水');
    expect(html).toContain('-3');
    expect(html).toContain('+5');
    expect(html).toContain('负变动');
    expect(html).toContain('正变动');
    expect(html).toContain('E');
    expect(html).toContain('SALE-0007');
    expect(html).toContain('PURCHASE-0003');
    expect(html).toContain('当前返回 2 条');
    expect(html).not.toContain('金额');
    expect(html).not.toContain('锁定 / 调整');
  });

  it('四态行常驻 DOM，空流水保留表头', () => {
    const html = render(<InventoryFlowsPage />, (client) => {
      client.setQueryData(authKeys.me, ME);
      client.setQueryData(
        inventoryQueryKeys.flows({
          companyId: undefined,
          batchId: undefined,
          sourceDocType: undefined,
          sourceDocId: undefined,
          cursor: null,
        }),
        { items: [], nextCursor: null },
      );
    });

    expect(html).toContain('data-state="empty"');
    expect(html).toContain('st-empty');
    expect(html).toContain('st-loading');
    expect(html).toContain('st-error');
    expect(html).toContain('批次 ID');
    expect(html).toContain('没有符合条件的库存流水');
  });
});

describe('盘点页（#143）', () => {
  it('复用盘点面板并渲染待审批记录', () => {
    const html = render(<StocktakesPage />, (client) => {
      client.setQueryData(authKeys.me, ME);
      client.setQueryData(reversalsQueryKeys.batches(COMPANY_ID), {
        items: [BATCH],
        nextCursor: null,
      });
      client.setQueryData(
        reversalsQueryKeys.stocktakes({
          companyId: COMPANY_ID,
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
    expect(html).toContain('强版本校验');
    expect(html).toContain('当前筛选');
    // 列表行内动作按钮在 v0.13 版式里统一叫「详情」（#337）
    expect(html).toContain('详情');
    expect(html).toContain('唯一能直接改批次数量');
  });

  it('盘点草稿表单使用语义类，旧样式扫描覆盖已展开分支', () => {
    const html = render(<StocktakesPage initialFormOpen />, (client) => {
      client.setQueryData(authKeys.me, ME);
      client.setQueryData(reversalsQueryKeys.batches(COMPANY_ID), {
        items: [BATCH],
        nextCursor: null,
      });
      client.setQueryData(
        reversalsQueryKeys.stocktakes({
          companyId: COMPANY_ID,
          status: undefined,
          keyword: undefined,
          cursor: null,
        }),
        { items: [STOCKTAKE], nextCursor: null },
      );
    });

    expect(html).toContain('class="card stocktake-form"');
    expect(html).toContain('class="form-grid form-grid-3"');
    expect(html).toContain('class="field-control"');
    expect(html).toContain('发起盘点单');
  });
});
