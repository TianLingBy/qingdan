import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { platformAdminApi } from '../../api/platform-admin';
import { ApiError } from '../../api/client';

/**
 * 操作日志页（22 页之第 21 页，#144）。
 *
 * - `GET /api/v1/audit-logs`：只追加、不可改删（契约第三批 §1）；keyset 按时间倒序；
 *   **看日志本身是敏感读**：每次成功查询服务端都会记一条审计（D54②）；
 * - 契约查询参数只有分页（PageQuerySchema），**操作人/对象筛选在客户端做**——
 *   服务端筛选属契约变更，归主线，不在这里自造参数；
 * - 展示口径：actorType=system 固定 `system`；平台账号带 `platform:` 前缀（D54）。
 */

const ACTOR_LABELS: Readonly<Record<string, string>> = {
  platform: '平台',
  employee: '员工',
  ai: 'AI',
  system: '系统',
};

export function AuditLogsPage() {
  const listQuery = useQuery({
    queryKey: ['admin', 'audit-logs'],
    queryFn: () => platformAdminApi.listAuditLogs(),
  });

  const [actorKeyword, setActorKeyword] = useState('');
  const [objectKeyword, setObjectKeyword] = useState('');

  const logs = listQuery.data?.items ?? [];
  const filtered = useMemo(() => {
    const actor = actorKeyword.trim().toLowerCase();
    const object = objectKeyword.trim().toLowerCase();
    return logs.filter((log) => {
      if (actor !== '') {
        const haystack = `${log.actorType} ${log.actorId}`.toLowerCase();
        if (!haystack.includes(actor)) return false;
      }
      if (object !== '') {
        const haystack = `${log.objectType} ${log.objectId ?? ''}`.toLowerCase();
        if (!haystack.includes(object)) return false;
      }
      return true;
    });
  }, [logs, actorKeyword, objectKeyword]);

  return (
    <section className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">操作日志</h1>
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
            已接真实接口
          </span>
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
            敏感读 · 查询本身会被记录
          </span>
        </div>
        <div className="flex gap-2">
          <input
            type="search"
            value={actorKeyword}
            onChange={(e) => setActorKeyword(e.target.value)}
            placeholder="按操作人筛选（类型 / ID）"
            className="w-56 rounded border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-slate-400"
          />
          <input
            type="search"
            value={objectKeyword}
            onChange={(e) => setObjectKeyword(e.target.value)}
            placeholder="按对象筛选（类型 / ID）"
            className="w-56 rounded border border-slate-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-slate-400"
          />
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-lg border border-slate-200 bg-white">
        {listQuery.isPending ? (
          <div className="space-y-2 p-4" aria-busy="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-slate-100" />
            ))}
            <p className="pt-1 text-xs text-slate-400">操作日志加载中…</p>
          </div>
        ) : listQuery.isError ? (
          <div className="p-6 text-center">
            <p className="text-sm text-rose-600">
              操作日志加载失败：{listQuery.error instanceof ApiError
                ? `${listQuery.error.message}（${listQuery.error.code}）`
                : '未知错误'}
            </p>
            <p className="mt-1 text-xs text-slate-400">
              {listQuery.error instanceof ApiError && listQuery.error.status === 403
                ? '查看操作日志需要 audit.read 权限（敏感读），请联系老板开通。'
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
        ) : logs.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm text-slate-500">还没有操作记录。发生业务动作后会自动出现在这里。</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm text-slate-500">没有匹配当前筛选条件的日志。</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-400">
                  <th className="px-4 py-2.5 font-medium">时间</th>
                  <th className="px-4 py-2.5 font-medium">操作人</th>
                  <th className="px-4 py-2.5 font-medium">来源</th>
                  <th className="px-4 py-2.5 font-medium">动作</th>
                  <th className="px-4 py-2.5 font-medium">对象</th>
                  <th className="px-4 py-2.5 font-medium">结果</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((log) => (
                  <tr key={log.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-500">
                      {log.time.slice(0, 19).replace('T', ' ')}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">
                        {ACTOR_LABELS[log.actorType] ?? log.actorType}
                      </span>
                      <span className="ml-1.5 font-mono text-slate-500" title={log.actorId}>
                        {shortId(log.actorId)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">{log.source}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-slate-700">{log.action}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">
                      {log.objectType}
                      {log.objectId && (
                        <span className="ml-1 font-mono text-slate-400" title={log.objectId}>
                          {shortId(log.objectId)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={[
                          'rounded-full px-2 py-0.5 text-xs font-medium',
                          log.result === 'success'
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-rose-100 text-rose-700',
                        ].join(' ')}
                        title={log.errorCode ?? undefined}
                      >
                        {log.result === 'success' ? '成功' : `失败${log.errorCode ? `·${log.errorCode}` : ''}`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="mt-3 text-xs text-slate-400">
        日志只追加、不可改删；在线保留 180 天（契约口径）。本页查询本身是敏感读，服务端会记录一条
        audit.read 审计。操作人/对象筛选暂为客户端过滤，服务端筛选参数待契约扩展（#144 备注）。
      </p>
    </section>
  );
}

/** 长 uuid 只显示前 8 位，完整值放 title 悬浮。 */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
