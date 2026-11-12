import type { InventoryCostAdjustment } from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { createQueryClient } from '../../api/query';
import {
  BatchCostAdjustments,
  costAdjustmentErrorText,
  validateCostAdjustmentDraft,
} from './BatchCostAdjustments';
import { costAdjustmentQueryKeys } from './inventory-cost-adjustment-api';

const BATCH_ID = '00000000-0000-4000-8000-000000000001';
const ADJUSTMENT_ID = '00000000-0000-4000-8000-000000000002';
const EMPLOYEE_ID = '00000000-0000-4000-8000-000000000003';
const ORDER_ID = '00000000-0000-4000-8000-000000000004';

const PENDING_T2: InventoryCostAdjustment = {
  id: ADJUSTMENT_ID,
  tenantId: 'tenant-1',
  companyId: '00000000-0000-4000-8000-000000000005',
  batchId: BATCH_ID,
  tier: 'T2',
  beforeUnitCost: '18.75',
  afterUnitCost: '21.5',
  deltaAmount: '137.5',
  reason: '补录供应商运费',
  status: 'pending_approval',
  requestedBy: EMPLOYEE_ID,
  approvedBy: null,
  referenceSnapshot: {
    referenced: true,
    settled: false,
    references: [
      { module: 'sales', docType: 'E', docId: ORDER_ID, status: '进行中' },
    ],
  },
  requestId: 'req-cost-1',
  version: 1,
  createdAt: '2026-11-12T08:00:00.000Z',
  appliedAt: null,
};

function render(
  canUpdate: boolean,
  canApprove: boolean,
  canViewPrice: boolean,
  items: readonly InventoryCostAdjustment[] = [PENDING_T2],
) {
  const client = createQueryClient();
  const filters = { cursor: null, limit: 50 };
  client.setQueryData(costAdjustmentQueryKeys.list(BATCH_ID, filters), {
    items,
    nextCursor: null,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <BatchCostAdjustments
        batchId={BATCH_ID}
        canRead
        canUpdate={canUpdate}
        canApprove={canApprove}
        canViewPrice={canViewPrice}
      />
    </QueryClientProvider>,
  );
}

describe('批次成本更正面板', () => {
  it('T2 历史展示档位、状态、成本差额和下游引用，审批权限可分开展示', () => {
    const html = render(true, true, true);

    expect(html).toContain('T2 待审批');
    expect(html).toContain('补录供应商运费');
    expect(html).toContain('¥18.75');
    expect(html).toContain('¥21.50');
    expect(html).toContain('¥137.50');
    expect(html).toContain('sales E');
    expect(html).toContain('审批通过');
    expect(html).toContain('驳回');
  });

  it('只读身份可看历史，但没有发起与审批入口', () => {
    const html = render(false, false, true);

    expect(html).toContain('发起成本更正');
    expect(html).toContain('disabled');
    expect(html).toContain('需 inventory_qty.approve');
    expect(html).not.toContain('>审批通过</button>');
    expect(html).not.toContain('>驳回</button>');
  });

  it('无看价权限时成本和差额全部显示占位', () => {
    const html = render(false, false, false, [
      {
        ...PENDING_T2,
        beforeUnitCost: null,
        afterUnitCost: null,
        deltaAmount: null,
      },
    ]);

    expect(html).toContain('inventory_qty.view_price');
    expect(html).toContain('—');
    expect(html).not.toContain('¥18.75');
    expect(html).not.toContain('¥137.50');
  });

  it('空历史有明确空态', () => {
    const html = render(false, false, true, []);
    expect(html).toContain('暂无成本更正记录');
  });
});

describe('成本更正表单与错误口径', () => {
  it('前端只挡明显非法 decimal 与空原因，0 成本允许提交给服务端判定', () => {
    expect(validateCostAdjustmentDraft({ afterUnitCost: '21.5', reason: '调价' })).toEqual([]);
    expect(validateCostAdjustmentDraft({ afterUnitCost: '0', reason: '赠品' })).toEqual([]);
    expect(validateCostAdjustmentDraft({ afterUnitCost: 'abc', reason: '' })).toEqual([
      '更正后单位成本必须是非负 decimal，最多 6 位小数。',
      '必须填写更正原因。',
    ]);
  });

  it('409 提示刷新，T3 明确说明已结算锁定', () => {
    const stale = new ApiError({
      code: 'VERSION_CONFLICT',
      message: '版本冲突',
      status: 409,
      details: { reason: 'NOT_PENDING_APPROVAL' },
    });
    expect(costAdjustmentErrorText(stale, '审批失败')).toContain('刷新到最新状态');

    const locked = new ApiError({
      code: 'STATE_CONFLICT',
      message: '成本已锁定',
      status: 409,
      details: { reason: 'COST_ADJUSTMENT_LOCKED' },
    });
    expect(costAdjustmentErrorText(locked, '提交失败')).toContain('成本已锁定');
    expect(costAdjustmentErrorText(locked, '提交失败')).toContain('退货单据');
  });
});
