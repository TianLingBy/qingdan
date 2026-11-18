import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ScopeMatrix } from '@qingdan/contracts';
import { platformAdminApi } from '../../api/platform-admin';
import { ApiError } from '../../api/client';
import { ListEmpty, ListError, ListLoading } from '../../components/ListStates';
import { fetchMe } from '../../api/platform';
import { DOMAIN_WORDS } from '../employees/domain-words';
import { resolveListState, type ListState } from '../../lib/list-state';
import { allows, type ScopeAction } from '../../lib/access';

/**
 * API 与集成页（22 页之第 22 页，#144；v0.13 重做 #340）。
 *
 * - Token 列表：`GET /api/v1/api-tokens`（敏感读）；
 * - 创建：`POST /api/v1/api-tokens`，scope ⊆ 创建人授权；明文 secret 只显示一次；
 * - 撤销：`DELETE /api-tokens/{id}`，If-Match。
 * - 写入口按 scope：api_integration.create / api_integration.delete。
 */

interface CreatedSecret {
  name: string;
  secret: string;
}

export function ApiIntegrationPage() {
  const queryClient = useQueryClient();
  const listQuery = useQuery({
    queryKey: ['admin', 'api-tokens'],
    queryFn: platformAdminApi.listApiTokens,
  });
  const meQuery = useQuery({
    queryKey: ['me'],
    queryFn: fetchMe,
  });

  const scope = meQuery.data?.scope as ScopeMatrix | undefined;
  const can = (action: ScopeAction) => allows(scope, 'api_integration', action);
  const canCreate = can('create');
  const canDelete = can('delete');

  const [form, setForm] = useState<{ open: boolean; name: string; domains: ReadonlySet<string> }>({
    open: false,
    name: '',
    domains: new Set(),
  });
  const [created, setCreated] = useState<CreatedSecret | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin', 'api-tokens'] });

  const createMutation = useMutation({
    mutationFn: () => {
      const me = meQuery.data!;
      const scope = [...form.domains].map((domain) => ({
        domain,
        actions: (me.scope.find((s) => s.domain === domain)?.actions ?? []).slice(),
      }));
      return platformAdminApi.createApiToken({
        name: form.name.trim(),
        employeeId: me.employeeId,
        scope: scope.filter((entry) => entry.actions.length > 0),
      });
    },
    onSuccess: (token) => {
      setForm({ open: false, name: '', domains: new Set() });
      setError(null);
      setNotice(`已创建 Token「${token.name}」。`);
      setCreated({ name: token.name, secret: token.secret });
      void invalidate();
    },
    onError: (e) => setError(describeError(e, '创建失败')),
  });

  const revokeMutation = useMutation({
    mutationFn: (token: { id: string; name: string; version: number }) =>
      platformAdminApi.revokeApiToken(token.id, token.version),
    onSuccess: (_, token) => {
      setError(null);
      setNotice(`Token「${token.name}」已撤销，持有该密钥的请求即刻失效。`);
      void invalidate();
    },
    onError: (e) => setError(describeError(e, '撤销失败')),
  });

  const tokens = listQuery.data?.items ?? [];
  const listState: ListState = resolveListState({
    isPending: listQuery.isPending,
    hasError: listQuery.error !== null,
    isEmpty: tokens.length === 0,
  });
  const myScope = meQuery.data?.scope ?? [];
  const grantableDomains = DOMAIN_WORDS.filter((d) =>
    myScope.some((s) => s.domain === d.key && s.actions.length > 0),
  );

  return (
    <section className="mx-auto max-w-6xl space-y-4">
      <div className="p-head">
        <div>
          <div className="eyebrow">系统 · 外部集成</div>
          <h1>API 与集成</h1>
          <p className="sub">为 AI 助手 / 脚本 / CLI 发放受限 Token；明文密钥只在创建时显示一次。</p>
        </div>
        <div className="actions">
          <button
            type="button"
            disabled={!canCreate}
            onClick={() => setForm({ open: true, name: '', domains: new Set() })}
            className="btn btn-p"
            title={!canCreate ? '当前身份没有 api_integration.create 权限' : undefined}
          >
            + 创建 Token
          </button>
        </div>
      </div>

      {!canCreate && (
        <p className="text-xs text-slate-500">创建 Token 需要 api_integration.create。</p>
      )}

      {notice && <p className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

      <div className="card" data-state={listState}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left">
            <thead>
              <tr>
                <th>名称</th>
                <th>授权范围</th>
                <th>状态</th>
                <th>过期时间</th>
                <th>最后使用</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody data-state={listState}>
              <tr className="st-tr st-loading">
                <td colSpan={6}>
                  <ListLoading label="Token 列表加载中…" />
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={6}>
                  <ListError
                    title="Token 列表加载失败"
                    error={listQuery.error ?? null}
                    hint={
                      listQuery.error instanceof ApiError && listQuery.error.status === 403
                        ? '查看 Token 列表需要 api_integration.read 权限（敏感读），请联系老板开通。'
                        : undefined
                    }
                    onRetry={() => void listQuery.refetch()}
                  />
                </td>
              </tr>
              <tr className="st-tr st-empty">
                <td colSpan={6}>
                  <ListEmpty title="还没有 API Token。外部系统（AI 助手 / 脚本 / CLI）通过 Token 调用 /api/v1。" />
                </td>
              </tr>
              {tokens.map((token) => (
                <tr key={token.id} className="r-row">
                  <td className="px-4 py-3">{token.name}</td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {token.scope
                      .slice(0, 3)
                      .map(
                        (entry) =>
                          `${DOMAIN_WORDS.find((d) => d.key === entry.domain)?.label ?? entry.domain}(${entry.actions.length})`,
                      )
                      .concat(token.scope.length > 3 ? [`…共 ${token.scope.length} 域`] : [])
                      .join('、') || '—'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={token.status === 'active' ? 'text-emerald-600' : 'text-slate-400'}>
                      {token.status === 'active' ? '生效中' : token.status === 'revoked' ? '已撤销' : '已过期'}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">
                    {token.expiresAt ? token.expiresAt.slice(0, 10) : '永不过期'}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">
                    {token.lastUsedAt ? token.lastUsedAt.slice(0, 19).replace('T', ' ') : '从未使用'}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {token.status === 'active' && (
                      <button
                        type="button"
                        disabled={!canDelete || revokeMutation.isPending}
                        onClick={() =>
                          revokeMutation.mutate({ id: token.id, name: token.name, version: token.version })
                        }
                        className="btn btn-s"
                        title={
                          !canDelete
                            ? '当前身份没有 api_integration.delete 权限'
                            : '撤销后持有该密钥的请求即刻失效（If-Match 版本校验）'
                        }
                      >
                        撤销
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
        明文密钥只在创建时显示一次，服务端只存 SHA-256；授权范围不能超出你自己的权限（服务端强制）。
        接口契约真源：<span className="font-mono">GET /api/v1/openapi.json</span>（公开只读）。
      </p>

      {form.open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-6">
          <div className="w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-800">创建 API Token</h2>
              <button
                type="button"
                onClick={() => setForm({ open: false, name: '', domains: new Set() })}
                className="rounded border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50"
              >
                关闭
              </button>
            </div>
            <div className="mt-3">
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Token 名称（如：AI 助手-温汇敏）"
                className="w-72 rounded border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-slate-400"
              />
            </div>
            <p className="mt-3 text-xs text-slate-500">勾选授权功能域（继承你在该域的全部动作；可勾 = 你自己有权限）：</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {grantableDomains.map((domain) => {
                const checked = form.domains.has(domain.key);
                return (
                  <button
                    key={domain.key}
                    type="button"
                    aria-pressed={checked}
                    onClick={() => {
                      const next = new Set(form.domains);
                      if (checked) next.delete(domain.key);
                      else next.add(domain.key);
                      setForm({ ...form, domains: next });
                    }}
                    className={[
                      'rounded-full px-3 py-1 text-xs',
                      checked
                        ? 'bg-slate-800 text-white hover:bg-slate-700'
                        : 'border border-slate-200 text-slate-600 hover:border-slate-400',
                    ].join(' ')}
                  >
                    {domain.label}
                  </button>
                );
              })}
            </div>
            {grantableDomains.length === 0 && (
              <p className="mt-2 text-xs text-slate-400">你的账号当前没有任何可授予的功能域。</p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setForm({ open: false, name: '', domains: new Set() })}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={form.name.trim().length === 0 || form.domains.size === 0 || createMutation.isPending}
                onClick={() => createMutation.mutate()}
                className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {createMutation.isPending ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {created && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-6">
          <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
            <h2 className="text-lg font-semibold text-slate-800">密钥只显示这一次</h2>
            <p className="mt-1 text-sm text-slate-600">
              Token「{created.name}」已创建。请立即复制保存下面的密钥——关闭后无法再次查看（服务端只存哈希）。
            </p>
            <div className="mt-3 flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded bg-slate-100 px-3 py-2 font-mono text-xs break-all">
                {created.secret}
              </code>
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(created.secret)}
                className="rounded border border-slate-300 px-2.5 py-1.5 text-xs hover:bg-slate-50"
              >
                复制
              </button>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setCreated(null)}
                className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white hover:bg-slate-700"
              >
                我已保存
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function describeError(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.status === 428) return `${fallback}：缺少 If-Match 版本头，请刷新后重试。`;
    if (e.status === 409) return `${fallback}：版本冲突（Token 已被别人撤销或修改），请刷新后重试。`;
    if (e.status === 403) return `${fallback}：缺少 api_integration 权限，请联系老板开通。`;
    return `${fallback}：${e.message}（${e.code}）`;
  }
  return fallback;
}
