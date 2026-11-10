import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import type { Position } from '@qingdan/contracts';
import { platformAdminApi } from '../../api/platform-admin';
import { ApiError } from '../../api/client';
import { ACTION_WORDS, DOMAIN_WORDS } from '../employees/domain-words';

/**
 * 权限设置页（22 页之第 17 页，#144）——岗位模板（D44「权限设置」= 岗位 + 个人覆盖）。
 *
 * - 列表：`GET /api/v1/positions`；行内「编辑模板」打开 24 域 × 7 动作矩阵；
 * - 模板动作 = 8 动作去掉 `view_price`（D4：看价是数据可见性开关，不进操作勾选表）；
 * - 新建：`POST /positions`（presetKey 不传 = 自定义岗位；预设标识只能服务端定，D60②）；
 * - 改模板：`PATCH /positions/{id}`，If-Match 强 ETag，改完即时生效（computeAuthz 每请求现算）；
 * - 停用：`DELETE /positions/{id}`（软删除；被员工占用 → 422 POSITION_IN_USE，人话提示）；
 * - 个人级覆盖在员工页（#6），本页只管岗位模板。
 *
 * 词表复用 `employees/domain-words.ts`（唯一真源 contracts/domains.ts，有防漂移抽查）。
 */

/** 岗位模板可用动作 = 8 动作去掉看价（D4）。 */
const TEMPLATE_ACTIONS = ACTION_WORDS.filter((a) => a.key !== 'view_price');

const PRESET_LABELS: Readonly<Record<string, string>> = {
  owner: '老板',
  manager: '经理',
  finance: '财务',
  sales: '销售',
  purchase: '采购',
  quality: '质检',
  picking: '拣货',
  warehouse: '仓管',
};

type MatrixSelection = Readonly<Record<string, ReadonlySet<string>>>;

function selectionFromPosition(position: Position): MatrixSelection {
  const map: Record<string, Set<string>> = {};
  for (const entry of position.actions) {
    map[entry.domain] = new Set(entry.actions);
  }
  return map;
}

function actionsFromSelection(selection: MatrixSelection): { domain: string; actions: string[] }[] {
  return Object.entries(selection)
    .filter(([, actions]) => actions.size > 0)
    .map(([domain, actions]) => ({ domain, actions: [...actions] }));
}

