import { describe, expect, it } from 'vitest';
import {
  approveBlockedText,
  batchLabelOf,
  batchOptionLabel,
  needsLines,
  returnLineAmount,
  returnLinesTotal,
  stocktakeDiffText,
  stocktakeDirection,
  stocktakeDirectionText,
  validateCustomerReturnDraft,
  validateStocktakeDraft,
  validateSupplierReturnDraft,
  type ReturnLineDraft,
} from './reversals-api';

/**
 * 冲正页的口径测试（R / S / I 三类单据的提交前校验与差异方向）。
 *
 * 这里只测「前端能自己判断的部分」：必填项、无差异不许开单、金额定点运算。
 * 岗位（D47）、看价（D79）、状态机都以服务端为准，不在前端重算。
 */

const VALID_LINE: ReturnLineDraft = {
  productId: '01900000-0000-7000-8000-0000000001a1',
  batchIds: ['01900000-0000-7000-8000-0000000001b1'],
  qty: '2',
  unitPrice: '15.5',
};

describe('R 客户退货校验', () => {
  const base = {
    companyId: '01900000-0000-7000-8000-000000000002',
    originalSalesOrderId: '01900000-0000-7000-8000-0000000000e1',
    returnType: '退货退款' as const,
    onlyRefundKind: '' as const,
    refundAmount: '31',
    lines: [VALID_LINE],
  };

  it('填全了就通过', () => {
    expect(validateCustomerReturnDraft(base)).toEqual([]);
  });

  it('缺公司 / 缺原 E 单要报出来', () => {
    const errors = validateCustomerReturnDraft({ ...base, companyId: '', originalSalesOrderId: '' });
    expect(errors).toContain('请选择公司');
    expect(errors).toContain('请选择原销售单（R 单必须挂原 E 单）');
  });

  it('「仅退款」必须选纠收款 / 减成交额（D40）', () => {
    const errors = validateCustomerReturnDraft({
      ...base,
      returnType: '仅退款',
      lines: [],
    });
    expect(errors).toContain('「仅退款」必须选类型：纠收款 / 减成交额');
    // 仅退款不需要明细，所以不该报明细相关的错
    expect(errors.some((error) => error.includes('商品明细'))).toBe(false);
  });

  it('「退货退款」必须有明细，且每行要引批次（D22）', () => {
    const errors = validateCustomerReturnDraft({ ...base, lines: [] });
    expect(errors).toContain('「退货退款」必须有至少 1 行商品明细');

    const noBatch = validateCustomerReturnDraft({
      ...base,
      lines: [{ ...VALID_LINE, batchIds: [] }],
    });
    expect(noBatch).toContain('第 1 行商品：至少引用 1 个批次（D22）');
  });

  it('应退金额必须大于 0（D40：它是应退金额，不是退款行）', () => {
    for (const amount of ['', '0', '0.000', 'abc', '-1']) {
      expect(
        validateCustomerReturnDraft({ ...base, refundAmount: amount }),
        `金额 ${amount} 不该通过`,
      ).toContain('应退金额必须是大于 0 的数字（最多 6 位小数）');
    }
  });

  it('退货退款要明细、仅退款不要明细', () => {
    expect(needsLines('退货退款')).toBe(true);
    expect(needsLines('仅退款')).toBe(false);
  });
});

describe('S 供应商退货校验', () => {
  const base = {
    companyId: '01900000-0000-7000-8000-000000000002',
    originalPurchaseOrderId: '01900000-0000-7000-8000-0000000000a1',
    refundAmount: '1200',
    lines: [VALID_LINE],
  };

  it('填全了就通过', () => {
    expect(validateSupplierReturnDraft(base)).toEqual([]);
  });

  it('必须有原 A 单与至少 1 行明细（F4c）', () => {
    const errors = validateSupplierReturnDraft({
      ...base,
      originalPurchaseOrderId: '',
      lines: [],
    });
    expect(errors).toContain('请选择原采购单（S 单必须挂原 A 单）');
    expect(errors).toContain('供应商退货至少 1 行商品明细');
  });
});

