import type { Processor, PurchaseOrderDetail } from '@qingdan/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ShipDialog } from './ShipDialog';
import type { ShipDirection } from './ship-flow';

const ORDER: PurchaseOrderDetail = {
  id: 'o1',
  tenantId: 't1',
  companyId: '00000000-0000-4000-8000-000000000001',
  orderNo: 'A-BJ01-20261118-0001',
  supplierId: '00000000-0000-4000-8000-000000000201',
  supplierName: '宁波塑料厂',
  status: '进行中',
  handlerId: 'e1',
  lines: [
    { lineNo: 1, productId: 'p1', qty: '500', unitPrice: '8.6', amount: '4300' },
    { lineNo: 2, productId: 'p2', qty: '200', unitPrice: '3.2', amount: '640' },
  ],
  fees: [],
  goodsAmount: '4940',
  feeAmount: '0',
  totalAmount: '4940',
  version: 4,
  createdAt: '2026-11-18T02:00:00.000Z',
  updatedAt: '2026-11-18T03:00:00.000Z',
  cancelable: { allowed: true, reason: null },
};

const PROCESSOR: Processor = {
  id: 'proc-1',
  tenantId: 't1',
  companyId: ORDER.companyId,
  processorNo: 'W-01',
  name: '永久铰链厂',
  contactName: null,
  version: 1,
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
};

function render(
  directions: readonly ShipDirection[],
  opts: {
    processors?: readonly Processor[];
    processorsError?: string | null;
    errors?: readonly string[];
  } = {},
): string {
  return renderToStaticMarkup(
    <ShipDialog
      order={ORDER}
      productLabel={(productId) => (productId === 'p1' ? '不锈钢合页 4寸' : '塑料卡扣')}
      processors={opts.processors ?? [PROCESSOR]}
      processorsError={opts.processorsError ?? null}
      directions={directions}
      errors={opts.errors ?? []}
      busy={false}
      onChange={() => {}}
      onClose={() => {}}
      onSubmit={() => {}}
    />,
  );
}

const ALL_WAREHOUSE: ShipDirection[] = [
  { transitTo: 'warehouse', processorId: '' },
  { transitTo: 'warehouse', processorId: '' },
];

describe('采购发货弹层（D94 ①：按行选去向）', () => {
  it('逐行给出去向与加工厂两个下拉，行号与商品名都在', () => {
    const html = render(ALL_WAREHOUSE);
    expect(html).toContain('不锈钢合页 4寸');
    expect(html).toContain('塑料卡扣');
    expect(html).toContain('aria-label="第 1 行去向"');
    expect(html).toContain('aria-label="第 2 行去向"');
    expect(html).toContain('回仓库');
    expect(html).toContain('直发加工厂');
  });

  it('只有直发的那行能选加工厂；回仓库那行的下拉是灰的', () => {
    const html = render([
      { transitTo: 'warehouse', processorId: '' },
      { transitTo: 'processor', processorId: 'proc-1' },
    ]);
    // 第 2 行（直发）选中了加工厂，第 1 行（回仓库）不带 processorId
    expect(html).toContain('<option value="proc-1" selected="">永久铰链厂</option>');
    const firstSelect = /<select[^>]*aria-label="第 1 行加工厂"[^>]*>/.exec(html)?.[0] ?? '';
    expect(firstSelect).toContain('disabled=""');
    const secondSelect = /<select[^>]*aria-label="第 2 行加工厂"[^>]*>/.exec(html)?.[0] ?? '';
    expect(secondSelect).not.toContain('disabled=""');
  });

  it('看不到加工厂列表时禁掉「直发」选项，并把原因写在弹层里', () => {
    const html = render(ALL_WAREHOUSE, {
      processors: [],
      processorsError: '加工厂列表读不到（需要 processor.read）：403',
    });
    expect(html).toContain('（无加工厂可选）');
    expect(html).toContain('processor.read');
    // 「直发加工厂」这个选项本身要置灰，不能让人选了再撞 422
    const processorOption = /<option value="processor"[^>]*>直发加工厂<\/option>/.exec(html)?.[0] ?? '';
    expect(processorOption).toContain('disabled=""');
  });

  it('校验错误逐条列出（第几行没选加工厂）', () => {
    const html = render(
      [
        { transitTo: 'warehouse', processorId: '' },
        { transitTo: 'processor', processorId: '' },
      ],
      { errors: ['第 2 行选的是「直发加工厂」，请选具体加工厂。'] },
    );
    expect(html).toContain('第 2 行选的是「直发加工厂」');
  });
});