export function PermissionsPage() {
  const queryClient = useQueryClient();
  const listQuery = useQuery({
    queryKey: ['admin', 'positions'],
    queryFn: platformAdminApi.listPositions,
  });

  const [editor, setEditor] = useState<{
    position: Position | null; // null = 新建
    name: string;
    selection: MatrixSelection;
    version: number;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'positions'] });
    // 岗位模板变更影响员工页覆盖面板基线列。
    void queryClient.invalidateQueries({ queryKey: ['positions'] });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      platformAdminApi.createPosition({
        name: editor!.name.trim(),
        actions: actionsFromSelection(editor!.selection),
      }),
    onSuccess: (position) => {
      setEditor(null);
      setError(null);
      setNotice(`已创建岗位「${position.name}」，生效权限立即按新模板计算。`);
      void invalidate();
    },
    onError: (e) => setError(describeError(e, '创建失败')),
  });

  const updateMutation = useMutation({
    mutationFn: () =>
      platformAdminApi.updatePosition(
        editor!.position!.id,
        { name: editor!.name.trim(), actions: actionsFromSelection(editor!.selection) },
        editor!.version,
      ),
    onSuccess: (position) => {
      setEditor(null);
      setError(null);
      setNotice(`岗位「${position.name}」模板已更新，即时生效。`);
      void invalidate();
    },
    onError: (e) => setError(describeError(e, '模板保存失败')),
  });

  const disableMutation = useMutation({
    mutationFn: (position: Position) =>
      platformAdminApi.disablePosition(position.id, position.version),
    onSuccess: (position) => {
      setError(null);
      setNotice(`岗位「${position.name}」已停用（软删除，历史绑定与审计仍可追溯）。`);
      void invalidate();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 422) {
        setError('停用失败：该岗位仍有员工占用。请先把员工改绑到其他岗位。');
      } else {
        setError(describeError(e, '停用失败'));
      }
    },
  });

  const positions = listQuery.data?.items ?? [];

  const openCreate = () =>
    setEditor({ position: null, name: '', selection: {}, version: 0 });
  const openEdit = (position: Position) =>
    setEditor({
      position,
      name: position.name,
      selection: selectionFromPosition(position),
      version: position.version,
    });

  return (
    <section className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">权限设置</h1>
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700">
            已接真实接口
          </span>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white hover:bg-slate-700"
        >
          新建岗位
        </button>
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
            <p className="pt-1 text-xs text-slate-400">岗位列表加载中…</p>
          </div>
        ) : listQuery.isError ? (
          <div className="p-6 text-center">
            <p className="text-sm text-rose-600">
              岗位列表加载失败：{listQuery.error instanceof ApiError
                ? `${listQuery.error.message}（${listQuery.error.code}）`
                : '未知错误'}
            </p>
            <p className="mt-1 text-xs text-slate-400">
              {listQuery.error instanceof ApiError && listQuery.error.status === 403
                ? '你没有权限设置权限（permission.read），请联系老板开通。'
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
        ) : positions.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm text-slate-500">还没有岗位模板。点击右上角「新建岗位」创建。</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-400">
                  <th className="px-4 py-2.5 font-medium">岗位</th>
                  <th className="px-4 py-2.5 font-medium">类型</th>
                  <th className="px-4 py-2.5 font-medium">权限摘要</th>
                  <th className="px-4 py-2.5 font-medium">状态</th>
                  <th className="px-4 py-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((position) => (
                  <tr key={position.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60">
                    <td className="px-4 py-2.5">{position.name}</td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">
                      {position.presetKey
                        ? `预设 · ${PRESET_LABELS[position.presetKey] ?? position.presetKey}`
                        : '自定义'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-slate-600">
                      {position.actions
                        .slice(0, 4)
                        .map((entry) => `${labelOfDomain(entry.domain)}·${entry.actions.map(labelOfAction).join('')}`)
                        .concat(position.actions.length > 4 ? [`…共 ${position.actions.length} 域`] : [])
                        .join('、')}
                    </td>
                    <td className="px-4 py-2.5">
                      <span
                        className={[
                          'rounded-full px-2 py-0.5 text-xs font-medium',
                          position.status === '启用'
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-slate-100 text-slate-500',
                        ].join(' ')}
                      >
                        {position.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span className="inline-flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => openEdit(position)}
                          className="rounded border border-slate-300 px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50"
                        >
                          编辑模板
                        </button>
                        {position.status === '启用' && (
                          <button
                            type="button"
                            disabled={disableMutation.isPending}
                            onClick={() => disableMutation.mutate(position)}
                            className="rounded border border-rose-200 px-2.5 py-1 text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-40"
                            title="软删除；被员工占用的岗位会被拒绝"
                          >
                            停用
                          </button>
                        )}
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
        权限模板 = 功能域 × 动作（D4）；「看价」是数据可见性开关，不进模板表，个人级覆盖在员工页处理。
        模板改动即时生效（服务端每请求现算，D52.1②）。
      </p>

      {editor && (
        <PositionEditor
          editor={editor}
          saving={createMutation.isPending || updateMutation.isPending}
          onChange={(patch) => setEditor({ ...editor, ...patch })}
          onSave={() => (editor.position ? updateMutation.mutate() : createMutation.mutate())}
          onClose={() => setEditor(null)}
        />
      )}
    </section>
  );
}

function PositionEditor({
  editor,
  saving,
  onChange,
  onSave,
  onClose,
}: {
  editor: {
    position: Position | null;
    name: string;
    selection: MatrixSelection;
    version: number;
  };
  saving: boolean;
  onChange: (patch: { name?: string; selection?: MatrixSelection }) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const selectionError = useMemo(() => {
    if (editor.name.trim().length === 0) return '岗位名称不能为空。';
    if (actionsFromSelection(editor.selection).length === 0) return '至少要给一个功能域勾选动作。';
    return null;
  }, [editor.name, editor.selection]);

  const toggle = (domain: string, action: string) => {
    const current = editor.selection[domain] ?? new Set<string>();
    const next = new Set(current);
    if (next.has(action)) {
      next.delete(action);
    } else {
      next.add(action);
    }
    const domainMap: Record<string, ReadonlySet<string>> = { ...editor.selection };
    if (next.size === 0) {
      delete domainMap[domain];
    } else {
      domainMap[domain] = next;
    }
    onChange({ selection: domainMap });
  };

  const totalSelected = actionsFromSelection(editor.selection).reduce(
    (sum, entry) => sum + entry.actions.length,
    0,
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-6">
      <div className="w-full max-w-5xl rounded-lg bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-800">
              {editor.position ? `编辑岗位模板 · ${editor.position.name}` : '新建岗位'}
            </h2>
            {editor.position && (
              <p className="mt-0.5 text-xs text-slate-400">
                {editor.position.presetKey ? '预设岗位：角色标识（presetKey）不可改（D60②）' : '自定义岗位'}
                {' · '}版本 {editor.position.version}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="rounded border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50">
            关闭
          </button>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <input
            value={editor.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="岗位名称"
            className="w-56 rounded border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-slate-400"
          />
          <span className="text-xs text-slate-400">已勾选 {totalSelected} 个动作</span>
        </div>

        <div className="mt-3 max-h-[50vh] overflow-y-auto rounded border border-slate-200">
          <table className="w-full text-sm">
            <thead>
              <tr className="sticky top-0 border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
                <th className="px-3 py-2 text-left font-medium">功能域</th>
                {TEMPLATE_ACTIONS.map((action) => (
                  <th key={action.key} className="px-3 py-2 text-center font-medium" title={action.key}>
                    {action.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DOMAIN_WORDS.map((domain) => (
                <tr key={domain.key} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-1.5 text-xs text-slate-600">{domain.label}</td>
                  {TEMPLATE_ACTIONS.map((action) => {
                    const checked = editor.selection[domain.key]?.has(action.key) ?? false;
                    return (
                      <td key={action.key} className="px-3 py-1.5 text-center">
                        <button
                          type="button"
                          aria-pressed={checked}
                          aria-label={`${domain.label}·${action.label}`}
                          onClick={() => toggle(domain.key, action.key)}
                          className={[
                            'h-6 w-6 rounded text-xs',
                            checked
                              ? 'bg-slate-800 text-white hover:bg-slate-700'
                              : 'border border-slate-200 text-slate-300 hover:border-slate-400',
                          ].join(' ')}
                        >
                          {checked ? '✓' : ''}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {selectionError && <p className="mt-2 text-xs text-rose-600">{selectionError}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50">
            取消
          </button>
          <button
            type="button"
            disabled={selectionError !== null || saving}
            onClick={onSave}
            className="rounded bg-slate-800 px-3 py-1.5 text-sm text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? '保存中…' : '保存模板'}
          </button>
        </div>
      </div>
    </div>
  );
}

function labelOfDomain(key: string): string {
  return DOMAIN_WORDS.find((d) => d.key === key)?.label ?? key;
}

function labelOfAction(key: string): string {
  return ACTION_WORDS.find((a) => a.key === key)?.label ?? key;
}

function describeError(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.status === 428) return `${fallback}：缺少 If-Match 版本头，请刷新后重试。`;
    if (e.status === 409) return `${fallback}：版本冲突（别人已先改过），请刷新后重试。`;
    if (e.status === 403) return `${fallback}：缺少权限设置权限（permission.update），请联系老板开通。`;
    return `${fallback}：${e.message}（${e.code}）`;
  }
  return fallback;
}
