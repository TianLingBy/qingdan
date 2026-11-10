import type {
  InventoryBatch,
  Stocktake,
  StocktakeStatus,
} from '@qingdan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { fetchMe, type MeResult } from '../../api/platform';
import {
  compareDecimalStrings,
  inventoryApi,
  inventoryQueryKeys,
  type StocktakeDirection,
} from './inventory-api';
import {
  allows,
  errorText,
  formatDateTime,
  PageShell,
  Pagination,
  shortId,
} from './inventory-ui';

interface CreateFormState {
  batchId: string;
  companyId: string;
  bookQty: string;
  actualQty: string;
  remark: string;
}

const EMPTY_FORM: CreateFormState = {
  batchId: '',
  companyId: '',
  bookQty: '',
  actualQty: '',
  remark: '',
};

const DECIMAL_RE = /^\d{1,12}(\.\d{1,6})?$/;
const STATUSES: readonly StocktakeStatus[] = ['待审批', '已批准', '已驳回'];

function statusClass(status: StocktakeStatus): string {
  if (status === '已批准') return 'bg-emerald-50 text-emerald-700';
  if (status === '已驳回') return 'bg-rose-50 text-rose-700';
  return 'bg-amber-50 text-amber-700';
}

function directionOf(bookQty: string, actualQty: string): StocktakeDirection | null {
  if (!DECIMAL_RE.test(bookQty) || !DECIMAL_RE.test(actualQty)) return null;
  const compared = compareDecimalStrings(actualQty, bookQty);
  if (compared > 0) return 'increase';
  if (compared < 0) return 'decrease';
  return null;
}

function ApprovalPanel({
  stocktake,
  me,
  onClose,
}: {
  stocktake: Stocktake;
  me: MeResult | undefined;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: inventoryQueryKeys.stocktake(stocktake.id),
    queryFn: () => inventoryApi.getStocktake(stocktake.id),
  });
  const approve = useMutation({
    mutationFn: () => inventoryApi.approveStocktake(stocktake.id, detail.data!.version),
    onSuccess: async () => {
      setError(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['inventory', 'stocktakes'] }),
        queryClient.invalidateQueries({ queryKey: ['inventory', 'batches'] }),
      ]);
      onClose();
    },
    onError: (mutationError) => setError(errorText(mutationError, '审批失败')),
  });
  const canApprove = allows(me, 'stocktake', 'approve');

  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50/60 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">审批盘点单 {stocktake.stocktakeNo}</h2>
          <p className="mt-1 text-xs text-amber-800">
            审批会按差异追加库存流水，不会物理删除任何库存记录。
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-sm text-slate-500 hover:text-slate-900">
          关闭
        </button>
      </div>
      {detail.isPending ? (
        <p className="mt-4 text-sm text-slate-500">盘点详情加载中…</p>
      ) : detail.isError ? (
        <p className="mt-4 text-sm text-rose-600">{errorText(detail.error, '详情加载失败')}</p>
      ) : detail.data ? (
        <div className="mt-4 space-y-4">
          <div className="grid gap-3 text-sm sm:grid-cols-3">
            <div>
              <div className="text-xs text-slate-400">账面量</div>
              <div className="mt-1 font-medium">{detail.data.bookQty}</div>
            </div>
            <div>
              <div className="text-xs text-slate-400">实盘量</div>
              <div className="mt-1 font-medium">{detail.data.actualQty}</div>
            </div>
            <div>
              <div className="text-xs text-slate-400">差异量</div>
              <div
                className={`mt-1 font-medium ${
                  detail.data.diffQty.startsWith('-') ? 'text-rose-700' : 'text-emerald-700'
                }`}
              >
                {detail.data.diffQty}
              </div>
            </div>
          </div>
          {detail.data.approvable.allowed && canApprove ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                  className="size-4 rounded border-slate-300"
                />
                我已现场复核实物数量
              </label>
              <button
                type="button"
                disabled={!confirmed || approve.isPending}
                onClick={() => approve.mutate()}
                className="rounded-lg bg-amber-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
              >
                {approve.isPending ? '审批中…' : '确认审批'}
              </button>
            </div>
          ) : (
            <p className="text-sm text-slate-600">
              {!canApprove
                ? '当前账号没有 stocktake.approve 权限。'
                : detail.data.approvable.reason === 'already_approved'
                  ? '该盘点单已批准，不能重复审批。'
                  : '该盘点单已驳回，不能重复审批。'}
            </p>
          )}
          {error && <p className="text-sm text-rose-700">{error}</p>}
        </div>
      ) : null}
    </section>
  );
}

