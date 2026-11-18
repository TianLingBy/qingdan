import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { platformAdminApi } from '../../api/platform-admin';
import { ApiError } from '../../api/client';
import { ListEmpty, ListError, ListLoading } from '../../components/ListStates';
import { resolveListState, type ListState } from '../../lib/list-state';

/**
 * 操作日志页（22 页之第 21 页，#144；v0.13 重做 #340）。
 *
 * - `GET /api/v1/audit-logs`：只追加、不可改删；keyset 按时间倒序；游标分页（limit 50）。
 *   **看日志本身是敏感读**：每次成功查询服务端都会记一条审计（D54②）。
 * - 契约查询参数只有分页（PageQuerySchema），**操作人/对象筛选在客户端做**——
 *   服务端筛选属契约变更，归主线，不在这里自造参数。
 * - 四态用 `data-state` 由 CSS 驱动（app-v013.css），不写 `{!rows.length && <EmptyRow/>}`。
 */

const ACTOR_LABELS: Readonly<Record<string, string>> = {
  platform: '平台',
  employee: '员工',
  ai: 'AI',
  system: '系统',
};

export function AuditLogsPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const [actorKeyword, setActorKeyword] = useState('');
  const [objectKeyword, setObjectKeyword] = useState('');

  const listQuery = useQuery({
    queryKey: ['admin', 'audit-logs', cursor],
    queryFn: () => platformAdminApi.listAuditLogs(cursor),
  });

  const logs = listQuery.data?.items ?? [];
  const nextCursor = listQuery.data?.nextCursor ?? null;

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

  const listState: ListState = resolveListState({
    isPending: listQuery.isPending,
    hasError: listQuery.error !== null,
    isEmpty: logs.length === 0,
  });

  return (
    <section className="mx-auto max-w-7xl space-y-4">
      <div className="p-head">
        <div>
          <div className="eyebrow">平台 · 只追加审计</div>
          <h1>操作日志</h1>
          <p className="sub">所有写操作与敏感读的审计流水；只可查询，不可修改或删除（D51）。</p>
        </div>
      </div>

      <p className="note">
        本页查询本身是敏感读，服务端会记录一条 audit.read 审计（D54②）。
        操作人 / 对象筛选为客户端过滤（后端暂未提供关键字参数）。
      </p>

      <div className="toolbar">
        <input
          type="search"
          value={actorKeyword}
          onChange={(e) => setActorKeyword(e.target.value)}
          placeholder="按操作人筛选（类型 / ID）"
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        />
        <input
          type="search"
          value={objectKeyword}
          onChange={(e) => setObjectKeyword(e.target.value)}
          placeholder="按对象筛选（类型 / ID）"
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        />
      </div>

      {/*
        列表区（v0.13）：四态由容器与 tbody 上的 `data-state` 驱动，不写 JSX 分支。
        数据行只带 `r-row`，不要带 `st-tr`（`tbody > tr.st-tr` 默认隐藏，filled 态无法复原）。
      */}
      <div className="card" data-state={listState}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作人</th>
                <th>来源</th>
                <th>动作</th>
                <th>对象</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody data-state={listState}>
              <tr className="st-tr st-loading">
                <td colSpan={6}>
                  <ListLoading label="正在加载操作日志…" />
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={6}>
                  <ListError
                    title="操作日志加载失败"
                    error={listQuery.error ?? null}
                    hint={
                      listQuery.error instanceof ApiError && listQuery.error.status === 403
                        ? '查看操作日志需要 audit.read 权限（敏感读），请联系老板开通。'
                        : undefined
                    }
                    onRetry={() => void listQuery.refetch()}
                  />
                </td>
              </tr>
              <tr className="st-tr st-empty">
                <td colSpan={6}>
                  <ListEmpty title="还没有操作记录。发生业务动作后会自动出现在这里。" />
                </td>
              </tr>
              {filtered.map((log) => (
                <tr key={log.id} className="r-row">
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">
                    {log.time.slice(0, 19).replace('T', ' ')}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span className="text-slate-500">{ACTOR_LABELS[log.actorType] ?? log.actorType}</span>
                    <span className="ml-1.5 font-mono text-slate-500" title={log.actorId}>
                      {shortId(log.actorId)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-600">{log.source}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-700">{log.action}</td>
                  <td className="px-4 py-3 text-xs text-slate-600">
                    {log.objectType}
                    {log.objectId && (
                      <span className="ml-1 font-mono text-slate-400" title={log.objectId}>
                        {shortId(log.objectId)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={log.result === 'success' ? 'text-emerald-600' : 'text-rose-600'}
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
      </div>

      {nextCursor && (
        <div className="pager">
          <button type="button" className="btn btn-s" onClick={() => setCursor(nextCursor)}>
            下一页
          </button>
        </div>
      )}
    </section>
  );
}

/** 长 uuid 只显示前 8 位，完整值放 title 悬浮。 */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
