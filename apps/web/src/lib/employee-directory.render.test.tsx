import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createQueryClient } from '../api/query';
import type { EmployeeSummary } from '../api/platform';
import { employeeDirectoryKey, useEmployeeLabel } from './employee-directory';

/**
 * `useEmployeeLabel` 的接线测试：姓名簿命中给姓名，空表（无权限 403 的降级结果）退回 id 前缀。
 *
 * 为什么要有渲染测试：纯函数对了不代表接线对——查询键写错、`staleTime` 之外的重拉、
 * 或者忘了走缓存，都会让页面上又露回 UUID 前缀。这里直接塞缓存渲染，验证取值链路。
 */

const OWNER_ID = '01900000-0000-7000-8000-000000000021';

function Probe({ id }: { id: string | null }) {
  const employeeLabel = useEmployeeLabel();
  return <span>{employeeLabel(id)}</span>;
}

function render(client: ReturnType<typeof createQueryClient>, id: string | null): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Probe id={id} />
    </QueryClientProvider>,
  );
}

function employee(id: string, name: string): EmployeeSummary {
  return {
    id,
    employeeNo: `E-${id}`,
    name,
    status: '在职',
    isOwner: false,
    phoneMasked: '138****0000',
    companies: [],
  };
}

describe('员工姓名簿（页面级取值）', () => {
  it('命中姓名簿时显示姓名，不再露 id', () => {
    const client = createQueryClient();
    client.setQueryData(employeeDirectoryKey, [employee(OWNER_ID, '王芳')]);

    expect(render(client, OWNER_ID)).toContain('王芳');
    expect(render(client, OWNER_ID)).not.toContain('01900000');
  });

  it('空表（无员工读权限，403 降级）时退回 id 前 8 位', () => {
    const client = createQueryClient();
    client.setQueryData(employeeDirectoryKey, []);

    expect(render(client, OWNER_ID)).toContain('01900000');
  });

  it('归属人为空时是破折号，不是空白也不是 undefined', () => {
    const client = createQueryClient();
    client.setQueryData(employeeDirectoryKey, [employee(OWNER_ID, '王芳')]);

    expect(render(client, null)).toContain('—');
    expect(render(client, null)).not.toContain('undefined');
  });
});
