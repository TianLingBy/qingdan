import type { InventoryFlow } from '@qingdan/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { describeListError } from '../../components/ListStates';
import { Icon, type IconName } from '../../components/icons/Icon';
import { compareDecimal } from '../../lib/decimal';
import { useEmployeeLabel } from '../../lib/employee-directory';
import { resolveListState } from '../../lib/list-state';
import { authApi, authKeys } from '../auth/auth-api';
import { inventoryApi, inventoryQueryKeys } from './inventory-api';
import { errorText, formatDateTime, shortId } from './inventory-ui';

const SOURCE_TYPES = ['A', 'B', 'E', 'N', 'I', 'R', 'S'] as const;

export type FlowDirectionFilter = 'all' | 'positive' | 'negative' | 'zero';

const DIRECTION_FILTERS: readonly {
  readonly key: FlowDirectionFilter;
  readonly label: string;
  readonly icon: IconName | null;
}[] = [
  { key: 'all', label: '全部', icon: null },
  { key: 'positive', label: '正变动', icon: 'arrow-in' },
  { key: 'negative', label: '负变动', icon: 'arrow-out' },
  { key: 'zero', label: '零变动', icon: 'adjust' },
];

export function flowDirection(
  delta: string,
): Exclude<FlowDirectionFilter, 'all'> {
  const compared = compareDecimal(delta, '0');
  if (compared < 0) return 'negative';
  if (compared > 0) return 'positive';
  return 'zero';
}

function directionOf(delta: string): {
  readonly key: Exclude<FlowDirectionFilter, 'all'>;
  readonly text: string;
  readonly icon: IconName;
  readonly value: string;
} {
  const key = flowDirection(delta);
  if (key === 'negative') {
    return { key, text: '负变动', icon: 'arrow-out', value: delta };
  }
  if (key === 'positive') {
    return {
      key,
      text: '正变动',
      icon: 'arrow-in',
      value: delta.startsWith('+') ? delta : `+${delta}`,
    };
  }
  return { key, text: '零变动', icon: 'adjust', value: delta };
}

export function flowMatchesKeyword(
  flow: InventoryFlow,
  keyword: string,
  resolvedBatchNo: string | null,
  handledByLabel: string,
): boolean {
  const needle = keyword.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    flow.batchId,
    resolvedBatchNo ?? '',
    flow.sourceDocType,
    flow.sourceDocId,
    flow.handledBy,
    handledByLabel,
  ]
    .join(' ')
    .toLocaleLowerCase()
    .includes(needle);
}

function filterText(input: {
  readonly companyId: string;
  readonly batchNo: string | null;
  readonly sourceDocType: string;
  readonly sourceDocId: string;
  readonly keyword: string;
  readonly direction: FlowDirectionFilter;
}): string {
  const direction =
    DIRECTION_FILTERS.find((item) => item.key === input.direction)?.label ??
    '全部';
  return [
    input.companyId ? `公司 ${shortId(input.companyId)}` : '全部可见公司',
    input.batchNo ? `批次 ${input.batchNo}` : '全部批次',
    input.sourceDocType
      ? `来源类型 ${input.sourceDocType}`
      : '全部来源类型',
    input.sourceDocId.trim()
      ? `来源单号 ${input.sourceDocId.trim()}`
      : '全部来源单号',
    `方向 ${direction}`,
    input.keyword.trim() ? `关键字 ${input.keyword.trim()}` : '无关键字',
  ].join(' · ');
}

function FlowPager({
  pageIndex,
  currentCount,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
}: {
  readonly pageIndex: number;
  readonly currentCount: number;
  readonly hasPrevious: boolean;
  readonly hasNext: boolean;
  readonly onPrevious: () => void;
  readonly onNext: () => void;
}) {
  return (
    <div className="pager" aria-label="库存流水分批">
      <span className="count">当前返回 {currentCount} 条</span>
      <div className="nav">
        <button
          type="button"
          aria-label="上一批"
          title="上一批"
          disabled={!hasPrevious}
          onClick={onPrevious}
        >
          <Icon name="pg-prev" />
        </button>
        <span className="of">第 {pageIndex + 1} 批</span>
        <button
          type="button"
          aria-label="下一批"
          title="下一批"
          disabled={!hasNext}
          onClick={onNext}
        >
          <Icon name="pg-next" />
        </button>
      </div>
    </div>
  );
}

