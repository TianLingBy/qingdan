import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { fetchEmployees, type EmployeeSummary } from '../api/platform';

/**
 * 员工「姓名簿」：把单据上的裸 id（经手人 / 提成归属人 / 盘点发起人）换成**姓名**。
 *
 * 为什么需要它：契约里单据只回 `handlerId`、`commissionOwnerId`、`applicantId` 这类外键，
 * **没有配套的 `xxxName`**，前端不查就只能在界面上露 UUID 前 8 位——对使用者没有意义。
 *
 * 三条边界（都很重要）：
 * 1. **一次拉一册，不按 id 分片**。同一页里这些 id 高频重复（同一经手人开很多单），
 *    按 id 缓存会打出十几条请求；姓名簿整册缓存 5 分钟足够。
 * 2. **失败必须静默降级**。读员工要组织域权限，销售 / 仓管通常没有 → `403`。
 *    这里吞掉错误回空表，调用方退回 id 前 8 位，**不能因为查不到姓名就让单据页报错**。
 * 3. **只做展示**。不参与任何判定（权限仍以 `scope` 为准，D4/D15/D27）。
 */

/** 姓名簿查询键：整册一条，`staleTime` 内不重拉。 */
export const employeeDirectoryKey = ['employees', 'directory'] as const;

const DIRECTORY_LIMIT_NOTE = '员工上限 100 人（服务端一次 limit=100）——中小企业够用，超出时未命中的退回 id 前缀。';

/** 纯函数：员工列表 → `id → 姓名`。抽出来是为了单测不依赖 React。 */
export function buildEmployeeNameMap(
  employees: readonly Pick<EmployeeSummary, 'id' | 'name'>[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const employee of employees) {
    const name = employee.name.trim();
    if (employee.id && name) map.set(employee.id, name);
  }
  return map;
}

/** id 前缀兜底：姓名簿里没有这个 id 时，至少给出可肉眼区分的短 id。 */
export function shortIdLabel(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** 查询函数：失败一律回空表（见文件头第 2 条边界）。 */
async function loadEmployeeDirectory(): Promise<readonly EmployeeSummary[]> {
  try {
    const page = await fetchEmployees();
    return page.items;
  } catch {
    return [];
  }
}

/**
 * 返回 `id → 展示文案`：
 * - `null | undefined` → `—`（空字段显示破折号，不留白）；
 * - 命中姓名簿 → 姓名；
 * - 未命中 / 无权限 → id 前 8 位。
 *
 * 用法：`const employeeLabel = useEmployeeLabel();` 然后 `employeeLabel(order.handlerId)`。
 */
export function useEmployeeLabel(): (id: string | null | undefined) => string {
  const { data } = useQuery({
    queryKey: employeeDirectoryKey,
    queryFn: loadEmployeeDirectory,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const names = useMemo(() => buildEmployeeNameMap(data ?? []), [data]);

  return useCallback(
    (id: string | null | undefined) => {
      if (!id) return '—';
      return names.get(id) ?? shortIdLabel(id);
    },
    [names],
  );
}

export const EMPLOYEE_DIRECTORY_NOTE = DIRECTORY_LIMIT_NOTE;
