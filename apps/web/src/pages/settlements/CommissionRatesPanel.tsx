import type { CommissionRate, CommissionRateCreateInput } from '@qingdan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { fetchEmployees } from '../../api/platform';
import { buildEmployeeNameMap, shortIdLabel } from '../../lib/employee-directory';
import { useCompanyLabel } from '../../lib/company-directory';
import {
  commissionRateQueryKeys,
  commissionRatesApi,
  describeCommissionRateError,
  formatRatePercent,
  percentToRate,
  todayIsoDate,
} from './commission-rates-api';

/**
 * 提成比例配置面板（结算单 C 页的从属入口；#214 / D77 / D36）。
 *
 * 为什么挂在 C 单页而不是单开一页：提成是 C 单的派生数字（D36 以 C 单为单位、不跨单归并），
 * 22 页 IA 里没有「提成配置」这一页（prototype-v0 §2 把提成并进 C 单）。
 *
 * 四条边界：
 * 1. **公司只能选自己已授权的**：下拉取 `GET /auth/me` 的 `companyIds`，不用公司目录全量——
 *    前端多给一个选项，用户点下去只会拿到 403，等于骗人（D15）。
 * 2. **员工按所选公司过滤**：员工必须先绑定到该公司（`employee.companies`），
 *    否则服务端回 422（D80）；这里提前收窄，别让人白填一遍。
 * 3. **比例按百分比输入、按 decimal 提交**：界面 `5`（%），请求体 `0.05`，换算走定点（D54）。
 * 4. **只读不猜**：列表、比例、生效日全部渲染服务端返回值；不重算提成，不动算法（D36 快照）。
 */

/** 员工选项查询键（与姓名簿分开：这里要把 403 暴露出来给用户看）。 */
const COMMISSION_EMPLOYEE_OPTIONS_KEY = ['employees', 'commission-options'] as const;

interface CommissionRatesPanelProps {
  /** 当前身份已授权公司（`/auth/me` 的 `companyIds`）。 */
  readonly companyIds: readonly string[];
  readonly canCreate: boolean;
  readonly canDelete: boolean;
}

