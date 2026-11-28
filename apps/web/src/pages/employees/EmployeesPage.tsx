import type { ScopeMatrix } from '@qingdan/contracts';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchEmployees, fetchMe, fetchPositions } from '../../api/platform';
import { ApiError } from '../../api/client';
import { ListEmpty, ListError, ListLoading } from '../../components/ListStates';
import { allows } from '../../lib/access';
import { resolveListState } from '../../lib/list-state';
import { PermissionOverridePanel } from './PermissionOverridePanel';

/**
 * 员工页（22 页之第 16 页，#6 / #432 五页重做之一）。
 *
 * 视觉：照 v0.13 `员工.html` 与 `design/v3.0/index.html` 的 `PG.employees` 逐块搬 ——
 * 标题区（eyebrow + h1 + sub）→ 工具条（状态分段 / 公司 / 搜索）→ `.card.list-card`
 * 表格（工号 / 姓名 / 手机号 / 公司 · 岗位 / 状态 / 操作）→ 页脚条 `.tf`。
 * 页面不再写任何 Tailwind 工具类，行内不加 `style=`，样式全部来自 `app-v013.css`
 * 与 `app-v30.css`（#488 之后由负责人维护，页面 PR 不改 `styles/**`）。
 *
 * 数据：**真接口** `GET /api/v1/employees`；手机号服务端已脱敏；
 * 筛选为本地过滤（`fetchEmployees()` 不带查询参数，不自造 keyword/status 参数）。
 *
 * 操作列只放**真接口**做得到的事：「权限」→ 个人权限覆盖面板。
 * 稿子里的「新建 / 停用」照抄会变成假按钮，故不画（口径见页脚 note）：
 * `POST /employees` 与 `DELETE /employees/{id}` 都是危险动作（D52.1 / D54⑥，
 * 契约 `ai.policy = forbid`，停用还要 `reasonRequired` + If-Match），
 * 前端 API 层尚未接线，接线需单独 issue。
 */

/** 状态分段（与契约 `EmployeeSummary.status` 取值一致）。 */
const STATUS_TABS = [
  { value: '', label: '全部状态' },
  { value: '在职', label: '在职' },
  { value: '停用', label: '停用' },
] as const;

