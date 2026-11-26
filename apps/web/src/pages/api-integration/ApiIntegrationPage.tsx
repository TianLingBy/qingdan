import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { ScopeMatrix } from '@qingdan/contracts';
import { platformAdminApi } from '../../api/platform-admin';
import { ApiError } from '../../api/client';
import { describeListError } from '../../components/ListStates';
import { Icon } from '../../components/icons/Icon';
import { fetchMe } from '../../api/platform';
import { DOMAIN_WORDS } from '../employees/domain-words';
import { resolveListState } from '../../lib/list-state';
import { allows } from '../../lib/access';

/**
 * API 与集成页（22 页之第 22 页，#144；v3.0 重做 #434）。
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

type StatusFilter = 'all' | 'active' | 'revoked';

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
  const canCreate = allows(scope, 'api_integration', 'create');
  const canDelete = allows(scope, 'api_integration', 'delete');

  const [form, setForm] = useState<{ open: boolean; name: string; domains: ReadonlySet<string> }>({
    open: false,
    name: '',
    domains: new Set(),
  });
  const [created, setCreated] = useState<CreatedSecret | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');

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
  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return tokens.filter((token) => {
      if (status === 'active' && token.status !== 'active') return false;
      if (status === 'revoked' && token.status !== 'revoked') return false;
      if (kw !== '') {
        const haystack = `${token.name} ${token.scope.map((entry) => entry.domain).join(' ')}`.toLowerCase();
        if (!haystack.includes(kw)) return false;
      }
      return true;
    });
  }, [tokens, keyword, status]);
  const state = resolveListState({
    isPending: listQuery.isPending,
    hasError: listQuery.isError,
    isEmpty: tokens.length === 0,
  });
  const myScope = meQuery.data?.scope ?? [];
  const grantableDomains = DOMAIN_WORDS.filter((d) =>
    myScope.some((s) => s.domain === d.key && s.actions.length > 0),
  );

  const statusCell = (token: (typeof tokens)[number]) =>
    token.status === 'revoked' ? (
      <span className="st bad">已吊销</span>
    ) : token.status === 'active' ? (
      <span className="st ok">生效中</span>
    ) : (
      <span className="st cancel">已停用</span>
    );

  return (
    <section className="space-y-4">
      <header className="p-head">
        <div>
          <div className="eyebrow">系统 · 外部集成</div>
          <h1>API 与集成</h1>
          <p className="sub">外部系统接入与密钥管理。密钥只在创建时完整显示一次；吊销立即生效，不可恢复。</p>
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn-p"
            disabled={!canCreate}
            onClick={() => setForm({ open: true, name: '', domains: new Set() })}
            title={canCreate ? '新建密钥 · 需要 api_integration.create 权限' : '需要 api_integration.create 权限'}
          >
            新建密钥
          </button>
        </div>
      </header>

      <div className="toolbar">
        <label>
          <span className="sr-only">搜索</span>
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索密钥名称、授权范围…"
            className="search"
          />
        </label>
        <div className="chips">
          {([
            ['all', '全部'],
            ['active', '生效中'],
            ['revoked', '已吊销'],
          ] as ReadonlyArray<readonly [StatusFilter, string]>).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`chip${status === value ? ' on' : ''}`}
              onClick={() => setStatus(value)}
            >
              {label}
              <b>{value === 'all' ? tokens.length : tokens.filter((t) => t.status === value).length}</b>
            </button>
          ))}
        </div>
        <span className="grow" />
        <span className="note">
          <Icon name="shield" size={14} /> 密钥仅创建时显示一次，之后只能吊销重发
        </span>
      </div>

      {notice && <p className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>}
      {error && <p className="rounded bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

      <div className="card list-card" data-state={state} aria-busy={state === 'loading'}>
        <div className="tw">
          <table className="w-full min-w-[900px] text-left">
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
            <tbody data-state={state}>
              {filtered.map((token) => (
                <tr key={token.id} className="r-row">
                  <td>
                    <b>{token.name}</b>
                  </td>
                  <td className="mono muted">
                    {token.scope
                      .slice(0, 3)
                      .map(
                        (entry) =>
                          `${DOMAIN_WORDS.find((d) => d.key === entry.domain)?.label ?? entry.domain}(${entry.actions.length})`,
                      )
                      .concat(token.scope.length > 3 ? [`…共 ${token.scope.length} 域`] : [])
                      .join('、') || '—'}
                  </td>
                  <td>{statusCell(token)}</td>
                  <td className="mono muted">
                    {token.expiresAt ? token.expiresAt.slice(0, 10) : '永不过期'}
                  </td>
                  <td className="mono muted">
                    {token.lastUsedAt ? token.lastUsedAt.slice(0, 19).replace('T', ' ') : '从未使用'}
                  </td>
                  <td className="text-right">
                    {token.status === 'active' && (
                      <span className="rowacts">
                        <button
                          type="button"
                          disabled={!canDelete || revokeMutation.isPending}
                          onClick={() =>
                            revokeMutation.mutate({ id: token.id, name: token.name, version: token.version })
                          }
                          className="btn btn-s danger"
                          title={
                            canDelete
                              ? '吊销后立即失效，不可恢复（If-Match 版本校验）'
                              : '需要 api_integration.delete 权限'
                          }
                        >
                          <Icon name="trash" size={14} /> 吊销
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
              <tr className="st-tr st-empty">
                <td colSpan={6}>
                  <div className="st-box">
                    <div className="st-ico">
                      <Icon name="key" />
                    </div>
                    <div className="st-title">还没有 API Token</div>
                    <p className="st-desc">外部系统（AI 助手 / 脚本 / CLI）通过 Token 调用 /api/v1。</p>
                  </div>
                </td>
              </tr>
              <tr className="st-tr st-loading">
                <td colSpan={6}>
                  <div className="st-box" aria-label="Token 列表加载中">
                    <div className="sk sk-line w80" />
                    <div className="sk sk-line w60" />
                    <div className="sk sk-line w40" />
                    <p className="st-desc mt-3">Token 列表加载中…</p>
                  </div>
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={6}>
                  <div className="st-box st-error">
                    <div className="st-ico">
                      <Icon name="refresh" />
                    </div>
                    <div className="st-title">Token 列表加载失败</div>
                    <p className="st-desc">{describeListError('Token 列表加载失败', listQuery.error)}</p>
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
          <span>
            接口契约真源：GET /api/v1/openapi.json（公开只读）；密钥只显示一次，服务端只存 SHA-256。
          </span>
          <span className="count">共 {tokens.length} 枚 · 吊销后不可恢复</span>
        </footer>
      </div>

      {form.open && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-6">
          <div className="w-full max-w-2xl rounded-lg bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-800">创建 API Token</h2>
              <button
                type="button"
                onClick={() => setForm({ open: false, name: '', domains: new Set() })}
                className="btn btn-ghost"
              >
                关闭
              </button>
            </div>
            <div className="mt-3">
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="Token 名称（如：AI 助手-温汇敏）"
                className="search"
              />
            </div>
            <p className="mt-3 text-sm text-slate-500">
              勾选授权功能域（继承你在该域的全部动作；可勾 = 你自己有权限）：
            </p>
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
                    className={`chip${checked ? ' on' : ''}`}
                  >
                    {domain.label}
                  </button>
                );
              })}
            </div>
            {grantableDomains.length === 0 && (
              <p className="mt-2 text-sm text-slate-400">你的账号当前没有任何可授予的功能域。</p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setForm({ open: false, name: '', domains: new Set() })}
                className="btn"
              >
                取消
              </button>
              <button
                type="button"
                disabled={form.name.trim().length === 0 || form.domains.size === 0 || createMutation.isPending}
                onClick={() => createMutation.mutate()}
                className="btn btn-p"
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
                className="btn btn-s"
              >
                <Icon name="copy" size={14} /> 复制
              </button>
            </div>
            <div className="mt-4 flex justify-end">
              <button type="button" onClick={() => setCreated(null)} className="btn btn-p">
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
