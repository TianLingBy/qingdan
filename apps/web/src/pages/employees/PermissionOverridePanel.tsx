import { useMemo, useState } from 'react';
import {
  updatePermissionOverrides,
  type EmployeeSummary,
  type MeResult,
  type PermissionOverrideEntry,
  type PositionSummary,
} from '../../api/platform';
import { ApiError } from '../../api/client';
import { ACTION_WORDS, DOMAIN_WORDS, describeDeny, hasFullScope } from './domain-words';

/**
 * 员工个人权限覆盖面板（#6，唯一真接口联调部分）。
 *
 * - 「岗位基线」列：来自该员工各岗位的权限模板（`GET /positions`，#156 上线后可用；
 *   未上线时基线列显示「模板接口未上线」并允许继续提交覆盖）；
 * - 「本次覆盖」列：用户勾选的加减项，**服务端才是真源**——接口没有覆盖读端点，
 *   这里只展示本次会话里成功提交的差异（刷新后清空，TODO(接口待做): 覆盖读端点）；
 * - 可勾选项 = 当前登录人自己的生效权限（`GET /auth/me` 的 scope）；老板全量可选；
 * - 提交走真 `PATCH /employees/{id}/permissions`：先「预览」（dryRun=true）再「保存」；
 * - 403 的 reason 逐一翻译成人话（domain-words.ts DENY_REASON_MESSAGES）。
 */

interface OverridePanelProps {
  readonly employee: EmployeeSummary;
  readonly me: MeResult;
  readonly positions: readonly PositionSummary[] | null;
  readonly positionsUnavailable: boolean;
  readonly onClose: () => void;
}

/** 勾选状态键：`domain.action`。 */
function entryKey(domain: string, action: string): string {
  return `${domain}.${action}`;
}

