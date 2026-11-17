import type {
  DedupeArchive,
  DedupeKind,
  DedupeMergeDirection,
  DedupePair,
  DedupeState,
} from '@qingdan/contracts';
import { DEDUPE_CONSOLE_LIMIT, DEDUPE_REASON_MAX } from '@qingdan/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ListEmpty, ListError, ListLoading } from '../../components/ListStates';
import { allows } from '../../lib/access';
import { resolveListState } from '../../lib/list-state';
import { describeWriteError } from '../../lib/write-error';
import { authApi, authKeys } from '../auth/auth-api';
import { dedupeApi, dedupeQueryKeys } from './dedupe-api';

/**
 * 主数据去重审核台（`/masterdata-dedupe`，后端 D102 / D103，契约 `masterdata-dedupe.ts`）。
 *
 * 场景：开单即建档（D100）在开单时静默建客户/供应商/加工厂/商品，疑似同一家的对子进
 * `masterdata_dedupe` 队列；运营在这里判「是不是同一家」，判错可以撤销，判「要并」则真的合并。
 *
 * 三条页内口径，都是从契约抄来的、不是审美选择：
 * 1. **合并方向必须由人当场选**，页面不预置默认值——左右两条谁并进谁，决定了「哪张单据改挂到哪个档案」，
 *    预置一个默认值等于让手快的人一路回车把老档案并进新档案（引用全错且不可回退）。
 * 2. **`merged` 的行三个动作都不给**：契约写明合法流转只有 pending→kept、kept→pending、pending→merged，
 *    合并已经改写了全库引用，不是改个状态就能撤销的（D103③）。
 * 3. **`name === null` 要显示「档案已删除」**：D93 起主数据是物理删除，队列行没有外键，
 *    删档案不会连带删队列行；直接渲染 `null` 会得到空白格子，看起来像「档案没名字」而不是「档案没了」。
 *
 * 权限：operationId 是 `customer.dedupe.*`，但服务端按对子真实的 `kind` 鉴权（`readableKinds` /
 * `requireKindMerge`）。所以前端**只按 kind 查自己的 scope 决定按钮灰不灰**，不造一套平行的权限真源；
 * 判错了服务端也会 403。
 */

const KIND_LABEL: Record<DedupeKind, string> = {
  customer: '客户',
  supplier: '供应商',
  processor: '加工厂',
  product: '商品',
};

/** 命中依据的中文标签：值来自 `matched_by` 的 CHECK（名称 / 名称+电话 / 曾用名）。 */
const MATCHED_BY_LABEL = {
  name_only: '名称相同',
  name_phone: '名称与电话都相同',
  alias: '曾用名命中',
} as const;

const STATE_LABEL: Record<DedupeState, string> = {
  pending: '待判',
  kept: '已判为不同',
  merged: '已合并',
};

const PAGE_DESCRIPTION =
  '开单即建档（D100）会静默建客户 / 供应商 / 加工厂 / 商品档案，疑似同一家的对子进这条队列。' +
  '判为不同之后这对不再提示；合并会改写全库引用且不可撤销（D103③）。';

const COLUMN_COUNT = 8;

/** 相似度 0–1 → 百分比两位小数。给「越高越像同一家」这句解释留位置，别让人把 0.62 当成评分。 */
function formatScore(score: number): string {
  return `${(score * 100).toFixed(2)}%`;
}

