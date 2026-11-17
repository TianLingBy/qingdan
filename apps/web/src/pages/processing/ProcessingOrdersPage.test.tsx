import type {
  ProcessingOrder,
  ProcessingOrderDetail,
  Product,
  Processor,
} from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { MASKED_AMOUNT } from '../../lib/decimal';
import { authKeys } from '../auth/auth-api';
import {
  CompletionPanel,
  DetailPanel,
  ProcessingOrdersPage,
  editBlockedText,
  printBlockedText,
  validateCompletionDraft,
  validateDraft,
} from './ProcessingOrdersPage';
import { processingQueryKeys } from './processing-api';

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000101';
const PROCESSOR_ID = '00000000-0000-4000-8000-000000000301';
const BATCH_ID = '00000000-0000-4000-8000-000000000401';

const PRODUCT: Product = {
  id: PRODUCT_ID,
  tenantId: 't1',
  companyId: COMPANY_ID,
  productNo: 'P-1001',
  name: '不锈钢合页 4寸',
  aliases: [],
  specification: '50/箱',
  unit: '箱',
  defaultSalePrice: '15.5',
  version: 1,
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
};

const PROCESSOR: Processor = {
  id: PROCESSOR_ID,
  tenantId: 't1',
  companyId: COMPANY_ID,
  processorNo: 'JG-001',
  name: '宁波精工加工厂',
  contactName: '陈厂长',
  version: 1,
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
};

const ORDER: ProcessingOrder = {
  id: 'b1',
  tenantId: 't1',
  companyId: COMPANY_ID,
  orderNo: 'B-0001-20261108-0001',
  processorId: PROCESSOR_ID,
  processorName: '宁波精工加工厂',
  outputProductId: PRODUCT_ID,
  status: '进行中',
  handlerId: 'e1',
  materialBatchIds: [{ batchId: BATCH_ID, qty: '500' }],
  auxMaterials: '包装膜 20 卷',
  fees: [{ feeName: '加工费', qty: '1', unitPrice: '1500', amount: '1500', remark: null }],
  inputQty: '500',
  lossQty: null,
  sellableQty: null,
  attributionDoc: null,
  version: 2,
  createdAt: '2026-11-08T02:00:00.000Z',
  updatedAt: '2026-11-08T03:00:00.000Z',
};

const ME_WITH_PRICE = {
  employeeId: 'e1',
  tenantId: 't1',
  displayName: '张明',
  companyIds: [COMPANY_ID],
  scope: [
    {
      domain: 'processing',
      actions: ['read', 'create', 'update', 'delete', 'approve', 'view_price'],
    },
  ],
};

function seedClient(input: {
  readonly me: typeof ME_WITH_PRICE;
  readonly orders: readonly ProcessingOrder[];
}): ReturnType<typeof createQueryClient> {
  const client = createQueryClient();
  client.setQueryData(authKeys.me, input.me);
  client.setQueryData(processingQueryKeys.products, { items: [PRODUCT], nextCursor: null });
  client.setQueryData(processingQueryKeys.processors, { items: [PROCESSOR], nextCursor: null });
  client.setQueryData(
    processingQueryKeys.list({
      companyId: undefined,
      processorId: undefined,
      status: undefined,
      keyword: undefined,
      cursor: null,
    }),
    { items: [...input.orders], nextCursor: null },
  );
  return client;
}

function renderPage(client: ReturnType<typeof createQueryClient>): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ProcessingOrdersPage />
    </QueryClientProvider>,
  );
}

describe('加工单 B 页面', () => {
  it('列表渲染单号、加工厂、成品名、投入、加工费、状态与归属单', () => {
    const html = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [ORDER] }));

    expect(html).toContain('加工单 B');
    expect(html).toContain('B-0001-20261108-0001');
    expect(html).toContain('宁波精工加工厂');
    // outputProductId 只有 id：成品名靠主数据映射
    expect(html).toContain('不锈钢合页 4寸');
    expect(html).toContain('¥1,500.00');
    expect(html).toContain('进行中');
    expect(html).toContain('新建加工单');
  });

  it('损耗量还没验收时显示「待验收」，不拿投入量或 0 假装已知（D5 / F3）', () => {
    const html = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [ORDER] }));

    expect(html).toContain('待验收');
    // 可售量没算出来时不能显示成 500（那是假装零损耗）
    expect(html).not.toContain('500 → 500');
    expect(html).not.toContain('→ 0');
  });

  it('无看价权限时加工费遮罩，页面不出现任何已格式化金额（D79）', () => {
    const html = renderPage(
      seedClient({
        me: { ...ME_WITH_PRICE, scope: [{ domain: 'processing', actions: ['read'] }] },
        orders: [ORDER],
      }),
    );

    expect(html).toContain(MASKED_AMOUNT);
    expect(html).toContain('当前身份无「看价」权限');
    expect(html).not.toContain('¥');
  });

  it('无 create 权限时直说缺哪个 scope，空列表给出下一步', () => {
    const html = renderPage(
      seedClient({
        me: { ...ME_WITH_PRICE, scope: [{ domain: 'processing', actions: ['read'] }] },
        orders: [],
      }),
    );

    expect(html).toContain('需要 processing.create');
    expect(html).toContain('暂无加工单');
  });

  it('进行中的单据显示「完成 / 验收」入口，不再写早已过期的 501 说明', () => {
    const html = renderPage(seedClient({ me: ME_WITH_PRICE, orders: [ORDER] }));

    expect(html).toContain('完成 / 验收');
    expect(html).toContain('processing.approve');
    expect(html).not.toContain('调用会回 501');
    expect(html).not.toContain('尚未登记');
  });
});

