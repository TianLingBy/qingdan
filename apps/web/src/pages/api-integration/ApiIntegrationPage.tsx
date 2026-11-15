import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { platformAdminApi } from '../../api/platform-admin';
import { ApiError } from '../../api/client';
import { fetchMe } from '../../api/platform';
import { DOMAIN_WORDS } from '../employees/domain-words';

/**
 * API 与集成页（22 页之第 22 页，#144）。
 *
 * - Token 列表：`GET /api/v1/api-tokens`（敏感读，服务端必记审计）；
 * - 创建：`POST /api/v1/api-tokens`，scope ⊆ 创建人授权（超出服务端拒绝）；
 *   明文 `secret` **只在创建响应里出现一次**（服务端只存 SHA-256，契约第三批 §2）；
 * - 撤销：`DELETE /api-tokens/{id}`，If-Match 强 ETag（危险动作）；
 * - 集成入口：`GET /api/v1/openapi.json`（公开只读，接口真源）。
 *
 * scope 编辑简化口径：按「功能域整域继承」勾选——勾中的域继承创建人在该域的
 * 全部动作，服务端仍是唯一判定者（D15）；逐动作粒度后续有需求再细化。
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
      // scope ⊆ 创建人授权：只取勾中域内「我自己也有的动作」，超出部分交给服务端兜底拒绝。
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
  const myScope = meQuery.data?.scope ?? [];
  const grantableDomains = DOMAIN_WORDS.filter((d) =>
    myScope.some((s) => s.domain === d.key && s.actions.length > 0),
  );

  return (
    <section className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">API 与集成</h1>
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
            已接真实接口
          </span>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
            Token 列表为敏感读
          </span>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setForm({ open: true, name: '', domains: new Set() })}
            className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white hover:bg-slate-700"
          >
            创建 Token
          </button>
        </div>
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
            <p className="pt-1 text-xs text-slate-400">Token 列表加载中…</p>
          </div>
        ) : listQuery.isError ? (
          <div className="p-6 text-center">
            <p className="text-sm text-rose-600">
              Token 列表加载失败：{listQuery.error instanceof ApiError
                ? `${listQuery.error.message}（${listQuery.error.code}）`
                : '未知错误'}
            </p>
            <p className="mt-1 text-xs text-slate-400">
              {listQuery.error instanceof ApiError && listQuery.error.status === 403
                ? '查看 Token 列表需要 api_integration.read 权限（敏感读），请联系老板开通。'
                : '请确认本地 API 已启动后重试。'}
            </p>
            <button
              type="button"
              onClick={() => listQuery.refetch()}
              className="mt-3 rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              重试
            </button>
          </div>
        ) : tokens.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm text-slate-500">
              还没有 API Token。外部系统（AI 助手 / 脚本 / CLI）通过 Token 调用 /api/v1。
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-400">
                  <th className="px-4 py-2.5 font-medium">名称</th>
                  <th className="px-4 py-2.5 font-medium">授权范围</th>
                  <th className="px-4 py-2.5 font-medium">状态</th>
                  <th className="px-4 py-2.5 font-medium">过期时间</th>
                  <th className="px-4 py-2.5 font-medium">最后使用</th>
                  <th className="px-4 py-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((token) => (
                  <tr key={token.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                    <td className="px-4 py-2.5">{token.name}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">
                      {token.scope
                        .slice(0, 3)
                        .map(
                          (entry) =>
                            `${DOMAIN_WORDS.find((d) => d.key === entry.domain)?.label ?? entry.domain}(${entry.actions.length})`,
                        )
                        .concat(token.scope.length > 3 ? [`…共 ${token.scope.length} 域`] : [])
                        .join('、') || '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={[
                          'rounded-full px-2 py-0.5 text-xs font-medium',
                          token.status === 'active'
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-slate-100 text-slate-500',
                        ].join(' ')}
                      >
                        {token.status === 'active' ? '生效中' : token.status === 'revoked' ? '已撤销' : '已过期'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-500">
                      {token.expiresAt ? token.expiresAt.slice(0, 10) : '永不过期'}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-500">
                      {token.lastUsedAt ? token.lastUsedAt.slice(0, 19).replace('T', ' ') : '从未使用'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {token.status === 'active' && (
                        <button
                          type="button"
                          disabled={revokeMutation.isPending}
                          onClick={() =>
                            revokeMutation.mutate({ id: token.id, name: token.name, version: token.version })
                          }
                          className="rounded border border-rose-200 px-2.5 py-1 text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-40"
                          title="撤销后持有该密钥的请求即刻失效（If-Match 版本校验）"
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
        )}
      </div>

      <p className="mt-3 text-xs text-slate-400">
        明文密钥只在创建时显示一次，服务端只存 SHA-256（契约第三批 §2）；授权范围不能超出你自己的权限（服务端强制）。
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
