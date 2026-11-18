import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { platformAdminApi } from '../../api/platform-admin';
import { ApiError } from '../../api/client';
import { ListEmpty, ListError, ListLoading } from '../../components/ListStates';
import { resolveListState, type ListState } from '../../lib/list-state';
import { authApi, authKeys } from '../auth/auth-api';
import { allows, type ScopeAction } from '../../lib/access';

/**
 * 公司管理页（22 页之第 18 页，#144；v0.13 重做 #340）。
 *
 * - 列表：`GET /api/v1/companies`（普通读不记审计）；
 * - 新建：`POST /api/v1/companies`，只收名称——公司码由服务端按 D16 自动发放，客户端不传 code；
 * - 改名：`PATCH /companies/{id}`，强 ETag If-Match。
 * - 写入口按 scope 三态：company.create / company.update。
 */

export function CompaniesPage() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: authKeys.me, queryFn: () => authApi.me(), retry: false });
  const scope = me.data?.scope;
  const can = (action: ScopeAction) => allows(scope, 'company', action);
  const canCreate = can('create');
  const canUpdate = can('update');

  const listQuery = useQuery({
    queryKey: ['admin', 'companies'],
    queryFn: platformAdminApi.listCompanies,
  });

  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; version: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'companies'] });

  const createMutation = useMutation({
    mutationFn: () => platformAdminApi.createCompany({ name: newName.trim() }),
    onSuccess: (company) => {
      setNewName('');
      setError(null);
      setNotice(`已创建「${company.name}」，公司码 ${company.code}（服务端自动发放）。`);
      void invalidate();
    },
    onError: (e) => setError(describeError(e, '创建失败')),
  });

  const updateMutation = useMutation({
    mutationFn: () =>
      platformAdminApi.updateCompany(editing!.id, { name: editing!.name.trim() }, editing!.version),
    onSuccess: (company) => {
      setEditing(null);
      setError(null);
      setNotice(`已改名「${company.name}」。`);
      void invalidate();
    },
    onError: (e) => setError(describeError(e, '改名失败')),
  });

  const companies = listQuery.data?.items ?? [];
  const listState: ListState = resolveListState({
    isPending: listQuery.isPending,
    hasError: listQuery.error !== null,
    isEmpty: companies.length === 0,
  });

  return (
    <section className="mx-auto max-w-5xl space-y-4">
      <div className="p-head">
        <div>
          <div className="eyebrow">组织 · 公司主体</div>
          <h1>公司管理</h1>
          <p className="sub">公司是数据隔离的基本单位（D15）；公司码由服务端按 D16 自动发放。</p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h">新建公司</div>
        <div className="flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="公司名称（1-64 字）"
            disabled={!canCreate}
            className="w-64 rounded border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            disabled={!canCreate || newName.trim().length === 0 || createMutation.isPending}
            onClick={() => createMutation.mutate()}
            className="btn btn-p"
            title={!canCreate ? '当前身份没有 company.create 权限' : undefined}
          >
            {createMutation.isPending ? '创建中…' : '创建'}
          </button>
        </div>
        {!canCreate && (
          <p className="mt-2 text-xs text-slate-500">新建公司需要 company.create。</p>
        )}
        <p className="mt-1.5 text-xs text-slate-400">
          公司码（4 位）由服务端按 D16 自动发放，页面不提供修改入口。
        </p>
      </div>

      {notice && <p className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

      <div className="card" data-state={listState}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left">
            <thead>
              <tr>
                <th>公司码</th>
                <th>名称</th>
                <th>更新时间</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody data-state={listState}>
              <tr className="st-tr st-loading">
                <td colSpan={4}>
                  <ListLoading label="公司列表加载中…" />
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={4}>
                  <ListError
                    title="公司列表加载失败"
                    error={listQuery.error ?? null}
                    onRetry={() => void listQuery.refetch()}
                  />
                </td>
              </tr>
              <tr className="st-tr st-empty">
                <td colSpan={4}>
                  <ListEmpty title="还没有公司。在上方输入名称创建第一家。" />
                </td>
              </tr>
              {companies.map((company) => (
                <tr key={company.id} className="r-row">
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">{company.code}</td>
                  <td className="px-4 py-3">
                    {editing?.id === company.id ? (
                      <input
                        value={editing.name}
                        onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                        className="w-56 rounded border border-slate-300 px-2 py-1 text-sm"
                      />
                    ) : (
                      company.name
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">
                    {company.updatedAt.slice(0, 19).replace('T', ' ')}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {editing?.id === company.id ? (
                      <span className="inline-flex gap-1.5">
                        <button
                          type="button"
                          disabled={editing.name.trim().length === 0 || updateMutation.isPending}
                          onClick={() => updateMutation.mutate()}
                          className="btn btn-s"
                        >
                          保存
                        </button>
                        <button type="button" onClick={() => setEditing(null)} className="btn btn-ghost">
                          取消
                        </button>
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={!canUpdate}
                        onClick={() =>
                          setEditing({ id: company.id, name: company.name, version: company.version })
                        }
                        className="btn btn-s"
                        title={!canUpdate ? '当前身份没有 company.update 权限' : undefined}
                      >
                        改名
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="note">
        公司间数据隔离（D15）：各公司只能看自己的单据，总部可看全部；写操作服务端必记审计（D51）。
      </p>
    </section>
  );
}

function describeError(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.status === 428) return `${fallback}：缺少 If-Match 版本头，请刷新后重试。`;
    if (e.status === 409) return `${fallback}：版本冲突（别人已先改过），请刷新后重试。`;
    if (e.status === 403) return `${fallback}：缺少 company 管理权限，请联系老板开通。`;
    return `${fallback}：${e.message}（${e.code}）`;
  }
  return fallback;
}