const COLUMN_COUNT = 6;

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
  const [statusFilter, setStatusFilter] = useState('');
  const [companyFilter, setCompanyFilter] = useState('');

  const employees = employeesQuery.data?.items ?? [];
  /**
   * `/auth/me` 的 `scope` 在 `api/platform.ts` 里还是宽类型（`{ domain: string }[]`），
   * 与服务端实际返回的 `ScopeMatrix` 一致，这里窄化一次再交给 `allows()`；
   * 宽类型收敛进契约另开 issue，页面不自己放宽判定。
   */
  const scope = meQuery.data?.scope as ScopeMatrix | undefined;

  /**
   * 筛选一律**本地过滤**：`fetchEmployees()` 固定 `limit=100` 且不传参数，
   * 后端是否支持 keyword/status/companyId 未证实（改稿清单 §六.5），不自造查询参数。
   */
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const meId = meQuery.data?.employeeId;
    return employees.filter((e) => {
      // 契约：is_owner 员工除本人外不可读；等 me 到了再过滤，避免首屏闪掉本人
      if (e.isOwner && meId !== undefined && e.id !== meId) return false;
      if (statusFilter !== '' && e.status !== statusFilter) return false;
      if (companyFilter !== '' && !e.companies.some((c) => c.companyId === companyFilter)) {
        return false;
      }
      if (kw === '') return true;
      return (
        e.name.toLowerCase().includes(kw) ||
        e.employeeNo.includes(kw) ||
        e.phoneMasked.includes(kw)
      );
    });
  }, [employees, keyword, statusFilter, companyFilter, meQuery.data?.employeeId]);

  /** 公司筛选项：从员工档案里的 companies 聚合（不额外打组织接口）。 */
  const companyOptions = useMemo(() => {
    const map = new Map<string, string>();
    employees.forEach((e) => e.companies.forEach((c) => map.set(c.companyId, c.companyName)));
    return [...map.entries()];
  }, [employees]);

  /**
   * 权限三态（#432 第 2 关「权限态」）：没 `employee.read` 时整页只剩提示页，
   * 没 `employee.update` 时「权限」按钮禁用并把缺的 scope 写进 `title`，不留假可点按钮。
   */
  const canRead = meQuery.data === undefined || allows(scope, 'employee', 'read');
  const canUpdate = meQuery.data === undefined || allows(scope, 'employee', 'update');
  const panelTitle = !canUpdate
    ? '需要 employee.update 才能改个人权限覆盖'
    : meQuery.data === undefined
      ? '身份信息加载中'
      : '个人权限覆盖';

  /** 列表四态：交给容器与 tbody 的 `data-state` 驱动，不写 JSX 三元分支。 */
  const listState = resolveListState({
    isPending: employeesQuery.isPending,
    hasError: employeesQuery.isError,
    isEmpty: filtered.length === 0,
  });

  return (
    <section className="page-body">
      <div className="p-head">
        <div>
          <div className="eyebrow">组织 / 员工</div>
          <h1>员工</h1>
          <p className="sub">工号 / 手机号（脱敏）/ 公司 · 岗位。停用即断权。</p>
        </div>
      </div>

      {meQuery.data && !canRead && (
        <p className="alert alert-warn">
          当前身份没有员工管理权限（<code className="mono">employee.read</code>），
          列表不会返回数据；请联系老板开通。
        </p>
      )}

      {/* 工具条：状态分段 + 公司下拉 + 搜索（v0.13 `.toolbar` 版式，全为本地过滤） */}
      <div className="toolbar">
        <div className="seg" role="group" aria-label="按状态筛选">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value || 'all'}
              type="button"
              className={statusFilter === tab.value ? 'on' : undefined}
              aria-pressed={statusFilter === tab.value}
              onClick={() => setStatusFilter(tab.value)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {companyOptions.length > 1 && (
          <select
            value={companyFilter}
            onChange={(event) => setCompanyFilter(event.target.value)}
            aria-label="按公司筛选"
            className="sel"
          >
            <option value="">全部公司</option>
            {companyOptions.map(([id, name]) => (
              <option key={id} value={id} title={id}>
                {name}
              </option>
            ))}
          </select>
        )}
        <input
          type="search"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="搜索姓名 / 工号…"
          aria-label="搜索姓名或工号"
          className="search"
        />
      </div>

      {/*
        列表（v3.0 `list-card`）：容器与 tbody 挂同一个 data-state，
        三行状态行常驻且带 `st-tr st-*`，显隐交给 `app-v013.css`；
        `.tf` 在空 / 加载 / 错误态自动收起右侧分页（`app-v30.css`）。
      */}
      <div className="card list-card" data-state={listState}>
        <div className="tw">
          <table className="w-full min-w-[860px] text-left">
            <thead>
              <tr>
                <th>工号</th>
                <th>姓名</th>
                <th>手机号（脱敏）</th>
                <th>公司 · 岗位</th>
                <th>状态</th>
                <th className="num">操作</th>
              </tr>
            </thead>
            <tbody data-state={listState}>
              <tr className="st-tr st-loading">
                <td colSpan={COLUMN_COUNT}>
                  <ListLoading label="员工列表加载中…" rows={4} />
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={COLUMN_COUNT}>
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
                <td colSpan={COLUMN_COUNT}>
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
                <tr key={employee.id} className="r-row">
                  <td className="mono">{employee.employeeNo}</td>
                  <td>
                    <b>{employee.name}</b>
                    {employee.isOwner && <span className="tag primary">老板</span>}
                    {/* v0.13 员工页的副行：老板档案除本人外不可读（契约 EmployeeSchema 注释） */}
                    {employee.isOwner && <span className="cell-sub">仅本人可见</span>}
                  </td>
                  <td className="mono">{employee.phoneMasked}</td>
                  <td>
                    {employee.companies.map((c) => `${c.companyName} · ${c.positionName}`).join('、') ||
                      '—'}
                  </td>
                  <td>
                    <span className={`st ${employee.status === '在职' ? 'ok' : 'idle'}`}>
                      {employee.status}
                    </span>
                  </td>
                  <td className="num">
                    <button
                      type="button"
                      disabled={meQuery.data === undefined || !canUpdate}
                      onClick={() => setPanel({ open: true, employeeId: employee.id })}
                      className="btn btn-s"
                      title={panelTitle}
                    >
                      权限
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="tf">
          <span>共 {filtered.length} 人</span>
        </div>
      </div>

      {/* `.note` 在 v3.0 组件层是「图标 + 一句话」的 inline-flex，长段落用 `.detail-why` */}
      <p className="detail-why">
        手机号为服务端脱敏值（前 3 + **** + 后 4）；数据可见范围由服务端判定（D15），前端隐藏不算数。
        新建与停用需 employee.create / employee.disable，属危险动作（D52.1 / D54⑥，
        停用还要填原因 + If-Match），前端 API 层未接线前不画按钮。
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
