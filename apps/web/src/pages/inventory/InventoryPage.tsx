import type {
  InventoryAlertItem,
  InventoryBatch,
  InventoryBatchDetail,
} from '@qingdan/contracts';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { describeListError } from '../../components/ListStates';
import { Icon } from '../../components/icons/Icon';
import { allows } from '../../lib/access';
import { formatQty } from '../../lib/decimal';
import { useEmployeeLabel } from '../../lib/employee-directory';
import { resolveListState } from '../../lib/list-state';
import { authApi, authKeys } from '../auth/auth-api';
import { masterdataApi } from '../masterdata/masterdata-api';
import { BatchCostAdjustments } from './BatchCostAdjustments';
import {
  inventoryApi,
  inventoryQueryKeys,
  type InventoryBatchSort,
} from './inventory-api';
import { formatDateTime, shortId } from './inventory-ui';

const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;
type InventoryQuickFilter = 'all' | 'low' | 'transit' | 'hold';

const QUICK_FILTERS: readonly {
  readonly key: InventoryQuickFilter;
  readonly label: string;
  readonly icon: 'filter' | null;
}[] = [
  { key: 'all', label: '全部', icon: null },
  { key: 'low', label: '低库存预警', icon: 'filter' },
  { key: 'transit', label: '有在途', icon: null },
  { key: 'hold', label: '有占用', icon: null },
];

const PRODUCT_DIRECTORY_KEY = [
  'masterdata',
  'products',
  { limit: 200 },
] as const;

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

/** 公司 UUIDv7 前缀相同，仓库列取尾部才有区分度；完整 id 保留在 title。 */
function companyShortId(id: string): string {
  return id.length > 6 ? `…${id.slice(-6)}` : id;
}

export function quickFilterMatches(
  batch: InventoryBatch,
  filter: InventoryQuickFilter,
  alertBatchIds: ReadonlySet<string>,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'low') return alertBatchIds.has(batch.id);
  if (filter === 'transit') return Number(batch.inTransitQty) > 0;
  return Number(batch.pendingExecutionQty) > 0;
}

function saveBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(href);
}

