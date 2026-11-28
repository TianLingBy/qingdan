import type { Customer, Processor, Product, Supplier } from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { createQueryClient } from '../../api/query';
import {
  CustomersPage,
  MasterDetail,
  ProcessorsPage,
  ProductsPage,
  ProcessorQuotes,
  SuppliersPage,
  deleteErrorText,
} from './MasterdataPage';
import { masterdataQueryKeys } from './masterdata-api';

const PRODUCT: Product = {
  id: 'p1',
  tenantId: 't1',
  companyId: '00000000-0000-4000-8000-000000000001',
  productNo: 'P-1',
  name: '红富士苹果',
  aliases: ['苹果'],
  specification: '10kg/箱',
  unit: '箱',
  defaultSalePrice: null,
  version: 1,
  createdAt: '2026-11-08T00:00:00.000Z',
  updatedAt: '2026-11-08T00:00:00.000Z',
};

const CUSTOMER: Customer = {
  id: 'c1',
  tenantId: 't1',
  companyId: PRODUCT.companyId,
  customerNo: 'C-9',
  name: '测试客户',
  contactName: '赵老板',
  contactPhone: '13900000000',
  creditTermDays: 30,
  version: 1,
  createdAt: PRODUCT.createdAt,
  updatedAt: PRODUCT.updatedAt,
};