export function PermissionOverridePanel({
  employee,
  me,
  positions,
  positionsUnavailable,
  onClose,
}: OverridePanelProps) {
  /** 本次勾选：true=加权 / false=减权；与基线一致的项提交后服务端会自动清掉覆盖行。 */
  const [selection, setSelection] = useState<Map<string, boolean>>(new Map());
  /** 已成功提交的差异（本会话内可见）。 */
  const [applied, setApplied] = useState<readonly PermissionOverrideEntry[]>([]);
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [lastEtag, setLastEtag] = useState<string | null>(null);

  const callerIsOwner = hasFullScope(me.scope);
  const isSelf = employee.id === me.employeeId;

  /** 非老板不可改老板 / 不可改自己（服务端硬约束；前端置灰只算提示，D15）。 */
  const blockedSelf = isSelf && !callerIsOwner;
  const blockedOwner = employee.isOwner && !callerIsOwner;
  const blocked = blockedSelf || blockedOwner;

  /** 岗位基线：员工各岗位模板的并集（只读对照用）。 */
  const baseline = useMemo(() => {
    const set = new Set<string>();
    if (positions === null) return set;
    for (const binding of employee.companies) {
      const position = positions.find((p) => p.id === binding.positionId);
      if (!position) continue;
      for (const entry of position.actions) {
        for (const action of entry.actions) set.add(entryKey(entry.domain, action));
      }
    }
    return set;
  }, [positions, employee]);

  const selectable = useMemo(() => {
    const set = new Set<string>();
    for (const entry of me.scope) {
      for (const action of entry.actions) set.add(entryKey(entry.domain, action));
    }
    return set;
  }, [me.scope]);

  function toggle(domain: string, action: string, granted: boolean): void {
    if (blocked || busy !== null) return;
    if (!selectable.has(entryKey(domain, action)) && !callerIsOwner) return;
    setSelection((prev) => {
      const next = new Map(prev);
      const key = entryKey(domain, action);
      if (next.get(key) === granted) {
        next.delete(key);
      } else {
        next.set(key, granted);
      }
      return next;
    });
  }

  const payload: PermissionOverrideEntry[] = [...selection.entries()].map(([key, granted]) => {
    const [domain, action] = key.split('.');
    return { domain: domain!, action: action!, granted };
  });

  async function submit(dryRun: boolean): Promise<void> {
    if (payload.length === 0) return;
    setBusy(dryRun ? 'preview' : 'save');
    setMessage(null);
    try {
      await updatePermissionOverrides(employee.id, payload, {
        dryRun,
        etag: lastEtag ?? undefined,
        onSuccess: (etag) => {
          if (!dryRun && etag) setLastEtag(etag);
        },
      });
      if (dryRun) {
        setMessage({ kind: 'ok', text: `预览通过：${payload.length} 项变更可提交（未落库）。` });
      } else {
        setApplied([...applied, ...payload]);
        setSelection(new Map());
        setMessage({ kind: 'ok', text: `已保存 ${payload.length} 项覆盖，立即生效。` });
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        setMessage({ kind: 'error', text: describeDeny(error.details) });
      } else if (error instanceof ApiError) {
        setMessage({ kind: 'error', text: `${error.message}（${error.code}）` });
      } else {
        setMessage({ kind: 'error', text: '提交失败，请稍后重试。' });
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        aria-label="关闭面板"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/30"
      />
      <aside className="relative z-10 flex h-full w-full max-w-2xl flex-col overflow-hidden bg-white shadow-xl">
        <header className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              权限覆盖 · {employee.name}
              <span className="ml-2 font-mono text-xs text-slate-400">{employee.employeeNo}</span>
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              岗位：{employee.companies.map((c) => `${c.companyName}·${c.positionName}`).join('、') || '未绑定'}
              {employee.isOwner ? ' · 老板' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50"
          >
            关闭
          </button>
        </header>

        {blocked && (
          <div className="border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-xs text-amber-800">
            {blockedSelf
              ? '不能修改自己的权限（防止自我提权）；如需调整请联系老板。'
              : '老板的权限只能由老板自己调整。'}
          </div>
        )}
        {positionsUnavailable && (
          <div className="border-b border-slate-200 bg-slate-50 px-5 py-2 text-xs text-slate-500">
            岗位模板接口（GET /positions）尚未上线，基线列暂不可对照；覆盖提交不受影响。
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-400">
                  <th className="py-2 pr-3 font-medium">功能域</th>
                  {ACTION_WORDS.map((a) => (
                    <th key={a.key} className="py-2 px-1.5 text-center font-medium" title={a.key}>
                      {a.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DOMAIN_WORDS.map((d) => (
                  <tr key={d.key} className="border-b border-slate-100">
                    <td className="py-1.5 pr-3 text-slate-700">{d.label}</td>
                    {ACTION_WORDS.map((a) => {
                      const key = entryKey(d.key, a.key);
                      const inBaseline = baseline.has(key);
                      const selected = selection.get(key);
                      const disabled = blocked || (!callerIsOwner && !selectable.has(key));
                      return (
                        <td key={a.key} className="px-1.5 py-1.5 text-center">
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => toggle(d.key, a.key, !inBaseline)}
                            title={
                              disabled
                                ? '超出你自己的权限，不可选择'
                                : inBaseline
                                  ? '岗位已有（点击=减权）'
                                  : '岗位没有（点击=加权）'
                            }
                            className={[
                              'h-6 w-6 rounded border text-xs leading-none',
                              selected === true
                                ? 'border-emerald-500 bg-emerald-500 text-white'
                                : selected === false
                                  ? 'border-rose-500 bg-rose-500 text-white'
                                  : inBaseline
                                    ? 'border-slate-300 bg-slate-100 text-slate-500'
                                    : 'border-slate-200 bg-white text-slate-300',
                              disabled ? 'cursor-not-allowed opacity-40' : 'hover:border-slate-400',
                            ].join(' ')}
                          >
                            {inBaseline && selected === undefined ? '✓' : selected === false ? '−' : ''}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-slate-400">
            深底「✓」= 岗位基线已有；绿 = 本次加权、红 = 本次减权（仅减权不受「不能超出自己权限」限制）。
            「看价」是数据可见性开关，不进岗位模板（D4）。
          </p>

          {applied.length > 0 && (
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800">
              <div className="font-medium">本会话已生效的覆盖（{applied.length} 项）</div>
              <div className="mt-1 leading-5">
                {applied
                  .map((e) => {
                    const d = DOMAIN_WORDS.find((w) => w.key === e.domain)?.label ?? e.domain;
                    const a = ACTION_WORDS.find((w) => w.key === e.action)?.label ?? e.action;
                    return `${d}·${a}${e.granted ? ' 加' : ' 减'}`;
                  })
                  .join('、')}
              </div>
              <div className="mt-1 text-emerald-600">
                TODO(接口待做): 覆盖明细读端点上线后改为服务端读取（当前刷新后不再展示）。
              </div>
            </div>
          )}
        </div>

        <footer className="border-t border-slate-200 px-5 py-3">
          {message && (
            <div
              className={[
                'mb-2 rounded px-3 py-2 text-xs',
                message.kind === 'ok'
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-rose-50 text-rose-700',
              ].join(' ')}
              role="status"
            >
              {message.text}
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-slate-400">
              {payload.length > 0 ? `已勾选 ${payload.length} 项` : '点击表格勾选加减项'}
              {lastEtag ? ` · ETag ${lastEtag}` : ''}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={blocked || payload.length === 0 || busy !== null}
                onClick={() => submit(true)}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === 'preview' ? '预览中…' : '预览（不落库）'}
              </button>
              <button
                type="button"
                disabled={blocked || payload.length === 0 || busy !== null}
                onClick={() => submit(false)}
                className="rounded bg-slate-900 px-3 py-1.5 text-sm text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy === 'save' ? '保存中…' : '保存覆盖'}
              </button>
            </div>
          </div>
        </footer>
      </aside>
    </div>
  );
}