/** 本地时间 `YYYY-MM-DD HH:mm`；不用 `toLocaleString`，Node 与浏览器的时区/语言包可能不一致。 */
function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}`;
}

/**
 * 原因校验（判定 / 撤销判定共用）。
 *
 * 为什么在前端也拦一遍：`reason` 是 1–200 字的必填项，用户在 `prompt` 里敲了 300 字后
 * 再吃一个 422 等于白写；这里先把「必须填」「超了几字」说清，用户当场就能改。
 * 返回 `null` = 用户取消（不是错误，不该弹红条）。
 */
function readReason(raw: string | null): { readonly reason: string } | { readonly error: string } | null {
  if (raw === null) return null;
  const reason = raw.trim();
  if (reason.length === 0) {
    return { error: '必须填写原因：判成「不是同一家」之后这对就不再提示，没有依据后面没人敢改。' };
  }
  if (reason.length > DEDUPE_REASON_MAX) {
    return { error: `原因最多 ${DEDUPE_REASON_MAX} 字，当前 ${reason.length} 字。` };
  }
  return { reason };
}

/** 一侧档案摘要：名字没了说明档案已被删除（D93 物理删除），不能渲染成空白。 */
function ArchiveSide({ archive }: { readonly archive: DedupeArchive }) {
  return (
    <span className="inline-flex flex-col text-left">
      {archive.name === null ? (
        <span className="text-slate-400" title="这条档案已被物理删除（D93），队列行仍在">
          档案已删除
        </span>
      ) : (
        <span className="text-slate-900">{archive.name}</span>
      )}
      {archive.specification !== null ? (
        <span className="text-xs text-slate-500">规格 {archive.specification}</span>
      ) : null}
      {archive.contactPhone !== null ? (
        <span className="text-xs text-slate-500">{archive.contactPhone}</span>
      ) : null}
    </span>
  );
}

export function DedupeConsolePage() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: authKeys.me, queryFn: () => authApi.me(), retry: false });
  const scope = me.data?.scope;

  const [companyId, setCompanyId] = useState('');
  const [kind, setKind] = useState<'' | DedupeKind>('');
  const [state, setState] = useState<DedupeState>('pending');
  /** 每行的合并方向：故意不预置，键不存在 = 还没选。 */
  const [directions, setDirections] = useState<Record<string, DedupeMergeDirection>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const activeCompanyId = companyId === '' ? (me.data?.companyIds[0] ?? '') : companyId;
  const filters = {
    companyId: activeCompanyId,
    kind: kind === '' ? undefined : kind,
    state,
  } as const;

  const list = useQuery({
    queryKey: dedupeQueryKeys.list(filters),
    queryFn: () => dedupeApi.list(filters),
    // 没公司 id 就不发请求：`companyId` 是必传 uuid，发出去只会换来一个 422 红条。
    enabled: activeCompanyId !== '',
    retry: false,
  });

  const keepSeparate = useMutation({
    mutationFn: (input: { readonly id: string; readonly reason: string }) =>
      dedupeApi.keepSeparate(input.id, input.reason),
  });
  const reopen = useMutation({
    mutationFn: (input: { readonly id: string; readonly reason: string }) =>
      dedupeApi.reopen(input.id, input.reason),
  });
  const merge = useMutation({
    mutationFn: (input: { readonly id: string; readonly direction: DedupeMergeDirection }) =>
      dedupeApi.merge(input.id, input.direction),
  });

  const rows = list.data?.items ?? [];
  const listState = resolveListState({
    isPending: list.isPending,
    hasError: list.error !== null,
    isEmpty: rows.length === 0,
  });

  /** 该 kind 的 merge 权限：kind 名与功能域名一致（customer / supplier / processor / product）。 */
  const canMerge = (pairKind: DedupeKind): boolean => allows(scope, pairKind, 'merge');

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['masterdata', 'dedupe'] });

  const onCompanyChange = (next: string) => {
    setCompanyId(next);
    // 换公司 = 换一整条队列：类型 / 状态筛选与已选方向都是上一家公司的上下文，
    // 留着会让「A 公司的筛选条件」去解释 B 公司的数据，看着像筛选失灵。
    setKind('');
    setState('pending');
    setDirections({});
    setActionError(null);
    setNotice(null);
  };

  const askKeepSeparate = async (pair: DedupePair) => {
    setActionError(null);
    setNotice(null);
    const parsed = readReason(globalThis.prompt?.('判为不同的原因（1–200 字）') ?? null);
    if (parsed === null) return;
    if ('error' in parsed) {
      setActionError(parsed.error);
      return;
    }
    const confirmed = globalThis.confirm?.(
      `确认「${pair.left.name ?? '档案已删除'}」与「${pair.right.name ?? '档案已删除'}」不是同一家？\n` +
        '判完之后这对不再出现在待判队列（判错了还能用「撤销判定」放回来）。',
    );
    if (confirmed === false) return;
    try {
      await keepSeparate.mutateAsync({ id: pair.id, reason: parsed.reason });
      setNotice('已判为不同，这对不再提示；判错了可以在「已判为不同」里撤销。');
      await refresh();
    } catch (error) {
      setActionError(describeWriteError(error, '判定失败，请稍后重试'));
    }
  };

  const askReopen = async (pair: DedupePair) => {
    setActionError(null);
    setNotice(null);
    const parsed = readReason(globalThis.prompt?.('撤销判定的原因（1–200 字）') ?? null);
    if (parsed === null) return;
    if ('error' in parsed) {
      setActionError(parsed.error);
      return;
    }
    const confirmed = globalThis.confirm?.('确认撤销判定，把这对放回「待判」？');
    if (confirmed === false) return;
    try {
      await reopen.mutateAsync({ id: pair.id, reason: parsed.reason });
      setNotice('已撤销判定，这对回到待判队列。');
      await refresh();
    } catch (error) {
      setActionError(describeWriteError(error, '撤销失败，请稍后重试'));
    }
  };

  const askMerge = async (pair: DedupePair) => {
    setActionError(null);
    setNotice(null);
    const direction = directions[pair.id];
    if (direction === undefined) {
      // 理论上按钮此时是灰的；留这条是防「键盘直接回车提交」时把空方向发出去。
      setActionError('请先选择合并方向：左并入右，还是右并入左。');
      return;
    }
    const keptSide = direction === 'left_into_right' ? pair.right : pair.left;
    const mergedSide = direction === 'left_into_right' ? pair.left : pair.right;
    const keptName = keptSide.name ?? '档案已删除';
    const mergedName = mergedSide.name ?? '档案已删除';

    // 二次确认必须把「谁并进谁」和「不可撤销」都说出来：这是全库改写引用，
    // 用户在这儿唯一能核对的依据就是这两句名字。
    const confirmed = globalThis.confirm?.(
      `「${mergedName}」的单据明细、库存批次、报价等引用会改挂到「${keptName}」，` +
        '被并的档案记为已合并。此操作不可撤销（D103③）。继续？',
    );
    if (confirmed === false) return;
    try {
      const result = await merge.mutateAsync({ id: pair.id, direction });
      const total = result.movedReferences.reduce((sum, item) => sum + item.rows, 0);
      const touched = result.movedReferences
        .filter((item) => item.rows > 0)
        .map((item) => `${item.table}.${item.column}×${item.rows}`);
      setNotice(
        `已合并：「${mergedName}」并入「${keptName}」，共改写 ${total} 处引用` +
          (touched.length > 0 ? `（${touched.join('、')}）` : '') +
          '。',
      );
      setDirections((prev) => {
        const next = { ...prev };
        delete next[pair.id];
        return next;
      });
      await refresh();
    } catch (error) {
      setActionError(describeWriteError(error, '合并失败，请稍后重试'));
    }
  };

  return (
    <section className="mx-auto max-w-7xl space-y-5">
      <div className="p-head">
        <div>
          <div className="eyebrow">主数据 · 去重审核台</div>
          <h1>主数据去重审核台</h1>
          <p className="sub">{PAGE_DESCRIPTION}</p>
        </div>
      </div>

      {/* 工具条（v0.13）：公司、类型、状态三个筛选都是下拉，当前选择值就是查询条件本身 */}
      <div className="toolbar">
        <select
          value={activeCompanyId}
          onChange={(event) => onCompanyChange(event.target.value)}
          aria-label="选择公司"
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          {(me.data?.companyIds ?? []).map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>

        <select
          value={kind}
          onChange={(event) => setKind(event.target.value as '' | DedupeKind)}
          aria-label="按档案类型筛选"
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">全部类型</option>
          {(Object.keys(KIND_LABEL) as DedupeKind[]).map((item) => (
            <option key={item} value={item}>
              {KIND_LABEL[item]}
            </option>
          ))}
        </select>

        <select
          value={state}
          onChange={(event) => setState(event.target.value as DedupeState)}
          aria-label="按判定状态筛选"
          className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          {(Object.keys(STATE_LABEL) as DedupeState[]).map((item) => (
            <option key={item} value={item}>
              {item === 'merged' ? `${STATE_LABEL[item]}（不可回退）` : STATE_LABEL[item]}
            </option>
          ))}
        </select>

        <span className="ml-auto text-sm" style={{ color: 'var(--text-3)' }}>
          一次最多 {DEDUPE_CONSOLE_LIMIT} 条，按相似度倒序（不翻页：队列是「今天要处理掉」的活）
        </span>
      </div>

      {notice ? (
        <p className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          {notice}
        </p>
      ) : null}
      {actionError ? (
        <p className="rounded-xl bg-red-50 p-3 text-sm text-red-700" role="alert">
          {actionError}
        </p>
      ) : null}

      {/* 列表四态（v0.13）：容器与 tbody 各带 data-state，三个状态行常驻，显隐交给 CSS。 */}
      <div className="panel" data-state={listState}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] text-left">
            <thead>
              <tr>
                <th>类型</th>
                <th>档案 A</th>
                <th>档案 B</th>
                <th className="num" title="相似度 0–100%，越高越像同一家">
                  相似度（越高越像）
                </th>
                <th>命中依据</th>
                <th>备注</th>
                <th>入队时间</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody data-state={listState}>
              <tr className="st-tr st-loading">
                <td colSpan={COLUMN_COUNT}>
                  <ListLoading label="正在加载疑似重复档案…" />
                </td>
              </tr>
              <tr className="st-tr st-error">
                <td colSpan={COLUMN_COUNT}>
                  <ListError
                    title="疑似重复档案加载失败"
                    error={list.error}
                    onRetry={() => void list.refetch()}
                  />
                </td>
              </tr>
              <tr className="st-tr st-empty">
                <td colSpan={COLUMN_COUNT}>
                  <ListEmpty
                    title="这条队列里没有要处理的疑似重复档案。"
                    hint="开单时静默建档（D100）才会产生候选；已判为不同的对子可以在上面把状态切到「已判为不同」查看并撤销。"
                  />
                </td>
              </tr>
              {rows.map((pair) => {
                const mergeAllowed = canMerge(pair.kind);
                const direction = directions[pair.id];
                return (
                  <tr key={pair.id} className="r-row">
                    <td className="whitespace-nowrap text-slate-600">{KIND_LABEL[pair.kind]}</td>
                    <td>
                      <ArchiveSide archive={pair.left} />
                    </td>
                    <td>
                      <span className="mr-1 text-slate-400">↔</span>
                      <ArchiveSide archive={pair.right} />
                    </td>
                    <td className="num" title="越高越像同一家">
                      {formatScore(pair.score)}
                    </td>
                    <td className="whitespace-nowrap text-slate-600">
                      {MATCHED_BY_LABEL[pair.matchedBy]}
                    </td>
                    <td className="text-slate-600">{pair.note ?? '—'}</td>
                    <td className="whitespace-nowrap text-slate-500">
                      {formatDateTime(pair.createdAt)}
                    </td>
                    <td className="text-right">
                      {pair.state === 'merged' ? (
                        // 契约：merged 不能回退，合并已改写全库引用；这里连按钮都不画，避免给假希望。
                        <span className="text-xs text-slate-400">已合并，不可回退</span>
                      ) : (
                        <div className="flex flex-wrap items-center justify-end gap-2">
                          {pair.state === 'kept' ? (
                            <button
                              type="button"
                              className="btn btn-ghost btn-s"
                              disabled={!mergeAllowed}
                              title={
                                mergeAllowed
                                  ? '把这对放回待判'
                                  : `需要 ${pair.kind}.merge 权限才能撤销判定`
                              }
                              onClick={() => void askReopen(pair)}
                            >
                              撤销判定
                            </button>
                          ) : (
                            <>
                              <select
                                value={direction ?? ''}
                                onChange={(event) => {
                                  const next = event.target.value as '' | DedupeMergeDirection;
                                  setDirections((prev) => {
                                    const copy = { ...prev };
                                    if (next === '') {
                                      delete copy[pair.id];
                                    } else {
                                      copy[pair.id] = next;
                                    }
                                    return copy;
                                  });
                                }}
                                aria-label={`选择合并方向：${pair.left.name ?? '档案已删除'} 与 ${
                                  pair.right.name ?? '档案已删除'
                                }`}
                                className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs"
                              >
                                {/* 不预置方向：先并谁后并谁决定单据挂到哪个档案，必须人来选 */}
                                <option value="">选择合并方向…</option>
                                <option value="left_into_right">左并入右</option>
                                <option value="right_into_left">右并入左</option>
                              </select>
                              <button
                                type="button"
                                className="btn btn-primary btn-s"
                                disabled={!mergeAllowed || direction === undefined}
                                title={
                                  mergeAllowed
                                    ? direction === undefined
                                      ? '先选择合并方向'
                                      : '把两条档案真正合并'
                                    : `需要 ${pair.kind}.merge 权限才能合并`
                                }
                                onClick={() => void askMerge(pair)}
                              >
                                合并
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost btn-s"
                                disabled={!mergeAllowed}
                                title={
                                  mergeAllowed
                                    ? '判为不同，此后不再提示'
                                    : `需要 ${pair.kind}.merge 权限才能判定`
                                }
                                onClick={() => void askKeepSeparate(pair)}
                              >
                                不是同一家
                              </button>
                            </>
                          )}
                          {mergeAllowed ? null : (
                            // 只说「无权限」等于让人去猜该找谁开：把缺的权限点写出来。
                            <span className="text-xs text-slate-400">
                              需要 {pair.kind}.merge 权限
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="note">
        只有持有某类档案 `read` 权限的人，才会在这条队列里看到那一类对子（服务端按 kind 鉴权）；
        合并 / 判定 / 撤销判定需要该类档案的 `merge` 权限。前端置灰只是提前提示，判定一律以服务端为准。
      </p>
    </section>
  );
}