describe('商品资料页', () => {
  it('使用真实列表数据渲染，无看价权限时显示占位', () => {
    const client = createQueryClient();
    client.setQueryData(masterdataQueryKeys.me, {
      employeeId: 'e1',
      tenantId: 't1',
      displayName: '测试员工',
      companyIds: [PRODUCT.companyId],
      scope: [{ domain: 'product', actions: ['read'] }],
    });
    client.setQueryData(
      masterdataQueryKeys.list('products', {
        keyword: undefined,
        cursor: null,
      }),
      { items: [PRODUCT], nextCursor: null },
    );

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ProductsPage />
      </QueryClientProvider>,
    );

    expect(html).toContain('商品资料');
    expect(html).toContain('红富士苹果');
    expect(html).toContain('10kg/箱');
    // 无看价权限：钱列只显示「—」，原因写在 title（#432 必做点 6）
    expect(html).toContain('无看价权限或未设置');
    expect(html).toContain('新建商品');
    // 表头按 design/v3.0 逐块照抄（anchors.json：products = 编号/名称/规格/参考价）
    expect(html).toContain('规格');
    expect(html).toContain('参考价');
    expect(html).not.toContain('别名');
    expect(html).not.toContain('单位');
    expect(html).not.toContain('补充信息');
    // 主数据已去掉状态：不再有状态列（只断言表头，副标题里含「状态」二字）
    expect(html).not.toContain('<th>状态</th>');
    expect(html).not.toContain('停用');
    // 行内不再塞按钮（第 2 关「稿子里点行进详情就点行」）：操作只在详情面板头部
    expect(html).not.toContain('<th class="r">操作</th>');
    expect(html).toContain('class="r-row click"');
  });

  it('删除被单据引用时直接显示后端 409 消息，不吞成通用失败', () => {
    const conflict = new ApiError({
      code: 'STATE_CONFLICT',
      message: '该客户还有单据在用，不能删除',
      status: 409,
      details: { reason: 'HAS_REFERENCES' },
    });
    expect(deleteErrorText(conflict)).toBe('该客户还有单据在用，不能删除');
    expect(deleteErrorText(new Error('网络错误'))).toBe('网络错误');
  });

  it('空列表提供明确空态（稿子 EMPTY_BY_PAGE 原句）', () => {
    const client = createQueryClient();
    client.setQueryData(
      masterdataQueryKeys.list('products', {
        keyword: undefined,
        cursor: null,
      }),
      { items: [], nextCursor: null },
    );

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ProductsPage />
      </QueryClientProvider>,
    );

    expect(html).toContain('还没有商品');
    expect(html).toContain('先建商品资料与规格，开单时才有东西可选。');
  });

  it('写入口按 scope 三态：无权限禁用并在 title 写明缺哪个 scope，不藏按钮', () => {
    const client = createQueryClient();
    client.setQueryData(masterdataQueryKeys.me, {
      employeeId: 'e1',
      tenantId: 't1',
      displayName: '测试员工',
      companyIds: [PRODUCT.companyId],
      // 只有 read：创建 / 编辑 / 删除都该禁用
      scope: [{ domain: 'product', actions: ['read'] }],
    });
    client.setQueryData(
      masterdataQueryKeys.list('products', {
        keyword: undefined,
        cursor: null,
      }),
      { items: [PRODUCT], nextCursor: null },
    );

    const listHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ProductsPage />
      </QueryClientProvider>,
    );
    expect(listHtml).toContain('新建商品');
    expect(listHtml).toContain('需要 product.create 权限');
    expect(listHtml).toContain('disabled=""');

    // 编辑 / 删除在详情面板头部：同样「按钮仍在 DOM 里」，只是 disabled + title
    const detailHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MasterDetail
          kind="products"
          item={PRODUCT}
          companyLabel="星辰商贸总公司"
          domain="product"
          canUpdate={false}
          canDelete={false}
          canViewPrice={false}
          canQuote={false}
          onEdit={() => {}}
          onDelete={() => {}}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );
    expect(detailHtml).toContain('编辑');
    expect(detailHtml).toContain('删除');
    expect(detailHtml).toContain('需要 product.update 权限');
    expect(detailHtml).toContain('需要 product.delete 权限');
    expect(detailHtml).toContain('disabled=""');
  });

  it('四态由 data-state 驱动：三行状态行常驻 tbody，数据行只带 r-row', () => {
    const client = createQueryClient();
    client.setQueryData(masterdataQueryKeys.me, {
      employeeId: 'e1',
      tenantId: 't1',
      displayName: '测试员工',
      companyIds: [PRODUCT.companyId],
      scope: [{ domain: 'product', actions: ['read', 'create', 'update', 'delete'] }],
    });
    client.setQueryData(
      masterdataQueryKeys.list('products', {
        keyword: undefined,
        cursor: null,
      }),
      { items: [PRODUCT], nextCursor: null },
    );

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ProductsPage />
      </QueryClientProvider>,
    );

    expect(html).toContain('data-state="filled"');
    expect(html).toContain('st-tr st-loading');
    expect(html).toContain('st-tr st-error');
    expect(html).toContain('st-tr st-empty');
    // 数据行只带 r-row（+ 稿子的 click），不能带 st-tr（否则 filled 状态下会被隐藏，#337）
    expect(html).toContain('class="r-row click"');
    expect(html).not.toContain('r-row st-tr');
    expect(html).not.toContain('r-row click st-tr');
    // 有 create 权限时可点：title 换成「执行「X」· 需要 …」这一种（规范 §四.3），不带 disabled
    expect(html).toContain('执行「新建」· 需要 product.create 权限');
    expect(html).not.toContain('title="需要 product.create 权限"');
  });

  it('供应商页表头按 anchors：编号 / 名称 / 对接人 / 历史采购', () => {
    const supplier: Supplier = {
      id: 's1',
      tenantId: 't1',
      companyId: PRODUCT.companyId,
      supplierNo: null,
      name: '测试供应商',
      contactName: '李经理',
      contactPhone: '10000000000',
      suppliedMaterials: ['纸箱'],
      version: 1,
      createdAt: PRODUCT.createdAt,
      updatedAt: PRODUCT.updatedAt,
    };

    const client = createQueryClient();
    client.setQueryData(masterdataQueryKeys.me, {
      employeeId: 'e1',
      tenantId: 't1',
      displayName: '测试员工',
      companyIds: [PRODUCT.companyId],
      scope: [],
    });
    client.setQueryData(
      masterdataQueryKeys.list('suppliers', {
        keyword: undefined,
        cursor: null,
      }),
      { items: [supplier], nextCursor: null },
    );
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <SuppliersPage />
      </QueryClientProvider>,
    );

    expect(html).toContain('供应商档案');
    expect(html).toContain('测试供应商');
    expect(html).toContain('对接人');
    // 主对接人以 tag 呈现（稿子 `<span class="tag primary">`）
    expect(html).toContain('李经理');
    expect(html).toContain('历史采购');
    expect(html).not.toContain('补充信息');
    // 供货物料只在表单 / 详情里维护，列表按稿子不上屏
    expect(html).not.toContain('供货物料');
  });

  it('加工厂页表头按 anchors：编号 / 名称 / 对接人 / 加工单 / 报价', () => {
    const processor: Processor = {
      id: 'pr1',
      tenantId: 't1',
      companyId: PRODUCT.companyId,
      processorNo: null,
      name: '测试加工厂',
      contactName: '王师傅',
      version: 1,
      createdAt: PRODUCT.createdAt,
      updatedAt: PRODUCT.updatedAt,
    };

    const client = createQueryClient();
    client.setQueryData(masterdataQueryKeys.me, {
      employeeId: 'e1',
      tenantId: 't1',
      displayName: '测试员工',
      companyIds: [PRODUCT.companyId],
      scope: [],
    });
    client.setQueryData(
      masterdataQueryKeys.list('processors', {
        keyword: undefined,
        cursor: null,
      }),
      { items: [processor], nextCursor: null },
    );
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ProcessorsPage />
      </QueryClientProvider>,
    );

    expect(html).toContain('加工厂档案');
    expect(html).toContain('测试加工厂');
    expect(html).toContain('对接人');
    expect(html).toContain('王师傅');
    expect(html).toContain('加工单');
    expect(html).toContain('报价');
  });

  it('客户页表头按 anchors：编号 / 名称 / 对接人 / 价目 / 历史销售，且不出现任何金额列', () => {
    const client = createQueryClient();
    client.setQueryData(masterdataQueryKeys.me, {
      employeeId: 'e1',
      tenantId: 't1',
      displayName: '测试员工',
      companyIds: [PRODUCT.companyId],
      scope: [{ domain: 'customer', actions: ['read'] }],
    });
    client.setQueryData(
      masterdataQueryKeys.list('customers', {
        keyword: undefined,
        cursor: null,
      }),
      { items: [CUSTOMER], nextCursor: null },
    );

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <CustomersPage />
      </QueryClientProvider>,
    );

    expect(html).toContain('客户档案');
    expect(html).toContain('测试客户');
    expect(html).toContain('对接人');
    expect(html).toContain('赵老板');
    expect(html).toContain('价目');
    expect(html).toContain('历史销售');
    expect(html).not.toContain('补充信息');
    expect(html).toContain('新建客户');
    // 客户没有金额口径（D49 注释），页面不得出现售价列
    expect(html).not.toContain('默认售价');
    // 「价目」这一列后端没有字段：必须留 title 说明缺口，不许编数据
    expect(html).toContain('客户档案契约里没有价目字段');
  });
});

