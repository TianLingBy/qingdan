import type { Customer, Processor, Product, Supplier } from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/client';
import { createQueryClient } from '../../api/query';
import {
  CustomersPage,
  ProcessorsPage,
  ProductsPage,
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
    expect(html).toContain('无看价权限或未设置');
    expect(html).toContain('新增商品');
    // 拆列（#338 §2.1）：别名 / 规格 / 单位 各独立一列，不再合并成「补充信息」
    expect(html).toContain('别名');
    expect(html).toContain('规格');
    expect(html).toContain('单位');
    expect(html).not.toContain('补充信息');
    // 主数据已去掉状态：不再有状态列，操作列提供「删除」而不是「停用」。
    expect(html).not.toContain('状态');
    expect(html).not.toContain('停用');
    expect(html).toContain('删除');
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

  it('空列表提供明确空态', () => {
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

    expect(html).toContain('暂无数据');
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

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ProductsPage />
      </QueryClientProvider>,
    );

    // 按钮仍在 DOM 里（不 return null 藏起来），只是 disabled + title 说明缺哪个 scope
    expect(html).toContain('新增商品');
    expect(html).toContain('编辑');
    expect(html).toContain('删除');
    expect(html).toContain('需要 product.create 权限');
    expect(html).toContain('需要 product.update 权限');
    expect(html).toContain('需要 product.delete 权限');
    expect(html).toContain('disabled=""');
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
    // 数据行只带 r-row，不能带 st-tr（否则 filled 状态下会被隐藏，#337）
    expect(html).toContain('class="r-row"');
    expect(html).not.toContain('r-row st-tr');
    // 有 create 权限时新增按钮不禁用
    expect(html).not.toContain('需要 product.create 权限');
  });

  it('供应商页与加工厂页也完成真实路由组件接线', () => {
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
    const me = {
      employeeId: 'e1',
      tenantId: 't1',
      displayName: '测试员工',
      companyIds: [PRODUCT.companyId],
      scope: [],
    };

    const supplierClient = createQueryClient();
    supplierClient.setQueryData(masterdataQueryKeys.me, me);
    supplierClient.setQueryData(
      masterdataQueryKeys.list('suppliers', {
        keyword: undefined,
        cursor: null,
      }),
      { items: [supplier], nextCursor: null },
    );
    const supplierHtml = renderToStaticMarkup(
      <QueryClientProvider client={supplierClient}>
        <SuppliersPage />
      </QueryClientProvider>,
    );
    expect(supplierHtml).toContain('供应商档案');
    expect(supplierHtml).toContain('测试供应商');
    expect(supplierHtml).toContain('纸箱');
    // 供应商表头拆列（改稿清单 §2.3）：供货物料、主联系人各独立成列，不再有合并的「补充信息」。
    expect(supplierHtml).toContain('供货物料');
    expect(supplierHtml).toContain('主联系人');
    expect(supplierHtml).not.toContain('补充信息');
    // 主联系人列同时带出联系电话
    expect(supplierHtml).toContain('李经理');
    expect(supplierHtml).toContain('10000000000');

    const processorClient = createQueryClient();
    processorClient.setQueryData(masterdataQueryKeys.me, me);
    processorClient.setQueryData(
      masterdataQueryKeys.list('processors', {
        keyword: undefined,
        cursor: null,
      }),
      { items: [processor], nextCursor: null },
    );
    const processorHtml = renderToStaticMarkup(
      <QueryClientProvider client={processorClient}>
        <ProcessorsPage />
      </QueryClientProvider>,
    );
    expect(processorHtml).toContain('加工厂档案');
    expect(processorHtml).toContain('测试加工厂');
    // 行操作按钮文案按改稿清单 §2.4 由「报价」改为「价目」；主联系人独立成列且不显示电话。
    expect(processorHtml).toContain('价目');
    expect(processorHtml).toContain('主联系人');
    expect(processorHtml).toContain('王师傅');
  });

  it('客户档案页主联系人独立成列（姓名+电话），且不出现任何金额列', () => {
    const customer: Customer = {
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
      { items: [customer], nextCursor: null },
    );

    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <CustomersPage />
      </QueryClientProvider>,
    );

    expect(html).toContain('客户档案');
    expect(html).toContain('测试客户');
    // 表头按改稿清单 §2.2：主联系人独立成列，姓名后带电话；不再有合并的「补充信息」列。
    expect(html).toContain('主联系人');
    expect(html).toContain('赵老板');
    expect(html).toContain('13900000000');
    expect(html).not.toContain('补充信息');
    expect(html).toContain('新增客户');
    // 客户没有金额口径（D49 注释），页面不得出现售价列
    expect(html).not.toContain('默认售价');
  });
});
