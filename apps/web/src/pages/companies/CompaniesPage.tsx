import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { platformAdminApi } from '../../api/platform-admin';
import { ApiError } from '../../api/client';

/**
 * 公司管理页（22 页之第 18 页，#144）。
 *
 * - 列表：`GET /api/v1/companies`（普通读不记审计）；
 * - 新建：`POST /api/v1/companies`，只收名称——**公司码由服务端按 D16 自动发放**，
 *   客户端不传 `code`（契约 .strict() 传入即 422）；
 * - 改名：`PATCH /companies/{id}`，强 ETag If-Match（版本冲突 → 428/409 人话提示）。
 *
 * 口径：公司码是数据隔离与跨司溯源的刚性字段，页面不提供任何改码入口（D16）。
 */

export function CompaniesPage() {
  const queryClient = useQueryClient();
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

  return (
    <section className="mx-auto max-w-4xl">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">公司管理</h1>
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
          已接真实接口
        </span>
      </div>

      <div className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
        <p className="text-sm font-medium text-slate-700">新建公司</p>
        <div className="mt-2 flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="公司名称（1-64 字）"
            className="w-64 rounded border border-slate-200 px-3 py-1.5 text-sm outline-none focus:border-slate-400"
          />
          <button
            type="button"
            disabled={newName.trim().length === 0 || createMutation.isPending}
            onClick={() => createMutation.mutate()}
            className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {createMutation.isPending ? '创建中…' : '创建'}
          </button>
        </div>
        <p className="mt-1.5 text-xs text-slate-400">
          公司码（4 位）由服务端按 D16 自动发放，页面不提供修改入口。
        </p>
      </div>

      {notice && (
        <p className="mt-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}
      {error && (
        <p className="mt-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error}
        </p>
      )}

      <div className="mt-5 overflow-hidden rounded-lg border border-slate-200 bg-white">
        {listQuery.isPending ? (
          <div className="space-y-2 p-4" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-slate-100" />
            ))}
            <p className="pt-1 text-xs text-slate-400">公司列表加载中…</p>
          </div>
        ) : listQuery.isError ? (
          <div className="p-6 text-center">
            <p className="text-sm text-rose-600">
              公司列表加载失败：{listQuery.error instanceof ApiError
                ? `${listQuery.error.message}（${listQuery.error.code}）`
                : '未知错误'}
            </p>
            <button
              type="button"
              onClick={() => listQuery.refetch()}
              className="mt-3 rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              重试
            </button>
          </div>
        ) : companies.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm text-slate-500">还没有公司。在上方输入名称创建第一家。</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-400">
                  <th className="px-4 py-2.5 font-medium">公司码</th>
                  <th className="px-4 py-2.5 font-medium">名称</th>
                  <th className="px-4 py-2.5 font-medium">更新时间</th>
                  <th className="px-4 py-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {companies.map((company) => (
                  <tr key={company.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{company.code}</td>
                    <td className="px-4 py-2.5">
                      {editing?.id === company.id ? (
                        <input
                          value={editing.name}
                          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                          className="w-56 rounded border border-slate-300 px-2 py-1 text-sm outline-none focus:border-slate-400"
                        />
                      ) : (
                        company.name
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-500">
                      {company.updatedAt.slice(0, 19).replace('T', ' ')}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {editing?.id === company.id ? (
                        <span className="inline-flex gap-1.5">
                          <button
                            type="button"
                            disabled={editing.name.trim().length === 0 || updateMutation.isPending}
                            onClick={() => updateMutation.mutate()}
                            className="rounded bg-slate-800 px-2.5 py-1 text-xs text-white hover:bg-slate-700 disabled:opacity-40"
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditing(null)}
                            className="rounded border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50"
                          >
                            取消
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() =>
                            setEditing({ id: company.id, name: company.name, version: company.version })
                          }
                          className="rounded border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
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
        )}
      </div>

      <p className="mt-3 text-xs text-slate-400">
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