describe('档案详情面板（#432 必做点 2 / 3）', () => {
  it('对接人列表：主对接人标记 + 后端脱敏手机号 + 软停用态；无看价时金额占位', () => {
    const client = createQueryClient();
    client.setQueryData(['masterdata', 'customers', CUSTOMER.id, 'contacts'], [
      {
        id: 'ct1',
        tenantId: 't1',
        companyId: CUSTOMER.companyId,
        name: '顾岚',
        title: '采购经理',
        isPrimary: true,
        status: '启用',
        version: 1,
        createdAt: CUSTOMER.createdAt,
        updatedAt: CUSTOMER.updatedAt,
        phoneMasked: '138****2046',
      },
      {
        id: 'ct2',
        tenantId: 't1',
        companyId: CUSTOMER.companyId,
        name: '宋一鸣',
        title: null,
        isPrimary: false,
        status: '停用',
        version: 1,
        createdAt: CUSTOMER.createdAt,
        updatedAt: CUSTOMER.updatedAt,
        phoneMasked: '139****7731',
      },
    ]);
    client.setQueryData(['masterdata', 'customers', CUSTOMER.id, 'summary'], {
      orderCount: 12,
      // 无 view_price：后端不给 totalAmount 键
      lastOrderAt: '2026-11-20T00:00:00.000Z',
      recentOrders: [],
      contacts: [],
    });

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MasterDetail
          kind="customers"
          item={CUSTOMER}
          companyLabel="星辰商贸总公司"
          domain="customer"
          canUpdate
          canDelete
          canViewPrice={false}
          canQuote={false}
          onEdit={() => {}}
          onDelete={() => {}}
          onClose={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(html).toContain('顾岚');
    expect(html).toContain('主对接人');
    expect(html).toContain('138****2046');
    expect(html).toContain('停用');
    expect(html).toContain('单据数');
    expect(html).toContain('12');
    // 档案自身电话也只显示后 4 位
    expect(html).toContain('****0000');
    expect(html).not.toContain('13900000000');
    // 有权限时按钮可点，title 写明所需 cap
    expect(html).toContain('执行「编辑」· 需要 customer.update 权限');
    expect(html).toContain('执行「删除」· 需要 customer.delete 权限');
  });
});

describe('加工厂报价面板', () => {
  const PROCESSOR: Processor = {
    id: 'pr1',
    tenantId: 't1',
    companyId: '00000000-0000-4000-8000-000000000001',
    processorNo: null,
    name: '测试加工厂',
    contactName: '王师傅',
    version: 1,
    createdAt: '2026-11-08T00:00:00.000Z',
    updatedAt: '2026-11-08T00:00:00.000Z',
  };

  const renderQuotes = (canQuote: boolean) =>
    renderToStaticMarkup(
      <QueryClientProvider client={createQueryClient()}>
        <ProcessorQuotes processor={PROCESSOR} canQuote={canQuote} />
      </QueryClientProvider>,
    );

  it('无 processor.create 时「记录报价」禁用并写明缺哪个 scope', () => {
    const html = renderQuotes(false);
    expect(html).toContain('记录报价');
    expect(html).toContain('需要 processor.create 权限');
    expect(html).toContain('disabled=""');
  });

  it('有 processor.create 时「记录报价」可点', () => {
    const html = renderQuotes(true);
    expect(html).toContain('记录报价');
    // 可点态 title 是「执行「X」· 需要 …」（规范 §四.3），不能再是纯缺失提示
    expect(html).toContain('执行「记录报价」· 需要 processor.create 权限');
    expect(html).not.toContain('title="需要 processor.create 权限"');
  });
});
