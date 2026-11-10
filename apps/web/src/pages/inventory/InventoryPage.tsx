import type { InventoryBatch } from '@qingdan/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { fetchMe } from '../../api/platform';
import { inventoryApi, inventoryQueryKeys } from './inventory-api';
import {
  allows,
  errorText,
  formatDateTime,
  formatQuantity,
  PageShell,
  Pagination,
  shortId,
} from './inventory-ui';

function amountText(
  value: string | null | undefined,
  canViewPrice: boolean,
): string {
  if (!canViewPrice) return '无看价权限';
  return value ?? '—';
}

export function InventoryPage() {
  const [keyword, setKeyword] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);

  const me = useQuery({
    queryKey: inventoryQueryKeys.me,
    queryFn: fetchMe,
  });
  const canViewPrice = allows(me.data, 'inventory_qty', 'view_price');
  const filters = {
    companyId: companyId || undefined,
    keyword: keyword.trim() || undefined,
    cursor: cursors[pageIndex] ?? null,
  };
  const batches = useQuery({
    queryKey: inventoryQueryKeys.batches(filters),
    queryFn: () => inventoryApi.listBatches(filters),
  });
  const detail = useQuery({
    queryKey: inventoryQueryKeys.batch(selectedBatchId),
    queryFn: () => inventoryApi.getBatch(selectedBatchId!),
    enabled: selectedBatchId !== null,
  });

  useEffect(() => {
    setCursors([null]);
    setPageIndex(0);
    setSelectedBatchId(null);
  }, [keyword, companyId]);

  const rows = batches.data?.items ?? [];

  return (
    <PageShell
      title="库存数量"
      description="按批次核对入库、引用、在途、待执行和可用数量；金额由服务端权限控制。"
    >
      <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2">
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
          <span className="text-slate-600">批次号 / 商品名</span>
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="输入批次号或商品名"
            className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2"
          />
        </label>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        {batches.isPending ? (
          <div className="space-y-2 p-5" aria-busy="true">
            {[0, 1, 2].map((item) => (
              <div key={item} className="h-9 animate-pulse rounded bg-slate-100" />
            ))}
            <p className="text-xs text-slate-400">库存批次加载中…</p>
          </div>
        ) : batches.isError ? (
          <div className="p-6 text-center">
            <p className="text-sm text-rose-600">{errorText(batches.error, '库存加载失败')}</p>
            <button
              type="button"
              onClick={() => void batches.refetch()}
              className="mt-3 rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
            >
              重试
            </button>
          </div>
        ) : rows.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">
            没有符合条件的库存批次。可清空筛选或等待单据完成入库。
          </p>
        ) : (
          <table className="w-full min-w-[1020px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-4 py-3">批次号</th>
                <th className="px-4 py-3">商品</th>
                <th className="px-4 py-3 text-right">入库量</th>
                <th className="px-4 py-3 text-right">已引用</th>
                <th className="px-4 py-3 text-right">在途</th>
                <th className="px-4 py-3 text-right">待执行</th>
                <th className="px-4 py-3 text-right">可用量</th>
                <th className="px-4 py-3 text-right">锁定单价</th>
                <th className="px-4 py-3 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((batch: InventoryBatch) => (
                <tr key={batch.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-3 font-mono text-xs">{batch.batchNo}</td>
                  <td className="px-4 py-3 font-mono text-xs text-slate-500">
                    {shortId(batch.productId)}
                  </td>
                  <td className="px-4 py-3 text-right">{formatQuantity(batch.inboundQty)}</td>
                  <td className="px-4 py-3 text-right">{formatQuantity(batch.referencedQty)}</td>
                  <td className="px-4 py-3 text-right">{formatQuantity(batch.inTransitQty)}</td>
                  <td className="px-4 py-3 text-right">
                    {formatQuantity(batch.pendingExecutionQty)}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-emerald-700">
                    {formatQuantity(batch.availableQty)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {amountText(
                      batch.lockedUnitCost as string | null | undefined,
                      canViewPrice,
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setSelectedBatchId(batch.id)}
                      className="rounded border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50"
                    >
                      查看
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Pagination
        pageIndex={pageIndex}
        nextCursor={batches.data?.nextCursor ?? null}
        onPrevious={() => setPageIndex((index) => Math.max(0, index - 1))}
        onNext={(cursor) => {
          setCursors((items) => [...items.slice(0, pageIndex + 1), cursor]);
          setPageIndex((index) => index + 1);
        }}
      />

      {selectedBatchId && (
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">批次详情</h2>
            <button
              type="button"
              onClick={() => setSelectedBatchId(null)}
              className="text-sm text-slate-500 hover:text-slate-900"
            >
              关闭
            </button>
          </div>
          {detail.isPending ? (
            <p className="mt-4 text-sm text-slate-500">详情加载中…</p>
          ) : detail.isError ? (
            <p className="mt-4 text-sm text-rose-600">{errorText(detail.error, '详情加载失败')}</p>
          ) : detail.data ? (
            <div className="mt-4 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <div className="text-xs text-slate-400">商品</div>
                <div className="mt-1 font-medium">{detail.data.productName}</div>
                <div className="text-xs text-slate-500">{detail.data.productNo ?? '无商品编号'}</div>
              </div>
              <div>
                <div className="text-xs text-slate-400">保管人</div>
                <div className="mt-1 font-mono text-xs">{detail.data.custodianId}</div>
              </div>
              <div>
                <div className="text-xs text-slate-400">锁定单价</div>
                <div className="mt-1">
                  {amountText(
                    detail.data.lockedUnitCost as string | null | undefined,
                    canViewPrice,
                  )}
                </div>
              </div>
              <div>
                <div className="text-xs text-slate-400">更新时间</div>
                <div className="mt-1">{formatDateTime(detail.data.updatedAt)}</div>
              </div>
              <div className="sm:col-span-2 lg:col-span-4">
                <div className="text-xs text-slate-400">待执行占用来源</div>
                {detail.data.pendingOccupancies.length === 0 ? (
                  <p className="mt-1 text-slate-500">无待执行占用。</p>
                ) : (
                  <ul className="mt-2 space-y-1">
                    {detail.data.pendingOccupancies.map((item) => (
                      <li key={`${item.sourceDocType}-${item.sourceDocId}`}>
                        {item.sourceDocType} · {item.sourceDocId} · {item.qty}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
        </section>
      )}
    </PageShell>
  );
}
