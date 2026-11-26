import type { InventoryFlow } from '@qingdan/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { describeListError } from '../../components/ListStates';
import { Icon } from '../../components/icons/Icon';
import { compareDecimal } from '../../lib/decimal';
import { resolveListState } from '../../lib/list-state';
import { authApi, authKeys } from '../auth/auth-api';
import { inventoryApi, inventoryQueryKeys } from './inventory-api';
import { errorText, formatDateTime, shortId } from './inventory-ui';

const SOURCE_TYPES = ['A', 'B', 'E', 'N', 'I', 'R', 'S'] as const;

function directionOf(delta: string): {
  readonly text: string;
  readonly className: string;
  readonly value: string;
} {
  const compared = compareDecimal(delta, '0');
  if (compared < 0) {
    return { text: '负变动', className: 'st warn', value: delta };
  }
  if (compared > 0) {
    return {
      text: '正变动',
      className: 'st ok',
      value: delta.startsWith('+') ? delta : `+${delta}`,
    };
  }
  return { text: '零变动', className: 'st draft', value: delta };
}

function filterText(input: {
  readonly companyId: string;
  readonly resolvedBatchNo: string | null;
  readonly sourceDocType: string;
  readonly sourceDocId: string;
}): string {
  return [
    input.companyId ? `公司 ${shortId(input.companyId)}` : '全部可见公司',
    input.resolvedBatchNo ? `批次 ${input.resolvedBatchNo}` : '全部批次',
    input.sourceDocType ? `来源类型 ${input.sourceDocType}` : '全部来源类型',
    input.sourceDocId.trim()
      ? `来源单号 ${input.sourceDocId.trim()}`
      : '全部来源单号',
  ].join(' · ');
}

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

  const rows = flows.data?.items ?? [];
  const state = resolveListState({
    isPending: flows.isPending,
    hasError: flows.isError,
    isEmpty: rows.length === 0,
  });

  return (
    <section className="page-stack">
      <header className="p-head">
        <div>
          <div className="eyebrow">库存 · 流水</div>
          <h1>库存流水</h1>
          <p className="sub">
            流水只追加、不修改。本页只展示冻结契约真实提供的时间、批次、变动量、来源单据与经手人。
          </p>
        </div>
        <div className="page-chips">
          <span className="chip icon-chip">
            <Icon name="shield" size={14} /> 只追加
          </span>
          <span className="st ok">D2 口径</span>
        </div>
      </header>

      <div className="toolbar">
        <label>
          <span className="sr-only">可见公司</span>
          <select
            value={companyId}
            onChange={(event) => {
              setCompanyId(event.target.value);
              setBatchId(undefined);
              setResolvedBatchNo(null);
              setBatchNoInput('');
              setTraceError(null);
            }}
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
          <span className="sr-only">来源单据类型</span>
          <select
            value={sourceDocType}
            onChange={(event) => setSourceDocType(event.target.value)}
            className="search"
          >
            <option value="">全部来源类型</option>
            {SOURCE_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">来源单据号</span>
          <input
            value={sourceDocId}
            onChange={(event) => setSourceDocId(event.target.value)}
            placeholder="来源单据 ID"
            className="search"
          />
        </label>
        <label>
          <span className="sr-only">批次号追溯</span>
          <span className="toolbar-inline">
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
              placeholder="批次号追溯"
              className="search"
            />
            <button
              type="button"
              disabled={!batchNoInput.trim() || resolveBatch.isPending}
              onClick={() => resolveBatch.mutate()}
              className="btn btn-primary"
            >
              {resolveBatch.isPending ? '查找中…' : '追溯'}
            </button>
          </span>
        </label>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setCompanyId('');
            setBatchNoInput('');
            setBatchId(undefined);
            setResolvedBatchNo(null);
            setSourceDocType('');
            setSourceDocId('');
            setTraceError(null);
          }}
        >
          <Icon name="refresh" size={14} />
          重置
        </button>
      </div>

      <div className="page-chips">
        {resolvedBatchNo ? (
          <>
            <span className="chip icon-chip">
              <Icon name="pin" size={14} />
              当前批次：{resolvedBatchNo}
            </span>
            <button
              type="button"
              onClick={() => {
                setBatchId(undefined);
                setResolvedBatchNo(null);
                setBatchNoInput('');
              }}
              className="btn"
            >
              清除批次筛选
            </button>
          </>
        ) : null}
        {traceError ? <span className="inline-error">{traceError}</span> : null}
      </div>

      <div
        className="card list-card"
        data-state={state}
        aria-busy={state === 'loading'}
      >
        <div className="tw">
          <table className="data-table wide-flows">
            <thead>
              <tr>
                <th>发生时间</th>
                <th>批次 ID</th>
                <th>方向</th>
                <th className="cell-right">变动量</th>
                <th>来源类型</th>
                <th>来源单据 ID</th>
                <th>经手人</th>
              </tr>
            </thead>
            <tbody data-state={state}>
              {rows.map((flow: InventoryFlow) => {
                const direction = directionOf(flow.delta);
                return (
                  <tr key={flow.id} className="r-row">
                    <td className="mono">{formatDateTime(flow.occurredAt)}</td>
                    <td className="mono" title={flow.batchId}>
                      {flow.batchId === batchId && resolvedBatchNo
                        ? resolvedBatchNo
                        : shortId(flow.batchId)}
                    </td>
                    <td>
                      <span className={direction.className}>
                        {direction.text}
                      </span>
                    </td>
                    <td className="num cell-right">
                      <b>{direction.value}</b>
                    </td>
                    <td>
                      <span className="mono" title={flow.sourceDocType}>
                        {flow.sourceDocType}
                      </span>
                    </td>
                    <td className="mono" title={flow.sourceDocId}>
                      {flow.sourceDocId}
                    </td>
                    <td className="mono" title={flow.handledBy}>
                      {shortId(flow.handledBy)}
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
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setCompanyId('');
                        setBatchNoInput('');
                        setBatchId(undefined);
                        setResolvedBatchNo(null);
                        setSourceDocType('');
                        setSourceDocId('');
                      }}
                    >
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
                    <p className="st-desc st-desc-next">库存流水加载中…</p>
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
          <span>
            当前筛选：
            {filterText({
              companyId,
              resolvedBatchNo,
              sourceDocType,
              sourceDocId,
            })}
          </span>
          <div className="pager" aria-label="库存流水分批">
            <span className="count">当前返回 {rows.length} 条</span>
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
                disabled={!flows.data?.nextCursor}
                onClick={() => {
                  const nextCursor = flows.data?.nextCursor;
                  if (!nextCursor) return;
                  setCursors((items) => [
                    ...items.slice(0, pageIndex + 1),
                    nextCursor,
                  ]);
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