describe('I 盘点差异方向', () => {
  it('实盘 > 账面 = 盘盈，实盘 < 账面 = 盘亏，相等 = 不开单', () => {
    expect(stocktakeDirection('10', '12')).toBe('increase');
    expect(stocktakeDirection('10', '8')).toBe('decrease');
    expect(stocktakeDirection('10', '10')).toBe('none');
    // 归一化后相等：1 与 1.000000 是同一数量
    expect(stocktakeDirection('1', '1.000000')).toBe('none');
  });

  it('非法输入不算差异，避免拼错就提交', () => {
    expect(stocktakeDirection('', '1')).toBe('none');
    expect(stocktakeDirection('abc', '1')).toBe('none');
  });

  it('差异量带符号展示，0 不加号', () => {
    expect(stocktakeDiffText('10', '12')).toBe('+2');
    expect(stocktakeDiffText('10', '8')).toBe('-2');
    expect(stocktakeDiffText('10', '10')).toBe('0');
    expect(stocktakeDiffText('0.1', '0.3')).toBe('+0.2');
  });

  it('方向文案与差异量一致', () => {
    expect(stocktakeDirectionText('2')).toBe('盘盈');
    expect(stocktakeDirectionText('-2')).toBe('盘亏');
    expect(stocktakeDirectionText('0')).toBe('无差异');
  });

  it('无差异直接拒绝开单（D47：盘点只为盘盈盘亏冲正）', () => {
    const errors = validateStocktakeDraft({
      companyId: '01900000-0000-7000-8000-000000000002',
      batchId: '01900000-0000-7000-8000-0000000001b1',
      bookQty: '10',
      actualQty: '10',
    });
    expect(errors).toContain('实盘量和账面量一样，无差异不需要盘点单（D47）');
  });

  it('缺批次、数量非法都要报', () => {
    const errors = validateStocktakeDraft({
      companyId: '',
      batchId: '',
      bookQty: 'x',
      actualQty: '',
    });
    expect(errors).toContain('请选择公司');
    expect(errors).toContain('请选择盘点批次');
    expect(errors).toContain('账面量必须是非负数字');
    expect(errors).toContain('实盘量必须是非负数字');
  });
});

describe('金额与展示口径', () => {
  it('行金额走定点乘法，不漂', () => {
    expect(returnLineAmount({ ...VALID_LINE, qty: '2', unitPrice: '15.5' })).toBe('31');
    expect(returnLineAmount({ ...VALID_LINE, qty: '0.1', unitPrice: '3' })).toBe('0.3');
    // 非法输入返回 0，不抛错（避免输入过程中的中间态把页面打崩）
    expect(returnLineAmount({ ...VALID_LINE, qty: '', unitPrice: '3' })).toBe('0');
  });

  it('明细合计：0.1 × 3 行 = 0.3，不是 0.30000000000000004', () => {
    const lines = Array.from({ length: 3 }, () => ({ ...VALID_LINE, qty: '0.1', unitPrice: '1' }));
    expect(returnLinesTotal(lines)).toBe('0.3');
  });

  it('审批不可用原因按服务端 reason 翻译', () => {
    expect(approveBlockedText(null)).toBeNull();
    expect(approveBlockedText('already_approved')).toContain('已批准');
    expect(approveBlockedText('already_rejected')).toContain('已驳回');
    expect(approveBlockedText('whatever')).toBe('当前状态不可审批');
  });

  it('批次下拉带可用量（唯一可引用数字，D38）', () => {
    const label = batchOptionLabel({
      id: 'b1',
      tenantId: 't1',
      companyId: 'c1',
      productId: 'p1',
      batchNo: 'B-0001',
      lockedUnitCost: '12',
      inboundQty: '100',
      referencedQty: '0',
      remainingQty: '100',
      inTransitQty: '0',
      pendingExecutionQty: '0',
      availableQty: '300.000000',
      custodianId: '01900000-0000-7000-8000-000000000021',
      version: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
    // 服务端回 6 位小数（D54），下拉里给人看的应该是 `300` 而不是 `300.000000`。
    expect(label).toBe('B-0001（可用 300）');
  });

  it('明细里的 batchIds 换成批次号，换不到才退回 id 前缀', () => {
    const batch = {
      id: '01900000-0000-7000-8000-0000000001b1',
      tenantId: 't1',
      companyId: 'c1',
      productId: 'p1',
      batchNo: 'B-20261101-0001',
      lockedUnitCost: '10',
      inboundQty: '1000',
      referencedQty: '10',
      remainingQty: '990',
      inTransitQty: '0',
      pendingExecutionQty: '0',
      availableQty: '990',
      custodianId: '01900000-0000-7000-8000-000000000021',
      version: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
    };
    expect(batchLabelOf([batch], batch.id)).toBe('B-20261101-0001');
    // 不同公司的批次拉不到 → 退回 id 前 8 位，而不是显示 undefined。
    expect(batchLabelOf([batch], '01900000-0000-7000-8000-0000000009z9')).toBe('01900000');
  });
});
