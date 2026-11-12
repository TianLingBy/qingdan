import type { CommissionRate } from '@qingdan/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EmployeeSummary } from '../../api/platform';
import { createQueryClient } from '../../api/query';
import { companyDirectoryQueryKey } from '../../lib/company-directory';
import { CommissionRatesPanel } from './CommissionRatesPanel';
import { commissionRateQueryKeys } from './commission-rates-api';

/**
 * 提成比例配置面板的渲染口径测试（静态渲染，与项目其余页面测试一致）。
 *
 * 盯的是「权限不对时界面别骗人」：没有 create 就不要出现保存按钮，
 * 没有 delete 就不要出现删除按钮，没有授权公司就说清没有公司。
 */

const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
const EMPLOYEE_ID = '01900000-0000-7000-8000-000000000021';

const RATE: CommissionRate = {
  id: 'r1',
  tenantId: 't1',
  companyId: COMPANY_ID,
  employeeId: EMPLOYEE_ID,
  rate: '0.125',
  effectiveFrom: '2026-03-01',
  createdBy: '01900000-0000-7000-8000-000000000011',
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-01T00:00:00.000Z',
};

const EMPLOYEE: EmployeeSummary = {
  id: EMPLOYEE_ID,
  employeeNo: 'E0007',
  name: '张明',
  status: '在职',
  isOwner: false,
  phoneMasked: '138****0000',
  companies: [
    {
      companyId: COMPANY_ID,
      companyName: '演示公司',
      positionId: 'p1',
      positionName: '销售',
    },
  ],
};

function seedClient(input: {
  readonly companyIds?: readonly string[];
  readonly rates?: readonly CommissionRate[];
  readonly employees?: readonly EmployeeSummary[];
}): ReturnType<typeof createQueryClient> {
  const client = createQueryClient();
  const companyIds = input.companyIds ?? [COMPANY_ID];
  client.setQueryData(companyDirectoryQueryKey, {
    items: [{ id: COMPANY_ID, name: '演示公司', code: '0001' }],
    nextCursor: null,
  });
  client.setQueryData(['employees', 'commission-options'], {
    items: [...(input.employees ?? [EMPLOYEE])],
    nextCursor: null,
  });
  if (companyIds[0] !== undefined) {
    client.setQueryData(
      commissionRateQueryKeys.list({ companyId: companyIds[0], employeeId: undefined }),
      { items: [...(input.rates ?? [])], nextCursor: null },
    );
  }
  return client;
}

function renderPanel(
  client: ReturnType<typeof createQueryClient>,
  props: { readonly canCreate: boolean; readonly canDelete: boolean; readonly companyIds?: readonly string[] },
): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CommissionRatesPanel
        companyIds={props.companyIds ?? [COMPANY_ID]}
        canCreate={props.canCreate}
        canDelete={props.canDelete}
      />
    </QueryClientProvider>,
  );
}

describe('提成比例配置面板', () => {
  it('列出配置：公司名、员工姓名、比例按百分比带足小数、生效日', () => {
    const html = renderPanel(seedClient({ rates: [RATE] }), {
      canCreate: true,
      canDelete: true,
    });

    expect(html).toContain('提成比例配置');
    expect(html).toContain('演示公司（0001）');
    expect(html).toContain('张明');
    // 0.125 → 12.50%，不能显示成 0.125%
    expect(html).toContain('12.50%');
    expect(html).toContain('2026-03-01');
  });

  it('写明口径：一期只按人、结算时快照、改配置不影响已结算单（D77 / D36）', () => {
    const html = renderPanel(seedClient({}), { canCreate: true, canDelete: true });

    expect(html).toContain('一期只按人');
    expect(html).toContain('快照');
    expect(html).toContain('不影响已结算单');
  });

  it('没有 create 权限时不出现保存按钮，并说明差哪个 scope', () => {
    const html = renderPanel(seedClient({}), { canCreate: false, canDelete: false });

    expect(html).not.toContain('保存配置');
    expect(html).toContain('commission.create');
  });

  it('没有 delete 权限时行内显示「无删除权限」，而不是给一个点了会 403 的按钮', () => {
    const html = renderPanel(seedClient({ rates: [RATE] }), {
      canCreate: false,
      canDelete: false,
    });

    expect(html).toContain('无删除权限');
    expect(html).not.toContain('>删除<');
  });

  it('有 delete 权限时出现删除按钮', () => {
    const html = renderPanel(seedClient({ rates: [RATE] }), {
      canCreate: true,
      canDelete: true,
    });

    expect(html).toContain('>删除<');
  });

  it('没有授权公司时说清「没有可用公司」，不给空下拉', () => {
    const html = renderPanel(seedClient({ companyIds: [] }), {
      canCreate: true,
      canDelete: true,
      companyIds: [],
    });

    expect(html).toContain('当前账号没有可用公司');
  });

  it('空列表解释「没配就记 0」，不让人以为要用别的公司比例兜底（D77 ②）', () => {
    const html = renderPanel(seedClient({ rates: [] }), { canCreate: true, canDelete: true });

    expect(html).toContain('还没有提成配置');
    expect(html).toContain('没配就按 0 记提成');
  });

  it('员工名册里没有绑到该公司的员工时，新增表单给明确结论而不是空下拉', () => {
    const otherCompanyEmployee: EmployeeSummary = {
      ...EMPLOYEE,
      companies: [{ ...EMPLOYEE.companies[0]!, companyId: '00000000-0000-4000-8000-0000000000ff' }],
    };
    const html = renderPanel(
      seedClient({ employees: [otherCompanyEmployee] }),
      { canCreate: true, canDelete: true },
    );

    expect(html).toContain('该公司下没有可配置的员工');
  });
});
