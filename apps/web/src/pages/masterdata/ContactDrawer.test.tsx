import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../../api/query';
import { ContactDrawer } from './ContactDrawer';

const CREATED_AT = '2026-11-08T00:00:00.000Z';

function renderDrawer(summaryData: unknown): string {
  const client = createQueryClient();
  client.setQueryData(['masterdata', 'customers', 'c1', 'contact-summary'], summaryData);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ContactDrawer
        kind="customers"
        entityId="c1"
        entityName="测试客户"
        entityLabel="客户"
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

describe('对接人抽屉', () => {
  it('显示「未指定对接人」分组，且无看价权限时金额是占位符而不是 0', () => {
    const html = renderDrawer({
      orderCount: 5,
      // totalAmount 键整段缺失 = 无 view_price
      lastOrderAt: CREATED_AT,
      recentOrders: [
        {
          id: 'o1',
          orderNo: 'SO-1',
          status: '进行中',
          createdAt: CREATED_AT,
          contactId: 'ct1',
          contactName: '赵老板',
        },
        {
          id: 'o2',
          orderNo: 'SO-2',
          status: '进行中',
          createdAt: CREATED_AT,
          contactId: null,
          contactName: null,
        },
      ],
      contacts: [
        {
          id: 'ct1',
          tenantId: 't1',
          companyId: 'co1',
          customerId: 'c1',
          name: '赵老板',
          phone: '13900000000',
          title: '采购主管',
          isPrimary: true,
          status: '启用',
          version: 1,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
      ],
      contactGroups: [
        { contactId: 'ct1', contactName: '赵老板', orderCount: 3, lastOrderAt: CREATED_AT },
        { contactId: null, contactName: null, orderCount: 2, lastOrderAt: null },
      ],
    });

    expect(html).toContain('测试客户 · 对接人');
    // 未指定对接人组必须出现，否则各分组数量加不出总数
    expect(html).toContain('未指定对接人');
    expect(html).toContain('赵老板');
    // summary 带完整手机号，抽屉里脱敏成后 4 位
    expect(html).toContain('****0000');
    expect(html).not.toContain('13900000000');
    // 金额键缺失 → 占位符，不是 0
    expect(html).toContain('—');
    expect(html).not.toContain('>0<');
  });
});
