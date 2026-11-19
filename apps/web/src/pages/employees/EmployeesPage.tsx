import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchEmployees, fetchMe, fetchPositions } from '../../api/platform';
import { ApiError } from '../../api/client';
import { ListEmpty, ListError, ListLoading } from '../../components/ListStates';
import { resolveListState } from '../../lib/list-state';
import { PermissionOverridePanel } from './PermissionOverridePanel';

/**
 * 员工页（22 页之第 16 页，#6）。
 *
 * - 列表：**真接口** `GET /api/v1/employees`（员工列表端点已上线，原 issue 假数据前提不再成立），
 *   含加载 / 空 / 错误三态；手机号服务端已脱敏；
 * - 行内「权限」按钮 → 个人权限覆盖面板（唯一真接口联调部分，PermissionOverridePanel）；
 * - 岗位管理、公司管理入口：占位（公司/岗位端点 #156 已补，页面归 #144）。
 *
 * 隐私口径：手机号只展示脱敏值；数据可见范围由服务端判定（D15，前端隐藏不算数）。
 */

export function EmployeesPage() {
  const employeesQuery = useQuery({
    queryKey: ['employees'],
    queryFn: fetchEmployees,
  });
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: fetchMe,
  });
  // 岗位模板用于覆盖面板的基线列；端点未上线（501）时降级为无基线对照。
  const positionsQuery = useQuery({
    queryKey: ['positions'],
    queryFn: fetchPositions,
    retry: false,
  });

  const [panel, setPanel] = useState<{ open: boolean; employeeId: string | null }>({
    open: false,
    employeeId: null,
  });
  const [keyword, setKeyword] = useState('');

  const employees = employeesQuery.data?.items ?? [];
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (kw === '') return employees;
    return employees.filter(
      (e) =>
        e.name.toLowerCase().includes(kw) ||
        e.employeeNo.includes(kw) ||
        e.phoneMasked.includes(kw),
    );
  }, [employees, keyword]);

  const canOpenPanel = meQuery.data !== undefined;
  /** 列表四态：交给容器与 tbody 的 `data-state` 驱动，不写 JSX 三元分支。 */
  const listState = resolveListState({
    isPending: employeesQuery.isPending,
    hasError: employeesQuery.isError,
    isEmpty: filtered.length === 0,
  });

  return (
    <section className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">员工</h1>
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
            已接真实接口
          </span>
        </div>
        <input
          type="search"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="按姓名 / 工号 / 手机号后四位筛选"
          className="w-64 rounded border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-slate-400"
        />
      </div>

      <div className="card mt-5" data-state={listState}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-400">
                <th className="px-4 py-2.5 font-medium">工号</th>
                <th className="px-4 py-2.5 font-medium">姓名</th>
                <th className="px-4 py-2.5 font-medium">手机号（脱敏）</th>
                <th className="px-4 py-2.5 font-medium">公司 · 岗位</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 text-right font-medium">操作</th>
              </tr>
            </thead>
            <tbody data-state={listState}>
              {/* 三个状态行常驻 DOM，CSS 按 data-state 只显示其中一个 */}
              <tr className="st-tr st-loading">
                <td colSpan={6}>
                  <ListLoading label="员工列表加载中…" rows={4} />
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={6}>
                  <ListError
                    title="员工列表加载失败"
                    error={employeesQuery.error}
                    hint={
                      employeesQuery.error instanceof ApiError &&
                      employeesQuery.error.status === 403
                        ? '你没有员工管理权限（employee.read），请联系老板开通。'
                        : '请确认本地 API 已启动（vite 会把 /api 代理到 127.0.0.1:3000），然后重试。'
                    }
                    onRetry={() => void employeesQuery.refetch()}
                  />
                </td>
              </tr>
              <tr className="st-tr st-empty">
                <td colSpan={6}>
                  <ListEmpty
                    title={
                      employees.length === 0
                        ? '还没有员工。请联系老板在后台建号。'
                        : '没有匹配的员工。'
                    }
                  />
                </td>
              </tr>
              {filtered.map((employee) => (
                <tr key={employee.id} className="r-row border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{employee.employeeNo}</td>
                  <td className="px-4 py-2.5">
                    {employee.name}
                    {employee.isOwner && (
                      <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                        老板
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{employee.phoneMasked}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-600">
                    {employee.companies.map((c) => `${c.companyName}·${c.positionName}`).join('、') || '—'}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={[
                        'rounded-full px-2 py-0.5 text-xs font-medium',
                        employee.status === '在职'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-slate-100 text-slate-500',
                      ].join(' ')}
                    >
                      {employee.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      type="button"
                      disabled={!canOpenPanel}
                      onClick={() => setPanel({ open: true, employeeId: employee.id })}
                      className="rounded border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
                      title={canOpenPanel ? '个人权限覆盖' : '身份信息加载中'}
                    >
                      权限
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-3 text-xs text-slate-400">
        手机号为脱敏展示（服务端口径）；数据可见范围由服务端判定（D15），前端隐藏不算数。
        公司管理、岗位模板页面见 #144（本页只做列表与权限覆盖）。
      </p>

      {panel.open &&
        meQuery.data &&
        (() => {
          const target = employees.find((e) => e.id === panel.employeeId);
          if (!target) return null;
          return (
            <PermissionOverridePanel
              employee={target}
              me={meQuery.data}
              positions={positionsQuery.data?.items ?? null}
              positionsUnavailable={positionsQuery.isError}
              onClose={() => setPanel({ open: false, employeeId: null })}
            />
          );
        })()}
    </section>
  );
}
