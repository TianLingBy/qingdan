import type {
  InventoryAlertItem,
  InventoryBatch,
  InventoryBatchDetail,
} from '@qingdan/contracts';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { describeListError } from '../../components/ListStates';
import { Icon } from '../../components/icons/Icon';
import { allows } from '../../lib/access';
import { formatQty } from '../../lib/decimal';
import { resolveListState } from '../../lib/list-state';
import { authApi, authKeys } from '../auth/auth-api';
import { BatchCostAdjustments } from './BatchCostAdjustments';
import {
  inventoryApi,
  inventoryQueryKeys,
  type InventoryBatchSort,
} from './inventory-api';
import { formatDateTime, shortId } from './inventory-ui';

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

function amountText(
  value: string | null | undefined,
  canViewPrice: boolean,
): string {
  if (!canViewPrice) return '—';
  return value ?? '—';
}

/** 库龄按批次 createdAt 到当前日期计算；契约没有单独的 ageDays 字段。 */
export function batchAgeDays(createdAt: string, now = new Date()): number {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return 0;
  return Math.max(
    0,
    Math.floor((now.getTime() - created.getTime()) / 86_400_000),
  );
}

function alertTitle(item: InventoryAlertItem): string {
  return `近 30 天日均出库 ${item.avgDailyOut}，按当前可用量约剩 ${item.daysLeft} 天（D104）`;
}

function currentFilterText(input: {
  readonly companyId: string;
  readonly keyword: string;
  readonly sort: InventoryBatchSort;
}): string {
  const parts = [
    input.companyId ? `公司 ${shortId(input.companyId)}` : '全部可见公司',
    input.keyword.trim() ? `关键字「${input.keyword.trim()}」` : '全部批次',
    input.sort === 'batchNo'
      ? '按批次号'
      : input.sort === 'availableQty'
        ? '按可用量'
        : '按入库时间',
  ];
  return `当前筛选：${parts.join(' · ')}`;
}

