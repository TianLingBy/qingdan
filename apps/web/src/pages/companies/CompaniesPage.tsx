import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { platformAdminApi } from '../../api/platform-admin';
import { ApiError } from '../../api/client';
import { describeListError } from '../../components/ListStates';
import { Icon } from '../../components/icons/Icon';
import { resolveListState } from '../../lib/list-state';
import { authApi, authKeys } from '../auth/auth-api';
import { allows } from '../../lib/access';

/**
 * 公司管理页（22 页之第 18 页，#144；v3.0 重做 #434）。
 *
 * - 列表：`GET /api/v1/companies`（普通读不记审计）；
 * - 新建：`POST /api/v1/companies`，只收名称——公司码由服务端按 D16 自动发放，客户端不传 code；
 * - 改名：`PATCH /companies/{id}`，强 ETag If-Match。
 * - 写入口按 scope 三态：company.create / company.update；「来源」字段后端没有（#305），本页不画。
 */

export function CompaniesPage() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: authKeys.me, queryFn: () => authApi.me(), retry: false });
  const scope = me.data?.scope;
  const canCreate = allows(scope, 'company', 'create');
  const canUpdate = allows(scope, 'company', 'update');

  const listQuery = useQuery({
    queryKey: ['admin', 'companies'],
    queryFn: platformAdminApi.listCompanies,
  });

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; version: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'companies'] });

  const createMutation = useMutation({
    mutationFn: () => platformAdminApi.createCompany({ name: newName.trim() }),
    onSuccess: (company) => {
      setNewName('');
      setCreating(false);
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
  const state = resolveListState({
    isPending: listQuery.isPending,
    hasError: listQuery.isError,
    isEmpty: companies.length === 0,
  });

  return (
    <section className="space-y-4">
      <header className="p-head">
        <div>
          <div className="eyebrow">组织 · 公司主体</div>
          <h1>公司管理</h1>
          <p className="sub">
            登记子公司与公司码；数据按公司隔离（D15），公司码由服务端按 D16 自动发放。
          </p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn-p"
            disabled={!canCreate}
            onClick={() => setCreating(true)}
            title={canCreate ? '新建公司 · 需要 company.create 权限' : '需要 company.create 权限'}
          >
            + 新建公司
          </button>
        </div>
      </header>

      {creating && (
        <div className="panel">
          <div className="panel-h">新建公司</div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="公司名称（1-64 字）"
              className="search"
            />
            <button
              type="button"
              disabled={newName.trim().length === 0 || createMutation.isPending}
              onClick={() => createMutation.mutate()}
              className="btn btn-p"
            >
              {createMutation.isPending ? '创建中…' : '创建'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>
              取消
            </button>
          </div>
          <p className="muted mt-2">
            公司码（4 位）由服务端按 D16 自动发放，页面不提供修改入口。
          </p>
        </div>
      )}

      {notice && <p className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

      <div className="card list-card" data-state={state} aria-busy={state === 'loading'}>
        <div className="tw">
          <table className="w-full min-w-[640px] text-left">
            <thead>
              <tr>
                <th>公司码</th>
                <th>名称</th>
                <th>更新时间</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody data-state={state}>
              {companies.map((company) => (
                <tr key={company.id} className="r-row">
                  <td className="mono">
                    <b>{company.code}</b>
                  </td>
                  <td>
                    {editing?.id === company.id ? (
                      <input
                        value={editing.name}
                        onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                        className="search"
                      />
                    ) : (
                      company.name
                    )}
                  </td>
                  <td className="mono muted">{company.updatedAt.slice(0, 19).replace('T', ' ')}</td>
                  <td className="text-right">
                    {editing?.id === company.id ? (
                      <span className="rowacts">
                        <button
                          type="button"
                          disabled={editing.name.trim().length === 0 || updateMutation.isPending}
                          onClick={() => updateMutation.mutate()}
                          className="btn btn-s"
                        >
                          保存
                        </button>
                        <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>
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
                        title={canUpdate ? '改名 · 需要 company.update 权限' : '需要 company.update 权限'}
                      >
                        <Icon name="pencil" size={14} /> 改名
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="st-tr st-empty">
                <td colSpan={4}>
                  <div className="st-box">
                    <div className="st-ico">
                      <Icon name="pin" />
                    </div>
                    <div className="st-title">还没有公司</div>
                    <p className="st-desc">点击右上角「+ 新建公司」登记第一家子公司。</p>
                  </div>
                </td>
              </tr>
              <tr className="st-tr st-loading">
                <td colSpan={4}>
                  <div className="st-box" aria-label="公司列表加载中">
                    <div className="sk sk-line w80" />
                    <div className="sk sk-line w60" />
                    <div className="sk sk-line w40" />
                    <p className="st-desc mt-3">公司列表加载中…</p>
                  </div>
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={4}>
                  <div className="st-box st-error">
                    <div className="st-ico">
                      <Icon name="refresh" />
                    </div>
                    <div className="st-title">公司列表加载失败</div>
                    <p className="st-desc">{describeListError('公司列表加载失败', listQuery.error)}</p>
                    <button type="button" className="btn" onClick={() => void listQuery.refetch()}>
                      重试
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <footer className="tf">
          <span>公司间数据隔离（D15）：各公司只能看自己的单据，总部可看全部；写操作服务端必记审计（D51）。</span>
          <span className="count">共 {companies.length} 家</span>
        </footer>
      </div>
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
