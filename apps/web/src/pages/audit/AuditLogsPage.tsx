import type { AuditLog } from '@qingdan/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { platformAdminApi } from '../../api/platform-admin';
import { describeListError } from '../../components/ListStates';
import { Icon } from '../../components/icons/Icon';
import { resolveListState } from '../../lib/list-state';
import { allows } from '../../lib/access';
import { authApi, authKeys } from '../auth/auth-api';

/**
 * 操作日志页（22 页之第 21 页，#144；v3.0 重做 #434）。
 *
 * - `GET /api/v1/audit-logs`：只追加、不可改删；游标分页（limit 50）；敏感读（D54②）。
 * - 契约查询参数只有分页，**搜索 / 结果 / 来源筛选都在客户端做**。
 * - 四态用 `data-state` 由 CSS 驱动，四分支常驻 DOM（app-v013.css）。
 */

const ACTOR_LABELS: Readonly<Record<string, string>> = {
  platform: '平台',
  employee: '员工',
  ai: 'AI',
  system: '系统',
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  web: 'Web',
  cli: 'CLI',
  api: 'API',
  mcp: 'MCP',
  job: 'Job',
};

const SOURCE_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['all', '全部来源'],
  ['web', 'Web'],
  ['cli', 'CLI'],
  ['api', 'API'],
  ['mcp', 'MCP'],
  ['job', 'Job'],
];

export interface AuditLogFilter {
  readonly keyword: string;
  readonly result: 'all' | 'success' | 'fail';
  readonly source: string;
}

/** 客户端筛选（纯函数，便于单测）：关键字匹配操作人/动作/对象，另按结果与来源过滤。 */
export function filterAuditLogs(logs: readonly AuditLog[], filter: AuditLogFilter): AuditLog[] {
  const keyword = filter.keyword.trim().toLowerCase();
  return logs.filter((log) => {
    if (keyword !== '') {
      const haystack =
        `${log.actorType} ${log.actorId} ${log.action} ${log.objectType} ${log.objectId ?? ''}`.toLowerCase();
      if (!haystack.includes(keyword)) return false;
    }
    if (filter.result === 'success' && log.result !== 'success') return false;
    if (filter.result === 'fail' && log.result === 'success') return false;
    if (filter.source !== 'all' && log.source !== filter.source) return false;
    return true;
  });
}

