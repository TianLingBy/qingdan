import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  masterdataSuggestApi,
  type SuggestCandidate,
  type SuggestKind,
} from './masterdata-suggest-api.js';

/**
 * 主数据「建档防重」联想提示（D99 / #302 块 B 的前端落点）。
 *
 * 职责只有一个：**在用户打完名字时提醒「这条档案已经有了」，点一下直接用**。
 * 它不是完整的档案选择器 —— 契约只回 `id/name/score/reason` 四个字段，
 * 编号、电话、规格、账期一概不回（`packages/contracts/src/suggest.ts:38-43`
 * 写明「带上敏感字段就变成跨公司信息探测器」）。
 * 所以这里不负责填充表单的其它字段，`onPick` 之后由调用方自己决定填什么。
 *
 * 三条刻意的取舍：
 *
 * 1. **失败静默**。suggest 是辅助，不是开单的必经一步。它挂了、超时了、
 *    用户没权限，都只是「这次没有提示」，绝不能弹错误条或挡住保存。
 *    因此 `onError` 不设，`error` 只用来决定「什么都不渲染」。
 *
 * 2. **没有候选就什么都不渲染**。不用空态、不用占位骨架 ——
 *    这是嵌在输入框下面的内联提示，一个「暂无结果」的框会把用户正在看的
 *    表单往下推一截，边打字边跳。
 *
 * 3. **`companyId` 必传且不由本组件兜底**。见 `masterdata-suggest-api.ts` 顶部注释。
 *    调用方拿不到 `companyId` 时应该根本不该渲染本组件。
 */

const DEBOUNCE_MS = 250;

/** 契约要求最少 2 个字（`suggest.ts:32`）。单字查询等于免费得到「本公司所有张姓客户」。 */
const MIN_LENGTH = 2;

export interface SuggestHintProps {
  readonly kind: SuggestKind;
  /** 用户在输入框里当前打的名字。未 trim。 */
  readonly name: string;
  /** 当前公司。契约必传 —— 拿不到就别渲染本组件。 */
  readonly companyId: string;
  /** 点了某条候选。调用方据此把 `id` 填进表单。 */
  readonly onPick: (candidate: SuggestCandidate) => void;
  /** 关掉提示（例如用户已经选过了）。 */
  readonly enabled?: boolean;
}

function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function SuggestHint({ kind, name, companyId, onPick, enabled = true }: SuggestHintProps) {
  const trimmed = name.trim();
  const debounced = useDebounced(trimmed, DEBOUNCE_MS);

  // 防抖后的值仍然太短就不发请求。注意用的是 debounced 而不是 trimmed：
  // 用 trimmed 的话每敲一个字都会重新触发 queryFn 的 enabled 判断，Debounce 白做。
  const shouldQuery = enabled && debounced.length >= MIN_LENGTH && companyId.length > 0;

  const query = useQuery({
    queryKey: ['masterdata', 'suggest', kind, companyId, debounced],
    queryFn: () => masterdataSuggestApi.suggest(kind, { name: debounced, companyId }),
    enabled: shouldQuery,
    // 边打字边查是高频操作，但同一个名字重复查没有意义；
    // 1 分钟足够覆盖「打了又删、删了又打回来」。
    staleTime: 60_000,
    // 失败不重试 —— 它不是关键路径，重试只会拖慢下一次输入。
    retry: false,
  });

  const candidates = useMemo(
    () => (shouldQuery ? (query.data?.candidates ?? []) : []),
    [shouldQuery, query.data],
  );

  // 输入变化后、新结果回来之前，旧候选还在手上。此时**不渲染**：
  // 显示上一轮的候选会让用户以为「张记」和「张记建材」是同一个东西。
  const isStale = debounced !== trimmed;

  if (!shouldQuery || isStale || candidates.length === 0) return null;

  return (
    <div>
      <p className="note">已有相似档案，点一下直接用，别新建重复的：</p>
      <ul>
        {candidates.map((candidate) => (
          <li key={candidate.id}>
            <button type="button" className="btn-ghost" onClick={() => onPick(candidate)}>
              {candidate.name}
              <span className="note">
                （{candidate.reason} · {(candidate.score * 100).toFixed(0)}%）
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