function SortHeader({
  label,
  field,
  sort,
  order,
  numeric = false,
  onSort,
}: {
  readonly label: string;
  readonly field: InventoryBatchSort;
  readonly sort: InventoryBatchSort;
  readonly order: 'asc' | 'desc';
  readonly numeric?: boolean;
  readonly onSort: (field: InventoryBatchSort) => void;
}) {
  const active = sort === field;
  return (
    <th
      className={numeric ? 'inv-num' : undefined}
      aria-sort={
        active ? (order === 'asc' ? 'ascending' : 'descending') : 'none'
      }
    >
      <button
        type="button"
        className="inv-sort"
        onClick={() => onSort(field)}
        title={`按${label}排序`}
      >
        {label}
        <i aria-hidden="true">
          {active ? (order === 'asc' ? '↑' : '↓') : '↕'}
        </i>
      </button>
    </th>
  );
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

function Composition({ batch }: { readonly batch: InventoryBatch }) {
  const total = Number(batch.inboundQty);
  const segments = [
    {
      key: 'referenced',
      className: 'inv-composition-ref',
      value: Number(batch.referencedQty),
    },
    {
      key: 'transit',
      className: 'inv-composition-transit',
      value: Number(batch.inTransitQty),
    },
    {
      key: 'hold',
      className: 'inv-composition-hold',
      value: Number(batch.pendingExecutionQty),
    },
    {
      key: 'available',
      className: 'inv-composition-available',
      value: Number(batch.availableQty),
    },
  ].filter((segment) => Number.isFinite(segment.value) && segment.value > 0);

  if (!(total > 0) || segments.length === 0) {
    return <span className="cell-muted">—</span>;
  }

  let start = 0;
  return (
    <div
      className="inv-composition"
      title={`已引用 ${formatQty(batch.referencedQty)} · 在途 ${formatQty(batch.inTransitQty)} · 占用 ${formatQty(batch.pendingExecutionQty)} · 可用 ${formatQty(batch.availableQty)}`}
    >
      <svg
        className="inv-composition-track"
        viewBox="0 0 1000 6"
        preserveAspectRatio="none"
        role="img"
        aria-label="库存构成：已引用、在途、占用、可用"
      >
        {segments.map((segment) => {
          const width = (segment.value / total) * 1000;
          const x = start;
          start += width;
          return (
            <rect
              key={segment.key}
              className={segment.className}
              x={x}
              y={0}
              width={width}
              height={6}
            />
          );
        })}
      </svg>
    </div>
  );
}

export function InventoryPage() {
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(20);
  const [sort, setSort] = useState<InventoryBatchSort>('createdAt');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [filter, setFilter] = useState<InventoryQuickFilter>('all');
  const [expandedBatchId, setExpandedBatchId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const employeeLabel = useEmployeeLabel();

  const me = useQuery({
    queryKey: authKeys.me,
    queryFn: authApi.me,
  });
  const products = useQuery({
    queryKey: PRODUCT_DIRECTORY_KEY,
    queryFn: () => masterdataApi.listProducts({ limit: 200 }),
    retry: false,
  });
  const canViewPrice = allows(me.data?.scope, 'inventory_qty', 'view_price');
  const canExport = allows(me.data?.scope, 'inventory_qty', 'export');
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
    queryKey: inventoryQueryKeys.batch(expandedBatchId),
    queryFn: () => inventoryApi.getBatch(expandedBatchId!),
    enabled: expandedBatchId !== null,
  });

  useEffect(() => {
    setPage(1);
    setExpandedBatchId(null);
    setFilter('all');
  }, [keyword, sort, order, pageSize]);

  const allRows = batches.data?.items ?? [];
  const alerts = alertQueries.flatMap((query) => query.data?.items ?? []);
  const alertBatchIds = useMemo(
    () => new Set(alerts.map((item) => item.batchId)),
    [alerts],
  );
  const rows = allRows.filter((batch) =>
    quickFilterMatches(batch, filter, alertBatchIds),
  );
  const total = batches.data?.total ?? allRows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const listState = resolveListState({
    isPending: batches.isPending,
    hasError: batches.isError,
    isEmpty: allRows.length === 0,
  });
  const displayState =
    listState === 'filled' && rows.length === 0 ? 'empty' : listState;
  const alertsByBatch = new Map(alerts.map((item) => [item.batchId, item]));
  const productNames = new Map(
    (products.data?.items ?? []).map((product) => [product.id, product.name]),
  );
  const detailState = resolveListState({
    isPending: detail.isPending,
    hasError: detail.isError,
    isEmpty: detail.data === undefined,
  });

  const quickFilterCount = (nextFilter: InventoryQuickFilter): number => {
    if (nextFilter === 'all') {
      return filter === 'all' ? rows.length : allRows.length;
    }
    return allRows.filter((batch) =>
      quickFilterMatches(batch, nextFilter, alertBatchIds),
    ).length;
  };

  const toggleSort = (field: InventoryBatchSort) => {
    setSort(field);
    setOrder((current) =>
      sort === field && current === 'desc' ? 'asc' : 'desc',
    );
  };

  const exportCsv = async () => {
    setExportError(null);
    try {
      const file = await inventoryApi.exportBatches({
        keyword: keyword.trim() || undefined,
      });
      saveBlob(file.blob, file.filename);
    } catch (error) {
      setExportError(
        error instanceof Error ? `导出失败：${error.message}` : '导出失败',
      );
    }
  };

  const toggleExpanded = (batchId: string) => {
    setExpandedBatchId((current) => (current === batchId ? null : batchId));
  };

  return (
    <section className="inventory-page">
      <header className="inv-head">
        <div>
          <h1>库存数量</h1>
          <p>
            按批次看可用量、库龄与低库存预警。可用量 = 入库 − 已引用 − 在途 −
            占用，是唯一可引用数字（D38）；预警口径见 `/inventory/alerts`（D104）。
          </p>
        </div>
        <div className="inv-actions">
          <button
            type="button"
            className="btn"
            disabled={!canExport}
            title={
              canExport
                ? '导出当前筛选条件下的库存批次 · 需要 inventory_qty.export 权限'
                : '需要 inventory_qty.export 权限'
            }
            onClick={() => void exportCsv()}
          >
            <Icon name="arrow-in" size={15} />
            导出 CSV
          </button>
        </div>
      </header>

      <div className="inv-tools">
        <label className="inv-field">
          <Icon name="filter" size={15} />
          <span className="sr-only">搜索批次、商品、仓库</span>
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索批次、商品、仓库…"
            autoComplete="off"
          />
        </label>
        <div className="inv-chips" aria-label="库存快速筛选">
          {QUICK_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`inv-chip${filter === item.key ? ' on' : ''}`}
              aria-pressed={filter === item.key}
              title={
                item.key === 'all'
                  ? '显示当前页全部批次'
                  : '后端列表没有该筛选参数，这里筛选当前页返回结果'
              }
              onClick={() => {
                setFilter(item.key);
                setExpandedBatchId(null);
              }}
            >
              {item.icon ? <Icon name={item.icon} size={14} /> : null}
              {item.label}
              <b>{quickFilterCount(item.key)}</b>
            </button>
          ))}
        </div>
        <div className="inv-grow" />
        <div className="inv-legend" aria-label="库存构成图例">
          <span>
            <i className="inv-legend-ref" />
            已引用
          </span>
          <span>
            <i className="inv-legend-transit" />
            在途
          </span>
          <span>
            <i className="inv-legend-hold" />
            占用
          </span>
          <span>
            <i className="inv-legend-available" />
            可用
          </span>
        </div>
      </div>

      {exportError ? (
        <p className="inv-notice inv-notice-error" role="alert">
          {exportError}
        </p>
      ) : null}

      <div
        className="card list-card"
        data-state={displayState}
        aria-busy={displayState === 'loading'}
      >
        <div className="tw">
          <table className="inv-table">
            <thead>
              <tr>
                <SortHeader
                  label="批次号"
                  field="batchNo"
                  sort={sort}
                  order={order}
                  onSort={toggleSort}
                />
                <th>商品</th>
                <th>仓库 / 保管人</th>
                <th className="inv-num">入库</th>
                <th>构成</th>
                <th className="inv-num">已引用</th>
                <th className="inv-num">在途</th>
                <th className="inv-num">占用</th>
                <SortHeader
                  label="可用"
                  field="availableQty"
                  sort={sort}
                  order={order}
                  numeric
                  onSort={toggleSort}
                />
                <SortHeader
                  label="库龄"
                  field="createdAt"
                  sort={sort}
                  order={order}
                  numeric
                  onSort={toggleSort}
                />
                <th>低库存预警</th>
                <th className="inv-num">锁定单价</th>
              </tr>
            </thead>
            <tbody data-state={displayState}>
              {rows.map((batch: InventoryBatch) => {
                const alert = alertsByBatch.get(batch.id);
                const age = batchAgeDays(batch.createdAt);
                const expanded = expandedBatchId === batch.id;
                return (
                  <Fragment key={batch.id}>
                    <tr
                      className="r-row click inv-row"
                      tabIndex={0}
                      aria-expanded={expanded}
                      title="点击行展开批次明细与成本更正历史"
                      onClick={() => toggleExpanded(batch.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          toggleExpanded(batch.id);
                        }
                      }}
                    >
                      <td className="mono">
                        <b>{batch.batchNo}</b>
                      </td>
                      <td>
                        {productNames.get(batch.productId) ?? (
                          <span className="mono" title={batch.productId}>
                            {shortId(batch.productId)}
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="inv-warehouse" title={batch.companyId}>
                          {companyShortId(batch.companyId)}
                        </span>
                        <small className="inv-keeper">
                          保管 {employeeLabel(batch.custodianId)}
                        </small>
                      </td>
                      <td className="num inv-num">
                        {formatQty(batch.inboundQty)}
                      </td>
                      <td>
                        <Composition batch={batch} />
                      </td>
                      <td className="num inv-num">
                        {formatQty(batch.referencedQty)}
                      </td>
                      <td className="num inv-num">
                        {formatQty(batch.inTransitQty)}
                      </td>
                      <td className="num inv-num">
                        {formatQty(batch.pendingExecutionQty)}
                      </td>
                      <td className="num inv-num inv-available">
                        <b>{formatQty(batch.availableQty)}</b>
                      </td>
                      <td className="num inv-num">
                        <span className={`inv-age${age >= 45 ? ' slow' : ''}`}>
                          <Icon name="clock" size={13} />
                          {age} 天
                        </span>
                      </td>
                      <td>
                        {alert ? (
                          <span
                            className="st inv-st-low"
                            title={alertTitle(alert)}
                          >
                            低于安全库存
                          </span>
                        ) : me.data?.companyIds.length ? (
                          <span className="st ok">充足</span>
                        ) : (
                          <span className="cell-muted">—</span>
                        )}
                      </td>
                      <td
                        className="num inv-num"
                        title={
                          canViewPrice
                            ? '批次锁定单价'
                            : '需要 inventory_qty.view_price 权限'
                        }
                      >
                        {amountText(batch.lockedUnitCost, canViewPrice)}
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="inv-detail-row">
                        <td colSpan={12}>
                          <section
                            className="inv-detail"
                            data-state={detailState}
                          >
                            <div className="st-block st-filled">
                              {detail.data ? (
                                <BatchDetail
                                  detail={detail.data}
                                  custodianLabel={employeeLabel(
                                    detail.data.custodianId,
                                  )}
                                  canViewPrice={canViewPrice}
                                  canReadCostAdjustments={
                                    canReadCostAdjustments
                                  }
                                  canUpdateCostAdjustments={
                                    canUpdateCostAdjustments
                                  }
                                  canApproveCostAdjustments={
                                    canApproveCostAdjustments
                                  }
                                  onClose={() => setExpandedBatchId(null)}
                                />
                              ) : null}
                            </div>
                            <div className="st-block st-empty">
                              <div className="st-box">
                                <div className="st-title">批次详情不存在</div>
                                <p className="st-desc">
                                  该批次可能已被调整，请刷新列表后重试。
                                </p>
                                <button
                                  type="button"
                                  className="btn"
                                  onClick={() => setExpandedBatchId(null)}
                                >
                                  关闭
                                </button>
                              </div>
                            </div>
                            <div className="st-block st-loading">
                              <div
                                className="st-box"
                                aria-label="批次详情加载中"
                              >
                                <div className="sk sk-line w80" />
                                <div className="sk sk-line w60" />
                                <div className="sk sk-line w40" />
                                <p className="st-desc">批次详情加载中…</p>
                              </div>
                            </div>
                            <div className="st-block st-error">
                              <div className="st-box st-error">
                                <div className="st-title">
                                  批次详情加载失败
                                </div>
                                <p className="st-desc">
                                  {describeListError(
                                    '批次详情加载失败',
                                    detail.error,
                                  )}
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
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
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
                        setFilter('all');
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
                    <p className="st-desc">库存批次加载中…</p>
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
          <span>
            共 {total} 条 · 预警阈值按 /inventory/alerts 口径（D104，服务端实时判定）·
            点击行查看该批次明细
          </span>
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
    </section>
  );
}

function BatchDetail({
  detail,
  custodianLabel,
  canViewPrice,
  canReadCostAdjustments,
  canUpdateCostAdjustments,
  canApproveCostAdjustments,
  onClose,
}: {
  readonly detail: InventoryBatchDetail;
  readonly custodianLabel: string;
  readonly canViewPrice: boolean;
  readonly canReadCostAdjustments: boolean;
  readonly canUpdateCostAdjustments: boolean;
  readonly canApproveCostAdjustments: boolean;
  readonly onClose: () => void;
}) {
  return (
    <div className="detail">
      <div className="detail-head">
        <div className="detail-head-row">
          <div>
            <small className="detail-why">库存 · 批次 · 行内明细</small>
            <h3 className="detail-title">
              <span className="no">{detail.batchNo}</span>
            </h3>
          </div>
          <div className="detail-tools">
            <button type="button" onClick={onClose} className="btn">
              收起
            </button>
          </div>
        </div>
      </div>

      <dl className="dl" data-cols="4">
        <div>
          <dt>商品</dt>
          <dd>{detail.productName}</dd>
        </div>
        <div>
          <dt>商品编号</dt>
          <dd className="mono">
            {detail.productNo ?? shortId(detail.productId)}
          </dd>
        </div>
        <div>
          <dt>保管人</dt>
          <dd className="mono" title={detail.custodianId}>
            {custodianLabel}
          </dd>
        </div>
        <div>
          <dt>锁定单价</dt>
          <dd
            className="num"
            title={
              canViewPrice ? undefined : '需要 inventory_qty.view_price 权限'
            }
          >
            {amountText(detail.lockedUnitCost, canViewPrice)}
          </dd>
        </div>
        <div>
          <dt>入库 / 已引用</dt>
          <dd className="num">
            {formatQty(detail.inboundQty)} / {formatQty(detail.referencedQty)}
          </dd>
        </div>
        <div>
          <dt>在途 / 占用 / 可用</dt>
          <dd className="num">
            {formatQty(detail.inTransitQty)} /{' '}
            {formatQty(detail.pendingExecutionQty)} /{' '}
            {formatQty(detail.availableQty)}
          </dd>
        </div>
        <div>
          <dt>更新时间</dt>
          <dd>{formatDateTime(detail.updatedAt)}</dd>
        </div>
        <div>
          <dt>版本</dt>
          <dd className="mono">v{detail.version}</dd>
        </div>
      </dl>

      <div>
        <h4 className="inv-subtitle">待执行占用来源</h4>
        {detail.pendingOccupancies.length === 0 ? (
          <p className="detail-why">无待执行占用。</p>
        ) : (
          <ul className="inv-occupancies">
            {detail.pendingOccupancies.map((item) => (
              <li key={`${item.sourceDocType}-${item.sourceDocId}`}>
                <span className="mono">{item.sourceDocType}</span>
                <span>·</span>
                <span className="mono">{item.sourceDocId}</span>
                <span>·</span>
                <span className="num">{formatQty(item.qty)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <BatchCostAdjustments
        batchId={detail.id}
        canRead={canReadCostAdjustments}
        canUpdate={canUpdateCostAdjustments}
        canApprove={canApproveCostAdjustments}
        canViewPrice={canViewPrice}
      />
    </div>
  );
}