export function StocktakesPage() {
  const queryClient = useQueryClient();
  const [companyId, setCompanyId] = useState('');
  const [status, setStatus] = useState<'' | StocktakeStatus>('');
  const [keyword, setKeyword] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [form, setForm] = useState<CreateFormState>(EMPTY_FORM);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [approving, setApproving] = useState<Stocktake | null>(null);

  const me = useQuery({ queryKey: inventoryQueryKeys.me, queryFn: fetchMe });
  const batchOptions = useQuery({
    queryKey: inventoryQueryKeys.batches({ limit: 200 }),
    queryFn: () => inventoryApi.listBatches({ limit: 200 }),
  });
  const filters = {
    companyId: companyId || undefined,
    status: status || undefined,
    keyword: keyword.trim() || undefined,
    cursor: cursors[pageIndex] ?? null,
  };
  const stocktakes = useQuery({
    queryKey: inventoryQueryKeys.stocktakes(filters),
    queryFn: () => inventoryApi.listStocktakes(filters),
  });
  const create = useMutation({
    mutationFn: async () => {
      const direction = directionOf(form.bookQty, form.actualQty);
      if (!form.companyId || !form.batchId || !direction) {
        throw new Error('请选择批次，并填写有差异的账面量和实盘量');
      }
      return inventoryApi.createStocktake(direction, {
        companyId: form.companyId,
        batchId: form.batchId,
        bookQty: form.bookQty,
        actualQty: form.actualQty,
        remark: form.remark.trim() || null,
      });
    },
    onSuccess: async (created) => {
      setNotice(`已创建盘点单 ${created.stocktakeNo}，等待审批。`);
      setFormError(null);
      setForm((current) => ({ ...current, actualQty: '', remark: '' }));
      await queryClient.invalidateQueries({ queryKey: ['inventory', 'stocktakes'] });
    },
    onError: (error) => setFormError(errorText(error, '创建盘点单失败')),
  });

  useEffect(() => {
    setCursors([null]);
    setPageIndex(0);
  }, [companyId, status, keyword]);

  const batches = batchOptions.data?.items ?? [];
  const selectedBatch = batches.find((batch) => batch.id === form.batchId) ?? null;
  const direction = directionOf(form.bookQty, form.actualQty);
  const canCreateIncrease = allows(me.data, 'stocktake', 'create');
  const canCreateDecrease = allows(me.data, 'stocktake', 'delete');
  const canCreate = direction === 'increase' ? canCreateIncrease : direction === 'decrease' ? canCreateDecrease : false;
  const rows = stocktakes.data?.items ?? [];

  const selectBatch = (batch: InventoryBatch | null) => {
    setForm((current) => ({
      ...current,
      batchId: batch?.id ?? '',
      companyId: batch?.companyId ?? '',
      bookQty: batch?.availableQty ?? '',
      actualQty: '',
    }));
    setFormError(null);
  };

  return (
    <PageShell
      title="盘点"
      description="盘盈与盘亏分开授权；提交后进入审批，审批通过再追加冲正流水。"
    >
      <form
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (direction === null) {
            setFormError('实盘量与账面量必须不同，且都应为非负 decimal。');
            return;
          }
          if (!canCreate) {
            setFormError(
              direction === 'increase'
                ? '当前账号缺少 stocktake.create 权限。'
                : '当前账号缺少 stocktake.delete 权限。',
            );
            return;
          }
          create.mutate();
        }}
        className="rounded-xl border border-slate-200 bg-white p-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">发起盘点差异</h2>
          {direction && (
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${
                direction === 'increase'
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-rose-50 text-rose-700'
              }`}
            >
              {direction === 'increase' ? '盘盈' : '盘亏'}
            </span>
          )}
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          <label className="text-sm xl:col-span-2">
            <span className="text-slate-600">盘点批次</span>
            <select
              value={form.batchId}
              onChange={(event) =>
                selectBatch(batches.find((batch) => batch.id === event.target.value) ?? null)
              }
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
            >
              <option value="">选择批次</option>
              {batches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.batchNo} · 可用 {batch.availableQty}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="text-slate-600">账面量</span>
            <input
              required
              inputMode="decimal"
              value={form.bookQty}
              onChange={(event) =>
                setForm((current) => ({ ...current, bookQty: event.target.value }))
              }
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="text-slate-600">实盘量</span>
            <input
              required
              inputMode="decimal"
              value={form.actualQty}
              onChange={(event) =>
                setForm((current) => ({ ...current, actualQty: event.target.value }))
              }
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
          <label className="text-sm">
            <span className="text-slate-600">备注</span>
            <input
              value={form.remark}
              onChange={(event) =>
                setForm((current) => ({ ...current, remark: event.target.value }))
              }
              placeholder="可选"
              className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
            />
          </label>
        </div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-400">
            {selectedBatch
              ? `批次 ${selectedBatch.batchNo}；公司 ${shortId(selectedBatch.companyId)}`
              : batchOptions.isPending
                ? '正在加载可盘点批次…'
                : '没有可盘点批次时，请先完成入库单据。'}
          </p>
          <button
            type="submit"
            disabled={!form.batchId || !direction || !canCreate || create.isPending}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
          >
            {create.isPending ? '提交中…' : '提交盘点差异'}
          </button>
        </div>
        {formError && <p className="mt-3 text-sm text-rose-700">{formError}</p>}
      </form>

      {notice && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}
      {approving && (
        <ApprovalPanel stocktake={approving} me={me.data} onClose={() => setApproving(null)} />
      )}

      <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-3">
        <label className="text-sm">
          <span className="text-slate-600">可见公司</span>
          <select
            value={companyId}
            onChange={(event) => setCompanyId(event.target.value)}
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
          <span className="text-slate-600">状态</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as '' | StocktakeStatus)}
            className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2"
          >
            <option value="">全部状态</option>
            {STATUSES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="text-slate-600">盘点单号</span>
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="输入盘点单号"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        {stocktakes.isPending ? (
          <div className="space-y-2 p-5" aria-busy="true">
            {[0, 1, 2].map((item) => (
              <div key={item} className="h-9 animate-pulse rounded bg-slate-100" />
            ))}
            <p className="text-xs text-slate-400">盘点单加载中…</p>
          </div>
        ) : stocktakes.isError ? (
          <div className="p-6 text-center">
            <p className="text-sm text-rose-600">
              {errorText(stocktakes.error, '盘点单加载失败')}
            </p>
            <button
              type="button"
              onClick={() => void stocktakes.refetch()}
              className="mt-3 rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              重试
            </button>
          </div>
        ) : rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">
            暂无盘点单。发现实物与账面差异时，可在上方发起盘盈或盘亏。
          </p>
        ) : (
          <table className="w-full min-w-[1040px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3">盘点单号</th>
                <th className="px-4 py-3">批次</th>
                <th className="px-4 py-3 text-right">账面量</th>
                <th className="px-4 py-3 text-right">实盘量</th>
                <th className="px-4 py-3 text-right">差异量</th>
                <th className="px-4 py-3">状态</th>
                <th className="px-4 py-3">更新时间</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item: Stocktake) => (
                <tr key={item.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 font-mono text-xs">{item.stocktakeNo}</td>
                  <td className="px-4 py-3 font-mono text-xs" title={item.batchId}>
                    {batches.find((batch) => batch.id === item.batchId)?.batchNo ??
                      shortId(item.batchId)}
                  </td>
                  <td className="px-4 py-3 text-right">{item.bookQty}</td>
                  <td className="px-4 py-3 text-right">{item.actualQty}</td>
                  <td
                    className={`px-4 py-3 text-right font-medium ${
                      item.diffQty.startsWith('-') ? 'text-rose-600' : 'text-emerald-700'
                    }`}
                  >
                    {item.diffQty}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${statusClass(item.status)}`}>
                      {item.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{formatDateTime(item.updatedAt)}</td>
                  <td className="px-4 py-3 text-right">
                    {item.status === '待审批' && allows(me.data, 'stocktake', 'approve') ? (
                      <button
                        type="button"
                        onClick={() => setApproving(item)}
                        className="rounded border border-amber-300 px-2.5 py-1 text-xs text-amber-800 hover:bg-amber-50"
                      >
                        审批
                      </button>
                    ) : (
                      <span className="text-xs text-slate-400">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination
        pageIndex={pageIndex}
        nextCursor={stocktakes.data?.nextCursor ?? null}
        onPrevious={() => setPageIndex((index) => Math.max(0, index - 1))}
        onNext={(cursor) => {
          setCursors((items) => [...items.slice(0, pageIndex + 1), cursor]);
          setPageIndex((index) => index + 1);
        }}
      />
    </PageShell>
  );
}
