import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SettingsSession } from '@qingdan/contracts';
import { ApiError } from '../../api/client';
import { settingsApi } from './settings-api';

/**
 * 「我的登录设备」区块（`platform.settings.sessions` + `.revoke_session`）。
 *
 * ## 为什么不并进 `SettingsOverview`
 *
 * 会话是**会变的**：别处刚登录就多一条。而概览是配置类快照（公司、单号规则、权限），
 * 一天看一次就够。混在一起有两个坏处 —— 踢掉一台设备后整页重新加载；60 秒的
 * `staleTime` 还会把刚踢完的视图卡住。
 *
 * ## 为什么自己管四态
 *
 * 它有自己的请求，不能借外层页面的 `data-state`。否则会话拉失败会把整页五块正文
 * 一起打掉 —— 用户明明能看到自己的公司和权限，却因为设备列表 500 而整页报错。
 *
 * ## 已吊销的会话照样显示
 *
 * 后端的列表连 `revokedAt !== null` 的一起返回，注释写明理由：「『我刚踢了谁』有据可查」。
 * 所以这里**不过滤**，只是把已吊销的行压暗、不给按钮 —— 用户踢完能看见它变成「已踢出」，
 * 这才是操作生效的凭据。踢完就消失会让人怀疑自己到底点中没点中。
 */

/** 403 是正常业务分支：后端用 403 表达「这条会话不归你」。 */
function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/** 时刻按 `YYYY-MM-DD HH:mm` 显示。相对时间（「3 小时前」）在这里不合适 —— 排障要看准点。 */
export function formatMoment(value: string | null): string {
  if (value === null) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** 一行设备的状态标签。优先级：当前 > 已踢出 > 已过期 > 有效。 */
function SessionBadge({ session }: { readonly session: SettingsSession }) {
  if (session.current) {
    return <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-white">本机</span>;
  }
  if (session.revokedAt !== null) {
    return (
      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">已踢出</span>
    );
  }
  // active 是后端算好的（未吊销 **且** 未过期）。不要自己拿 revokedAt + expiresAt 重算 ——
  // 漏掉过期判断就会把一条早已失效的会话显示成「可用」。
  if (!session.active) {
    return (
      <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">已过期</span>
    );
  }
  return null;
}

export function SessionsBlock() {
  const queryClient = useQueryClient();
  const [kickTarget, setKickTarget] = useState<SettingsSession | null>(null);

  const query = useQuery({
    queryKey: ['settings', 'sessions'],
    queryFn: settingsApi.sessions,
    // 会话会在别处变化，但不必每次都拉；切页回来 30 秒内用缓存
    staleTime: 30_000,
  });

  const revoke = useMutation({
    mutationFn: (id: string) => settingsApi.revokeSession(id),
    onSuccess: () => {
      // 重新拉列表而不是本地改状态：后端回的是 {id, revokedAt}，而列表里还有 lastSeenAt 等
      // 会被这次操作间接影响的字段。本地拼一个「假已踢出」行容易和后端不一致。
      void queryClient.invalidateQueries({ queryKey: ['settings', 'sessions'] });
      setKickTarget(null);
    },
  });

  const state = query.isPending ? 'loading' : query.isError ? 'error' : 'filled';

  const errorText = (() => {
    if (!revoke.isError) return null;
    if (isForbidden(revoke.error)) {
      // 后端把「不存在」与「不是本人的」都回 403，措辞必须按这个说 ——
      // 说成「会话不存在」就等于承认了「这条会话存在与否可探测」。
      return '只能撤销本人的登录会话。';
    }
    return revoke.error instanceof ApiError ? revoke.error.message : '踢出失败，请重试。';
  })();

  return (
    <section className="panel" data-state={state}>
      <div className="flex items-baseline justify-between">
        <h2 className="panel-h">我的登录设备</h2>
        <button
          type="button"
          className="btn-ghost text-xs"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? '刷新中…' : '刷新'}
        </button>
      </div>

      <p className="note mt-1">
        只列本人的会话。设备名由浏览器标识推导，服务器不留原文，也不显示 IP。
      </p>

      <div className="st-block st-loading mt-3" role="status" aria-live="polite">
        <p className="text-sm text-slate-500">正在读取登录设备…</p>
      </div>

      <div className="st-block st-error mt-3">
        <p className="text-sm text-red-600">
          {isForbidden(query.error)
            ? '没有权限查看登录设备（需要 employee.read）。'
            : '登录设备读取失败，其他区块不受影响。'}
        </p>
        <button type="button" className="btn-ghost mt-2 text-xs" onClick={() => void query.refetch()}>
          重试
        </button>
      </div>

      <div className="st-block st-filled mt-3">
        {/*
          没有 empty 态：能打开这个页面 = 已登录 = 至少有「本机」这一条。
          写「暂无登录设备」会是永远走不到的死代码。
        */}
        <table className="table">
          <thead>
            <tr>
              <th>设备</th>
              <th>签发时间</th>
              <th>最近使用</th>
              <th>到期</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(query.data?.items ?? []).map((session) => (
              <tr key={session.id} className={session.revokedAt !== null ? 'text-slate-400' : ''}>
                <td>
                  <span className="mr-2">{session.deviceLabel}</span>
                  <SessionBadge session={session} />
                </td>
                <td className="num text-xs">{formatMoment(session.issuedAt)}</td>
                <td className="num text-xs">{formatMoment(session.lastSeenAt)}</td>
                <td className="num text-xs">{formatMoment(session.expiresAt)}</td>
                <td className="text-right">
                  {/*
                    三种情况不给按钮：
                    - 当前这条：踢掉自己等于立即登出，而契约里没有「踢完自己跳哪」的约定；
                    - 已吊销 / 已过期：点了也没意义，只会换来一句「已撤销过」。
                  */}
                  {!session.current && session.active && (
                    <button
                      type="button"
                      className="btn-ghost text-xs text-red-600"
                      disabled={revoke.isPending}
                      onClick={() => setKickTarget(session)}
                    >
                      踢出
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {errorText !== null && (
        <p className="mt-3 text-sm text-red-600" role="alert">
          {errorText}
        </p>
      )}

      {/* 二次确认做在块内而不是用 globalThis.confirm：这里要显示设备名与签发时间，
          让用户确认自己踢的是哪一台，而 confirm 只能给一行字。 */}
      {kickTarget !== null && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-800">
            踢出「{kickTarget.deviceLabel}」（{formatMoment(kickTarget.issuedAt)} 签发）？
          </p>
          <p className="note mt-1">
            踢出后这台设备需要重新登录。当前设备不受影响 —— 你自己这台不在这里踢。
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="btn text-xs"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(kickTarget.id)}
            >
              {revoke.isPending ? '踢出中…' : '确认踢出'}
            </button>
            <button
              type="button"
              className="btn-ghost text-xs"
              disabled={revoke.isPending}
              onClick={() => setKickTarget(null)}
            >
              取消
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