export function AuditLogsPage() {
  const me = useQuery({ queryKey: authKeys.me, queryFn: () => authApi.me(), retry: false });
  const canView = allows(me.data?.scope, 'audit', 'read');

  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [keyword, setKeyword] = useState('');
  const [result, setResult] = useState<'all' | 'success' | 'fail'>('all');
  const [source, setSource] = useState('all');

  const listQuery = useQuery({
    queryKey: ['admin', 'audit-logs', cursors[pageIndex] ?? null],
    queryFn: () => platformAdminApi.listAuditLogs(cursors[pageIndex] ?? null),
    enabled: canView,
  });

  useEffect(() => {
    setCursors([null]);
    setPageIndex(0);
  }, [keyword, result, source]);

  const logs = listQuery.data?.items ?? [];
  const filtered = useMemo(
    () => filterAuditLogs(logs, { keyword, result, source }),
    [logs, keyword, result, source],
  );
  const state = resolveListState({
    isPending: listQuery.isPending,
    hasError: listQuery.isError,
    isEmpty: logs.length === 0,
  });

  const resultCount = (value: 'success' | 'fail') =>
    logs.filter((log) => log.result === value).length;

  if (!canView) {
    return (
      <section className="space-y-4">
        <header className="p-head">
          <div>
            <div className="eyebrow">平台 · 只追加审计</div>
            <h1>操作日志</h1>
            <p className="sub">谁 / 从哪 / 对谁 / 做了什么 / 成没成。只追加，不可改删（D51）。</p>
          </div>
        </header>
        <div className="card state">
          <div>
            <div className="st-ico">
              <Icon name="shield" />
            </div>
            <div className="st-title">没有查看权限</div>
            <p className="st-desc">查看操作日志需要 audit.read 权限（敏感读），请联系老板开通。</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <header className="p-head">
        <div>
          <div className="eyebrow">平台 · 只追加审计</div>
          <h1>操作日志</h1>
          <p className="sub">谁 / 从哪 / 对谁 / 做了什么 / 成没成。只追加，不可改删（D51）。</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="chip inline-flex items-center gap-1">
            <Icon name="shield" size={14} /> 只追加
          </span>
          <span className="st warn">敏感读 · 查询本身会被记录</span>
        </div>
      </header>

      <div className="toolbar">
        <label>
          <span className="sr-only">搜索</span>
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索操作人、动作、对象…"
            className="search"
          />
        </label>
        <div className="chips">
          <button
            type="button"
            className={`chip${result === 'all' ? ' on' : ''}`}
            onClick={() => setResult('all')}
          >
            全部<b>{logs.length}</b>
          </button>
          <button
            type="button"
            className={`chip${result === 'success' ? ' on' : ''}`}
            onClick={() => setResult('success')}
          >
            <Icon name="check" size={14} />成功<b>{resultCount('success')}</b>
          </button>
          <button
            type="button"
            className={`chip${result === 'fail' ? ' on' : ''}`}
            onClick={() => setResult('fail')}
          >
            被拒绝<b>{resultCount('fail')}</b>
          </button>
        </div>
        <div className="seg" title="来源">
          {SOURCE_OPTIONS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={source === value ? 'on' : undefined}
              onClick={() => setSource(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="grow" />
        <span className="note">
          <Icon name="shield" size={14} /> 日志只追加，不可编辑或删除
        </span>
      </div>

      <div className="card list-card" data-state={state} aria-busy={state === 'loading'}>
        <div className="tw">
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
            <tbody data-state={state}>
              {filtered.map((log) => (
                <tr key={log.id} className="r-row">
                  <td className="mono muted">{log.time.slice(0, 19).replace('T', ' ')}</td>
                  <td>
                    <b>{ACTOR_LABELS[log.actorType] ?? log.actorType}</b>
                    <span className="mono muted ml-1" title={log.actorId}>
                      {shortId(log.actorId)}
                    </span>
                  </td>
                  <td>
                    <span className="tag">{SOURCE_LABELS[log.source] ?? log.source}</span>
                  </td>
                  <td className="mono">{log.action}</td>
                  <td className="mono muted" title={log.objectId ?? undefined}>
                    {log.objectType}
                    {log.objectId ? ` · ${shortId(log.objectId)}` : ''}
                  </td>
                  <td>
                    <span className={`st ${log.result === 'success' ? 'ok' : 'bad'}`}>
                      {log.result === 'success' ? '成功' : '被拒绝'}
                    </span>
                  </td>
                </tr>
              ))}
              <tr className="st-tr st-empty">
                <td colSpan={6}>
                  <div className="st-box">
                    <div className="st-ico">
                      <Icon name="filter" />
                    </div>
                    <div className="st-title">还没有操作记录</div>
                    <p className="st-desc">发生业务动作后会自动出现在这里；可清空筛选重试。</p>
                  </div>
                </td>
              </tr>
              <tr className="st-tr st-loading">
                <td colSpan={6}>
                  <div className="st-box" aria-label="操作日志加载中">
                    <div className="sk sk-line w80" />
                    <div className="sk sk-line w60" />
                    <div className="sk sk-line w40" />
                    <p className="st-desc mt-3">操作日志加载中…</p>
                  </div>
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={6}>
                  <div className="st-box st-error">
                    <div className="st-ico">
                      <Icon name="refresh" />
                    </div>
                    <div className="st-title">操作日志加载失败</div>
                    <p className="st-desc">{describeListError('操作日志加载失败', listQuery.error)}</p>
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
            当前筛选：
            {[
              keyword.trim() ? `关键字「${keyword.trim()}」` : '全部关键字',
              result === 'success' ? '成功' : result === 'fail' ? '被拒绝' : '全部结果',
              source !== 'all' ? `来源 ${SOURCE_LABELS[source] ?? source}` : '全部来源',
            ].join(' · ')}
          </span>
          <div className="pager" aria-label="操作日志分批">
            <span className="count">当前返回 {filtered.length} 条</span>
            <div className="nav">
              <button
                type="button"
                disabled={pageIndex === 0}
                onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
              >
                上一批
              </button>
              <span className="of">第 {pageIndex + 1} 批</span>
              <button
                type="button"
                disabled={!listQuery.data?.nextCursor}
                onClick={() => {
                  const nextCursor = listQuery.data?.nextCursor;
                  if (!nextCursor) return;
                  setCursors((items) => [...items.slice(0, pageIndex + 1), nextCursor]);
                  setPageIndex((index) => index + 1);
                }}
              >
                下一批
              </button>
            </div>
          </div>
        </footer>
      </div>
    </section>
  );
}

/** 长 uuid 只显示前 8 位，完整值放 title 悬浮。 */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}
