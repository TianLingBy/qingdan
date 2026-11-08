import type { Processor, Product, Supplier } from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { ProcessorsPage, ProductsPage, SuppliersPage } from './MasterdataPage';
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
  status: '启用',
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
        status: undefined,
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
  });

  it('空列表提供明确空态', () => {
    const client = createQueryClient();
    client.setQueryData(
      masterdataQueryKeys.list('products', {
        keyword: undefined,
        status: undefined,
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
      status: '启用',
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
      status: '启用',
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
        status: undefined,
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

    const processorClient = createQueryClient();
    processorClient.setQueryData(masterdataQueryKeys.me, me);
    processorClient.setQueryData(
      masterdataQueryKeys.list('processors', {
        keyword: undefined,
        status: undefined,
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
    expect(processorHtml).toContain('报价');
  });
});