describe('加工单完成 / 验收', () => {
  const DETAIL: ProcessingOrderDetail = {
    ...ORDER,
    outputBatchId: null,
    lossRecord: null,
    cancelable: { allowed: true, reason: null },
  };

  it('录入损耗量后实时显示可售量，并提供确认完成入口', () => {
    const html = renderToStaticMarkup(
      <CompletionPanel
        order={DETAIL}
        lossQty="4"
        confirmFullLoss={false}
        errors={[]}
        busy={false}
        onLossQtyChange={() => {}}
        onConfirmFullLossChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(html).toContain('完成 / 验收');
    expect(html).toContain('损耗量');
    expect(html).toContain('可售量');
    expect(html).toContain('496');
    expect(html).toContain('确认完成');
  });

  it('全损耗展示二次确认且按钮文案明确', () => {
    const html = renderToStaticMarkup(
      <CompletionPanel
        order={DETAIL}
        lossQty="500"
        confirmFullLoss={false}
        errors={['可售量为 0 属于全损耗，请勾选二次确认。']}
        busy={false}
        onLossQtyChange={() => {}}
        onConfirmFullLossChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(html).toContain('全损耗');
    expect(html).toContain('确认全损耗并完成');
    expect(html).toContain('扣减全部材料');
    expect(html).toContain('请勾选二次确认');
  });

  it('损耗量必填、不能超过投入，全损耗必须二次确认', () => {
    expect(validateCompletionDraft('500', '', false)).toEqual([
      '损耗量必须是非负数字（最多 6 位小数）。',
    ]);
    expect(validateCompletionDraft('500', '501', false)).toEqual(['损耗量不能大于投入量。']);
    expect(validateCompletionDraft('500', '500', false)).toEqual([
      '可售量为 0 属于全损耗，请勾选二次确认。',
    ]);
    expect(validateCompletionDraft('500', '4', false)).toEqual([]);
    expect(validateCompletionDraft('500', '500', true)).toEqual([]);
  });
});

describe('加工单开单前校验', () => {
  const validMaterial = { batchId: BATCH_ID, qty: '500' };
  const validFee = { feeName: '加工费', qty: '1', unitPrice: '1500', amount: '1500', remark: '' };

  it('加工厂、成品、材料、费用都是硬门槛（F2b / §3.2）', () => {
    expect(validateDraft('', '', [], [], '', '')).toEqual(
      expect.arrayContaining([
        '请选择加工厂',
        '请选择成品商品（完成后据此生成产出批次，#150 决策 A）',
        '加工单至少 1 行材料投入（F2b；包工包料请走 A 单）',
        '加工单至少 1 行费用明细（加工费 / 运杂费，§3.2）',
      ]),
    );
    expect(
      validateDraft(PROCESSOR_ID, PRODUCT_ID, [{ batchId: '', qty: '' }], [], '', ''),
    ).toEqual(
      expect.arrayContaining([
        '第 1 行材料：请选择批次',
        '第 1 行材料：投入数量必须是非负数字（最多 6 位小数）',
      ]),
    );
    expect(
      validateDraft(PROCESSOR_ID, PRODUCT_ID, [{ ...validMaterial, qty: '0' }], [validFee], '', ''),
    ).toContain('第 1 行材料：投入数量必须大于 0');
  });

  it('D39：B 单费用金额必须 ≥ 0（加工费 / 运杂费为负无现实意义）', () => {
    const negative = { ...validFee, amount: '-200' };
    expect(
      validateDraft(PROCESSOR_ID, PRODUCT_ID, [validMaterial], [negative], '', ''),
    ).toContain('第 1 行费用：金额必须是非负数字（D39：B 单加工费 / 运杂费不可为负）');
  });

  it('归属单只收 E / N 单号（D18 / D35）', () => {
    expect(
      validateDraft(PROCESSOR_ID, PRODUCT_ID, [validMaterial], [validFee], '', 'A-0001-20261105-0001'),
    ).toContain('归属单只收 E / N 单号，格式如 E-0001-20261105-0001（D16 / D35）');
    expect(
      validateDraft(PROCESSOR_ID, PRODUCT_ID, [validMaterial], [validFee], '', 'E-0001-20261105-0001'),
    ).toHaveLength(0);
  });

  it('合法单据零报错（辅料选填，不填也能开）', () => {
    expect(validateDraft(PROCESSOR_ID, PRODUCT_ID, [validMaterial], [validFee], '', '')).toHaveLength(0);
  });

  it('辅料超 500 字被挡', () => {
    const tooLong = 'x'.repeat(501);
    expect(
      validateDraft(PROCESSOR_ID, PRODUCT_ID, [validMaterial], [validFee], tooLong, ''),
    ).toContain('辅料说明最多 500 字');
  });
});

/* ------------------- 详情面板按钮三态（#261 / P0-08） ------------------- */

const PANEL_ORDER: ProcessingOrderDetail = {
  ...ORDER,
  outputBatchId: null,
  lossRecord: null,
  cancelable: { allowed: true, reason: null },
};

const FULL_ACTIONS = {
  canViewPrice: true,
  canUpdate: true,
  canPrint: true,
  canCancel: true,
  canComplete: true,
};

function renderDetailPanel(
  overrides: Partial<typeof FULL_ACTIONS> & { status?: ProcessingOrderDetail['status'] } = {},
): string {
  const { status, ...perms } = overrides;
  return renderToStaticMarkup(
    <DetailPanel
      order={{ ...PANEL_ORDER, status: status ?? PANEL_ORDER.status }}
      products={[PRODUCT]}
      batches={[]}
      canViewPrice={perms.canViewPrice ?? FULL_ACTIONS.canViewPrice}
      canUpdate={perms.canUpdate ?? FULL_ACTIONS.canUpdate}
      canPrint={perms.canPrint ?? FULL_ACTIONS.canPrint}
      canCancel={perms.canCancel ?? FULL_ACTIONS.canCancel}
      canComplete={perms.canComplete ?? FULL_ACTIONS.canComplete}
      canceling={false}
      completing={false}
      onClose={() => undefined}
      onEdit={() => undefined}
      onCancel={() => undefined}
      onComplete={() => undefined}
      onPrint={() => undefined}
    />,
  );
}

/** 取出某个按钮自己的标签，避免被旁边的提示文案干扰。 */
function buttonTag(html: string, label: string): string {
  const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html);
  expect(match, `找不到按钮「${label}」`).not.toBeNull();
  return match![0];
}

/**
 * 只看 `disabled` **属性**，不看 class：按钮 class 里带 `disabled:opacity-40`，
 * 直接 `toContain('disabled')` 会把「能点」误判成「禁用」。
 */
function isDisabled(html: string, label: string): boolean {
  return /\sdisabled(=""|\s|>)/.test(buttonTag(html, label));
}

describe('加工单详情面板：按钮三态', () => {
  it('有权限 + 状态允许：编辑与打印都能点', () => {
    const html = renderDetailPanel();

    expect(isDisabled(html, '编辑')).toBe(false);
    expect(isDisabled(html, '打印发厂联')).toBe(false);
  });

  it('无 processing.update：「编辑」禁用并说明缺哪个权限点', () => {
    const html = renderDetailPanel({ canUpdate: false });

    expect(isDisabled(html, '编辑')).toBe(true);
    expect(html).toContain('当前身份没有 processing.update 权限');
  });

  it('无 processing.read：「打印发厂联」禁用并说明缺哪个权限点', () => {
    const html = renderDetailPanel({ canPrint: false });

    expect(isDisabled(html, '打印发厂联')).toBe(true);
    expect(html).toContain('当前身份没有 processing.read 权限');
  });

  it('有权限但单据已完成：「编辑」禁用，原因说的是状态而不是权限', () => {
    const html = renderDetailPanel({ status: '已完成' });

    expect(isDisabled(html, '编辑')).toBe(true);
    expect(html).toContain('只有「进行中」的加工单能编辑，当前是「已完成」');
    expect(html).not.toContain('当前身份没有 processing.update 权限');
  });

  it('先权限后状态：两样都不满足时只提缺权限', () => {
    expect(editBlockedText({ canUpdate: false, canViewPrice: true, status: '已完成' })).toBe(
      '当前身份没有 processing.update 权限',
    );
    expect(editBlockedText({ canUpdate: true, canViewPrice: false, status: '进行中' })).toContain(
      'processing.view_price',
    );
    expect(editBlockedText({ canUpdate: true, canViewPrice: true, status: '进行中' })).toBeNull();
  });

  it('打印只需要 processing.read，不看单据状态（已取消也能补打）', () => {
    expect(printBlockedText(true)).toBeNull();
    expect(printBlockedText(false)).toBe('当前身份没有 processing.read 权限');
  });
});