export function InventoryFlowsPage() {
  const [keyword, setKeyword] = useState('');
  const [direction, setDirection] = useState<FlowDirectionFilter>('all');
  const [companyId, setCompanyId] = useState('');
  const [batchNoInput, setBatchNoInput] = useState('');
  const [batchId, setBatchId] = useState<string | undefined>();
  const [resolvedBatchNo, setResolvedBatchNo] = useState<string | null>(null);
  const [sourceDocType, setSourceDocType] = useState('');
  const [sourceDocId, setSourceDocId] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [traceError, setTraceError] = useState<string | null>(null);
  const employeeLabel = useEmployeeLabel();

  const me = useQuery({
    queryKey: authKeys.me,
    queryFn: authApi.me,
  });
  const filters = useMemo(
    () => ({
      companyId: companyId || undefined,
      batchId,
      sourceDocType: sourceDocType || undefined,
      sourceDocId: sourceDocId.trim() || undefined,
      cursor: cursors[pageIndex] ?? null,
    }),
    [
      companyId,
      batchId,
      sourceDocType,
      sourceDocId,
      cursors,
      pageIndex,
    ],
  );
  const flows = useQuery({
    queryKey: inventoryQueryKeys.flows(filters),
    queryFn: () => inventoryApi.listFlows(filters),
  });
  const resolveBatch = useMutation({
    mutationFn: () =>
      inventoryApi.resolveBatchByNumber(batchNoInput, companyId || undefined),
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

  const returnedRows = flows.data?.items ?? [];
  const searchedRows = returnedRows.filter((flow) =>
    flowMatchesKeyword(
      flow,
      keyword,
      resolvedBatchNo,
      employeeLabel(flow.handledBy),
    ),
  );
  const rows = searchedRows.filter(
    (flow) => direction === 'all' || flowDirection(flow.delta) === direction,
  );
  const listState = resolveListState({
    isPending: flows.isPending,
    hasError: flows.isError,
    isEmpty: returnedRows.length === 0,
  });
  const displayState =
    listState === 'filled' && rows.length === 0 ? 'empty' : listState;

  const directionCount = (next: FlowDirectionFilter): number =>
    next === 'all'
      ? searchedRows.length
      : searchedRows.filter((flow) => flowDirection(flow.delta) === next)
          .length;

  const resetFilters = () => {
    setCompanyId('');
    setBatchNoInput('');
    setBatchId(undefined);
    setResolvedBatchNo(null);
    setSourceDocType('');
    setSourceDocId('');
    setKeyword('');
    setDirection('all');
    setTraceError(null);
  };

  const currentFilterText = filterText({
    companyId,
    batchNo: resolvedBatchNo,
    sourceDocType,
    sourceDocId,
    keyword,
    direction,
  });

  return (
    <section className="inventory-page flow-page">
      <header className="inv-head">
        <div>
          <h1>库存流水</h1>
          <p>
            解释可用量为什么变。流水只追加、不修改（D2）；本页只展示冻结契约真实提供的发生时间、批次、变动量、来源单据与经手人。
          </p>
        </div>
      </header>

      <div className="inv-tools flow-tools">
        <label className="inv-field flow-search">
          <Icon name="filter" size={15} />
          <span className="sr-only">搜索批次、来源单据、经手人</span>
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索批次、来源单据、经手人…"
            autoComplete="off"
          />
        </label>
        <div className="inv-chips" aria-label="库存流水方向筛选">
          {DIRECTION_FILTERS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`inv-chip${direction === item.key ? ' on' : ''}`}
              aria-pressed={direction === item.key}
              title={
                item.key === 'all'
                  ? '显示当前批全部库存流水'
                  : '后端没有方向筛选参数，这里筛选当前批返回结果'
              }
              onClick={() => setDirection(item.key)}
            >
              {item.icon ? <Icon name={item.icon} size={14} /> : null}
              {item.label}
              <b>{directionCount(item.key)}</b>
            </button>
          ))}
        </div>
        <div className="inv-grow" />
        <span className="flow-note">
          <Icon name="shield" size={15} />
          只追加，不允许改历史流水
        </span>
      </div>

      <div className="flow-filterbar" aria-label="库存流水精确筛选">
        <label className="flow-filter">
          <span>公司</span>
          <select
            value={companyId}
            onChange={(event) => {
              setCompanyId(event.target.value);
              setBatchId(undefined);
              setResolvedBatchNo(null);
              setBatchNoInput('');
              setTraceError(null);
            }}
            className="flow-select"
          >
            <option value="">全部可见公司</option>
            {(me.data?.companyIds ?? []).map((id) => (
              <option key={id} value={id}>
                {shortId(id)}
              </option>
            ))}
          </select>
        </label>
        <label className="flow-filter">
          <span>来源类型</span>
          <select
            value={sourceDocType}
            onChange={(event) => setSourceDocType(event.target.value)}
            className="flow-select"
          >
            <option value="">全部类型</option>
            {SOURCE_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="flow-filter flow-filter-wide">
          <span>来源单据号</span>
          <input
            value={sourceDocId}
            onChange={(event) => setSourceDocId(event.target.value)}
            placeholder="输入来源单据 ID"
            className="flow-input"
          />
        </label>
        <form
          className="flow-filter flow-filter-wide"
          onSubmit={(event) => {
            event.preventDefault();
            if (batchNoInput.trim() && !resolveBatch.isPending) {
              resolveBatch.mutate();
            }
          }}
        >
          <span>批次追溯</span>
          <span className="flow-resolve">
            <input
              value={batchNoInput}
              onChange={(event) => {
                setBatchNoInput(event.target.value);
                if (resolvedBatchNo) {
                  setBatchId(undefined);
                  setResolvedBatchNo(null);
                }
                setTraceError(null);
              }}
              placeholder="输入批次号"
              className="flow-input"
            />
            <button
              type="submit"
              disabled={!batchNoInput.trim() || resolveBatch.isPending}
              className="btn"
            >
              {resolveBatch.isPending ? '查找中…' : '追溯'}
            </button>
          </span>
        </form>
        <button
          type="button"
          className="btn flow-reset"
          onClick={resetFilters}
        >
          <Icon name="refresh" size={14} />
          重置
        </button>
      </div>

      {resolvedBatchNo ? (
        <span className="chip flow-batch-chip">
          <Icon name="pin" size={14} />
          当前批次：{resolvedBatchNo}
        </span>
      ) : null}
      {traceError ? (
        <p className="inv-notice inv-notice-error" role="alert">
          {traceError}
        </p>
      ) : null}

      <p className="flow-current">当前筛选：{currentFilterText}</p>

      <div
        className="card list-card"
        data-state={displayState}
        aria-busy={displayState === 'loading'}
      >
        <div className="tw">
          <table className="inv-table flow-table">
            <thead>
              <tr>
                <th>发生时间</th>
                <th>批次 ID</th>
                <th>方向</th>
                <th className="inv-num">变动量</th>
                <th>来源类型</th>
                <th>来源单据</th>
                <th>经手人</th>
              </tr>
            </thead>
            <tbody data-state={displayState}>
              {rows.map((flow: InventoryFlow) => {
                const directionValue = directionOf(flow.delta);
                return (
                  <tr key={flow.id} className="r-row flow-row">
                    <td className="mono flow-time">
                      {formatDateTime(flow.occurredAt)}
                    </td>
                    <td className="mono" title={flow.batchId}>
                      <b>
                        {flow.batchId === batchId && resolvedBatchNo
                          ? resolvedBatchNo
                          : shortId(flow.batchId)}
                      </b>
                    </td>
                    <td>
                      <span
                        className={`flow-kind flow-kind-${directionValue.key}`}
                      >
                        <Icon name={directionValue.icon} size={14} />
                        {directionValue.text}
                      </span>
                    </td>
                    <td className="num inv-num">
                      <b
                        className={`flow-delta flow-delta-${directionValue.key}`}
                      >
                        {directionValue.value}
                      </b>
                    </td>
                    <td>
                      <span
                        className="flow-source"
                        title={`来源单据类型 ${flow.sourceDocType}`}
                      >
                        {flow.sourceDocType}
                      </span>
                    </td>
                    <td className="mono flow-source-id" title={flow.sourceDocId}>
                      {flow.sourceDocId}
                    </td>
                    <td className="flow-handler" title={flow.handledBy}>
                      {employeeLabel(flow.handledBy)}
                    </td>
                  </tr>
                );
              })}
              <tr className="st-tr st-empty">
                <td colSpan={7}>
                  <div className="st-box">
                    <div className="st-ico">
                      <Icon name="filter" />
                    </div>
                    <div className="st-title">没有符合条件的库存流水</div>
                    <p className="st-desc">
                      可清空筛选；单据入库、出库或冲正审批后会在这里留下不可修改的记录。
                    </p>
                    <button type="button" className="btn" onClick={resetFilters}>
                      清空筛选
                    </button>
                  </div>
                </td>
              </tr>
              <tr className="st-tr st-loading">
                <td colSpan={7}>
                  <div className="st-box" aria-label="库存流水加载中">
                    <div className="sk sk-line w80" />
                    <div className="sk sk-line w60" />
                    <div className="sk sk-line w40" />
                    <p className="st-desc">库存流水加载中…</p>
                  </div>
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={7}>
                  <div className="st-box st-error">
                    <div className="st-ico">
                      <Icon name="refresh" />
                    </div>
                    <div className="st-title">库存流水加载失败</div>
                    <p className="st-desc">
                      {describeListError('库存流水加载失败', flows.error)}
                    </p>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void flows.refetch()}
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
          <span>{currentFilterText}</span>
          <FlowPager
            pageIndex={pageIndex}
            currentCount={rows.length}
            hasPrevious={pageIndex > 0}
            hasNext={Boolean(flows.data?.nextCursor)}
            onPrevious={() =>
              setPageIndex((index) => Math.max(0, index - 1))
            }
            onNext={() => {
              const nextCursor = flows.data?.nextCursor;
              if (!nextCursor) return;
              setCursors((items) => [
                ...items.slice(0, pageIndex + 1),
                nextCursor,
              ]);
              setPageIndex((index) => index + 1);
            }}
          />
        </footer>
      </div>
    </section>
  );
}