function Pager({
  page,
  total,
  pageSize,
  canPrevious,
  canNext,
  onPage,
  onPageSize,
}: {
  readonly page: number;
  readonly total: number;
  readonly pageSize: number;
  readonly canPrevious: boolean;
  readonly canNext: boolean;
  readonly onPage: (page: number) => void;
  readonly onPageSize: (pageSize: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager" aria-label="库存批次分页">
      <span className="count">共 {total} 个批次</span>
      <div className="nav">
        <button
          type="button"
          aria-label="首页"
          title="首页"
          disabled={!canPrevious}
          onClick={() => onPage(1)}
        >
          <Icon name="pg-first" />
        </button>
        <button
          type="button"
          aria-label="上一页"
          title="上一页"
          disabled={!canPrevious}
          onClick={() => onPage(Math.max(1, page - 1))}
        >
          <Icon name="pg-prev" />
        </button>
        <span className="of">
          {page} / {totalPages}
        </span>
        <button
          type="button"
          aria-label="下一页"
          title="下一页"
          disabled={!canNext}
          onClick={() => onPage(Math.min(totalPages, page + 1))}
        >
          <Icon name="pg-next" />
        </button>
        <button
          type="button"
          aria-label="末页"
          title="末页"
          disabled={!canNext}
          onClick={() => onPage(totalPages)}
        >
          <Icon name="pg-last" />
        </button>
        <select
          className="per"
          aria-label="每页条数"
          value={pageSize}
          onChange={(event) => onPageSize(Number(event.target.value))}
        >
          {PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size} 条 / 页
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function InventoryPage({
  initialBatchId = null,
}: {
  readonly initialBatchId?: string | null;
} = {}) {
  const [keyword, setKeyword] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(20);
  const [sort, setSort] = useState<InventoryBatchSort>('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(
    initialBatchId,
  );

  const me = useQuery({
    queryKey: authKeys.me,
    queryFn: authApi.me,
  });
  const canViewPrice = allows(me.data?.scope, 'inventory_qty', 'view_price');
  const canReadCostAdjustments = allows(
    me.data?.scope,
    'inventory_qty',
    'read',
  );
  const canUpdateCostAdjustments = allows(
    me.data?.scope,
    'inventory_qty',
    'update',
  );
  const canApproveCostAdjustments = allows(
    me.data?.scope,
    'inventory_qty',
    'approve',
  );

  const filters = {
    companyId: companyId || undefined,
    keyword: keyword.trim() || undefined,
    page,
    pageSize,
    sort,
    order,
  };
  const batches = useQuery({
    queryKey: inventoryQueryKeys.batches(filters),
    queryFn: () => inventoryApi.listBatches(filters),
  });
  const alertQueries = useQueries({
    queries: (me.data?.companyIds ?? []).map((id) => ({
      queryKey: inventoryQueryKeys.alerts(id),
      queryFn: () => inventoryApi.listAlerts(id),
    })),
  });
  const detail = useQuery({
    queryKey: inventoryQueryKeys.batch(selectedBatchId),
    queryFn: () => inventoryApi.getBatch(selectedBatchId!),
    enabled: selectedBatchId !== null,
  });

  useEffect(() => {
    setPage(1);
    setSelectedBatchId(null);
  }, [keyword, companyId, sort, order, pageSize]);

  const rows = batches.data?.items ?? [];
  const total = batches.data?.total ?? rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const state = resolveListState({
    isPending: batches.isPending,
    hasError: batches.isError,
    isEmpty: rows.length === 0,
  });
  const alertsByBatch = new Map(
    alertQueries
      .flatMap((query) => query.data?.items ?? [])
      .map((item) => [item.batchId, item]),
  );
  const detailState = resolveListState({
    isPending: detail.isPending,
    hasError: detail.isError,
    isEmpty: detail.data === undefined,
  });

  return (
    <section className="page-stack">
      <header className="p-head">
        <div>
          <div className="eyebrow">库存 · 批次</div>
          <h1>库存数量</h1>
          <p className="sub">
            按批次核对入库、引用、在途、占用与可用量。可用量 = 入库 − 已引用 −
            在途 − 占用，是唯一可引用数字（D38）。
          </p>
        </div>
        <div className="page-chips">
          <span className="chip icon-chip">
            <Icon name="shield" size={14} /> 真实接口
          </span>
          <span className="st ok">D38 口径</span>
        </div>
      </header>

      <div className="toolbar">
        <label>
          <span className="sr-only">可见公司</span>
          <select
            value={companyId}
            onChange={(event) => setCompanyId(event.target.value)}
            className="search"
          >
            <option value="">全部可见公司</option>
            {(me.data?.companyIds ?? []).map((id) => (
              <option key={id} value={id}>
                {shortId(id)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">批次号或商品名</span>
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索批次号或商品名"
            className="search"
          />
        </label>
        <label>
          <span className="sr-only">排序字段</span>
          <select
            value={sort}
            onChange={(event) =>
              setSort(event.target.value as InventoryBatchSort)
            }
            className="search"
          >
            <option value="createdAt">按入库时间</option>
            <option value="batchNo">按批次号</option>
            <option value="availableQty">按可用量</option>
          </select>
        </label>
        <button
          type="button"
          className="btn"
          onClick={() =>
            setOrder((current) => (current === 'desc' ? 'asc' : 'desc'))
          }
        >
          <Icon name={order === 'desc' ? 'arrow-out' : 'arrow-in'} size={14} />
          {order === 'desc' ? '倒序' : '正序'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setKeyword('');
            setCompanyId('');
            setSort('createdAt');
            setOrder('desc');
          }}
        >
          <Icon name="refresh" size={14} />
          重置
        </button>
      </div>

      <div
        className="card list-card"
        data-state={state}
        aria-busy={state === 'loading'}
      >
        <div className="tw">
          <table className="data-table wide-inventory">
            <thead>
              <tr>
                <th>批次号</th>
                <th>商品</th>
                <th>保管人</th>
                <th className="cell-right">入库</th>
                <th className="cell-right">已引用</th>
                <th className="cell-right">在途</th>
                <th className="cell-right">占用</th>
                <th className="cell-right">可用</th>
                <th>库龄</th>
                <th>低库存预警</th>
                <th className="cell-right">锁定单价</th>
                <th className="cell-right">操作</th>
              </tr>
            </thead>
            <tbody data-state={state}>
              {rows.map((batch: InventoryBatch) => {
                const alert = alertsByBatch.get(batch.id);
                const age = batchAgeDays(batch.createdAt);
                return (
                  <tr key={batch.id} className="r-row">
                    <td className="mono">
                      <b>{batch.batchNo}</b>
                    </td>
                    <td>
                      <span className="mono" title={batch.productId}>
                        {shortId(batch.productId)}
                      </span>
                    </td>
                    <td>
                      <span className="mono" title={batch.custodianId}>
                        {shortId(batch.custodianId)}
                      </span>
                    </td>
                    <td className="num cell-right">
                      {formatQty(batch.inboundQty)}
                    </td>
                    <td className="num cell-right">
                      {formatQty(batch.referencedQty)}
                    </td>
                    <td className="num cell-right">
                      {formatQty(batch.inTransitQty)}
                    </td>
                    <td className="num cell-right">
                      {formatQty(batch.pendingExecutionQty)}
                    </td>
                    <td className="num cell-right">
                      <b>{formatQty(batch.availableQty)}</b>
                    </td>
                    <td>
                      <span className={`age ${age >= 45 ? 'is-old' : ''}`}>
                        <Icon name="clock" size={14} />
                        {age} 天
                      </span>
                    </td>
                    <td>
                      {alert ? (
                        <span className="st warn" title={alertTitle(alert)}>
                          低于安全库存
                        </span>
                      ) : me.data?.companyIds.length ? (
                        <span className="st ok">充足</span>
                      ) : (
                        <span className="cell-muted">—</span>
                      )}
                    </td>
                    <td
                      className="num cell-right"
                      title={
                        canViewPrice
                          ? '批次锁定单价'
                          : '需要 inventory_qty.view_price 权限'
                      }
                    >
                      {amountText(batch.lockedUnitCost, canViewPrice)}
                    </td>
                    <td className="cell-right">
                      <button
                        type="button"
                        onClick={() => setSelectedBatchId(batch.id)}
                        className="btn"
                      >
                        查看
                      </button>
                    </td>
                  </tr>
                );
              })}
              <tr className="st-tr st-empty">
                <td colSpan={12}>
                  <div className="st-box">
                    <div className="st-ico">
                      <Icon name="filter" />
                    </div>
                    <div className="st-title">没有符合条件的库存批次</div>
                    <p className="st-desc">
                      可清空筛选，或等待采购到货确认 / 加工产出生成批次。
                    </p>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setKeyword('');
                        setCompanyId('');
                      }}
                    >
                      清空筛选
                    </button>
                  </div>
                </td>
              </tr>
              <tr className="st-tr st-loading">
                <td colSpan={12}>
                  <div className="st-box" aria-label="库存批次加载中">
                    <div className="sk sk-line w80" />
                    <div className="sk sk-line w60" />
                    <div className="sk sk-line w40" />
                    <p className="st-desc st-desc-next">库存批次加载中…</p>
                  </div>
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={12}>
                  <div className="st-box st-error">
                    <div className="st-ico">
                      <Icon name="refresh" />
                    </div>
                    <div className="st-title">库存批次加载失败</div>
                    <p className="st-desc">
                      {describeListError('库存批次加载失败', batches.error)}
                    </p>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void batches.refetch()}
                    >
                      重试
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <footer className="tf">
          <span>{currentFilterText({ companyId, keyword, sort })}</span>
          <Pager
            page={page}
            total={total}
            pageSize={pageSize}
            canPrevious={page > 1}
            canNext={page < totalPages}
            onPage={setPage}
            onPageSize={setPageSize}
          />
        </footer>
      </div>

      {selectedBatchId ? (
        <section className="card detail-card" data-state={detailState}>
          <div className="st-block st-filled">
            {detail.data ? (
              <BatchDetail
                detail={detail.data}
                canViewPrice={canViewPrice}
                canReadCostAdjustments={canReadCostAdjustments}
                canUpdateCostAdjustments={canUpdateCostAdjustments}
                canApproveCostAdjustments={canApproveCostAdjustments}
                onClose={() => setSelectedBatchId(null)}
              />
            ) : null}
          </div>
          <div className="st-block st-empty">
            <div className="st-box">
              <div className="st-title">批次详情不存在</div>
              <p className="st-desc">该批次可能已被调整，请刷新列表后重试。</p>
              <button
                type="button"
                className="btn"
                onClick={() => setSelectedBatchId(null)}
              >
                关闭
              </button>
            </div>
          </div>
          <div className="st-block st-loading">
            <div className="st-box" aria-label="批次详情加载中">
              <div className="sk sk-line w80" />
              <div className="sk sk-line w60" />
              <div className="sk sk-line w40" />
              <p className="st-desc st-desc-next">批次详情加载中…</p>
            </div>
          </div>
          <div className="st-block st-error">
            <div className="st-box st-error">
              <div className="st-title">批次详情加载失败</div>
              <p className="st-desc">
                {describeListError('批次详情加载失败', detail.error)}
              </p>
              <button
                type="button"
                className="btn"
                onClick={() => void detail.refetch()}
              >
                重试
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </section>
  );
}

function BatchDetail({
  detail,
  canViewPrice,
  canReadCostAdjustments,
  canUpdateCostAdjustments,
  canApproveCostAdjustments,
  onClose,
}: {
  readonly detail: InventoryBatchDetail;
  readonly canViewPrice: boolean;
  readonly canReadCostAdjustments: boolean;
  readonly canUpdateCostAdjustments: boolean;
  readonly canApproveCostAdjustments: boolean;
  readonly onClose: () => void;
}) {
  return (
    <>
      <div className="detail-head">
        <div>
          <div className="eyebrow">批次详情</div>
          <h2 className="mono">{detail.batchNo}</h2>
        </div>
        <button type="button" onClick={onClose} className="btn">
          关闭
        </button>
      </div>
      <div className="detail-grid">
        <div className="detail-item">
          <div className="detail-label">商品</div>
          <div className="detail-value detail-value-strong">
            {detail.productName}
          </div>
          <div className="detail-value detail-value-mono detail-value-muted">
            {detail.productNo ?? shortId(detail.productId)}
          </div>
        </div>
        <div className="detail-item">
          <div className="detail-label">保管人</div>
          <div
            className="detail-value detail-value-mono"
            title={detail.custodianId}
          >
            {shortId(detail.custodianId)}
          </div>
        </div>
        <div className="detail-item">
          <div className="detail-label">锁定单价</div>
          <div
            className="detail-value num"
            title={
              canViewPrice ? undefined : '需要 inventory_qty.view_price 权限'
            }
          >
            {amountText(detail.lockedUnitCost, canViewPrice)}
          </div>
        </div>
        <div className="detail-item">
          <div className="detail-label">更新时间</div>
          <div className="detail-value">{formatDateTime(detail.updatedAt)}</div>
        </div>
        <div className="detail-item detail-span-all">
          <div className="detail-label">待执行占用来源</div>
          {detail.pendingOccupancies.length === 0 ? (
            <p className="detail-value detail-value-muted">无待执行占用。</p>
          ) : (
            <ul className="detail-list">
              {detail.pendingOccupancies.map((item) => (
                <li key={`${item.sourceDocType}-${item.sourceDocId}`}>
                  <span className="mono">{item.sourceDocType}</span> ·{' '}
                  <span className="mono">{item.sourceDocId}</span> · {item.qty}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <div className="detail-section">
        <BatchCostAdjustments
          batchId={detail.id}
          canRead={canReadCostAdjustments}
          canUpdate={canUpdateCostAdjustments}
          canApprove={canApproveCostAdjustments}
          canViewPrice={canViewPrice}
        />
      </div>
    </>
  );
}
