import type { InventoryFlow } from '@qingdan/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { authApi, authKeys } from '../auth/auth-api';
import { inventoryApi, inventoryQueryKeys } from './inventory-api';
import {
  errorText,
  formatDateTime,
  PageShell,
  Pagination,
  shortId,
} from './inventory-ui';

const SOURCE_TYPES = ['A', 'B', 'E', 'N', 'I', 'R', 'S'] as const;

export function InventoryFlowsPage() {
  const [companyId, setCompanyId] = useState('');
  const [batchNoInput, setBatchNoInput] = useState('');
  const [batchId, setBatchId] = useState<string | undefined>();
  const [resolvedBatchNo, setResolvedBatchNo] = useState<string | null>(null);
  const [sourceDocType, setSourceDocType] = useState('');
  const [sourceDocId, setSourceDocId] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [traceError, setTraceError] = useState<string | null>(null);

  const me = useQuery({
    queryKey: authKeys.me,
    queryFn: authApi.me,
  });
  const filters = {
    companyId: companyId || undefined,
    batchId,
    sourceDocType: sourceDocType || undefined,
    sourceDocId: sourceDocId.trim() || undefined,
    cursor: cursors[pageIndex] ?? null,
  };
  const flows = useQuery({
    queryKey: inventoryQueryKeys.flows(filters),
    queryFn: () => inventoryApi.listFlows(filters),
  });
  const resolveBatch = useMutation({
    mutationFn: () => inventoryApi.resolveBatchByNumber(batchNoInput, companyId || undefined),
    onSuccess: (batch) => {
      if (!batch) {
        setBatchId(undefined);
        setResolvedBatchNo(null);
        setTraceError('未找到该批次号，请核对后重试。');
        return;
      }
      setTraceError(null);
      setBatchId(batch.id);
      setResolvedBatchNo(batch.batchNo);
      setBatchNoInput(batch.batchNo);
    },
    onError: (error) => setTraceError(errorText(error, '批次追溯失败')),
  });

  useEffect(() => {
    setCursors([null]);
    setPageIndex(0);
  }, [companyId, batchId, sourceDocType, sourceDocId]);

  const rows = flows.data?.items ?? [];

  return (
    <PageShell
      title="库存流水"
      description="流水只追加；可按公司、批次和来源单据追溯每一次入库、出库与冲正。"
    >
      <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 md:grid-cols-2 xl:grid-cols-4">
        <label className="text-sm">
          <span className="text-slate-600">可见公司</span>
          <select
            value={companyId}
            onChange={(event) => {
              setCompanyId(event.target.value);
              setBatchId(undefined);
              setResolvedBatchNo(null);
              setBatchNoInput('');
            }}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
          >
            <option value="">全部可见公司</option>
            {(me.data?.companyIds ?? []).map((id) => (
              <option key={id} value={id}>
                {shortId(id)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="text-slate-600">批次号追溯</span>
          <span className="mt-1 flex gap-2">
            <input
              value={batchNoInput}
              onChange={(event) => {
                setBatchNoInput(event.target.value);
                if (resolvedBatchNo) {
                  setBatchId(undefined);
                  setResolvedBatchNo(null);
                }
              }}
              placeholder="如 PB-0001-20261110-0001"
              className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2"
            />
            <button
              type="button"
              disabled={!batchNoInput.trim() || resolveBatch.isPending}
              onClick={() => resolveBatch.mutate()}
              className="rounded-lg bg-slate-800 px-3 py-2 text-sm text-white disabled:opacity-40"
            >
              {resolveBatch.isPending ? '查找中…' : '追溯'}
            </button>
          </span>
        </label>
        <label className="text-sm">
          <span className="text-slate-600">来源单据类型</span>
          <select
            value={sourceDocType}
            onChange={(event) => setSourceDocType(event.target.value)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
          >
            <option value="">全部来源</option>
            {SOURCE_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="text-slate-600">来源单据号</span>
          <input
            value={sourceDocId}
            onChange={(event) => setSourceDocId(event.target.value)}
            placeholder="输入来源单据 ID"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        {resolvedBatchNo ? (
          <>
            <span className="rounded-full bg-sky-50 px-2 py-1 text-sky-700">
              当前批次：{resolvedBatchNo}
            </span>
            <button
              type="button"
              onClick={() => {
                setBatchId(undefined);
                setResolvedBatchNo(null);
                setBatchNoInput('');
              }}
              className="rounded border border-slate-300 px-2 py-1 hover:bg-white"
            >
              清除批次筛选
            </button>
          </>
        ) : (
          <span>未指定批次时显示全部可见流水。</span>
        )}
        {traceError && <span className="text-rose-600">{traceError}</span>}
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        {flows.isPending ? (
          <div className="space-y-2 p-5" aria-busy="true">
            {[0, 1, 2].map((item) => (
              <div key={item} className="h-9 animate-pulse rounded bg-slate-100" />
            ))}
            <p className="text-xs text-slate-400">库存流水加载中…</p>
          </div>
        ) : flows.isError ? (
          <div className="p-6 text-center">
            <p className="text-sm text-rose-600">{errorText(flows.error, '流水加载失败')}</p>
            <button
              type="button"
              onClick={() => void flows.refetch()}
              className="mt-3 rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              重试
            </button>
          </div>
        ) : rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">
            暂无库存流水。单据完成入库、出库或盘点审批后会在这里留痕。
          </p>
        ) : (
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3">发生时间</th>
                <th className="px-4 py-3">批次</th>
                <th className="px-4 py-3 text-right">变动量</th>
                <th className="px-4 py-3">来源单据</th>
                <th className="px-4 py-3">经手人</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((flow: InventoryFlow) => (
                <tr key={flow.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 text-slate-600">{formatDateTime(flow.occurredAt)}</td>
                  <td className="px-4 py-3 font-mono text-xs" title={flow.batchId}>
                    {flow.batchId === batchId && resolvedBatchNo
                      ? resolvedBatchNo
                      : shortId(flow.batchId)}
                  </td>
                  <td
                    className={`px-4 py-3 text-right font-medium ${
                      flow.delta.startsWith('-') ? 'text-rose-600' : 'text-emerald-700'
                    }`}
                  >
                    {flow.delta.startsWith('-') ? flow.delta : `+${flow.delta}`}
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs">
                      {flow.sourceDocType}
                    </span>
                    <span className="ml-2 font-mono text-xs text-slate-600">
                      {flow.sourceDocId}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">
                    {shortId(flow.handledBy)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination
        pageIndex={pageIndex}
        nextCursor={flows.data?.nextCursor ?? null}
        onPrevious={() => setPageIndex((index) => Math.max(0, index - 1))}
        onNext={(cursor) => {
          setCursors((items) => [...items.slice(0, pageIndex + 1), cursor]);
          setPageIndex((index) => index + 1);
        }}
      />
    </PageShell>
  );
}
