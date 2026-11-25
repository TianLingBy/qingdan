import { Icon } from './icons/Icon';

/**
 * 列表分页（v3.0 `.tf` 页脚右侧的 `.pager`）。
 *
 * 为什么抽成组件：单据六页（采购 A / 加工 B / 销售 E / 内贸 N / 结算 C / 冲正）
 * 的页码条完全一样——首 / 上 / 页码 / 下 / 末 + 每页条数。
 * 以前各页各写一份 `上一页 / 输入框 / 下一页`（v0.13 版式），
 * 六页里有五个页面的「总页数」算法还不一样；这里收一处。
 *
 * 口径（`docs/ui/frontend-change-rules.md` §二 分页 + 对照稿 §四）：
 * - 参数名是后端真名 `page` / `pageSize`，本组件只发页码，不拼 query；
 * - 超过 7 页折叠成 `1 … 4 5 6 … 12`（稿子 index.html:1108-1120 的算法）；
 * - 页码是**服务端分页**，不是把当前页切片，`totalPages` 来自 `total / pageSize`；
 * - `totalPages <= 1` 时不画页码按钮，但每页条数选择器保留（用户可能想 50 条一屏看完）。
 */
export const PAGE_SIZE_OPTIONS = [10, 20, 50] as const;

/** 页码条里的一项：数字页码或省略号。 */
export type PageItem = number | 'dots';

/**
 * 算出要画的页码序列。
 *
 * `totalPages <= 7` 全画；再多就「首 / 当前±1 / 末」夹两个省略号，
 * 保证当前页永远在中间——否则翻到第 9 页时高亮块跑出可视区。
 */
export function pageWindow(page: number, totalPages: number): readonly PageItem[] {
  if (totalPages <= 7) {
    return Array.from({ length: Math.max(0, totalPages) }, (_, index) => index + 1);
  }
  const items: PageItem[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);
  if (start > 2) items.push('dots');
  for (let index = start; index <= end; index += 1) items.push(index);
  if (end < totalPages - 1) items.push('dots');
  items.push(totalPages);
  return items;
}

export interface ListPagerProps {
  /** 当前页，从 1 开始。 */
  readonly page: number;
  readonly totalPages: number;
  readonly pageSize: number;
  readonly onPage: (page: number) => void;
  /** 不传就不画「N 条/页」下拉（有些列表后端不接受 pageSize）。 */
  readonly onPageSize?: (pageSize: number) => void;
  readonly pageSizeOptions?: readonly number[];
  /** 无障碍名字，默认「分页」。 */
  readonly label?: string;
  readonly disabled?: boolean;
}

export function ListPager({
  page,
  totalPages,
  pageSize,
  onPage,
  onPageSize,
  pageSizeOptions = PAGE_SIZE_OPTIONS,
  label = '分页',
  disabled = false,
}: ListPagerProps) {
  const items = pageWindow(page, totalPages);
  const atFirst = page <= 1;
  const atLast = page >= totalPages;

  return (
    <div className="pager" role="group" aria-label={label}>
      <div className="nav">
        <button
          type="button"
          aria-label="第一页"
          title="第一页"
          disabled={disabled || atFirst}
          onClick={() => onPage(1)}
        >
          <Icon name="pg-first" />
        </button>
        <button
          type="button"
          aria-label="上一页"
          title="上一页"
          disabled={disabled || atFirst}
          onClick={() => onPage(Math.max(1, page - 1))}
        >
          <Icon name="pg-prev" />
        </button>
        {items.map((item, index) =>
          item === 'dots' ? (
            // 省略号不是按钮：点了没反应会让用户以为坏了。
            <span key={`dots-${index}`} className="dots" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={item}
              type="button"
              className={item === page ? 'on' : undefined}
              aria-current={item === page ? 'page' : undefined}
              aria-label={`第 ${item} 页`}
              disabled={disabled}
              onClick={() => onPage(item)}
            >
              {item}
            </button>
          ),
        )}
        <button
          type="button"
          aria-label="下一页"
          title="下一页"
          disabled={disabled || atLast}
          onClick={() => onPage(Math.min(totalPages, page + 1))}
        >
          <Icon name="pg-next" />
        </button>
        <button
          type="button"
          aria-label="最后一页"
          title="最后一页"
          disabled={disabled || atLast}
          onClick={() => onPage(totalPages)}
        >
          <Icon name="pg-last" />
        </button>
        {onPageSize ? (
          <select
            className="per"
            aria-label="每页条数"
            value={pageSize}
            disabled={disabled}
            onChange={(event) => onPageSize(Number(event.target.value))}
          >
            {pageSizeOptions.map((size) => (
              <option key={size} value={size}>
                {size} 条/页
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </div>
  );
}