export function CommissionRatesPanel({
  companyIds,
  canCreate,
  canDelete,
}: CommissionRatesPanelProps) {
  const queryClient = useQueryClient();
  const companyLabel = useCompanyLabel();

  const [companyId, setCompanyId] = useState<string>(companyIds[0] ?? '');
  const [employeeFilter, setEmployeeFilter] = useState('');
  const [formEmployeeId, setFormEmployeeId] = useState('');
  const [formPercent, setFormPercent] = useState('');
  const [formEffectiveFrom, setFormEffectiveFrom] = useState(() => todayIsoDate());
  const [formError, setFormError] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 授权公司可能在面板打开后才回填（`/auth/me` 还在加载），补一次默认值。
  useEffect(() => {
    if (companyId === '' && companyIds[0] !== undefined) setCompanyId(companyIds[0]);
  }, [companyIds, companyId]);

  const filters = useMemo(
    () => ({
      companyId: companyId === '' ? undefined : companyId,
      employeeId: employeeFilter === '' ? undefined : employeeFilter,
    }),
    [companyId, employeeFilter],
  );

  const list = useQuery({
    queryKey: commissionRateQueryKeys.list(filters),
    queryFn: () => commissionRatesApi.list(filters),
    enabled: companyId !== '',
  });

  /**
   * 员工名册：既要给「提成归属人」渲染姓名，也要给新增表单提供选项。
   * 读员工要组织域权限（`employee.read`）——老板有，财务未必有，所以 `isError` 要能看见，
   * 不能像姓名簿那样静默吞掉，否则表单会显示成「没有员工」而不是「没权限」。
   */
  const employeesQuery = useQuery({
    queryKey: COMMISSION_EMPLOYEE_OPTIONS_KEY,
    queryFn: fetchEmployees,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const employees = employeesQuery.data?.items ?? [];
  const nameMap = useMemo(() => buildEmployeeNameMap(employees), [employees]);
  const employeeLabel = (id: string | null): string => {
    if (id === null) return '—';
    return nameMap.get(id) ?? shortIdLabel(id);
  };

  /** 该公司下可配置的员工（员工必须已绑定公司，否则服务端 422，D80）。 */
  const companyEmployees = useMemo(
    () =>
      employees.filter((employee) =>
        employee.companies.some((binding) => binding.companyId === companyId),
      ),
    [employees, companyId],
  );

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ['commission-rates', 'list'] });

  const create = useMutation({
    mutationFn: (input: CommissionRateCreateInput) => commissionRatesApi.create(input),
    onSuccess: (rate) => {
      setFormPercent('');
      setFormError(null);
      setPanelError(null);
      setNotice(
        `已为「${employeeLabel(rate.employeeId)}」配置 ${formatRatePercent(rate.rate)}，自 ${rate.effectiveFrom} 起生效。`,
      );
      void invalidate();
    },
    onError: (error) => setFormError(describeCommissionRateError(error)),
  });

  const remove = useMutation({
    mutationFn: (rate: CommissionRate) => commissionRatesApi.remove(rate.id),
    onSuccess: (rate) => {
      setPanelError(null);
      setNotice(
        `已删除「${employeeLabel(rate.employeeId)}」${formatRatePercent(rate.rate)}（${rate.effectiveFrom} 生效的那条）。已结算单用的是当时的快照，不受影响（D77 ④）。`,
      );
      void invalidate();
    },
    onError: (error) => {
      // 404 = 别人先删了：结果和目标一致，刷新掉这一行，别让用户对着一条幻影点第二次。
      if (error instanceof ApiError && error.code === 'NOT_FOUND') void invalidate();
      setPanelError(describeCommissionRateError(error));
    },
  });

  const submit = () => {
    if (companyId === '') {
      setFormError('请先选择公司（当前账号没有可用公司）');
      return;
    }
    if (formEmployeeId === '') {
      setFormError('请选择提成归属人（一期只支持按人配置，D77 ①）');
      return;
    }
    const rate = percentToRate(formPercent);
    if (rate === null) {
      setFormError('提成比例请填 0–100 的百分比，最多 4 位小数（例：5、7.5、0.125）');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(formEffectiveFrom)) {
      setFormError('请选择生效日（含当日）');
      return;
    }
    setFormError(null);
    setNotice(null);
    create.mutate({ companyId, employeeId: formEmployeeId, rate, effectiveFrom: formEffectiveFrom });
  };

  const askRemove = (rate: CommissionRate) => {
    const message = `确认删除「${employeeLabel(rate.employeeId)}」${formatRatePercent(rate.rate)}（${rate.effectiveFrom} 起生效）这条配置吗？\n\n已结算的 C 单用的是结算时的比例快照，删除不影响历史单（D77 ④）；但之后新结算的 C 单会按剩下的配置算。`;
    if (globalThis.confirm?.(message) === false) return;
    setNotice(null);
    remove.mutate(rate);
  };

  const rows = list.data?.items ?? [];
  const noCompany = companyIds.length === 0;

  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
      <header>
        <h2 className="text-base font-semibold text-slate-900">提成比例配置</h2>
        <p className="mt-1 text-xs text-slate-500">
          按「员工 + 本公司 + 生效日」配置（一期只按人，D77 ①）；确认结算时取
          <b>生效日 ≤ 结算日</b>的最新一条写成快照，之后改配置不影响已结算单（D36 / D77 ④）。
          比例是 C 单的派生数字，本页不参与任何算法。
        </p>
      </header>

      {noCompany ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          当前账号没有可用公司，无法查询或配置提成比例。
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-slate-600">
          公司
          <select
            value={companyId}
            onChange={(event) => {
              setCompanyId(event.target.value);
              setEmployeeFilter('');
              setFormEmployeeId('');
              setNotice(null);
              setPanelError(null);
            }}
            disabled={companyIds.length <= 1}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-50"
          >
            {noCompany ? <option value="">没有可用公司</option> : null}
            {companyIds.map((id) => (
              <option key={id} value={id}>
                {companyLabel(id)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-slate-600">
          归属人筛选
          <select
            value={employeeFilter}
            onChange={(event) => setEmployeeFilter(event.target.value)}
            disabled={employeesQuery.isError}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-50"
          >
            <option value="">全部归属人</option>
            {companyEmployees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}（{employee.employeeNo}）
              </option>
            ))}
          </select>
        </label>

        <p className="text-xs text-slate-400">
          一期只按人配置；按岗配置要等岗位解析端口落地（D77 ①）。
        </p>
      </div>

      {employeesQuery.isError ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          无法加载员工名册（当前身份没有员工读权限，`employee.read`）：列表里的归属人只能显示 id 短号，
          新增配置也无法选人。请让老板代为配置，或先开通员工读权限。
        </p>
      ) : null}

      {canCreate ? (
        <div className="flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 p-3">
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            提成归属人
            <select
              value={formEmployeeId}
              onChange={(event) => setFormEmployeeId(event.target.value)}
              disabled={employeesQuery.isError || companyEmployees.length === 0}
              className="min-w-56 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm disabled:bg-slate-100"
            >
              <option value="">
                {companyEmployees.length === 0 ? '该公司下没有可配置的员工' : '请选择员工'}
              </option>
              {companyEmployees.map((employee) => (
                <option key={employee.id} value={employee.id}>
                  {employee.name}（{employee.employeeNo}）
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-slate-600">
            提成比例（%）
            <span className="flex items-center gap-1">
              <input
                value={formPercent}
                onChange={(event) => setFormPercent(event.target.value)}
                inputMode="decimal"
                placeholder="5"
                className="w-28 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              />
              <span className="text-sm text-slate-500">%</span>
            </span>
          </label>

          <label className="flex flex-col gap-1 text-xs text-slate-600">
            生效日（含当日）
            <input
              type="date"
              value={formEffectiveFrom}
              onChange={(event) => setFormEffectiveFrom(event.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
          </label>

          <button
            type="button"
            onClick={submit}
            disabled={create.isPending || noCompany || companyEmployees.length === 0}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {create.isPending ? '提交中…' : '保存配置'}
          </button>

          {formPercent.trim() !== '' && percentToRate(formPercent) !== null ? (
            <span className="text-xs text-slate-500">
              实际提交 {percentToRate(formPercent)}（decimal，D54）
            </span>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-slate-500">
          新增 / 修改配置需要 commission.create；当前身份只能查看。
        </p>
      )}

      {formError ? (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{formError}</p>
      ) : null}
      {panelError ? (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{panelError}</p>
      ) : null}
      {notice ? (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {notice}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        {companyId === '' ? (
          <p className="p-4 text-sm text-slate-500">请先选择公司。</p>
        ) : list.isPending ? (
          <p className="p-4 text-sm text-slate-500">正在加载配置…</p>
        ) : list.error ? (
          <div className="p-4">
            <p className="text-sm text-red-700">{describeCommissionRateError(list.error)}</p>
            <button
              type="button"
              onClick={() => void list.refetch()}
              className="mt-2 rounded border border-slate-300 px-3 py-1.5 text-sm"
            >
              重试
            </button>
          </div>
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">
            该公司还没有提成配置。没配就按 0 记提成（D77 ②），不会用别的公司或别人的比例兜底。
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 font-medium">公司</th>
                <th className="px-3 py-2 font-medium">提成归属人</th>
                <th className="px-3 py-2 font-medium">提成比例</th>
                <th className="px-3 py-2 font-medium">生效日</th>
                <th className="px-3 py-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((rate) => (
                <tr key={rate.id} className="border-t border-slate-100">
                  <td className="px-3 py-2 text-slate-700" title={rate.companyId}>
                    {companyLabel(rate.companyId)}
                  </td>
                  <td className="px-3 py-2 text-slate-900" title={rate.employeeId}>
                    {employeeLabel(rate.employeeId)}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-900">
                    {formatRatePercent(rate.rate)}
                  </td>
                  <td className="px-3 py-2 text-slate-700">{rate.effectiveFrom}</td>
                  <td className="px-3 py-2">
                    {canDelete ? (
                      <button
                        type="button"
                        onClick={() => askRemove(rate)}
                        disabled={remove.isPending}
                        className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 disabled:opacity-50"
                      >
                        删除
                      </button>
                    ) : (
                      <span className="text-xs text-slate-400">无删除权限</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="text-xs text-slate-400">
        想改比例同时保住历史：换个生效日再存一条（同员工 + 公司 + 生效日唯一，重复会提示冲突）。
        删除要谨慎——之后新结算的 C 单会按剩下的配置算，历史单不受影响（D77 ④）。
      </p>
    </section>
  );
}
